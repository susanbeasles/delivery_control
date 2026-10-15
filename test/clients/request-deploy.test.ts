import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run } from '../../clients/request-deploy.mjs';

const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' };
const args = parseArgs(['--application', 'prosrus', '--environment', 'production', '--release-tag', 'v1.4.2']);

function fakeFetch(phases: string[], admit = { status: 202, body: { status: 'QUEUED', deploymentId: 'd-1', githubDeploymentId: 7 } }) {
  const calls: any[] = [];
  let tokens = 0;
  const fetcher = async (url: string, init: any = {}) => {
    calls.push({ url, init });
    if (url.startsWith('https://token.example/')) return Response.json({ value: `oidc-${++tokens}` });
    const body = JSON.parse(init.body);
    if (body.action === 'deploy') return Response.json(admit.body, { status: admit.status });
    return Response.json({ phase: phases.shift() ?? 'DEPLOYING_TARGETS', lastError: { code: 'health_failed', message: 'api unhealthy' } });
  };
  return { fetcher, calls };
}

const quiet = () => {};
const instant = async () => {};

test('argument validation', () => {
  assert.throws(() => parseArgs(['--application', 'x']), /application/);
  assert.throws(() => parseArgs(['--application', 'prosrus', '--environment', 'production', '--release-tag', 'latest']), /vX.Y.Z/);
  assert.equal(parseArgs(['--application', 'prosrus', '--environment', 'production', '--release-tag', 'v1.0.0', '--intent', 'rollback']).intent, 'rollback');
});

test('success path: one OIDC token per call, audience pinned, no redirects', async () => {
  const { fetcher, calls } = fakeFetch(['VERIFYING', 'SUCCEEDED']);
  assert.equal(await run({ args, env, fetcher, log: quiet, sleep: instant }), 0);
  const posts = calls.filter((c) => c.url === 'https://services.susanb.dev/v1/token');
  assert.equal(posts.length, 3);
  assert.deepEqual(new Set(posts.map((p) => p.init.headers.authorization)).size, 3, 'fresh token for every call');
  assert.ok(calls[0].url.endsWith('&audience=services.susanb.dev'));
  assert.ok(calls.every((c) => c.init.redirect === 'error'));
});

test('a rolled-back deployment fails the job with the reason', async () => {
  const { fetcher } = fakeFetch(['ROLLED_BACK']);
  const lines: string[] = [];
  assert.equal(await run({ args, env, fetcher, log: (l: string) => lines.push(l), sleep: instant }), 1);
  assert.ok(lines.some((l) => l.includes('health_failed')));
});

test('a refused request fails immediately and is not retried', async () => {
  const { fetcher, calls } = fakeFetch([], { status: 403, body: { error: 'bad_workflow' } as any });
  assert.equal(await run({ args, env, fetcher, log: quiet, sleep: instant }), 1);
  assert.equal(calls.filter((c) => c.url.startsWith('https://services')).length, 1);
});

test('missing id-token permission is explained', async () => {
  const { fetcher } = fakeFetch([]);
  await assert.rejects(run({ args, env: {}, fetcher, log: quiet, sleep: instant }), /id-token: write/);
});
