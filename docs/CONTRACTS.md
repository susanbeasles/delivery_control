# Deployment contracts

Version 1, 2026-10-15. This file is the single source of truth for every message, object and
interface that crosses a boundary of the deployment control plane. Code validates against these
shapes with fatal parsers: unknown fields, missing fields and wrong types are rejections, never
warnings. Each schema id is versioned; a breaking change mints a new id and both versions are
accepted only during an explicit, documented transition.

Who produces and who consumes each contract:

| Contract | Producer | Consumer |
|---|---|---|
| Release assets and `release-manifest/v2` | release workflow (GitHub side) | deployer |
| `worker-artifact/v1` | release workflow, inside `release.zip` | deployer `cloudflare-worker/v1` adapter |
| `POST /v1/token` request | deploy workflow (GitHub side) | authorizer |
| `deploy-subject/v1` | authorizer | deployer |
| `deploy-registry/v1` | `infra` Terraform, written to KV | deployer |
| `promotion-request/v1` | deployer admission | deployer coordinator |
| `deployment-state/v1` | deployer coordinator | deployer, ledger readers |
| `deployment-pointer/v1` | deployer coordinator | deployer, humans, DR |
| `runner-job/v1` | deployer, root runner | runner container agent |

## 0. Shared rules

- **Canonical JSON** is RFC 8785 (JCS) restricted to: `null`, booleans, strings, safe integers,
  arrays and plain objects. Floats, `-0`, `NaN`, duplicate keys and non-UTF-8 input are rejected.
  Keys sort by UTF-16 code units. A *digest* is lowercase hex SHA-256 of the canonical UTF-8 bytes.
- **Fatal parsing.** JSON is decoded with a fatal UTF-8 decoder, parsed, then checked with an exact
  key set. Size is bounded before parsing.
- **Identifiers.**
  - `application`: `^[a-z][a-z0-9-]{0,38}[a-z0-9]$`
  - `environment`: `^[a-z][a-z0-9-]{0,30}[a-z0-9]$`
  - `targetId`: `^[a-z][a-z0-9-]{0,30}[a-z0-9]$`
  - `releaseTag`: stable semver with a `v` prefix, `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`
  - `repository`: `owner/name`, `^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`
  - `repositoryId`, `releaseId`, `assetId`, `githubDeploymentId`: positive safe integers
  - `sourceCommit`: `^[a-f0-9]{40}$`
  - `sha256`: `^[a-f0-9]{64}$`
  - `deploymentId`, `requestId`, `jobId`: UUIDv7, lowercase, `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
  - `scriptName`: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`
  - timestamps: RFC 3339 UTC with `Z` and millisecond precision, produced by `Date.toISOString()`
- **No secrets** ever appear in any contract below. Validators reject PEM blocks and fields named
  like credentials.

## 1. Release assets (GitHub release)

A deployable release is a GitHub release that is **immutable**, **published**, **not a prerelease**
and tagged `vX.Y.Z` at a commit reachable from `main`. Its assets, by exact name:

| Asset | Content |
|---|---|
| `release.manifest.json` | `release-manifest/v2`, canonical JSON bytes |
| `release.zip` | the artifact archive described by the manifest |
| `attestation.sigstore.json` | Sigstore bundle from `actions/attest-build-provenance`, whose in-toto statement lists **both** `release.zip` and `release.manifest.json` as subjects |

GitHub's per-asset `digest` field (`sha256:<hex>`) must be present on all three assets. The
deployer refuses a release whose downloaded bytes do not match those digests.

The attestation is verified offline against a reviewed, pinned trusted root, with:

- source repository = the registry's repository for the application
- signer workflow = the registry's `releaseWorkflow` (for example
  `susanbeasles/workflow_depot/.github/workflows/release.yml`)
- source ref = `refs/heads/main` or `refs/tags/<releaseTag>`, source digest = `sourceCommit`
- GitHub-hosted runner only

### 1.1 `release-manifest/v2`

```json
{
  "schema": "release-manifest/v2",
  "application": "prosrus",
  "repository": "susanbeasles/ProsRUs",
  "repositoryId": 1412827677,
  "releaseTag": "v1.4.2",
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "createdAt": "2026-10-15T12:00:00.000Z",
  "artifact": {
    "path": "release.zip",
    "sha256": "<64 hex>",
    "sizeBytes": 123456,
    "mediaType": "application/zip"
  },
  "targets": [
    {
      "id": "api",
      "adapter": "cloudflare-worker/v1",
      "artifactPath": "targets/api/worker-artifact.json",
      "sha256": "<64 hex of that entry's bytes>",
      "dependsOn": [],
      "healthContract": { "path": "/healthz", "expectStatus": 200, "expectReleaseTag": true }
    }
  ]
}
```

Rules:

- `application`, `repository`, `repositoryId` must equal the registry and the authorizer subject.
  `releaseTag` and `sourceCommit` must equal the authorizer subject.
- `artifact.path` is exactly `release.zip`; `mediaType` is exactly `application/zip`;
  `sizeBytes` is between 1 and the registry's `maxArtifactBytes` (default 64 MiB).
- `targets`: 1 to 32 entries, unique `id`s. Every `id` must exist in the registry for the
  requested environment, with the same `adapter`. Registry targets missing from the manifest are
  left untouched.
- `dependsOn` lists target ids of this manifest; the graph must be acyclic. Execution order is a
  deterministic topological sort (ties broken by `id`).
- `artifactPath` is a relative zip entry path: `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`, no `.` or
  `..` segments, at most 256 bytes.
- `healthContract` (required for `cloudflare-worker/v1`): `path` matches
  `^/[A-Za-z0-9._~/-]{0,255}$` without `//` or `..`; `expectStatus` is 200 to 299;
  `expectReleaseTag` is a boolean. The **origin comes only from the registry**; the manifest can
  never name a host. Redirects are failures.
- When `expectReleaseTag` is true, the endpoint must answer with a JSON object (at most 64 KiB)
  whose `release` field equals the deployed tag. The deployer injects that tag as the plain-text
  binding `DEPLOY_RELEASE_TAG`, so the handler is one line:
  `return Response.json({ release: env.DEPLOY_RELEASE_TAG })`. This is how the deployer proves the
  new version, not a cached old one, is serving.

### 1.2 `release.zip`

- Standard ZIP, stored or deflate entries only, no encryption, no ZIP64, no multi-disk, no data
  descriptors with mismatched sizes.
- At most 2,048 entries; every name passes the `artifactPath` rule; no duplicates (case-folded);
  no directories other than implied ones; no symlinks or other non-regular files (external
  attribute file type must be regular or zero).
- Each entry at most 32 MiB uncompressed; total uncompressed at most 256 MiB; per-entry
  compression ratio at most 200:1.
- The deployer never extracts the archive to a filesystem and never executes anything in it. It
  reads only the entries named by the manifest and by the target artifacts, by range from R2.

### 1.3 `worker-artifact/v1` (adapter `cloudflare-worker/v1`)

Like the manifest, the artifact document's bytes must be canonical JSON (RFC 8785); the deployer
re-serializes and compares, which also rules out duplicate keys.

```json
{
  "schema": "worker-artifact/v1",
  "mainModule": "index.js",
  "compatibilityDate": "2026-10-01",
  "compatibilityFlags": ["nodejs_compat"],
  "modules": [
    { "name": "index.js", "path": "targets/api/index.js", "type": "esm", "sha256": "<hex>" },
    { "name": "index.js.map", "path": "targets/api/index.js.map", "type": "sourcemap", "sha256": "<hex>" }
  ],
  "bindings": ["DB", "SESSIONS"]
}
```

- `modules`: 1 to 64 entries; `type` is one of `esm`, `cjs`, `text`, `data`, `wasm`,
  `sourcemap`; `mainModule` names an `esm` or `cjs` module; module names follow the
  `artifactPath` rule; total module bytes at most 10 MiB.
- `bindings` lists the binding **names** the code expects. Binding types and resources come only
  from the registry. A name absent from the registry target is a rejection. The deployer always
  adds two plain-text bindings it owns, `DEPLOY_RELEASE_TAG` and `DEPLOY_ID`; an artifact may not
  declare either.
- Durable Object migrations, containers, routes, custom domains and cron triggers are not part of
  an artifact. Infrastructure owns them. An artifact that needs a migration is rejected with
  `migration_unsupported`.

## 2. Deploy request, GitHub side → authorizer

```
POST https://services.susanb.dev/v1/token
Authorization: Bearer <GitHub Actions OIDC token, audience "services.susanb.dev">
Content-Type: application/json

{"action":"deploy","subject":{"application":"prosrus","environment":"production","releaseTag":"v1.4.2","intent":"deploy"}}
```

- `intent` is `deploy` (the default flow on push to `main`) or `rollback` (an explicit,
  owner-dispatched redeploy of an older release).
- Responses never redirect. Errors are JSON `{"error":"<code>"}` with `cache-control: no-store`:
  `400 bad_request`; `403` with a refusal code (`bad_sig`, `bad_iss`, `bad_aud`, `expired`,
  `bad_owner`, `bad_repo`, `bad_workflow`, `bad_env`, `bad_ref`, `bad_event`, `bad_subject`,
  `bad_action`, `replay`, `no_evidence`); `404 not_found`; `409 {"error":"rejected","reason":"<code>"}`
  for a final admission rejection; `503 unavailable` for a transient failure (retry with a fresh
  OIDC token). Success is `202`:

```json
{"status":"QUEUED","deploymentId":"<uuidv7>","githubDeploymentId":123456}
```

`status` is `QUEUED` or `ALREADY_CURRENT`. Progress and the final result are reported on the
GitHub Deployment, and by `{"action":"deploy.status","subject":{"application":"…","environment":"…","deploymentId":"…"}}`
on the same endpoint.

## 3. `deploy-subject/v1` (authorizer → deployer)

The authorizer builds this from **verified** evidence only. Nothing in it is copied from the
request body except fields the policy then checked.

```json
{
  "schema": "deploy-subject/v1",
  "intent": "deploy",
  "application": "prosrus",
  "environment": "production",
  "repository": "susanbeasles/ProsRUs",
  "repositoryId": 1412827677,
  "releaseTag": "v1.4.2",
  "releaseId": 987654,
  "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
  "assets": {
    "manifest": { "id": 11, "sha256": "<hex>", "size": 900 },
    "archive": { "id": 12, "sha256": "<hex>", "size": 123456 },
    "attestation": { "id": 13, "sha256": "<hex>", "size": 8000 }
  },
  "requestedBy": {
    "actorId": 215839550,
    "runId": 1234567890,
    "runAttempt": 1,
    "workflowRef": "susanbeasles/ProsRUs/.github/workflows/deploy.yml@refs/heads/main",
    "jobWorkflowRef": "susanbeasles/workflow_depot/.github/workflows/deploy.yml@refs/heads/main",
    "eventName": "push"
  },
  "authorizedAt": "2026-10-15T12:00:05.000Z"
}
```

For `intent: "rollback"`, `assets` may be `null`: a rollback can only target a release the deployer
has already ingested and previously committed.

### 3.1 `terraform-subject/v1` (authorizer → deployer or root runner)

```json
{
  "schema": "terraform-subject/v1",
  "operation": "plan",
  "stack": "infra",
  "repository": "susanbeasles/infra",
  "repositoryId": 1417590199,
  "pullRequest": 42,
  "commit": "<40 hex>",
  "treeSha": "<40 hex>",
  "headSha": "<40 hex>",
  "requestedBy": { "…": "as in deploy-subject/v1" }
}
```

For a plan, `commit` is the pull request's merge commit and `headSha` the head it was built from.
For an apply, `commit` is the head of `main` (the squash merge of `pullRequest`). Plans are stored and
looked up by `treeSha`, because the promoter's squash merge changes the commit but not the tree.
Stack `infra` runs in the deployer with grant actions `infra.plan`/`infra.apply`; stack
`infra-root` runs in the root runner with `root.plan`/`root.apply`.

## 4. Service-binding RPC

All internal calls are Worker RPC over service bindings. No component has a route to another.

### 4.1 Authorizer entrypoint `Authorizer` (bound in the deployer and the root runner as `AUTHORIZER`)

```ts
consume(input: { tokenHash: string; action: string; subject: unknown }): Promise<
  | { ok: true; grant: { action: string; subjectDigest: string; sub: string; jti: string; expiresAt: number } }
  | { ok: false; error: "unknown" | "replay" | "expired" | "mismatch" }
>
```

Atomic delete-and-return in the `TokenLedger` Durable Object. `tokenHash` is the lowercase hex
SHA-256 of the UTF-8 bytes of the token string (base64url, 43 characters). `subject` is compared by
canonical digest. A second call for the same hash returns `replay`; a malformed request returns
`unknown` and burns nothing; a mismatched action or subject returns `mismatch` and burns the grant.
The grant's action is the request action: `deploy` for both intents, `infra.plan`/`infra.apply`
for stack `infra`, `root.plan`/`root.apply` for stack `infra-root`.

### 4.2 Deployer entrypoint `Deployer` (bound in the authorizer as `DEPLOYER`)

```ts
admit(input: { token: string; subject: DeploySubjectV1 }): Promise<AdmissionResult>
status(input: { application: string; environment: string; deploymentId: string }): Promise<StatusResult>
runJob(input: { token: string; job: { type: "terraform.plan" | "terraform.apply"; subject: TerraformSubjectV1 } }): Promise<RunnerJobStatus>
jobStatus(input: { jobId: string }): Promise<RunnerJobStatus>

type AdmissionResult =
  | { status: "QUEUED"; deploymentId: string; githubDeploymentId: number | null }
  | { status: "ALREADY_CURRENT"; deploymentId: string; githubDeploymentId: null }
  | { status: "REJECTED"; error: string; retryable?: boolean }
```

The authorizer answers `503 unavailable` for `registry_unavailable` and `internal` and `409` for
every other `REJECTED` error. `RunnerJobStatus` is defined in `worker/runner/api.ts`; the root
runner exposes the same `runJob`/`jobStatus` on its entrypoint `RootRunner`.

The deployer hashes `token`, calls `AUTHORIZER.consume` with the action and subject, and acts only
on `ok: true`. The grant is consumed before any other check, so a request that is rejected later
can never be replayed. Idempotency: the same token can never be consumed twice; the coordinator
also maps each token hash to the deployment it created, and a request for a release already in
flight joins that deployment. `requestId` is a fresh UUIDv7 per admission.

`REJECTED` error codes: `grant_malformed`, `grant_unknown`, `grant_replay`, `grant_expired`,
`grant_mismatch`, `subject_invalid`, `not_registered`, `repository_mismatch`, `registry_invalid`,
`registry_unavailable` (retry with a new token later), `stale_release`, `stale_generation`,
`release_conflict`, `not_previously_deployed`, `internal` (retry later).

## 5. `deploy-registry/v1` (Terraform → KV `deploy-registry`, key `registry`)

The registry is the trusted inventory. Only Terraform in `infra` writes it. The deployer reads it,
validates it fatally, and refuses to act on anything it does not list.

```json
{
  "schema": "deploy-registry/v1",
  "revision": 3,
  "accountId": "1a799c6e699d2ef7e87398692ce3ad7b",
  "applications": [
    {
      "application": "prosrus",
      "repository": "susanbeasles/ProsRUs",
      "repositoryId": 1412827677,
      "releaseWorkflow": "susanbeasles/workflow_depot/.github/workflows/release.yml",
      "maxArtifactBytes": 67108864,
      "environments": [
        {
          "environment": "production",
          "githubEnvironment": "production",
          "targets": [
            {
              "id": "api",
              "adapter": "cloudflare-worker/v1",
              "scriptName": "prosrus-api",
              "credential": "WORKER_PROSRUS_API",
              "health": { "origin": "https://jobs.susanb.dev", "timeoutMs": 5000, "attempts": 6, "intervalMs": 5000 },
              "bindings": [
                { "name": "DB", "type": "d1", "id": "<uuid>" },
                { "name": "SESSIONS", "type": "kv_namespace", "namespace_id": "<32 hex>" },
                { "name": "UPLOADS", "type": "r2_bucket", "bucket_name": "prosrus-uploads" },
                { "name": "AUTH", "type": "service", "service": "authorizer" },
                { "name": "API_KEY", "type": "secrets_store_secret", "store_id": "<32 hex>", "secret_name": "PROSRUS_API_KEY" },
                { "name": "MODE", "type": "plain_text", "text": "production" }
              ],
              "keepBindings": ["secret_text"]
            }
          ]
        }
      ]
    }
  ]
}
```

- `revision` strictly increases on every change to the document (enforced by policy P13 and
  recorded on each deployment).
- Binding types allowed: `plain_text`, `d1`, `kv_namespace`, `r2_bucket`, `service` (optional
  `entrypoint`), `queue` (`queue_name`), `secrets_store_secret`, `durable_object_namespace`
  (`class_name`, optional `script_name`), `version_metadata`. Names follow
  `^[A-Z][A-Z0-9_]{0,63}$` and `DEPLOY_*` is reserved. A `service` or `durable_object_namespace`
  binding may never reach `deployer`, `authorizer` or `root-runner`: application code must not be
  able to call the control plane's private entrypoints or its ledger.
- `keepBindings` is a subset of `["secret_text","secret_key"]`.
- `credential` names a Secrets Store binding **on the deployer Worker** that holds that target's
  token (Workers Scripts Edit). The deployer fails closed if the binding is missing. VERIFY whether
  Cloudflare can scope Workers Scripts Edit to one script; if it cannot, per-target tokens still
  give separate revocation and audit, but not containment.
- Script lifecycle: the deployer creates a target's Worker script on its first deploy (upload and
  deploy in one call, then workers.dev and preview URLs disabled), uploads a version per release
  after that, and never deletes a script. Terraform owns everything that points at the script:
  custom domains, routes, Access applications. So the order for a new target is: registry entry →
  first deploy → `infra` apply of its domain.
- `health.origin` is `https://` plus a hostname under an owner zone, no path, port or credentials.
  `timeoutMs` 1,000 to 10,000; `attempts` 1 to 20; `intervalMs` 1,000 to 30,000.
- `scriptName` values are unique across the registry. The names `deployer`, `authorizer` and
  `root-runner` are forbidden: control-plane Workers are never deployed through this path.
- Adapters accepted in this version: `cloudflare-worker/v1`. `cloudflare-d1-migrate/v1`,
  `static-assets/v1` and `host-agent/v1` are reserved names that fail validation with
  `adapter_not_implemented` until their adapters ship.

## 6. `promotion-request/v1` (internal, admission → coordinator)

```json
{
  "schema": "promotion-request/v1",
  "requestId": "<uuidv7>",
  "intent": "deploy",
  "application": "prosrus",
  "environment": "production",
  "repository": "susanbeasles/ProsRUs",
  "repositoryId": 1412827677,
  "releaseTag": "v1.4.2",
  "sourceCommit": "<40 hex>",
  "releaseManifestSha256": "<64 hex> | null",
  "assets": { "…": "as in deploy-subject/v1" },
  "expectedCurrentGeneration": null,
  "registryRevision": 3,
  "githubDeploymentId": 123456,
  "requestedAt": "2026-10-15T12:00:05.120Z"
}
```

`expectedCurrentGeneration` is `null` for the automatic flow (deploy on top of whatever is
current, newest release wins) or an integer for a fenced manual operation.

## 7. `deployment-state/v1` (coordinator record)

```json
{
  "schema": "deployment-state/v1",
  "deploymentId": "<uuidv7>",
  "application": "prosrus",
  "environment": "production",
  "intent": "deploy",
  "requestedReleaseTag": "v1.4.2",
  "requestedManifestSha256": "<hex> | null",
  "sourceCommit": "<40 hex>",
  "expectedCurrentGeneration": null,
  "generation": 7,
  "phase": "DEPLOYING_TARGETS",
  "currentTarget": "api",
  "completedTargets": [{ "id": "db", "operationId": "<24 hex>", "versionId": "<uuid> | null" }],
  "priorRelease": { "tag": "v1.4.1", "manifestSha256": "<hex>", "generation": 6 },
  "attempt": 1,
  "startedAt": "…",
  "updatedAt": "…",
  "lastError": null
}
```

Phases: `REQUESTED`, `AUTHORIZED`, `QUEUED`, `VERIFYING`, `PLANNED`, `DEPLOYING_TARGETS`,
`HEALTH_CHECKING`, `COMMITTING`, `SUCCEEDED`, `RECOVERING`, `ROLLED_BACK`, `RECOVERY_FAILED`,
`REJECTED`. Terminal: `SUCCEEDED`, `ROLLED_BACK`, `RECOVERY_FAILED`, `REJECTED`.
`lastError` is `{ "code": "<stable code>", "message": "<bounded text, no secrets>", "at": "…" }`.

## 8. R2 layout

`releases` bucket (indefinite lock on the whole bucket, create-only writes):

```
releases/{application}/{releaseTag}/release.manifest.json
releases/{application}/{releaseTag}/release.zip
releases/{application}/{releaseTag}/attestation.sigstore.json
releases/{application}/{releaseTag}/ingest.json        # deployer's verification record
```

`release-staging` bucket (no lock, lifecycle deletes after 3 days): `staging/{deploymentId}/{asset}`.

`deploy-state` bucket. Lock rules are prefix-scoped, so the immutable ledger and the mutable
pointers live under different top-level prefixes (this differs from the RFC's single-prefix
layout on purpose):

```
ledger/{application}/{environment}/{deploymentId}/accepted.json     # create-only, locked
ledger/{application}/{environment}/{deploymentId}/events/{seq}.json # create-only, locked; seq zero-padded to 8
ledger/{application}/{environment}/{deploymentId}/result.json       # create-only, locked
pointers/{application}/{environment}/current.json                   # deployment-pointer/v1, etag compare-and-swap
pointers/{application}/{environment}/rollback.json                  # previous current, etag compare-and-swap
pointers/{application}/{environment}/promote.json                   # in-flight snapshot, best effort
```

### 8.1 `deployment-pointer/v1`

```json
{
  "schema": "deployment-pointer/v1",
  "application": "prosrus",
  "environment": "production",
  "generation": 7,
  "deploymentId": "<uuidv7>",
  "release": { "tag": "v1.4.2", "manifestSha256": "<hex>", "sourceCommit": "<40 hex>" },
  "targets": { "api": { "adapter": "cloudflare-worker/v1", "scriptName": "prosrus-api", "versionId": "<uuid>" } },
  "committedAt": "…"
}
```

## 9. Queue `deploy-requests`

Message body, at-least-once, no secrets, idempotent on `(deploymentId, kick)`:

```json
{ "schema": "deploy-kick/v1", "application": "prosrus", "environment": "production", "deploymentId": "<uuidv7>", "kick": 3 }
```

The coordinator is the source of truth; a message only wakes it. Dead letters go to
`deploy-requests-dlq` and are surfaced by alerting.

## 10. `runner-job/v1` (container job envelope, delivered on stdin)

```json
{
  "schema": "runner-job/v1",
  "jobId": "<uuidv7>",
  "type": "terraform.plan",
  "deadlineAt": 1760534400,
  "input": { "…": "type-specific, never secret" }
}
```

Job types and inputs:

- `release.verify`: `{ repository, sourceCommit, releaseTag, signerWorkflow, files: [{ name, sha256, size }] }`.
  Files follow the envelope on stdin, length-prefixed in the order listed.
- `terraform.plan` / `terraform.apply` (deployer, stack `infra`) and `root.plan` / `root.apply`
  (root runner, stack `infra-root`): the `terraform-subject/v1` from section 3.1. The runner adds
  the repository tarball at `commit` and the policy bundle from `infra-root` `main` on stdin; an
  apply finds its plan under `tf-plans/{stack}/{treeSha}/` and refuses unless the plan's SHA-256,
  state serial and lineage still match.

The agent writes exactly one JSON result document to stdout (at most 256 KiB) and logs to stderr.
Exit code 0 means the result document is authoritative; any other exit or a missing or invalid
result is an `uncertain` outcome for mutating jobs and `failed` for read-only ones.
