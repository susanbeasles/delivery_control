# Runner

The runner executes container jobs for the control plane: `release.verify` and `terraform.plan` /
`terraform.apply` in the deployer, `root.plan` / `root.apply` in the root runner. Both Workers run
the same code (`worker/runner/`, `container/`) with different bindings; the privilege split is by
deployment, not by trust in a code path. Contracts: [CONTRACTS.md](CONTRACTS.md) sections 4 and 10.
Interface: [`worker/runner/api.ts`](../worker/runner/api.ts).

What the runner does not do: decide. Every job arrives after its caller consumed an authorizer
grant. The runner validates, executes, records an outcome, and reports.

## 1. Lifecycle

One `RunnerJob` Durable Object per job (`RUNNER.getByName(jobId)`), with one container bound to it.

```
submit ─▶ queued ─▶ preparing ─▶ starting ─▶ running ─▶ cleanup ─▶ done (succeeded | failed | uncertain)
                       │             │           │         ▲
                       └─────────────┴───────────┴─────────┘  outcome decided (refusal, watchdog, exit)
```

| Step | What happens | Where |
|---|---|---|
| submit | Request validated fatally (`request.ts`, `subject.ts`); recorded create-only. An identical canonical request returns the status; a different one with the same `jobId` is `job_conflict`. Alarm set for now. | `controller.ts` |
| preparing | Everything that needs no container: stack lock check, stored plan reuse, plan binding check, GitHub tree check, tarball downloads, staged file checks. A refusal here ends the job `failed`; retryable errors retry up to 3 times. | `prepare.ts` |
| starting | `interceptOutboundHttps('*')` and `interceptOutboundHttp('*')` to `EgressGate` with props `{ jobId, type }`, then `start({ image, instance: 'standard-1', enableInternet: false, env: {} })`, readiness probe, image check. | `container.ts` |
| running | `running` is persisted **before** `exec`. One `exec` of the agent with the framed job on stdin; stdout is the result (at most 256 KiB, strict JSON); stderr is redacted into `runner-logs` at `jobs/{type}/{jobId}/stderr.log` (at most 16 MiB). A heartbeat alarm every 30 s keeps the object resident and the watchdog prompt. | `exec.ts`, `log-sink.ts` |
| cleanup | Uncertain apply: write the stack lock first. Then `destroy()` and confirm `running === false` and `inspect() === null`. Unconfirmed: retry every 30 s, job stays non-terminal. | `controller.ts` |
| done | Terminal state recorded. Then, best effort and at most once: GitHub check run / Deployment, coordinator `runnerJobFinished`. | `github-report.ts`, `notify.ts` |

stdin framing (`worker/runner/framing.ts` writes, `container/agent/framing.mjs` reads): line 1 is the
`runner-job/v1` envelope, line 2 is `{"files":[{"name","sha256","size"}]}`, then each file's raw
bytes in order, then EOF. The agent verifies every size and digest and rejects trailing bytes.

The agent runs as uid 10001 in `/tmp/job` (one job per container; a second job is refused), gives
every tool an explicit minimal environment, kills tool process groups 20 s before the deadline
(SIGTERM, then SIGKILL after 10 s, so `tofu apply` can persist state), and writes exactly one
`runner-result/v1` document: `{ schema, jobId, outcome, result, error }`.

## 2. Outcomes

| Ending | Read-only job (`release.verify`, `*.plan`) | Mutating job (`*.apply`) |
|---|---|---|
| Refused in preparation (lock, missing or tampered plan, tree mismatch, staging digest) | `failed` | `failed` |
| Container did not start / not ready | `failed` | `failed` |
| Exit 0, valid document, `outcome: failed` (e.g. `state_serial_changed`) | `failed` | `failed` |
| Exit 0, valid document, `outcome: uncertain` (`apply_failed` after `tofu apply` started) | `failed` | `uncertain` |
| Exit 0, valid document, success result that fails validation or cross-checks | `failed` | `uncertain` |
| Non-zero exit, missing or invalid result, result over 256 KiB | `failed` | `uncertain` |
| Watchdog at `deadlineAt` while running | `failed` (`deadline_exceeded`) | `uncertain` (`deadline_exceeded`) |
| Object restarted while the agent ran (exec lost) | `failed` (`execution_lost`) | `uncertain` (`execution_lost`) |

Outcomes are decided once (first writer wins) and never retried. An `uncertain` apply writes
`locks/{stack}.json` to `tf-plans` (create-only, `stack-lock/v1`); every later apply on that stack
fails with `stack_locked_uncertain` before any container starts, until a human removes the lock
(section 6). A failed `tofu apply` is treated as uncertain on purpose: it may have changed part of
the infrastructure, and the next apply should follow a human look and a fresh plan.

Success results are checked against the job: plan summaries must name the job, stack, tree,
commit and repository; apply results the job, stack, tree and commit; `release.verify` results the
exact staged digests, repository, source commit, signer workflow and a ref of `main` or the tag.

## 3. Terraform flow

- **Plan** (`terraform.plan` on `infra`, `root.plan` on `infra-root`). The Durable Object checks the
  commit's tree with GitHub (`tree_mismatch` otherwise), resolves infra-root `main` to a commit
  (policy is never taken from the change under review), downloads both tarballs at exact commits
  (one redirect, only to `codeload.github.com`, without the token, at most 32 MiB / 16 MiB), and
  passes them on stdin. The agent extracts them safely, runs `tofu init -lockfile=readonly` with
  the runner's backend file, refuses any backend other than our s3 bucket and key, reads state
  serial and lineage, runs `tofu plan -lock=false -out plan.tfplan`, re-reads serial and lineage
  (must be unchanged), renders `tofu show -json`, **redacts every value the plan marks sensitive**,
  runs `conftest test --all-namespaces --policy <infra-root main>/policy` (the invocation `scripts/policy-check.sh` tests, and a run that evaluates no rule is a `policy_error`) on the redacted plan with a
  top-level `stack` field, and uploads `plan.tfplan`, `plan.json`, then `summary.json` (last, so it
  marks a complete plan) to `tf-plans/{stack}/{treeSha}/`.
  - Why `-lock=false`: a plan never writes state, so plan jobs hold no write credential at all, and a
    plan killed by the watchdog cannot leave a stale lock that blocks applies. R2 object writes are
    atomic, so a concurrent apply is seen either fully or not at all; it is then detected by the
    serial/lineage re-read, and authoritatively at apply time.
  - Plans are create-only per tree. If a complete plan already exists for the tree, the job reports
    it again without running. Plan files without `summary.json` are debris: `plan_incomplete`.
- **Apply** (`terraform.apply` / `root.apply`). Refused unless: no stack lock; `summary.json`
  exists for the main commit's tree (plans are keyed by tree because the promoter's squash merge
  keeps the tree and changes the commit); policy passed; the stored `plan.tfplan` hashes to the
  summary's `planSha256`; the main commit's tree is the subject's tree. The agent then downloads the
  plan through the gate, re-checks its digest, runs `tofu init`, compares the current state serial
  and lineage with the plan's, archives the stored (encrypted) state object to
  `tf-state-archive/{stack}/{treeSha}/{jobId}/before.tfstate`, runs `tofu apply -lock-timeout=60s
  plan.tfplan`, archives `after.tfstate`, and returns `{ applied: true, stateSerialBefore,
  stateSerialAfter, … }`. OpenTofu's own saved-plan staleness check and state lock remain in force.
- **Reporting** (best effort, after the job is terminal, never changes the outcome): a check run
  `terraform plan / {stack}` on `headSha` with counts and every policy result; a GitHub Deployment
  with a status on the applied commit, environment `{stack}`.
- **Encryption.** State and plans are encrypted with an enforced PBKDF2/AES-GCM method built by
  the agent into `TF_ENCRYPTION` (blocks named `runner`). Stack configurations keep an
  `encryption {}` block with `enforced = true` and must not define conflicting `state`/`plan`
  methods. The stored `plan.tfplan` is therefore ciphertext; a plan forged without the passphrase
  cannot be applied.

## 4. Egress

Containers start with the internet disabled; every HTTP and HTTPS request to any host is routed to
`EgressGate`, which denies by default. The table is data in
[`egress/rules.ts`](../worker/runner/egress/rules.ts) and is tested as a matrix.

| Job type | `api.cloudflare.com` | R2 S3 `<ACCOUNT_ID>.r2.cloudflarestorage.com` (path style) | `artifacts.runner.internal` |
|---|---|---|---|
| `release.verify` | denied | denied | denied (no egress at all) |
| `terraform.plan`, `root.plan` | `GET`, `HEAD` on `/client/v4/…` | `GET`/`HEAD` `tf-state/{stack}/terraform.tfstate`; `GET tf-state?list-type=2&prefix=env:/` | `PUT /plan.tfplan`, `/plan.json`, `/summary.json` → `tf-plans/{stack}/{treeSha}/…`, create-only |
| `terraform.apply`, `root.apply` | all methods on `/client/v4/…` | as plan, plus `PUT` state; `GET/HEAD/PUT/DELETE` `….tflock`; `PUT tf-state-archive/{stack}/{treeSha}/{jobId}/{before,after}.tfstate` (gate forces `if-none-match: *`) | `GET /plan.tfplan` from `tf-plans/{stack}/{treeSha}/` |

For every allowed request the gate keeps only a per-destination header allowlist (the container's
`Authorization`, cookies and `x-amz-*` headers never leave), injects the credential, sends with
`redirect: 'manual'`, and passes a 3xx back only when its target is itself allowed for the same job
(307/308 judged with the original method); anything else is `502 {"error":"redirect_refused"}`.
R2 requests are re-signed with SigV4 (service `s3`, region `auto`, `x-amz-content-sha256:
UNSIGNED-PAYLOAD`); `aws-chunked` and streaming payloads are refused. Egress is allowed only while
the job is `running` with no outcome; the gate asks the job's object on every request.

## 5. Credential custody

| Secret (Secrets Store binding) | Runner | Job types | Where it is used | Reaches the container? |
|---|---|---|---|---|
| `CF_PLAN` | deployer | `terraform.plan` | gate: `Authorization: Bearer` to `api.cloudflare.com` | no |
| `CF_APPLY` | deployer | `terraform.apply` | gate, same | no |
| `CF_ROOT_PLAN` | root | `root.plan` | gate, same | no |
| `CF_ROOT_APPLY` | root | `root.apply` | gate, same | no |
| `R2_STATE_RO` (+ var `R2_STATE_RO_TOKEN_ID`) | deployer | `terraform.plan` | gate: SigV4 key id = token id, secret = SHA-256 hex of the value | no |
| `R2_STATE_RW` (+ `R2_STATE_RW_TOKEN_ID`) | deployer | `terraform.apply` | gate, same | no |
| `R2_STATE_ROOT` (+ `R2_STATE_ROOT_TOKEN_ID`) | root | `root.plan` (GET/HEAD only), `root.apply` | gate, same | no |
| `TF_ENCRYPTION_INFRA` | deployer | `terraform.*` | Durable Object → `exec` env `RUNNER_TF_PASSPHRASE` → agent → `TF_ENCRYPTION` of tofu processes only | **yes, in memory, for one job** |
| `TF_ENCRYPTION_ROOT` | root | `root.*` | same | **yes, in memory, for one job** |
| `GITHUB_APP_KEY` (`DEPLOYER_GITHUB_APP_KEY`) | both | `terraform.*`, `root.*` | Durable Object: tree check, tarballs (`contents: read`), check runs (`checks: write`), Deployments (`deployments: write`) | no |
| `CF_SECRETS_WRITE` | root | `secrets.generate` | root runner Worker: Secrets Store API | no |

The container's start environment is empty. The passphrase is removed from the agent's own
environment before anything runs and is passed to no tool but `tofu`. Logs are redacted (exact
passphrase, authorization headers, bearer, GitHub and JWT tokens, SigV4 material, `key=value`
secrets, mixed-case high-entropy strings); hex digests survive.

`secrets.generate` is not an authorizer action. It runs inside the root runner as the first step
of every granted `root.plan` / `root.apply`: for each of `TF_ENCRYPTION_ROOT` and
`TF_ENCRYPTION_INFRA`, if no secret of exactly that name exists, it creates one from 32 bytes of
`crypto.getRandomValues` (base64url). It never overwrites, never logs or returns a value, and its
failure does not stop the job (a missing passphrase then fails the job closed). There is no
rotation path: replacing a state passphrase without an OpenTofu key migration (a `fallback` key
provider in the stack's `encryption` block) makes the state unreadable. Rotation is a reviewed
migration change, not a runner job.

## 6. Operator runbook

All commands run from the owner's sandbox host session (`wrangler` logged in with OAuth), never
with a pasted token.

- **Inspect a job.** Status: the caller's `jobStatus({ jobId })` (deployer `Deployer`, root runner
  `RootRunner`). Log: `wrangler r2 object get runner-logs/jobs/<type>/<jobId>/stderr.log --remote --pipe`.
  Events: Workers Logs for `deployer` / `root-runner`, filter on the `jobId` field (events
  `runner.*`, `egress.*`; `egress.denied` shows every refused request with host, path and reason).
- **Clear an uncertain stack lock.** `<plans>` is `tf-plans` for `infra` and `tf-plans-root` for
  `infra-root`.
  1. Read the lock: `wrangler r2 object get <plans>/locks/<stack>.json --remote --pipe` (job id,
     commit, tree, reason) and the job's log.
  2. Compare `tf-state-archive/<stack>/<tree>/<jobId>/before.tfstate` with `after.tfstate` (if
     present) and the current state; run a fresh plan for the current `main` through the normal PR
     path to see what remains.
  3. If a state lock object remains (`tf-state/<stack>/terraform.tfstate.tflock`) and no apply is
     running, remove it: `wrangler r2 object delete tf-state/<stack>/terraform.tfstate.tflock --remote`.
  4. Remove the stack lock: `wrangler r2 object delete <plans>/locks/<stack>.json --remote`.
  5. Applies resume with the next reviewed plan.
- **Stale or incomplete plan** (`state_serial_changed`, `plan_incomplete`): delete the three objects
  under `<plans>/<stack>/<tree>/` and re-run the plan. Stack locks under `locks/` never expire;
  plans expire after 90 days (infra-root `lifecycle.tf`).
- **Rotate the trusted root** (`container/trust/trusted_root.jsonl`, commissioning input, absent
  until then; `release.verify` fails with `trusted_root_missing`): on the sandbox host run
  `gh attestation trusted-root > trusted_root.jsonl` (it walks GitHub's and Sigstore's TUF
  repositories), review the diff against the previous file (keys, validity windows, transparency
  log ids), commit it in a pull request, then rebuild the image. The verifier string in every
  `release.verify` result records the SHA-256 of the root it used.
- **Rebuild the image.** The Dockerfile has no defaults for the base image digest or tool
  checksums. Take each SHA-256 from the vendor's signed checksum file (OpenTofu `SHA256SUMS` with
  its signature, the provider's `SHA256SUMS`, conftest `checksums.txt`, gh `checksums.txt`),
  review, commit them as `ARG` defaults, and deploy. The deployer is rebuilt by its own deploy path;
  the root runner only by the bootstrap path (`wrangler deploy -c wrangler.root-runner.jsonc`).
- **Do not deploy the deployer while an apply runs.** A deploy restarts the object; the apply ends
  `uncertain` (`execution_lost`) and locks the stack.

## 7. VERIFY

Items to confirm against current vendor documentation or a first live run before relying on them.

1. Containers `exec`: `user: '10001'` accepted as a uid, `stdin: 'pipe'` closes on writer close,
   `kill(9)`, `exitCode`; the image's `USER` is the default exec user.
2. `interceptOutboundHttps('*')` / `interceptOutboundHttp('*')` accept a bare `*`, apply when called
   before `start()`, and make `artifacts.runner.internal` resolvable inside the container.
3. `/etc/cloudflare/certs/cloudflare-containers-ca.crt` exists at exec time and is readable by uid
   10001; Go tools trust it through `SSL_CERT_FILE` alone (no public CA bundle is installed or needed).
4. `inspect().image` format relative to `ctx.container.images.runner` (compared by digest).
5. A Durable Object stays resident through 30 s heartbeat alarms while an `exec` stream is open;
   alarm invocations never overlap.
6. `ctx.exports.EgressGate({ props })` is available to Durable Objects at compatibility date 2026-10-01.
7. R2 binding `put(…, { onlyIf: { etagDoesNotMatch: '*' } })` returns `null` when the key exists;
   multipart parts must be equal-sized except the last.
8. R2 S3 API: path-style requests, `PutObject` with `If-None-Match: *` (archives),
   `ListObjectsV2` with `prefix=env:/`, the `x-id` query parameter sent by aws-sdk-go-v2.
9. OpenTofu 1.10.6: `TF_ENCRYPTION` merges with the stack's `encryption {}` block as described;
   `-backend-config=<file>` overrides the backend block's attributes; `use_lockfile` and
   `skip_s3_checksum` with R2; `tofu state pull` output when no state exists; `-lockfile=readonly`.
10. Provider 5.28.0 unpacked into the filesystem mirror with every zip member yields the `h1:` hash
    recorded in the stacks' `.terraform.lock.hcl` for `linux_amd64`.
11. Release asset names and inner paths used by the Dockerfile; that conftest 0.71.1 and gh 2.74.0
    exist (pin another gh if not).
12. `gh attestation verify` in the pinned gh (based on the gh 2.74.0 manual): `--custom-trusted-root`,
    `--signer-workflow` accepting `owner/repo/.github/workflows/file.yml`, `--source-digest`,
    `--deny-self-hosted-runners`, `--format json`; fully offline with `--bundle`; a dummy `GH_TOKEN`
    is enough; JSON fields `verificationResult.statement.subject[].digest.sha256` and
    `verificationResult.signature.certificate.{sourceRepositoryURI, sourceRepositoryDigest,
    sourceRepositoryRef, buildSignerURI, runnerEnvironment}`.
13. conftest 0.71.1 JSON output (`successes`, `failures[].msg`, `metadata.details`) and exit code 1
    on failures.
14. Secrets Store API: `GET …/secrets?search=` and `POST …/secrets` with body
    `[{ name, value, scopes: ["workers"], comment }]` (`worker/runner/secrets-generate.ts`).
15. GitHub's tarball endpoint redirects to `codeload.github.com` (the URL carries its own token and
    is never logged).
16. Worker RPC errors carry only `name` and `message`; `RunnerJob.submit` therefore throws
    `Error("<code>: <message>")`.
17. The Node 24 base image has `groupadd`/`useradd` and `/bin/sleep`.

## 8. Open items

- **Root plans are isolated (closed).** The root runner binds `TF_PLANS` to `tf-plans-root`
  (`wrangler.root-runner.jsonc`), which only it can reach, and no R2 S3 credential is scoped to
  either plan bucket, so the deployer cannot read or delete root plans or `locks/infra-root.json`.
- **Passphrase recovery copy.** CONTROL-PLANE-SPEC 5.4 asks for an age-encrypted recovery copy of
  each generated passphrase next to the state. Not implemented: age needs X25519 and
  ChaCha20-Poly1305, the latter not in WebCrypto. Until decided, losing a Secrets Store secret loses
  the state it encrypts.
- **Policy conventions** for `infra-root/policy`: package `main`; input is the redacted plan JSON
  with a top-level `stack`; rule ids as a `P1:` message prefix or `details.rule`.
