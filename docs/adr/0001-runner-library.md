# ADR-0001: One private runner library for every privileged job

Status: proposed
Date: 2026-10-15
Scope: `packages/runner`, consumed by `deployer`, `infra-root`, `backup` and `signer`

## Context

Every privileged action in the control plane (OpenTofu plan and apply, Worker deploys, image promotion, state
passphrase generation, backup capture, commit signing) runs on Cloudflare in a container the owner controls, with
no public ingress, no credential in any envelope, queue, log or artifact, and an outcome that is reported rather
than assumed. Four Workers need the same mechanics. Building them four times is how the previous attempt failed.

Facts verified on 2026-10-15 against `@cloudflare/workers-types` 5.20261015.1 and the Containers documentation:

- The `durable_object` scheduling policy (beta) lets the Durable Object choose the image and instance size at
  `ctx.container.start({ image, instance, enableInternet })`. Images are named in the Wrangler configuration
  (`containers[].images.<name>`, a Dockerfile or a digest-pinned Cloudflare Registry reference) and surface as
  `ctx.container.images.<name>`. The class must use SQLite storage. Wrangler rejects `image`, `instance_type` and
  `max_instances` for this policy.
- `ctx.container.exec(argv, { env, stdin, stdout: 'pipe', stderr: 'pipe' })` returns a process with
  `stdin`, `stdout`, `stderr` streams, `exitCode` and `kill(signal)`. A `ReadableStream` can be handed in as stdin.
- `ctx.container.monitor()` settles when the container exits; `destroy()` stops it; `running` reports its state.
- With `enableInternet: false`, `interceptAllOutboundHttp(stub)` and `interceptOutboundHttps('*', stub)` route the
  container's port 80 and 443 traffic into a Worker entrypoint. Intercepted HTTPS is re-signed by a Cloudflare CA
  at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`, which the job's tools must trust.
- `ctx.exports.<Entrypoint>({ props })` yields a stub carrying props, so one entrypoint can serve one allowlist
  per job.
- Secrets Store bindings expose `get(): Promise<string>`; a container never has a binding of its own.

## Decision

1. **One library, pure core, thin adapter.** `JobController` depends on ports (`ContainerHandle`, `JobStore`,
   `Alarms`, `Clock`, `LogSink`, `SecretSource`, outbound factory) and never imports a Cloudflare module. It is
   tested under `node --test` with fakes and a `node:sqlite` adapter. `RunnerJob` (Durable Object) and
   `RunnerOutbound` (entrypoint) bind the ports to `ctx.container`, `ctx.storage.sql`, alarms, R2 and Secrets
   Store. Consumers subclass `RunnerJob` and supply their job types, secret bindings and outbound stub.
2. **The envelope carries intent, the job type carries capability.** An envelope names a `job_type` and
   `inputs`. Image, command, instance size, secret names, allowed hosts, timeout and log limit are static
   `JobTypeSpec` configuration in the consumer Worker, reviewed by PR. The envelope can never widen a job's
   reach, and no secret value exists anywhere but the process environment of the container.
3. **Envelope on stdin, secrets in the process environment.** The container starts with its image entrypoint
   (an idle init) and the job is `exec`ed with the canonical envelope JSON on stdin. Secrets resolved from
   Secrets Store go into that one process's environment together with the Cloudflare CA trust variables.
4. **Egress is deny by default.** Containers start with `enableInternet: false`; all HTTP and HTTPS is
   intercepted into `RunnerOutbound`, which allows exact hostnames over HTTPS on port 443 only and hands
   responses back untouched (a redirect is the job's problem, never followed on its behalf). Plain HTTP is refused.
5. **Lease, hard timeout, independent watchdog.** `run` writes a `running` record with
   `deadline = now + timeout + 30 s` and arms a Durable Object alarm before anything starts. At timeout the
   process gets SIGTERM, then SIGKILL after 5 s. If the controller instance is lost, the alarm settles the job.
6. **Cleanup before release, outcome exactly once.** Logs are captured with a per-stream cap (head and tail
   kept, everything counted, the pipe always drained), scrubbed of secret values, uploaded to the log sink,
   then the container is destroyed, then the record is settled. Whichever path settles first wins; the other
   returns the recorded outcome.
7. **Uncertain is a terminal state.** `exit_zero` and `exit_nonzero` are certain. `timeout` and `start_failed`
   are certain failures (the first was killed, the second never ran). `container_exited`, `controller_error`
   and `watchdog` are `uncertain`: the job may have acted. The runner never retries them; a human or the
   calling capability decides with the logs in hand.

## Consequences

- `deployer`, `infra-root`, `backup` and `signer` each become a job type registry plus job handlers.
- The container image must trust the Cloudflare CA file and run as non-root with an idle entrypoint; the job
  command reads its envelope from stdin and must write nothing secret to stdout or stderr (redaction is a
  backstop, not the control).
- The R2 `runner-logs` bucket with its 90-day lifecycle is an `infra-root` deliverable; until it exists the
  sink can be any `R2Bucket`.
- Open until the first live run (VERIFY): that `interceptOutboundHttps('*', …)` combined with
  `enableInternet: false` carries allowed traffic end to end for `git`, `tofu` and `wrangler` with the CA trust
  variables alone; the exact label grammar for `start({ labels })`; the behaviour of `monitor()` on a container
  that exits with a non-zero status (treated as "gone" either way).
