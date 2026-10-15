import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobController, PASSPHRASE_ENV } from '../../worker/runner/controller.ts';
import { planObjectKey } from '../../worker/runner/egress/rules.ts';
import {
  ACCOUNT,
  COMMIT,
  JOB_ID,
  NOW,
  OTHER_JOB_ID,
  PASSPHRASE,
  POLICY_COMMIT,
  RELEASE_BYTES,
  SECRETS,
  TREE,
  fakeGitHub,
  planSummary,
  releaseInput,
  request,
  terraformRequest,
} from './builders.ts';
import { FakeContainer, sha256 } from './fakes.ts';
import { harness, readStdin, resultDoc } from './harness.ts';

const planScript = async (call: { stdin: Uint8Array }) => {
  const { envelope } = await readStdin(call.stdin);
  return { stdout: resultDoc('succeeded', planSummary({ jobId: String(envelope['jobId']) })), stderr: 'tofu plan output\nAuthorization: Bearer leaked\n', exitCode: 0 };
};

function storePlan(plans: { putText(key: string, text: string): void }, summary = planSummary(), planBytes = 'ENCRYPTED-PLAN') {
  plans.putText(planObjectKey('infra', TREE, 'plan.tfplan'), planBytes);
  plans.putText(planObjectKey('infra', TREE, 'summary.json'), JSON.stringify({ ...summary, planSha256: sha256(planBytes) }));
}

test('submit records once; an identical resubmit returns status; a different request is job_conflict', async () => {
  const h = harness();
  const req = terraformRequest('terraform.plan');
  const first = await h.controller.submit(req);
  assert.equal(first.state, 'queued');
  assert.equal(first.jobId, JOB_ID);
  assert.deepEqual(h.storage.alarms, [h.clock.now()]);
  const again = await h.controller.submit(structuredClone(req));
  assert.deepEqual(again, first);
  assert.equal(h.storage.alarms.length, 1);
  await assert.rejects(h.controller.submit({ ...req, deadlineAt: req.deadlineAt + 60 }), { code: 'job_conflict' });
  // Resubmitting after the deadline still answers (time checks apply only to new jobs).
  h.clock.advance(2 * 60 * 60 * 1000);
  assert.equal((await h.controller.submit(req)).state, 'queued');
});

test('submit refuses invalid requests, other roles, misrouting and impossible deadlines', async () => {
  const h = harness();
  await assert.rejects(h.controller.submit({ ...terraformRequest('terraform.plan'), extra: 1 }), { code: 'invalid_job_request' });
  await assert.rejects(h.controller.submit(terraformRequest('root.plan')), { code: 'job_type_not_allowed' });
  await assert.rejects(harness({ role: 'root' }).controller.submit(terraformRequest('terraform.apply')), { code: 'job_type_not_allowed' });
  await assert.rejects(harness({ objectName: OTHER_JOB_ID }).controller.submit(terraformRequest('terraform.plan')), { code: 'job_misrouted' });
  await assert.rejects(h.controller.submit(terraformRequest('terraform.plan', { deadlineAt: NOW + 30 })), { code: 'invalid_job_request' });
  await assert.rejects(h.controller.submit(terraformRequest('terraform.plan', { deadlineAt: NOW + 3 * 3600 })), { code: 'invalid_job_request' });
  await assert.rejects(h.controller.submit(request('terraform.plan', { schema: 'terraform-subject/v1' })), { code: 'invalid_terraform_subject' });
  assert.equal(h.controller.status(), null);
});

test('plan runs end to end; no credential reaches the container except the state passphrase in exec env', async () => {
  const h = harness({ script: planScript });
  await h.controller.submit({ ...terraformRequest('terraform.plan'), notify: { application: 'infra', environment: 'production', deploymentId: OTHER_JOB_ID } });
  const status = await h.drive();
  assert.equal(status?.state, 'succeeded');
  assert.equal((status?.result as { addCount: number }).addCount, 1);
  assert.equal(status?.logKey, `jobs/terraform.plan/${JOB_ID}/stderr.log`);

  // Egress is configured before start, for every host, with the job's props.
  assert.deepEqual(h.container.intercepts.map((i) => [i.kind, i.addr]), [['https', '*'], ['http', '*']]);
  assert.deepEqual(h.gates, [{ jobId: JOB_ID, type: 'terraform.plan' }]);
  assert.deepEqual(h.container.starts, [{ image: h.container.images['runner'], instance: 'standard-1', enableInternet: false, env: {} }]);

  const call = h.lastCall();
  assert.ok(call);
  assert.equal(call.env[PASSPHRASE_ENV], PASSPHRASE);
  assert.equal(call.user, '10001');
  const everything = JSON.stringify({ starts: h.container.starts, env: { ...call.env, [PASSPHRASE_ENV]: null }, stdin: Buffer.from(call.stdin).toString('latin1') });
  for (const [name, value] of Object.entries(SECRETS)) assert.equal(everything.includes(value), false, `${name} leaked to the container`);

  const { envelope, files } = await readStdin(call.stdin);
  assert.equal(envelope['schema'], 'runner-job/v1');
  assert.deepEqual([...files.keys()], ['source.tar.gz', 'policy.tar.gz']);
  const input = envelope['input'] as Record<string, unknown>;
  assert.equal(input['policyCommit'], POLICY_COMMIT);
  assert.deepEqual(input['backend'], { bucket: 'tf-state', key: 'infra/terraform.tfstate', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com` });
  // GitHub: tarballs followed exactly one redirect to codeload, without our token.
  const codeload = h.github.seen.filter((s) => s.url.startsWith('https://codeload.github.com/'));
  assert.equal(codeload.length, 2);
  assert.ok(codeload.every((s) => s.authorization === null));

  // Logs are stored redacted; the container is gone; reporting and notify ran once.
  assert.match(h.logs.text(status?.logKey ?? '') ?? '', /Authorization: \[REDACTED\]/);
  assert.equal(h.container.running, false);
  assert.equal(h.reports.length, 1);
  assert.deepEqual(h.notifications, [{ notify: { application: 'infra', environment: 'production', deploymentId: OTHER_JOB_ID }, jobId: JOB_ID }]);
  assert.equal(h.storage.alarm, null);
});

test('release.verify streams staged files, gets no passphrase, and cross-checks the result', async () => {
  const input = releaseInput();
  const verified = {
    verified: true,
    subjects: [
      { name: 'release.zip', sha256: sha256(RELEASE_BYTES['release.zip']) },
      { name: 'release.manifest.json', sha256: sha256(RELEASE_BYTES['release.manifest.json']) },
    ],
    signerWorkflow: input['signerWorkflow'],
    sourceRepository: 'susanbeasles/ProsRUs',
    sourceDigest: COMMIT,
    sourceRef: 'refs/tags/v1.4.2',
    verifier: 'gh 2.74.0 attestation verify; trusted root sha256:' + 'a'.repeat(64),
  };
  const h = harness({ script: async () => ({ stdout: resultDoc('succeeded', verified), exitCode: 0 }) });
  for (const [name, bytes] of Object.entries(RELEASE_BYTES)) h.staging.objects.set(`staging/0199e7a0-0000-7000-8000-0000000000dd/${name}`, { bytes });
  await h.controller.submit(request('release.verify', input));
  const status = await h.drive();
  assert.equal(status?.state, 'succeeded');
  const call = h.lastCall();
  assert.equal(call?.env[PASSPHRASE_ENV], undefined);
  const { files } = await readStdin(call?.stdin ?? new Uint8Array());
  assert.deepEqual(Buffer.from(files.get('release.zip') ?? []), Buffer.from(RELEASE_BYTES['release.zip']));

  // A result naming another source commit is not trusted.
  const lying = harness({ script: async () => ({ stdout: resultDoc('succeeded', { ...verified, sourceDigest: 'b'.repeat(40) }), exitCode: 0 }) });
  for (const [name, bytes] of Object.entries(RELEASE_BYTES)) lying.staging.objects.set(`staging/0199e7a0-0000-7000-8000-0000000000dd/${name}`, { bytes });
  await lying.controller.submit(request('release.verify', input));
  assert.deepEqual((await lying.drive())?.error?.code, 'result_invalid');
});

test('release.verify: a staged file that changed is caught while streaming (staging_digest_mismatch)', async () => {
  const h = harness({ script: async () => ({ stdout: resultDoc('succeeded', {}), exitCode: 0 }) });
  const tampered = new Uint8Array(RELEASE_BYTES['release.zip']);
  tampered[10] = (tampered[10] ?? 0) ^ 0xff;
  h.staging.objects.set('staging/0199e7a0-0000-7000-8000-0000000000dd/release.zip', { bytes: tampered });
  h.staging.objects.set('staging/0199e7a0-0000-7000-8000-0000000000dd/release.manifest.json', { bytes: RELEASE_BYTES['release.manifest.json'] });
  h.staging.objects.set('staging/0199e7a0-0000-7000-8000-0000000000dd/attestation.sigstore.json', { bytes: RELEASE_BYTES['attestation.sigstore.json'] });
  await h.controller.submit(request('release.verify', releaseInput()));
  const status = await h.drive();
  assert.equal(status?.state, 'failed');
  assert.equal(status?.error?.code, 'staging_digest_mismatch');
  assert.equal(h.container.calls.length, 0, 'the agent never received a complete stdin');
  assert.equal(h.container.running, false);

  const wrongSize = harness();
  wrongSize.staging.objects.set('staging/0199e7a0-0000-7000-8000-0000000000dd/release.zip', { bytes: new Uint8Array(3) });
  await wrongSize.controller.submit(request('release.verify', releaseInput()));
  assert.equal((await wrongSize.drive())?.error?.code, 'staging_digest_mismatch');
  assert.equal(wrongSize.container.starts.length, 0);
});

test('watchdog: an overrunning plan fails, an overrunning apply is uncertain and locks the stack', async () => {
  const plan = harness({ script: async () => 'hang' });
  await plan.controller.submit(terraformRequest('terraform.plan'));
  await plan.controller.alarm();
  assert.equal(plan.controller.status()?.state, 'running');
  plan.clock.advance(31 * 60 * 1000);
  await plan.controller.alarm();
  const planStatus = plan.controller.status();
  assert.equal(planStatus?.state, 'failed');
  assert.equal(planStatus?.error?.code, 'deadline_exceeded');
  assert.equal(plan.container.running, false);
  assert.equal(plan.container.processes.at(-1)?.killed, true);

  const apply = harness({ script: async () => 'hang' });
  storePlan(apply.plans);
  await apply.controller.submit(terraformRequest('terraform.apply'));
  await apply.controller.alarm();
  apply.clock.advance(31 * 60 * 1000);
  await apply.controller.alarm();
  const applyStatus = apply.controller.status();
  assert.equal(applyStatus?.state, 'uncertain');
  assert.equal(applyStatus?.error?.code, 'deadline_exceeded');
  const lock = JSON.parse(apply.plans.text('locks/infra.json') ?? '{}');
  assert.equal(lock.schema, 'stack-lock/v1');
  assert.equal(lock.jobId, JOB_ID);
  assert.equal(lock.reason, 'deadline_exceeded');

  // The next apply on the stack is refused before any container starts.
  const next = harness({ plans: apply.plans, objectName: OTHER_JOB_ID, script: async () => ({ stdout: '', exitCode: 0 }) });
  await next.controller.submit({ ...terraformRequest('terraform.apply'), jobId: OTHER_JOB_ID });
  const refused = await next.drive();
  assert.equal(refused?.state, 'failed');
  assert.equal(refused?.error?.code, 'stack_locked_uncertain');
  assert.equal(next.container.starts.length, 0);
});

test('a failed agent exit is failed for plans and uncertain (with a stack lock) for applies', async () => {
  const plan = harness({ script: async () => ({ stdout: '', exitCode: 3 }) });
  await plan.controller.submit(terraformRequest('terraform.plan'));
  assert.equal((await plan.drive())?.state, 'failed');

  const apply = harness({ script: async () => ({ stdout: resultDoc('uncertain', null, { code: 'apply_failed', message: 'tofu apply exited with 1' }), exitCode: 0 }) });
  storePlan(apply.plans);
  await apply.controller.submit(terraformRequest('terraform.apply'));
  const status = await apply.drive();
  assert.equal(status?.state, 'uncertain');
  assert.equal(status?.error?.code, 'apply_failed');
  assert.ok(apply.plans.text('locks/infra.json'));

  const refusedBeforeMutation = harness({ script: async () => ({ stdout: resultDoc('failed', null, { code: 'state_serial_changed', message: 'serial 8, plan 7' }), exitCode: 0 }) });
  storePlan(refusedBeforeMutation.plans);
  await refusedBeforeMutation.controller.submit(terraformRequest('terraform.apply'));
  assert.equal((await refusedBeforeMutation.drive())?.error?.code, 'state_serial_changed');
  assert.equal(refusedBeforeMutation.plans.text('locks/infra.json'), null);

  const otherJob = harness({ script: async () => ({ stdout: resultDoc('succeeded', {}, null, OTHER_JOB_ID), exitCode: 0 }) });
  storePlan(otherJob.plans);
  await otherJob.controller.submit(terraformRequest('terraform.apply'));
  const st = await otherJob.drive();
  assert.equal(st?.state, 'uncertain');
  assert.equal(st?.error?.code, 'result_invalid');
});

test('cleanup that cannot be confirmed keeps the job non-terminal and retries', async () => {
  const h = harness({ script: planScript });
  h.container.stuck = true;
  await h.controller.submit(terraformRequest('terraform.plan'));
  await h.drive(4);
  const record = h.storage.kv.get('job') as { phase: string; cleanupAttempts: number; outcome: { state: string } };
  assert.equal(record.phase, 'cleanup');
  assert.equal(record.outcome.state, 'succeeded');
  assert.ok(record.cleanupAttempts >= 1);
  assert.equal(h.controller.status()?.state, 'running', 'not terminal until the container is confirmed gone');
  assert.ok((h.storage.alarm ?? 0) > h.clock.now());
  assert.equal(h.reports.length, 0);
  h.container.stuck = false;
  const status = await h.drive();
  assert.equal(status?.state, 'succeeded');
  assert.equal(h.reports.length, 1);
});

test('a restarted object with a running job ends it: failed for plans, uncertain for applies', async () => {
  for (const [type, expected] of [['terraform.plan', 'failed'], ['terraform.apply', 'uncertain']] as const) {
    const h = harness({ script: async () => 'hang' });
    if (type === 'terraform.apply') storePlan(h.plans);
    await h.controller.submit(terraformRequest(type));
    await h.controller.alarm();
    assert.equal((h.storage.kv.get('job') as { phase: string }).phase, 'running');
    // Same storage and container, new isolate: the in-memory exec is gone.
    const restarted = new JobController({ ...h.deps });
    await restarted.alarm();
    const status = restarted.status();
    assert.equal(status?.state, expected, type);
    assert.equal(status?.error?.code, 'execution_lost');
    assert.equal(h.container.running, false);
  }
});

test('apply binding refusals happen before any container exists', async () => {
  const missing = harness();
  await missing.controller.submit(terraformRequest('terraform.apply'));
  assert.equal((await missing.drive())?.error?.code, 'plan_missing');

  const tampered = harness();
  storePlan(tampered.plans);
  tampered.plans.putText(planObjectKey('infra', TREE, 'plan.tfplan'), 'SWAPPED-PLAN');
  await tampered.controller.submit(terraformRequest('terraform.apply'));
  assert.equal((await tampered.drive())?.error?.code, 'plan_digest_mismatch');

  const wrongTree = harness({ github: fakeGitHub({ trees: { [COMMIT]: '9'.repeat(40) } }) });
  storePlan(wrongTree.plans);
  await wrongTree.controller.submit(terraformRequest('terraform.apply'));
  assert.equal((await wrongTree.drive())?.error?.code, 'tree_mismatch');

  const policyFailed = harness();
  storePlan(policyFailed.plans, planSummary({ policyPassed: false, policy: [{ rule: 'P1', result: 'fail', messages: ['P1: deletes a protected bucket'] }] }));
  await policyFailed.controller.submit(terraformRequest('terraform.apply'));
  assert.equal((await policyFailed.drive())?.error?.code, 'plan_policy_failed');

  for (const h of [missing, tampered, wrongTree, policyFailed]) assert.equal(h.container.starts.length, 0);
});

test('a complete stored plan for the tree is reported again without running; debris needs a human', async () => {
  const reuse = harness();
  storePlan(reuse.plans);
  await reuse.controller.submit(terraformRequest('terraform.plan'));
  const status = await reuse.drive();
  assert.equal(status?.state, 'succeeded');
  assert.equal(reuse.container.starts.length, 0);
  assert.equal(reuse.reports.length, 1);

  const debris = harness();
  debris.plans.putText(planObjectKey('infra', TREE, 'plan.tfplan'), 'PARTIAL');
  await debris.controller.submit(terraformRequest('terraform.plan'));
  assert.equal((await debris.drive())?.error?.code, 'plan_incomplete');
});

test('notification and reporting failures never change the outcome', async () => {
  const h = harness({
    script: planScript,
    notify: async () => {
      throw new Error('coordinator unavailable');
    },
  });
  await h.controller.submit({ ...terraformRequest('terraform.plan'), notify: { application: 'infra', environment: 'production', deploymentId: OTHER_JOB_ID } });
  assert.equal((await h.drive())?.state, 'succeeded');
  const record = h.storage.kv.get('job') as { notified: boolean };
  assert.equal(record.notified, true);
});

test('container start failures end the job failed, never uncertain', async () => {
  const h = harness({ container: new FakeContainer(async () => ({ stdout: '', exitCode: 0 })) });
  h.container.probeFailures = 1000;
  storePlan(h.plans);
  await h.controller.submit(terraformRequest('terraform.apply'));
  const status = await h.drive();
  assert.equal(status?.state, 'failed');
  assert.equal(status?.error?.code, 'container_not_ready');
  assert.equal(h.plans.text('locks/infra.json'), null);
});
