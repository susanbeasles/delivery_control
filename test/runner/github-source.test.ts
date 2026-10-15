import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchHead, commitTree, downloadTarball } from '../../worker/runner/github-source.ts';
import { planCheckRun, deploymentState } from '../../worker/runner/github-report.ts';
import type { RunnerJobStatus } from '../../worker/runner/api.ts';
import type { TerraformSubject } from '../../worker/runner/subject.ts';
import { parseTerraformSubject } from '../../worker/runner/subject.ts';
import { COMMIT, JOB_ID, POLICY_COMMIT, TREE, fakeGitHub, planSummary, subject } from './builders.ts';
import { nodeHashes, sha256 } from './fakes.ts';

const repo = { repository: 'susanbeasles/infra', repositoryId: 1417590199 };

function deps(fetcher: (input: Request | string | URL, init?: RequestInit) => Promise<Response>) {
  return { tokens: { repositoryToken: async () => 'ghs_testToken' }, fetcher, hashes: nodeHashes };
}

test('tree and branch lookups', async () => {
  const gh = fakeGitHub();
  const d = { tokens: gh.tokens, fetcher: gh.fetcher, hashes: nodeHashes };
  assert.equal(await commitTree(d, repo, COMMIT), TREE);
  assert.equal(await branchHead(d, repo, 'main'), POLICY_COMMIT);
  await assert.rejects(commitTree(d, repo, 'b'.repeat(40)), { code: 'commit_not_found' });
});

test('tarball: exactly one redirect, only to codeload, without our token', async () => {
  const gh = fakeGitHub();
  const bytes = await downloadTarball({ tokens: gh.tokens, fetcher: gh.fetcher, hashes: nodeHashes }, repo, COMMIT, 1024 * 1024);
  assert.equal(bytes.sha256, sha256(Buffer.concat(bytes.chunks)));
  assert.deepEqual(gh.seen.map((s) => [new URL(s.url).hostname, s.authorization !== null]), [
    ['api.github.com', true],
    ['codeload.github.com', false],
  ]);

  const elsewhere = deps(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.tar.gz' } }));
  await assert.rejects(downloadTarball(elsewhere, repo, COMMIT, 1024), { code: 'tarball_redirect_refused' });
  const plain = deps(async () => new Response(null, { status: 302, headers: { location: 'http://codeload.github.com/x' } }));
  await assert.rejects(downloadTarball(plain, repo, COMMIT, 1024), { code: 'tarball_redirect_refused' });
  let hops = 0;
  const twice = deps(async () => {
    hops += 1;
    return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/again' } });
  });
  await assert.rejects(downloadTarball(twice, repo, COMMIT, 1024), { code: 'tarball_redirect_refused' });
  assert.equal(hops, 2);
  const large = deps(async () => new Response(new Uint8Array(2048)));
  await assert.rejects(downloadTarball(large, repo, COMMIT, 1024), { code: 'tarball_download' });
});

test('check run body: counts, every policy result, failure conclusion when policy fails', () => {
  const s: TerraformSubject = parseTerraformSubject(subject('plan'), { stack: 'infra', operation: 'plan' });
  const status: RunnerJobStatus = { jobId: JOB_ID, type: 'terraform.plan', state: 'succeeded', result: null, error: null, logKey: 'jobs/x', submittedAt: '', finishedAt: '' };
  const ok = planCheckRun(s, status, planSummary());
  assert.equal(ok['name'], 'terraform plan / infra');
  assert.equal(ok['head_sha'], 'd'.repeat(40));
  assert.equal(ok['conclusion'], 'success');
  assert.equal((ok['output'] as { title: string }).title, '1 to add, 2 to change, 0 to destroy');
  const failing = planCheckRun(s, status, planSummary({ policyPassed: false, policy: [{ rule: 'P1', result: 'fail', messages: ['P1: deletes | <b>bucket</b>'] }] }));
  assert.equal(failing['conclusion'], 'failure');
  const summary = (failing['output'] as { summary: string }).summary;
  assert.match(summary, /\| P1 \| fail \| P1: deletes {4}b bucket \/b  \|/);
  const failedJob = planCheckRun(s, { ...status, state: 'failed', error: { code: 'tofu_plan_failed', message: 'exit 1' } }, null);
  assert.equal((failedJob['output'] as { title: string }).title, 'plan failed: tofu_plan_failed');
  assert.equal(deploymentState({ ...status, state: 'uncertain' }), 'error');
});
