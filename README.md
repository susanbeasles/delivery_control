# deployer

The deployment control plane inside the Cloudflare boundary. It takes an authorized release and puts
it into production: verified, recorded, health-checked, and rolled back on failure. It also runs
OpenTofu for the `infra` stack in a private container.

## What it does

- **Admission.** Accepts deployment requests only from the `authorizer` over a service binding, and
  only after consuming that request's single-use grant.
- **Coordination.** One Durable Object per application and environment runs a state machine
  (`REQUESTED` → … → `SUCCEEDED`, or `ROLLED_BACK` / `RECOVERY_FAILED` / `REJECTED`) with a fenced
  lease, an outbox and a watchdog alarm. One deployment is active and one waits next in line; the
  newest request wins and older releases are refused.
- **Release ingest.** Downloads the release assets bound to the digests the authorizer captured,
  checks the archive defensively, has the runner verify the Sigstore attestation, and copies the
  bytes into the bucket-locked `releases` bucket. Everything after that, including rollbacks, reads
  only from there.
- **Deploy.** `cloudflare-worker/v1`: upload a version with registry-defined bindings, route 100 % of
  traffic to it, prove it serves through the health contract, commit by compare-and-swap of the
  environment pointer. On failure after a change, every touched target returns to its prior version.
- **Terraform runner.** `terraform.plan` and `terraform.apply` for `infra` in a container with no
  credentials of its own (see [docs/RUNNER.md](docs/RUNNER.md)).

## What it does not do

- Decide anything. The `authorizer` decides; this repo executes.
- Create, change or delete Terraform-managed resources: buckets, queues, KV, domains, routes,
  Access. It owns application Worker scripts' code and nothing that points at them.
- Deploy `deployer`, `authorizer` or `root-runner`. Those use the bootstrap path only.
- Build releases. The release workflow (GitHub side) produces them per [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Where results are seen

- The GitHub Deployment on the released commit: `queued`, `in_progress`, then `success`,
  `failure` (rejected or rolled back, with the reason) or `error` (needs a human).
- `deploy-state` R2 bucket: `ledger/{app}/{env}/{deploymentId}/` holds `accepted.json`, every
  event and `result.json` (bucket-locked, create-only); `pointers/{app}/{env}/current.json` names
  what is serving.
- Workers Observability logs: one JSON line per event, no secrets.
- `deploy.status` through the authorizer for a deploy workflow that waits on the result.
  [clients/request-deploy.mjs](clients/request-deploy.mjs) is a zero-dependency reference client
  for the GitHub-side workflow: it requests the deployment with the job's OIDC token and waits for
  a terminal phase, failing the job with the reason if the deployment is rejected or rolled back.

## Layout

```
worker/
  index.ts            exports: default handlers, Deployer, Coordinator, RunnerJob, EgressGate
  entry.ts            Deployer RPC entrypoint and the queue consumer
  wiring.ts           bindings → dependencies
  contracts/          deploy-subject/v1, release-manifest/v2, worker-artifact/v1
  registry/           deploy-registry/v1 validation and loading
  coordinator/        engine (state machine, lease, outbox), steps (one per phase), ledger, store
  release/            staging, promotion into the locked bucket, defensive ZIP reader
  adapters/           Cloudflare Workers API, cloudflare-worker/v1, health probe
  github/             App auth, release asset download, Deployments reporting
  runner/             container runner, egress gate, Terraform jobs
container/            runner image
docs/                 ARCHITECTURE, CONTRACTS, IMPLEMENTATION-PLAN, RUNNER, adr/
test/worker, test/runner
```

## Develop

Node 22.18 or later runs the TypeScript directly; `wrangler` and `tsc` are expected on `PATH`.

```sh
npm test            # node --test, in-memory fakes, no network
npm run typecheck   # generates Workers runtime types, then tsc --strict
npm run check:config  # fails until every commissioning value is set
```

## Commissioning

In order, each with its evidence in the pull request (details in
[docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)):

1. `infra-root` applied: buckets, locks, lifecycle. The seed has minted the runner tokens.
2. `infra` applied: queue, DLQ, registry KV. Put its `deploy_registry_namespace_id` output in
   `wrangler.jsonc`.
3. Create the `deployer` GitHub App (contents read, deployments write, checks write), land its key
   in Secrets Store as `DEPLOYER_GITHUB_APP_KEY`, set `GITHUB_APP_ID`. Set the R2 token ids.
4. Produce and review the trusted root for `release.verify` (see docs/RUNNER.md).
5. `npm run check:config`, then deploy through Workers Builds or the one-time bootstrap.
6. Apply the `infra` queue consumer (`deployer_deployed = true`).
7. Enroll an application: registry entry, `WORKER_<NAME>` token and binding, authorizer policy.

## Legacy

`src/`, `deployment/`, `templates/`, `scripts/enroll.py` and the matching tests are the previous
GitHub Actions runtime. The workflows under `.github/workflows/` still reference them, and those
workflows are owned elsewhere, so they stay until the cutover removes both together.
