# Deployment control plane: architecture

This describes what runs inside the Cloudflare boundary: the authorizer that decides, the deployer
that executes, the runner that executes Terraform, and the storage they write. GitHub supplies
source, releases, attestations and the audit surface; it holds no Cloudflare credential and decides
nothing. Contracts are in [CONTRACTS.md](CONTRACTS.md); the delivery plan and acceptance criteria
are in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).

## 1. The path from `main` to running code

```
 GitHub (release + deploy workflows)                 Cloudflare account
 ───────────────────────────────────                 ─────────────────────────────────────────────────────────
 push to main
   └─ release.yml: build, attest, immutable
      GitHub release vX.Y.Z with
      release.manifest.json, release.zip,
      attestation.sigstore.json
   └─ deploy.yml: OIDC token ──── POST /v1/token ──▶ authorizer  (services.susanb.dev, the only public ingress)
                                                      │ verify OIDC: signature, issuer, audience, lifetime,
                                                      │   owner, repository, pinned workflow, ref, replay (jti)
                                                      │ policy: repository → application/environment/intent
                                                      │ evidence (read-only App): release immutable, tag commit
                                                      │   on main, asset digests present
                                                      │ mint single-use token (TokenLedger DO, 60 s)
                                                      ▼
                                                    DEPLOYER.admit(token, deploy-subject/v1)   (service binding RPC)
                                                      │ AUTHORIZER.consume(hash) — atomic, single use
                                                      │ registry (KV, Terraform-written) must list app/env/targets
                                                      │ Coordinator DO "app:env": dedupe, monotonic release check,
                                                      │   active + next-in-line slot, outbox
                                                      ▼
   ◀────────────── 202 {QUEUED, deploymentId, githubDeploymentId}
                                                    Queue deploy-requests ──▶ deployer.queue() ──▶ Coordinator.advance()
                                                      VERIFYING   download assets (bounded) → release-staging (sha256 bound to
                                                                  authorizer digests) → zip safety → runner container
                                                                  verifies Sigstore attestation offline → copy into the
                                                                  locked releases bucket (create-only)
                                                      PLANNED     manifest ∩ registry, DAG order, capture prior versions
                                                      DEPLOYING   per target: Workers versions upload (op id in the
                                                                  version message) → deployment 100 % → checkpoint
                                                      HEALTH      registry origin + manifest path, release tag echoed
                                                      COMMITTING  ledger events + result (locked), pointers CAS
                                                      SUCCEEDED   GitHub Deployment status: success
                                                      failure after a mutation → RECOVERING: reverse order, prior
                                                      versions redeployed → ROLLED_BACK, or RECOVERY_FAILED
```

## 2. Components

| Component | Repo | Kind | Holds |
|---|---|---|---|
| `authorizer` | `authorizer` | Worker + `TokenLedger` DO, custom domain `services.susanb.dev` | its read-only GitHub App key |
| `deployer` | `deployer` | Worker, `Coordinator` DO, `RunnerJob` DO with container, `EgressGate` entrypoint, queue consumer; no route, no DNS | deployer GitHub App key, `CF_PLAN`, `CF_APPLY`, `R2_STATE_RO`, `R2_STATE_RW`, `TF_ENCRYPTION_INFRA`, one `WORKER_<NAME>` per target |
| `root-runner` | `deployer` (code), deployed only by the bootstrap path | Worker, `RunnerJob` DO with container; no route, no DNS | `CF_ROOT_APPLY`, `CF_SECRETS_WRITE`, `R2_STATE_ROOT`, `TF_ENCRYPTION_ROOT`, deployer GitHub App key |
| Terraform `infra-root` | `infra-root` | OpenTofu root | buckets, locks, lifecycle, token inventory, policy layer |
| Terraform `infra` | `infra` | OpenTofu | queues, registry KV and its value, authorizer domain and edge rules |

The root runner and the deployer run the same runner code with different bindings, so the code is
reviewed once and the privilege is split by deployment, not by trust in the code path. The deployer
can never deploy `deployer`, `authorizer` or `root-runner` through the artifact path; the registry
validator forbids those script names.

## 3. Trust boundaries and why each holds

1. **Admission.** The only public surface is `POST /v1/token`. It authenticates GitHub's OIDC token
   in the Worker, not with a Cloudflare Access service token, because a service token would have to
   live in GitHub and GitHub holds no secrets. This replaces the spec's "service-auth only" line for
   `services.susanb.dev` (ADR 0001). All other paths are blocked at the edge and return 404 from
   the Worker. A WAF rate limit fronts the hostname.
2. **Decision versus execution.** The authorizer decides and the deployer executes. The deployer has
   no route; it is reachable only through service bindings that exist only in reviewed Worker
   configuration. Even a forged binding cannot act: every job must consume a live, unconsumed
   ledger grant whose subject digest matches.
3. **Registry.** Terraform writes the registry; the deployer only reads it. A release can name
   targets, but only targets the registry already lists, with bindings and health origins from the
   registry. A release cannot add a binding, a host or a script.
4. **Release integrity.** Bytes are bound three times: GitHub's asset digest captured by the
   authorizer, the Sigstore attestation (repository, signer workflow, source commit), and
   per-entry SHA-256 values inside the manifest. After ingest, bytes are read only from the locked
   `releases` bucket. Rollbacks redeploy those same bytes.
5. **Credentials.** Each target's token is a Secrets Store binding scoped to one script. Runner
   containers start with the internet disabled. Every outbound request goes through the
   `EgressGate`, which allows only the job type's hosts and paths and injects credentials there,
   so the container never holds a Cloudflare token. The Terraform state passphrase is the one
   value a container must hold, in memory, for the life of one job.
6. **State.** The coordinator Durable Object is the transactional authority per application and
   environment. Its storage transitions are synchronous transactions with a fencing lease. R2
   holds the durable ledger (create-only, bucket-locked) and pointers (etag compare-and-swap).

## 4. Coordinator state machine

One `Coordinator` Durable Object per `application:environment`. It holds at most one **active**
deployment and one **next-in-line** request. A newer request replaces an older next-in-line
request, which ends `REJECTED` with `superseded`. A `deploy` intent whose release is older than or
equal to the committed release ends `REJECTED` with `stale_release` (equal and identical manifest
ends `ALREADY_CURRENT`). A `rollback` intent may target any release previously committed.

```
REQUESTED → AUTHORIZED → QUEUED → VERIFYING → PLANNED → DEPLOYING_TARGETS → HEALTH_CHECKING → COMMITTING → SUCCEEDED
                │            │         │          │               │                  │
                ▼            ▼         ▼          ▼               ▼                  ▼
             REJECTED     REJECTED  REJECTED   REJECTED       RECOVERING ─────▶ ROLLED_BACK
             (nothing mutated yet)                                  └──────────▶ RECOVERY_FAILED (human)
```

Execution:

- Admission writes the deployment and an outbox row in one transaction, then flushes the outbox to
  the queue. A failed flush leaves the row; the alarm retries it.
- `advance()` takes a lease (`holder`, `fence`, `expiresAt`). Every step re-reads the record inside a
  synchronous transaction and checks the fence before writing. A concurrent `advance()` sees a live
  lease and returns `busy`.
- Each step persists intent before its side effect and the outcome after it. Side effects carry an
  operation id, so after a crash the step reconciles by observing (for example, listing Worker
  versions for the operation id) instead of repeating blindly.
- Work runs in slices of at most 60 seconds. If a deployment is not terminal, the coordinator
  enqueues the next kick through the outbox. The alarm is the watchdog: an expired lease or an
  unflushed outbox re-kicks; a deployment idle past its budget is driven to recovery.
- Failure before any mutation is `REJECTED`. Failure after a mutation enters `RECOVERING`, which
  redeploys the prior version of every completed target in reverse order and health-checks again.
  A target with no prior version (first deploy), or a recovery that itself fails, ends
  `RECOVERY_FAILED` and stays visible for a human. Nothing is retried after `RECOVERY_FAILED`.

## 5. Runner

`RunnerJob` is one Durable Object per job with a container bound to it (`durable_object` scheduling
policy, digest-pinned image in the Cloudflare registry, no route).

1. The envelope is validated and recorded create-only by `jobId`. A repeated call returns status.
2. Egress: `enableInternet: false`, then `interceptOutboundHttps("*")` and
   `interceptOutboundHttp("*")` route to `EgressGate` with props `{ jobId, type }`. The gate allows
   only the hosts and paths for that job type, refuses redirects to anything else, and adds
   credentials for the hosts that need them (Cloudflare API bearer token, R2 S3 SigV4 re-signing,
   GitHub installation token).
3. The container's PID 1 idles with a hard maximum lifetime. The job runs through `exec` with the
   envelope and any input files on stdin. Stdout is the single result document; stderr streams to
   `runner-logs` in R2 with a 90-day lifecycle.
4. The alarm is the watchdog at the job deadline. Cleanup destroys the container and confirms it is
   gone before the job lease is released.
5. Outcome records are final. A mutating job (`terraform.apply`) that ends without an authoritative
   result is `uncertain`, which blocks further applies on that stack until a human resolves it.

Job types: `release.verify` (offline `gh attestation verify` against the pinned trusted root, no
egress at all), `terraform.plan`, `terraform.apply` (deployer, stack `infra`), and `root.plan`,
`root.apply` (root runner only, stack `infra-root`). Both runners receive
`{ type: "terraform.plan" | "terraform.apply", subject: terraform-subject/v1 }`; the grant's action
says which stack it was minted for.

## 6. Terraform flow

- `terraform.plan` runs for a pull request on the merge commit. Policy (rego under
  `infra-root/policy`) is always taken from `infra-root` `main`, never from the pull request. The
  plan, its JSON rendering, its SHA-256 and the state serial and lineage go to `tf-plans` under
  `{stack}/{treeSha}/` (the promoter's squash merge changes the commit, not the tree). Plans run
  with `-lock=false` and read-only state credentials. A check run reports add, change and destroy counts and every policy result.
- `terraform.apply` accepts only a stored plan for the tree of the head of `main`, whose SHA-256
  matches, and whose state serial and lineage are unchanged. It archives state to `tf-state-archive`
  (locked) before and after, then records a GitHub Deployment.
- Terraform owns every resource except application Worker scripts. The deployer creates a target's
  script on first deploy and uploads versions after that (ADR 0006); it never creates, deletes or
  edits a Terraform-managed resource.

## 7. Resource inventory

Created by `infra-root` (root token; everything the deployer binds to, so the day-zero apply
creates all of it; buckets, queues and the namespace carry `prevent_destroy`):

| Bucket | Lock | Lifecycle | Used by |
|---|---|---|---|
| `releases` | indefinite, whole bucket | none | deployer |
| `release-staging` | none | delete after 3 days | deployer |
| `deploy-state` | indefinite on `ledger/` | none | deployer |
| `runner-logs` | none | delete after 90 days | deployer, root runner |
| `tf-state` | none | abort multipart after 1 day | runners through the egress gate |
| `tf-state-archive` | indefinite, whole bucket | none | runners through the egress gate |
| `tf-plans` | none | delete after 90 days | runners |

| Other resource | Name | Notes |
|---|---|---|
| Queue | `deploy-requests` | wake-up kicks for coordinators |
| Queue | `deploy-requests-dlq` | alert on depth > 0 |
| KV namespace | `deploy-registry` | holds the registry value written by `infra` |

Created by `infra` (applied through the deployer's runner):

| Resource | Name | Notes |
|---|---|---|
| Queue consumer | `deploy-requests` → `deployer` | batch 1, 5 retries, 30 s delay, DLQ; applied once the deployer exists |
| KV value | `deploy-registry` / `registry` | `deploy-registry/v1`, `revision` strictly increasing |
| Custom domain | `services.susanb.dev` → `authorizer` | applied once the authorizer exists |
| Rulesets | zone `susanb.dev` | block everything but `POST /v1/token`; rate limit 10 per 10 s per IP |

Created by the deployer: application Worker scripts listed in the registry (never by Terraform;
rego P7 forbids Worker code resources in any plan).

Secrets Store `control-plane` (values minted by `infra-root/provision`, never by Terraform):

| Secret | Bound to | Permission |
|---|---|---|
| `AUTHORIZER_GITHUB_APP_KEY` | authorizer | App `authorizer`: contents, checks, pull requests, attestations read |
| `DEPLOYER_GITHUB_APP_KEY` | deployer, root runner | App `deployer`: contents read, deployments write, checks write |
| `CF_PLAN` | deployer | account and zone reads for plans |
| `CF_APPLY` | deployer | DNS, Access, routes and custom domains (VERIFY permission), queue consumers, Workers KV Storage Edit (registry value), zone WAF edit, notifications; no R2 admin, no Workers Scripts, no members, no tokens |
| `R2_STATE_RO` | deployer | Bucket Item Read on `tf-state` (plans run with `-lock=false`; plan files go through the Worker's `TF_PLANS` binding) |
| `R2_STATE_RW` | deployer | Bucket Item Write on `tf-state`, `tf-plans`, `tf-state-archive` |
| `TF_ENCRYPTION_INFRA` | deployer | generated passphrase |
| `WORKER_<NAME>` | deployer | Workers Scripts Edit. Cloudflare most likely cannot scope this to one script (VERIFY); the deployer only ever addresses the registry's script for that target, and the registry forbids control-plane script names. Per-target tokens still give separate revocation and audit. |
| `CF_ROOT_APPLY`, `R2_STATE_ROOT`, `TF_ENCRYPTION_ROOT`, `CF_SECRETS_WRITE` | root runner | R2 admin, queues edit, Workers KV namespaces edit, Zero Trust org, Secrets Store write. `TF_ENCRYPTION_ROOT` is generated once by `infra-root/bootstrap/day-zero.sh`. |

## 8. Operational invariants and where they are enforced

| # | Invariant | Enforced by |
|---|---|---|
| 1 | No attested, immutable release, no deploy | authorizer evidence; deployer staging digest + `release.verify` |
| 2 | No authorized proposal, no queue admission | `AUTHORIZER.consume` before any coordinator write |
| 3 | No registry match, no target mutation | registry validator; manifest ∩ registry in PLANNED |
| 4 | No concurrent deployments per app/env | one Coordinator per key, one active slot, fenced lease |
| 5 | No duplicate effect on replay | single-use tokens, requestId dedupe, operation ids, create-only R2 |
| 6 | No stale release overtakes a newer one | monotonic semver check for `deploy` intent |
| 7 | No mutable release bytes | locked `releases` bucket, create-only writes with SHA-256 |
| 8 | No silent partial deploy | checkpoints per target; RECOVERING; RECOVERY_FAILED is terminal and visible |
| 9 | No credential in GitHub, envelopes, queues, logs or state | Secrets Store bindings; egress gate injection; validators reject secret-shaped fields |
| 10 | No control-plane self-escalation | registry forbids control-plane script names; root runner deployed only by bootstrap |
| 11 | No Terraform apply without a reviewed plan | stored plan bound to merge commit, SHA-256, serial and lineage |
| 12 | No destructive plan on protected resources | rego P1/P2 from `infra-root` main; `prevent_destroy`; bucket locks |
