# ADR-0002: The deployer Worker, its container and its four jobs

Status: proposed
Date: 2026-10-15
Builds on: ADR-0001 (runner library), `infra-root/docs/CONTROL-PLANE-SPEC.md` §5.2 deployer, §5.4, §5.5, §7 Phase 1 deliverable 2, §10

## Context

The deployer is the single chokepoint for every deployment. It is invoked only by the authorizer over a private
service binding and runs four job types in a private container through the runner library. It holds the
per-purpose Cloudflare tokens as Secrets Store bindings and a GitHub App private key; the container holds only
what one job needs, for the life of that job.

## Decision

### Layout

```
deployer/
  packages/runner/      the library (ADR-0001)
  worker/               the Worker: wrangler.jsonc, src/, test/            (npm package, devDeps only)
  container/            Dockerfile, bin/runner-job, lib/, jobs/, test/      (Node ESM, no dependencies)
  docs/adr/, docs/BOOTSTRAP.md
```

`worker/` depends on the library as `"@susanbeasles/runner": "file:../packages/runner"` until it is published.

### Worker (`worker/`)

- `export class Deployer extends WorkerEntrypoint<Env>` with one RPC method `run(request)`. No `fetch` handler, no
  route, `workers_dev: false`, `preview_urls: false`. The only caller is the authorizer's service binding.
- `request` is `{ v: 1, action, subject, requested_by }`. `action` is one of `terraform.plan`, `terraform.apply`,
  `worker.deploy`, `image.promote`. `subject` is validated per action (below) against the static target list in
  `src/targets.ts`; anything else is refused with a stable code, never thrown across the binding.
- The envelope is derived, not received: `idempotency_key = sha256(canonical({action, subject}))`,
  `job_id` = a UUID formatted from the first 16 bytes of that digest (version nibble 8, variant 10), so the same
  action on the same subject always lands on the same Durable Object and runs once. `inputs = subject`.
- `export class DeployerJob extends RunnerJob<Env>`: job types from `src/job-types.ts`, secrets from Secrets Store
  bindings named exactly like the secret, `outbound()` returns `this.ctx.exports.Outbound({ props })`, `stage()`
  returns the stored plan for `terraform.apply` (read from `RUNNER_LOGS` under
  `logs/terraform.plan/<plan_job_id>/artifacts/`).
- `export class Outbound extends RunnerOutbound<Env>`: the allowlist gate, plus credential injection the job never
  sees: for `github.com` and `api.github.com` on the job's own repository it mints an installation token for the
  deployer GitHub App (RS256 over WebCrypto, key from Secrets Store binding `GITHUB_APP_KEY`, cached per
  repository until 5 minutes before expiry) and sets `Authorization`. Props: `{ allowedHosts, github: { repo,
  repo_id } | null }`. Everything else passes through untouched.
- After a job settles, `run()` reports: a check run on the subject SHA for every action, a PR comment with
  add/change/destroy counts for `terraform.plan`, a GitHub Deployment with status for `terraform.apply` and
  `worker.deploy`. Reporting failures are returned in the result, never hidden, never retried blindly.
- Tests: `node --test` over pure modules (request validation, envelope derivation, targets, JWT minting against
  a generated test key, outbound injection decisions). The Durable Object and entrypoint classes stay thin.

### Container (`container/`)

- Image: `debian:bookworm-slim` pinned by digest; `git`, `ca-certificates`, `jq`, `skopeo` from apt with
  versions pinned; OpenTofu 1.10.6 and conftest 0.71.1 and cosign 2.6.0 from GitHub releases with checksums
  verified; Node 24 from the official tarball with checksum; `wrangler@4.151.0` installed with
  `npm install -g --ignore-scripts`; the Cloudflare provider 5.28.0 mirrored at build with
  `tofu providers mirror` into `/opt/tofu/providers` and selected by `/etc/tofu/tofurc`
  (`provider_installation { filesystem_mirror { ... } }`, `TF_CLI_CONFIG_FILE`). No `op`: 1Password is not on the
  runtime path (spec §5.4). Non-root user `job`, home `/job`, entrypoint `sleep infinity`.
- `bin/runner-job` (Node, ESM, no dependencies): reads one envelope from stdin (bounded, fatal UTF-8, exact
  shape), resolves the job module from `job_type` (`worker.deploy.<target>` → `jobs/worker-deploy.mjs`), runs
  it with a context, exits 0 only when the job returns `ok`. Secrets arrive in the environment and are never
  written anywhere.
- `lib/`: `exec.mjs` (spawn without a shell, bounded captured output, timeout, env allowlist), `http.mjs`
  (`fetch` with `redirect: 'manual'`, timeout, bounded body; a helper that follows at most one redirect only
  when the target host is in an explicit list), `r2.mjs` (derive S3 credentials from a token value: access key
  id from `GET /client/v4/user/tokens/verify`, secret `sha256(value)`; the account's S3 endpoint from `R2_ENDPOINT`),
  `envelope.mjs`, `output.mjs` (writes to `/job/out`).
- Jobs, each a module with `export async function run(envelope, ctx)`:
  - `terraform.plan` on `{ repo, repo_id, sha, pr }`: clone the exact SHA into `/job/src` (git over HTTPS; the
    Outbound gate injects the credential), `policy/` from `main` into `/job/policy`, `tofu init` with the s3
    backend and derived read-only credentials, `tofu fmt -check`, `tofu validate`, `tflint` if present,
    `tofu plan -lock=false -out=/job/out/plan.tfplan`, `tofu show -json` → `plan.json`, `sha256(plan.tfplan)` →
    `plan.sha256`, `tofu state pull | jq .serial` → `state-serial.txt`, `conftest test plan.json -p /job/policy`,
    `summary.json` `{repo, sha, pr, add, change, destroy, addresses}`. Any failure or policy violation exits 1.
  - `terraform.apply` on `{ repo, repo_id, sha, plan_job_id }`: staged files in `/job/in`; refuse unless
    `summary.json.sha == sha`, `sha256(plan.tfplan) == plan.sha256`, and the current state serial equals
    `state-serial.txt`; `scripts/archive-state.sh pre` (R2 and B2 copies read back and compared); conftest again
    with policy from `main`; `tofu apply plan.tfplan`; `archive-state.sh post`; `scripts/smoke.sh`. Never a fresh
    plan.
  - `worker.deploy.<target>` on `{ repo, repo_id, release_tag, sha }`: fetch the release by tag, download the
    artifact, its SBOM, its cosign bundle and the GitHub attestation bundle for the artifact digest; verify with
    `cosign verify-blob` (bundle, certificate identity regexp pinned to the repository's pipeline on
    `refs/heads/main`, issuer `https://token.actions.githubusercontent.com`) and
    `cosign verify-blob-attestation`; unpack; `wrangler versions upload` then `wrangler versions deploy
    <id>@100% -y` with `CLOUDFLARE_API_TOKEN` set to `WORKER_<TARGET>`; write `deploy.json`.
  - `image.promote` on `{ repo, repo_id, image, digest }`: verify the image attestation for the digest against
    the repository's pipeline identity; `wrangler containers registries credentials --push --expiration-minutes 15`
    with `CF_REGISTRY`; `skopeo copy` by digest from GHCR to `registry.cloudflare.com/<account>/<name>:<short
    digest>`; `skopeo inspect` the destination and refuse unless the digest matches; write `promote.json`.
- Tests: `node --test` in `container/test`: `runner-job` end to end with a fixture job; `lib` units;
  `terraform.plan` against a local fixture configuration with a local backend (OpenTofu and conftest are
  installed in CI and in this environment); the other jobs against a fake `exec` and a fake `fetch` recording
  every command and request, with negative cases (bad attestation identity, digest mismatch, redirect to a host
  outside the list, stale serial, plan hash mismatch).

### Job types (static, `worker/src/job-types.ts`)

| job type | secrets | allowed hosts | artifacts | stage |
|---|---|---|---|---|
| `terraform.plan` | `CF_PLAN`, `R2_STATE_RO`, `TF_ENCRYPTION_INFRA` | `api.cloudflare.com`, `<account>.r2.cloudflarestorage.com`, `github.com`, `api.github.com` | `/job/out` | none |
| `terraform.apply` | `CF_APPLY`, `R2_STATE_RW`, `TF_ENCRYPTION_INFRA`, `B2_ARCHIVE` | the above plus `api.backblazeb2.com`, the B2 S3 endpoint | `/job/out` | `/job/in` |
| `worker.deploy.<target>` | `WORKER_<TARGET>` | `api.cloudflare.com`, `api.github.com`, `github.com`, `objects.githubusercontent.com`, `rekor.sigstore.dev`, `fulcio.sigstore.dev`, `tuf-repo-cdn.sigstore.dev` | `/job/out` | none |
| `image.promote` | `CF_REGISTRY` | `api.github.com`, `ghcr.io`, `pkg-containers.githubusercontent.com`, `registry.cloudflare.com`, `api.cloudflare.com`, the sigstore hosts | `/job/out` | none |

Instance `standard-1`, timeouts 20 min (plan), 40 min (apply), 15 min (deploy, promote), log cap 8 MiB.

### Bootstrap

Preferred: Workers Builds on `main` with deploy command `npx wrangler deploy --config worker/wrangler.jsonc`.
Fallback: `docs/BOOTSTRAP.md` carries the text of a one-time `bootstrap.yml` (`workflow_dispatch`, 24-hour token
in a GitHub environment secret deleted afterwards). `.github/workflows/` is protected in this repository, so the
human adds the file. After bootstrap the deployer self-updates through its own `worker.deploy.deployer` job.

## Consequences

- No credential exists in an envelope, a log, an artifact or a GitHub secret. GitHub credentials are injected by
  the Outbound gate; Cloudflare tokens are per job type; R2 S3 secrets are derived in memory.
- Redirects are never followed implicitly. Release and GHCR downloads resolve one redirect explicitly against an
  allowlist; everything at `services.susanb.dev` is still never redirected.
- Phase 1 validation that needs the live estate (bootstrap, `tofu init` against R2, lock contention, archive
  read-back, token negative tests) is shown in a later PR once the seed has minted the Phase 1 tokens.

## VERIFY before the first live run

- GHCR pulls of private packages with an App installation token (v1 assumes public packages).
- `wrangler containers registries credentials` JSON shape and whether skopeo accepts it as basic auth.
- The exact B2 S3 endpoint and that `B2_ARCHIVE` is `keyId:applicationKey`.
- Workers Builds can build the container image from `container/Dockerfile` (spec §9 open item).
