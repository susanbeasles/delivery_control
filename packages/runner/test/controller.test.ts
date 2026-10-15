import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTAINER_TRUST_ENV, TIMING } from '../src/controller.ts';
import { parseEnvelope, serializeEnvelope, sha256Hex } from '../src/envelope.ts';
import type { Outcome } from '../src/records.ts';
import { FakeProcess, decoder, encoder, settle } from './fakes.ts';
import { JOB_ID, SECRET_VALUE, envelopeBytes, harness, logKey, planSpec } from './helpers.ts';

function done(result: Awaited<ReturnType<ReturnType<typeof harness>['controller']['run']>>): Outcome {
  assert.equal(result.kind, 'done', JSON.stringify(result));
  if (result.kind !== 'done') throw new Error('unreachable');
  return result.outcome;
}

test('happy path: lease, egress gate, envelope on stdin, secrets in env, logs in the sink, container destroyed, outcome recorded', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  const exec = h.container.execs[0];
  assert.ok(exec, 'job was executed');
  // lease and watchdog armed before anything ran
  assert.equal(h.store.record?.state, 'running');
  assert.equal(h.alarms.at, h.clock.now() + planSpec.timeoutMs + TIMING.deadlineGraceMs);
  // container started closed, with the named image resolved and the job labelled
  assert.deepEqual(h.container.starts, [{ image: h.container.images['deployer'], instance: 'standard-1', enableInternet: false, labels: { job_id: JOB_ID, job_type: 'terraform.plan' } }]);
  // both egress interceptions registered before exec, carrying the job type's allowlist
  assert.deepEqual(h.container.intercepts.map((i) => [i.kind, i.address]), [['http', null], ['https', '*']]);
  assert.deepEqual(h.outbounds.map((o) => [o.allowedHosts, o.jobId]), [[planSpec.allowedHosts, JOB_ID]]);
  // envelope delivered on stdin, canonical, no secrets inside
  assert.deepEqual(exec.command, planSpec.command);
  const stdin = decoder.decode(exec.process.stdinBytes);
  assert.equal(stdin, decoder.decode(serializeEnvelope(parseEnvelope(envelopeBytes()))));
  assert.ok(!stdin.includes(SECRET_VALUE));
  assert.deepEqual(exec.options.env, { ...CONTAINER_TRUST_ENV, CF_PLAN: SECRET_VALUE, RUNNER_JOB_ID: JOB_ID, RUNNER_JOB_TYPE: 'terraform.plan', RUNNER_ATTEMPT: '1' });
  exec.process.out('planning\n');
  exec.process.err('warn\n');
  await h.clock.advance(2_000);
  exec.process.exit(0);
  const outcome = done(await run);
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.reason, 'exit_zero');
  assert.equal(outcome.exit_code, 0);
  assert.equal(outcome.duration_ms, 2_000);
  assert.deepEqual(outcome.logs, { stdout: { key: logKey('stdout.log'), bytes: 9, truncated: false }, stderr: { key: logKey('stderr.log'), bytes: 5, truncated: false } });
  assert.deepEqual(outcome.artifacts, []);
  assert.equal(h.sink.text(logKey('stdout.log')), 'planning\n');
  assert.deepEqual(h.sink.json(logKey('outcome.json')), outcome);
  assert.equal(h.sink.objects.get(logKey('outcome.json'))?.contentType, 'application/json');
  assert.equal(h.container.destroys, 1);
  assert.equal(h.container.running, false);
  assert.equal(h.store.record?.state, 'done');
  assert.deepEqual(h.store.record?.outcome, outcome);
  assert.deepEqual(h.alarms.calls.at(-1), 'clear');
  assert.equal(h.alarms.at, null);
  assert.deepEqual(h.events, []);
});

test('non-zero exit is a certain failure with the exit code', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.execs[0]?.process.exit(3);
  const outcome = done(await run);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'exit_nonzero');
  assert.equal(outcome.exit_code, 3);
  assert.equal(h.container.destroys, 1);
});

test('timeout: SIGTERM, then SIGKILL after the grace, failed/timeout, container destroyed', async () => {
  const h = harness();
  h.container.nextProcess = () => new FakeProcess('ignore');
  const run = h.controller.run(envelopeBytes());
  await h.started();
  const proc = h.container.execs[0]?.process;
  assert.ok(proc);
  await h.clock.advance(planSpec.timeoutMs - 1);
  assert.deepEqual(proc.signals, []);
  await h.clock.advance(1);
  assert.deepEqual(proc.signals, [15]);
  await h.clock.advance(TIMING.killGraceMs);
  assert.deepEqual(proc.signals, [15, 9]);
  proc.closeStreams();
  const outcome = done(await run);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.reason, 'timeout');
  assert.equal(outcome.exit_code, null);
  assert.match(outcome.notes.join('\n'), /killed after 60000 ms/);
  assert.equal(h.container.destroys, 1);
});

test('timeout where SIGTERM is honoured still records failed/timeout and skips nothing', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  await h.clock.advance(planSpec.timeoutMs);
  const outcome = done(await run);
  assert.equal(outcome.reason, 'timeout');
  assert.deepEqual(h.container.execs[0]?.process.signals, [15, 9]);
});

test('the container dying under the job is uncertain, not retried', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.die();
  const outcome = done(await run);
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.reason, 'container_exited');
  assert.equal(h.container.destroys, 0);
  assert.equal(h.container.execs.length, 1);
  assert.equal(h.store.record?.state, 'done');
});

test('an error after the job started is uncertain; before it started is a certain start failure', async () => {
  const lost = harness();
  const run = lost.controller.run(envelopeBytes());
  await lost.started();
  lost.container.execs[0]?.process.failExit();
  const uncertain = done(await run);
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.reason, 'controller_error');
  assert.match(uncertain.notes.join('\n'), /exit status lost/);

  const refused = harness();
  refused.container.failStart = new Error('no capacity');
  const failed = done(await refused.controller.run(envelopeBytes()));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'start_failed');
  assert.match(failed.notes.join('\n'), /starting: Error: no capacity/);
  assert.deepEqual(failed.logs, { stdout: null, stderr: null });
  assert.equal(refused.container.execs.length, 0);
  assert.deepEqual(refused.sink.json(logKey('outcome.json')), failed);

  const noImage = harness({ ...planSpec, image: 'missing' });
  const missing = done(await noImage.controller.run(envelopeBytes()));
  assert.equal(missing.reason, 'start_failed');
  assert.match(missing.notes.join('\n'), /image "missing" is not configured/);
  assert.equal(noImage.container.starts.length, 0);

  const noSecret = harness(planSpec, {});
  const unresolved = done(await noSecret.controller.run(envelopeBytes()));
  assert.equal(unresolved.reason, 'start_failed');
  assert.equal(noSecret.container.starts.length, 0);
  assert.ok(!JSON.stringify(unresolved).includes(SECRET_VALUE));
});

test('secret values never appear in logs, notes or the outcome', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  const proc = h.container.execs[0]?.process;
  assert.ok(proc);
  proc.out(`token is ${SECRET_VALUE} and again ${SECRET_VALUE}\n`);
  proc.err(`${SECRET_VALUE}\n`);
  proc.exit(1);
  const outcome = done(await run);
  assert.equal(h.sink.text(logKey('stdout.log')), 'token is [redacted:CF_PLAN] and again [redacted:CF_PLAN]\n');
  assert.equal(h.sink.text(logKey('stderr.log')), '[redacted:CF_PLAN]\n');
  for (const object of h.sink.objects.values()) assert.ok(!decoder.decode(object.body).includes(SECRET_VALUE));
  assert.ok(!JSON.stringify(outcome).includes(SECRET_VALUE));
  assert.ok(!JSON.stringify(h.store.record).includes(SECRET_VALUE));
});

test('logs are bounded by the job type limit and marked truncated', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  const proc = h.container.execs[0]?.process;
  assert.ok(proc);
  proc.outBytes(new Uint8Array(100_000).fill(0x61));
  proc.exit(0);
  const outcome = done(await run);
  assert.equal(outcome.logs.stdout?.truncated, true);
  assert.ok((outcome.logs.stdout?.bytes ?? Infinity) < planSpec.maxLogBytes + 128);
  assert.match(h.sink.text(logKey('stdout.log')), /\[runner: 91808 bytes omitted\]/);
});

test('log capture is cut off after the grace period when a stream never closes', async () => {
  const h = harness();
  const proc = new FakeProcess('ignore');
  h.container.nextProcess = () => proc;
  const run = h.controller.run(envelopeBytes());
  await h.started();
  proc.out('partial');
  proc.exitWithoutClosing(0);
  await settle(200);
  assert.equal(h.store.record?.state, 'running', 'still waiting on the pipes');
  await h.clock.advance(TIMING.captureGraceMs);
  const outcome = done(await run);
  assert.equal(outcome.status, 'succeeded');
  assert.match(h.sink.text(logKey('stdout.log')), /^partial\n\[runner: capture stopped/);
});

test('a failed log upload is noted and reported, the job still settles and the container is destroyed', async () => {
  const h = harness();
  h.sink.failKeys.add('stderr.log');
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.execs[0]?.process.exit(0);
  const outcome = done(await run);
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.logs.stderr, null);
  assert.ok(outcome.logs.stdout);
  assert.match(outcome.notes.join('\n'), /stderr upload failed/);
  assert.deepEqual(h.events.map((e) => e.stage), ['log_upload']);
  assert.equal(h.container.destroys, 1);
});

test('a failing destroy or alarm clear is survived and observed', async () => {
  const h = harness();
  h.container.failDestroy = new Error('runtime busy');
  h.alarms.failClear = true;
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.execs[0]?.process.exit(0);
  const outcome = done(await run);
  assert.equal(outcome.status, 'succeeded');
  assert.match(outcome.notes.join('\n'), /destroy failed: Error: runtime busy/);
  assert.deepEqual(h.events.map((e) => e.stage), ['destroy', 'alarm']);
  assert.equal(h.store.record?.state, 'done');
});

test('resubmission: running returns the lease, done returns the recorded outcome, a changed envelope is rejected', async () => {
  const h = harness();
  const first = h.controller.run(envelopeBytes());
  await h.started();
  const again = await h.controller.run(envelopeBytes());
  assert.deepEqual(again, { kind: 'running', job_id: JOB_ID, deadline_at: h.store.record?.deadline_at });
  const changed = await h.controller.run(envelopeBytes({ inputs: { repo: 'other' } }));
  assert.deepEqual(changed, { kind: 'rejected', code: 'envelope_mismatch' });
  h.container.execs[0]?.process.exit(0);
  const outcome = done(await first);
  const after = await h.controller.run(envelopeBytes());
  assert.deepEqual(after, { kind: 'done', outcome });
  assert.equal(h.container.starts.length, 1, 'no second container');
  assert.equal(h.store.puts, 2);
});

test('invalid envelopes and unknown job types are rejected with their code and start nothing', async () => {
  const h = harness();
  assert.deepEqual(await h.controller.run(new Uint8Array([0x7b, 0xff])), { kind: 'rejected', code: 'bad_encoding' });
  assert.deepEqual(await h.controller.run(envelopeBytes({ job_type: 'terraform.destroy' })), { kind: 'rejected', code: 'unknown_job_type' });
  assert.equal(h.store.record, undefined);
  assert.equal(h.container.starts.length, 0);
  assert.deepEqual(h.alarms.calls, []);
});

test('watchdog: re-arms before the deadline, settles an expired lease as uncertain and destroys a live container', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  const deadline = h.store.record?.deadline_at;
  assert.ok(deadline);
  await h.controller.watchdog();
  assert.deepEqual(h.alarms.calls, [`set:${deadline}`, `set:${deadline}`]);
  assert.equal(h.store.record?.state, 'running');
  // Simulate the controller losing its in-flight promise: time passes past the deadline with no outcome.
  // (The in-flight run is still pending in this process; it will observe the settled store.)
  h.clock.now = () => deadline + 1;
  await h.controller.watchdog();
  const record = h.store.record;
  assert.equal(record?.state, 'done');
  assert.equal(record?.outcome?.status, 'uncertain');
  assert.equal(record?.outcome?.reason, 'watchdog');
  assert.equal(h.container.destroys, 1);
  assert.deepEqual(h.sink.json(logKey('outcome.json')), record?.outcome);
  assert.equal(h.alarms.at, null);
  // The late in-flight run now completes; the watchdog's outcome stands and is not overwritten.
  h.container.execs[0]?.process.exit(0);
  const late = done(await run);
  assert.equal(late.reason, 'watchdog');
  assert.equal(h.store.record?.outcome?.reason, 'watchdog');
  assert.equal(h.store.puts, 2);
});

test('watchdog does nothing without a job or after completion', async () => {
  const h = harness();
  await h.controller.watchdog();
  assert.deepEqual(h.alarms.calls, []);
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.execs[0]?.process.exit(0);
  await run;
  const calls = h.alarms.calls.length;
  await h.controller.watchdog();
  assert.equal(h.alarms.calls.length, calls);
});

test('a resubmission after the lease expired settles the lost job instead of running it again', async () => {
  const h = harness();
  h.store.put({ job_id: JOB_ID, job_type: 'terraform.plan', idempotency_key: 'c'.repeat(64), envelope_digest: 'stale', state: 'running', attempt: 1, started_at: 0, deadline_at: 1, outcome: null });
  const mismatch = await h.controller.run(envelopeBytes());
  assert.deepEqual(mismatch, { kind: 'rejected', code: 'envelope_mismatch' });
  const digest = (await (async () => {
    const { envelopeDigest } = await import('../src/envelope.ts');
    return envelopeDigest(parseEnvelope(envelopeBytes()));
  })());
  h.store.put({ ...h.store.record!, envelope_digest: digest });
  h.container.running = true;
  const outcome = done(await h.controller.run(envelopeBytes()));
  assert.equal(outcome.status, 'uncertain');
  assert.equal(outcome.reason, 'watchdog');
  assert.equal(h.container.starts.length, 0);
  assert.equal(h.container.destroys, 1);
});

const artifactSpec = { ...planSpec, artifacts: { dir: '/job/out', maxBytes: 1_000, maxFiles: 3 } };

test('artifacts: the job output directory is collected, hashed and stored before the container is destroyed', async () => {
  const h = harness(artifactSpec);
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.files.set('/job/out/plan.json', encoder.encode('{"a":1}'));
  h.container.files.set('/job/out/nested/state-serial.txt', encoder.encode('42\n'));
  h.container.files.set('/elsewhere/not-collected', encoder.encode('x'));
  h.container.execs[0]?.process.exit(0);
  const outcome = done(await run);
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(
    outcome.artifacts.map((a) => [a.path, a.key, a.bytes]),
    [
      ['nested/state-serial.txt', logKey('artifacts/nested/state-serial.txt'), 3],
      ['plan.json', logKey('artifacts/plan.json'), 7],
    ],
  );
  assert.equal(outcome.artifacts[1]?.sha256, await sha256Hex(encoder.encode('{"a":1}')));
  assert.equal(h.sink.text(logKey('artifacts/plan.json')), '{"a":1}');
  assert.equal(h.sink.objects.get(logKey('artifacts/plan.json'))?.contentType, 'application/octet-stream');
  assert.equal(h.container.destroys, 1);
  assert.deepEqual(h.sink.json(logKey('outcome.json')), outcome);
});

test('artifacts: a file over the remaining budget is skipped and noted; later files still collect', async () => {
  const h = harness(artifactSpec);
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.files.set('/job/out/a-big.bin', new Uint8Array(1_001));
  h.container.files.set('/job/out/b-small.txt', encoder.encode('ok'));
  h.container.execs[0]?.process.exit(0);
  const outcome = done(await run);
  assert.deepEqual(outcome.artifacts.map((a) => a.path), ['b-small.txt']);
  assert.match(outcome.notes.join('\n'), /a-big.bin \(1001 bytes\) exceeds the remaining budget of 1000 bytes/);
});

test('artifacts: the file count is capped and noted, unsafe paths and unreadable files are skipped', async () => {
  const h = harness({ ...artifactSpec, artifacts: { dir: '/job/out', maxBytes: 1_000, maxFiles: 4 } });
  const run = h.controller.run(envelopeBytes());
  await h.started();
  for (const name of ['1', '2', '3', '4']) h.container.files.set(`/job/out/${name}`, encoder.encode(name));
  h.container.files.set('/job/out/../escape', encoder.encode('x'));
  h.container.unreadable.add('/job/out/2');
  h.container.execs[0]?.process.exit(1);
  const outcome = done(await run);
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(outcome.artifacts.map((a) => a.path), ['1', '3']);
  const notes = outcome.notes.join('\n');
  assert.match(notes, /1 artifact files beyond the limit of 4 were not collected/);
  assert.match(notes, /unsafe path/);
  assert.match(notes, /2 could not be read/);
});

test('artifacts: nothing is collected when the container died or the listing fails', async () => {
  const died = harness(artifactSpec);
  const run1 = died.controller.run(envelopeBytes());
  await died.started();
  died.container.files.set('/job/out/x', encoder.encode('x'));
  died.container.die();
  assert.deepEqual(done(await run1).artifacts, []);

  const broken = harness(artifactSpec);
  broken.container.failFind = true;
  const run2 = broken.controller.run(envelopeBytes());
  await broken.started();
  broken.container.execs[0]?.process.exit(0);
  const outcome = done(await run2);
  assert.deepEqual(outcome.artifacts, []);
  assert.match(outcome.notes.join('\n'), /artifact listing failed/);
});

test('secrets are resolved with the envelope so a source can scope a minted credential to the job', async () => {
  const h = harness();
  const run = h.controller.run(envelopeBytes());
  await h.started();
  h.container.execs[0]?.process.exit(0);
  await run;
  assert.deepEqual(h.secrets.requests, [{ name: 'CF_PLAN', job_id: JOB_ID }]);
});

const stageSpec = { ...planSpec, stage: { dir: '/job/in', maxBytes: 100, maxFiles: 2 } };

test('stage: consumer-provided files are written into the container before the job runs', async () => {
  const h = harness(stageSpec, { CF_PLAN: SECRET_VALUE }, [
    { path: 'plan.tfplan', bytes: encoder.encode('binary-plan') },
    { path: 'meta/summary.json', bytes: encoder.encode('{}') },
  ]);
  const run = h.controller.run(envelopeBytes());
  await h.started();
  assert.deepEqual(h.container.staged, ['/job/in/plan.tfplan', '/job/in/meta/summary.json']);
  assert.equal(decoder.decode(h.container.files.get('/job/in/plan.tfplan')), 'binary-plan');
  h.container.execs[0]?.process.exit(0);
  const outcome = done(await run);
  assert.equal(outcome.status, 'succeeded');
  assert.match(outcome.notes.join('\n'), /staged 2 file\(s\) under \/job\/in/);
});

test('stage: unsafe paths, too many files, over-budget files and write failures are start failures', async () => {
  for (const [files, pattern] of [
    [[{ path: '../etc/passwd', bytes: new Uint8Array(1) }], /unsafe or duplicate path/],
    [[{ path: 'a', bytes: new Uint8Array(1) }, { path: 'a', bytes: new Uint8Array(1) }], /unsafe or duplicate path/],
    [[{ path: 'a', bytes: new Uint8Array(1) }, { path: 'b', bytes: new Uint8Array(1) }, { path: 'c', bytes: new Uint8Array(1) }], /exceed the limit of 2/],
    [[{ path: 'big', bytes: new Uint8Array(101) }], /exceed the budget of 100 bytes/],
  ] as const) {
    const h = harness(stageSpec, { CF_PLAN: SECRET_VALUE }, [...files]);
    const outcome = done(await h.controller.run(envelopeBytes()));
    assert.equal(outcome.reason, 'start_failed', pattern.source);
    assert.match(outcome.notes.join('\n'), pattern);
    assert.equal(h.container.execs.length, 0, 'job never ran');
    assert.equal(h.container.destroys, 1, 'container cleaned up');
  }
  const h = harness(stageSpec, { CF_PLAN: SECRET_VALUE }, [{ path: 'x', bytes: new Uint8Array(1) }]);
  h.container.failStagePaths.add('/job/in/x');
  const outcome = done(await h.controller.run(envelopeBytes()));
  assert.equal(outcome.reason, 'start_failed');
  assert.match(outcome.notes.join('\n'), /writing x exited 1/);
});

test('stage: a job type without a stage directory never calls the stager', async () => {
  const h = harness(planSpec, { CF_PLAN: SECRET_VALUE }, [{ path: 'ignored', bytes: new Uint8Array(1) }]);
  const run = h.controller.run(envelopeBytes());
  await h.started();
  assert.deepEqual(h.container.staged, []);
  h.container.execs[0]?.process.exit(0);
  await run;
});
