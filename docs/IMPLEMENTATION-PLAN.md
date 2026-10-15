# Implementation plan: the deploy pipeline inside the Cloudflare boundary

## Acceptance criterion

> A commit lands on `main`. Minutes later the new code is serving, the GitHub Deployment says
> `success`, and nobody touched anything.

Precisely, for an enrolled application:

1. A push to `main` produces an immutable GitHub release `vX.Y.Z` with the three release assets and
   their attestation (GitHub side, owned by the release workflow).
2. The deploy workflow trades its OIDC token at `POST /v1/token` and receives `202 QUEUED` with a
   `deploymentId` and a `githubDeploymentId`.
3. Within the deploy budget, every registry target named by the manifest serves the new version; the
   health contract returns the new release tag; `pointers/{app}/{env}/current.json` names the new
   release with generation `n+1`; the ledger holds `accepted.json`, ordered events and
   `result.json`; the GitHub Deployment's last status is `success`.
4. The same request replayed, a second run on the same commit, or an out-of-order older release
   produces no second deployment.
5. A release that fails health is rolled back to the prior versions automatically, and the GitHub
   Deployment says `failure` with the reason.

## Ownership

| Owned here | Owned elsewhere |
|---|---|
| authorizer (admission and decision), deployer (coordinator, queue, ingest, adapters, recovery), runner and its container, Terraform for the deploy estate (`infra-root` buckets and policy, `infra` queues, registry and edge) | release and deploy workflows, GitHub-side Terraform (other agent); promoter and shadow-branch promotion; signer; backup and its ledger |

## Phases

### Phase A. Contracts and design (this PR set)

Deliverables: [CONTRACTS.md](CONTRACTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), ADRs under
`docs/adr/`.
Gate: the release workflow owner can build `release-manifest/v2` and the three assets from
CONTRACTS.md alone.

### Phase B. Deployer core

Deliverables: canonical JSON and validators; registry loader; `Coordinator` Durable Object with
fenced leases, outbox, next-in-line slot, alarms; queue consumer; R2 ledger and pointers; admission
RPC that consumes the authorizer grant.
Gate (offline tests): duplicate token, replayed request, stale generation, older release, newer
request superseding next-in-line, crash between outbox write and queue send, lease expiry with a
second consumer, ledger create-only conflict, pointer compare-and-swap conflict.

### Phase C. Release ingest and the Worker adapter

Deliverables: bounded asset download into `release-staging` bound to the authorizer's digests;
ZIP reader over R2 ranges with traversal, symlink, duplicate, ratio and size defenses; copy into the
locked `releases` bucket; `cloudflare-worker/v1` (versions upload with registry bindings, deployment
at 100 %, reconciliation by operation id); health contract; reverse-order recovery; GitHub
Deployments reporting through the deployer App.
Gate (offline tests): first deploy from absent code; tampered asset; manifest digest mismatch;
hostile ZIP set (traversal, absolute path, symlink, duplicate names, zip bomb, ZIP64, encrypted);
artifact declaring an unregistered binding; manifest naming an unregistered target; health failure
with automatic rollback; health failure on a first deploy ending `RECOVERY_FAILED`; crash after a
version upload reconciled without a second upload.

### Phase D. Runner and Terraform

Deliverables: `RunnerJob` with container, egress gate with credential injection, log capture,
watchdog, outcome records; container image with pinned OpenTofu 1.10.6, Cloudflare provider 5.28.0
mirrored into the image, conftest and `gh`; job types `release.verify`, `terraform.plan`,
`terraform.apply`; root runner configuration.
Gate (offline tests): egress allowlist per job type including redirect refusal; credential never
present in container environment; apply refuses a plan from a different commit, a different
SHA-256, or a changed serial or lineage; uncertain apply blocks the next apply; watchdog destroys an
overrunning container.

### Phase E. Authorizer

Deliverables: `POST /v1/token`; OIDC verification against GitHub's JWKS with caching and kid-miss
refresh; policy files; `TokenLedger` with jti replay protection and single-use grants; read-only
GitHub App evidence for `deploy`; `deploy.status`; `consume` RPC.
Gate (offline tests): one test per error code (`bad_sig`, `bad_iss`, `bad_aud`, `expired`,
`bad_owner`, `bad_repo`, `bad_workflow`, `bad_env`, `bad_ref`, `replay`, `bad_subject`,
`no_evidence`), two concurrent consumes with exactly one success, no 3xx ever.

### Phase F. Terraform for the deploy estate and the policy layer

Deliverables: `infra-root` backend and enforced state encryption, buckets with locks, lifecycle and
`prevent_destroy`, the token inventory for every runner credential, rego policies with one passing
and one failing fixture each; `infra` queues, DLQ and consumer, registry KV and value, authorizer
custom domain and edge rules.
Gate: `tofu fmt`, `tofu validate` against provider 5.28.0, `tflint`, `trivy config`, `conftest
verify`; a plan fixture deleting a protected bucket fails P1.

### Phase G. End-to-end acceptance (offline) and commissioning (live)

Offline: authorizer, deployer and a fake target run together under workerd with fake GitHub and
Cloudflare APIs; the acceptance criterion above is asserted step by step, plus its negative cases.

Live commissioning, in order, each step with its evidence recorded in the pull request:

1. Seed re-run with the new inventory tokens (`provision/sandbox.sh apply`).
2. Day-zero apply of `infra-root` from the sandbox (creates `tf-state` first, then imports it).
3. Deployer bootstrap through Workers Builds, or the one-time 24-hour bootstrap token.
4. `infra` plan and apply through the deployer runner.
5. Authorizer deploy through the bootstrap path; edge smoke tests (404 on every path except
   `/v1/token`, 403 with stable codes, never 3xx).
6. First application enrolled in the registry; push to `main`; acceptance criterion observed.

## Decisions taken (see ADRs)

1. Admission is authenticated by GitHub OIDC in the authorizer Worker, not by an Access service
   token, because GitHub may not hold secrets.
2. Release bytes are verified three ways and then live only in a locked bucket; rollbacks reuse them.
3. Attestations are verified with GitHub's own verifier inside a no-egress container against a
   pinned trusted root, rather than a hand-written Sigstore verifier.
4. The registry is a Terraform-written KV value; eventual consistency (up to 60 s) is accepted for
   registry edits and recorded per deployment as `registryRevision`.
5. One coordinator per application and environment, one active deployment, one next-in-line slot
   where newest wins; the queue only wakes the coordinator.
6. Runner containers hold no Cloudflare token; the egress gate injects credentials per host.

## Open items that need the owner

- GitHub App custody: creating the `authorizer` and `deployer` Apps and landing their private keys in
  Secrets Store without a human seeing them (manifest flow from the sandbox).
- The pinned Sigstore trusted root for `release.verify` (GitHub's trust domain for private
  repositories and the public-good root for public ones).
- Confirming zone `def559e8…` is `susanb.dev`.
- Durable Object migrations, D1 migrations and static assets are not in the first adapter set; they
  fail closed with explicit codes until their adapters ship.
