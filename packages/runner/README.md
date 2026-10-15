# runner

The private runner: a controller Durable Object that runs one job in one Cloudflare Container and reports what
happened. Used by `deployer`, `infra-root`, `backup` and `signer`. Design: `docs/adr/0001-runner-library.md`.

## What it does

- Accepts a job envelope (`v`, `job_id`, `job_type`, `idempotency_key`, `inputs`, `requested_by`, `created_at`),
  parsed with a fatal, bounded parser. Every refusal has a stable code.
- Looks the `job_type` up in the Worker's static registry: image, instance, command, secret names, allowed
  hosts, timeout, log limit. Unknown types are refused.
- Writes a lease and arms an alarm, starts the container closed (`enableInternet: false`), routes its egress
  through the allowlist gate, runs the command with the envelope on stdin and the secrets in its environment.
- Captures stdout and stderr up to the limit, scrubs secret values, uploads them and `outcome.json` to the log
  bucket under `logs/<job_type>/<job_id>/`, destroys the container, then records the outcome once.
- Settles a job whose controller was lost as `uncertain` from the alarm. Nothing is retried automatically.

## What it does not do

- Decide anything. The authorizer decides; the runner executes what it is handed.
- Carry credentials in the envelope, in logs or in outcome records.
- Expose a route. The Durable Object is reached only through a binding, the container only through the object.

## Consumer wiring

```ts
import { RunnerJob, RunnerOutbound, SecretsStoreSource } from '@susanbeasles/runner/durable-object';
import { JobTypeRegistry } from '@susanbeasles/runner';

export class Outbound extends RunnerOutbound<Env> {}

export class DeployerJob extends RunnerJob<Env> {
  protected jobTypes() {
    return new JobTypeRegistry([
      { name: 'terraform.plan', image: 'deployer', instance: 'standard-1', command: ['/usr/local/bin/runner-job'],
        secrets: ['CF_PLAN', 'R2_STATE_RO'], allowedHosts: ['api.cloudflare.com', '<account>.r2.cloudflarestorage.com'],
        timeoutMs: 20 * 60_000, maxLogBytes: 8 * 1024 * 1024 },
    ]);
  }
  protected secrets() {
    return new SecretsStoreSource({ CF_PLAN: this.env.CF_PLAN, R2_STATE_RO: this.env.R2_STATE_RO });
  }
  protected outbound(allowedHosts: readonly string[]) {
    return this.ctx.exports.Outbound({ props: { allowedHosts } });
  }
}
```

Wrangler: `containers[].scheduling_policy = "durable_object"` with a named `images.deployer` entry,
`exports.DeployerJob = { type: "durable-object", storage: "sqlite" }`, an R2 binding `RUNNER_LOGS`, one
`secrets_store_secrets` binding per secret name, `workers_dev = false`, no routes.

The container image: non-root, an idle entrypoint (the job is `exec`ed), the Cloudflare containers CA trusted
through the environment the runner sets (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`,
`NODE_EXTRA_CA_CERTS`), and a job command that reads one JSON envelope from stdin, exits 0 only on success and
prints nothing secret.

## Outcome

`status` is `succeeded`, `failed` or `uncertain`; `reason` says why (`exit_zero`, `exit_nonzero`, `timeout`,
`start_failed`, `container_exited`, `controller_error`, `watchdog`). `uncertain` means the controller cannot
say whether the job's side effects happened. Those jobs are left for a human with their logs.

## Where results are seen

In the consumer's R2 log bucket under `logs/<job_type>/<job_id>/{stdout.log,stderr.log,outcome.json}` and in
the Durable Object's own SQLite record, returned by a repeated `run` with the same envelope.

## Develop

```
npm ci --ignore-scripts
npm run check        # tsc strict (src with workers-types, tests with node types) + node --test
```

No runtime dependencies. Node 22.18 or later (type stripping); the Workers code is bundled by Wrangler.

Nothing here is activated: no Worker has been deployed from this package yet.
