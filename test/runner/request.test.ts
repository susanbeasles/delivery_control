import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDeadline, parseJobRequest, parseReleaseVerifyInput } from '../../worker/runner/request.ts';
import { parseTerraformSubject } from '../../worker/runner/subject.ts';
import { parsePlanSummary } from '../../worker/runner/plan-summary.ts';
import { NOW, NOW_MS, planSummary, releaseInput, request, subject, terraformRequest } from './builders.ts';

test('terraform-subject/v1 is validated fatally and bound to the stack repository and operation', () => {
  assert.equal(parseTerraformSubject(subject('plan'), { stack: 'infra', operation: 'plan' }).headSha, 'd'.repeat(40));
  const absentOptionals = subject('apply') as Record<string, unknown>;
  delete absentOptionals['pullRequest'];
  delete absentOptionals['headSha'];
  assert.equal(parseTerraformSubject(absentOptionals, { stack: 'infra', operation: 'apply' }).pullRequest, null);
  const bad: Array<[Record<string, unknown>, { stack: 'infra' | 'infra-root'; operation: 'plan' | 'apply' }]> = [
    [subject('plan'), { stack: 'infra', operation: 'apply' }],
    [subject('plan', 'infra-root'), { stack: 'infra', operation: 'plan' }],
    [subject('plan', 'infra', { repository: 'susanbeasles/infra-root' }), { stack: 'infra', operation: 'plan' }],
    [subject('plan', 'infra', { repositoryId: 1 }), { stack: 'infra', operation: 'plan' }],
    [subject('plan', 'infra', { treeSha: 'XYZ' }), { stack: 'infra', operation: 'plan' }],
    [subject('plan', 'infra', { token: 'x' }), { stack: 'infra', operation: 'plan' }],
    [subject('plan', 'infra', { schema: 'terraform-subject/v2' }), { stack: 'infra', operation: 'plan' }],
    [subject('plan', 'infra', { requestedBy: { actorId: 1 } }), { stack: 'infra', operation: 'plan' }],
  ];
  for (const [value, expected] of bad) assert.throws(() => parseTerraformSubject(value, expected), { code: 'invalid_terraform_subject' });
});

test('job requests: exact shape, role, notify and deadline window', () => {
  assert.equal(parseJobRequest(terraformRequest('terraform.plan'), 'deployer').type, 'terraform.plan');
  assert.equal(parseJobRequest(terraformRequest('root.apply'), 'root').type, 'root.apply');
  assert.throws(() => parseJobRequest(terraformRequest('root.apply'), 'deployer'), { code: 'job_type_not_allowed' });
  assert.throws(() => parseJobRequest(terraformRequest('release.verify' as never), 'root'), { code: 'job_type_not_allowed' });
  assert.throws(() => parseJobRequest({ ...terraformRequest('terraform.plan'), jobId: '0199e7a0-0000-4000-8000-000000000001' }, 'deployer'), { code: 'invalid_job_request' });
  assert.throws(
    () => parseJobRequest({ ...terraformRequest('root.plan'), notify: { application: 'a1', environment: 'e1', deploymentId: '0199e7a0-0000-7000-8000-000000000001' } }, 'root'),
    { code: 'invalid_job_request' },
  );
  assert.doesNotThrow(() => checkDeadline(terraformRequest('terraform.plan', { deadlineAt: NOW + 600 }), NOW_MS));
  assert.throws(() => checkDeadline(terraformRequest('terraform.plan', { deadlineAt: NOW + 60 }), NOW_MS), { code: 'invalid_job_request' });
  assert.throws(() => checkDeadline(terraformRequest('terraform.plan', { deadlineAt: NOW + 101 * 60 }), NOW_MS), { code: 'invalid_job_request' });
});

test('release.verify input: three named staged files with bounded sizes, keys matching names', () => {
  const parsed = parseReleaseVerifyInput(releaseInput());
  assert.deepEqual(parsed.files.map((f) => f.name), ['release.zip', 'release.manifest.json', 'attestation.sigstore.json']);
  const files = releaseInput()['files'] as Array<Record<string, unknown>>;
  const swapped = files.map((f, i) => (i === 0 ? { ...f, key: String(files[1]?.['key']) } : f));
  assert.throws(() => parseReleaseVerifyInput(releaseInput({ files: swapped })), { code: 'invalid_release_verify_input' });
  assert.throws(() => parseReleaseVerifyInput(releaseInput({ files: files.slice(0, 2) })), { code: 'invalid_release_verify_input' });
  assert.throws(() => parseReleaseVerifyInput(releaseInput({ files: [files[0], files[0], files[2]] })), { code: 'invalid_release_verify_input' });
  const huge = files.map((f, i) => (i === 1 ? { ...f, size: 2 * 1024 * 1024 } : f));
  assert.throws(() => parseReleaseVerifyInput(releaseInput({ files: huge })), { code: 'invalid_release_verify_input' });
  const traversal = files.map((f, i) => (i === 0 ? { ...f, key: 'staging/../releases/x/release.zip' } : f));
  assert.throws(() => parseReleaseVerifyInput(releaseInput({ files: traversal })), { code: 'invalid_release_verify_input' });
  assert.throws(() => parseJobRequest(request('release.verify', releaseInput({ signerWorkflow: 'x' })), 'deployer'), { code: 'invalid_release_verify_input' });
});

test('plan summaries are exact and internally consistent', () => {
  assert.equal(parsePlanSummary(planSummary(), 'x').policyPassed, true);
  assert.throws(() => parsePlanSummary(planSummary({ policy: [{ rule: 'P1', result: 'fail', messages: [] }] }), 'x'), { code: 'x' });
  assert.throws(() => parsePlanSummary(planSummary({ stateSerial: null }), 'x'), { code: 'x' });
  assert.throws(() => parsePlanSummary({ ...planSummary(), extra: 1 }, 'x'), { code: 'x' });
});
