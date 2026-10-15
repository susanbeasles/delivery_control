import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleEgress, type GateDeps } from '../../worker/runner/egress/gate.ts';
import type { EgressContext } from '../../worker/runner/egress/rules.ts';
import { signV4 } from '../../worker/runner/egress/sigv4.ts';
import { cloudflareToken, stateCredentials, type RunnerEnv } from '../../worker/runner/env.ts';
import type { RunnerJobType } from '../../worker/runner/api.ts';
import { JOB_PROFILES } from '../../worker/runner/profiles.ts';
import { ACCOUNT, JOB_ID, NOW_MS, SECRETS, TOKEN_IDS, TREE, secretEnv } from './builders.ts';
import { FakeBucket, FakeClock, sha256 } from './fakes.ts';

const R2 = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

function setup(type: RunnerJobType, respond: (sent: Sent) => Response = () => new Response('ok')) {
  const sent: Sent[] = [];
  const plans = new FakeBucket();
  const env = secretEnv() as unknown as RunnerEnv;
  const stack = JOB_PROFILES[type].stack;
  let running = true;
  const context: EgressContext = { jobId: JOB_ID, type, stack, treeSha: stack ? TREE : null, accountId: ACCOUNT };
  const deps: GateDeps = {
    context: async (jobId) => (running && jobId === JOB_ID ? context : null),
    cloudflareToken: (t) => cloudflareToken(env, t),
    stateCredentials: (t) => stateCredentials(env, t),
    fetcher: async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const body = init?.body ? new Uint8Array(init.body as Uint8Array) : null;
      const s = { url: String(input), method: init?.method ?? 'GET', headers, body };
      sent.push(s);
      return respond(s);
    },
    plans,
    clock: new FakeClock(NOW_MS),
  };
  const call = (url: string, init: RequestInit = {}) => handleEgress(new Request(url, init), { jobId: JOB_ID, type }, deps);
  return { sent, plans, deps, call, stop: () => (running = false) };
}

test('Cloudflare API: container credentials are stripped and the job type token injected', async () => {
  const plan = setup('terraform.plan');
  const response = await plan.call('https://api.cloudflare.com/client/v4/zones?name=susanb.dev', {
    headers: { authorization: 'Bearer stolen-or-forged', 'x-auth-key': 'k', 'x-auth-email': 'e', cookie: 'c=1', accept: 'application/json', 'cf-access-client-secret': 's' },
  });
  assert.equal(response.status, 200);
  assert.equal(plan.sent.length, 1);
  assert.deepEqual(plan.sent[0]?.headers, { accept: 'application/json', authorization: `Bearer ${SECRETS.CF_PLAN}` });

  const apply = setup('terraform.apply');
  await apply.call('https://api.cloudflare.com/client/v4/zones/z/dns_records', { method: 'POST', body: '{"type":"A"}', headers: { 'content-type': 'application/json' } });
  assert.equal(apply.sent[0]?.headers['authorization'], `Bearer ${SECRETS.CF_APPLY}`);
  assert.equal(new TextDecoder().decode(apply.sent[0]?.body ?? new Uint8Array()), '{"type":"A"}');

  const root = setup('root.apply');
  await root.call('https://api.cloudflare.com/client/v4/accounts/a/r2/buckets', { method: 'POST', body: '{}' });
  assert.equal(root.sent[0]?.headers['authorization'], `Bearer ${SECRETS.CF_ROOT_APPLY}`);
});

test('denials never reach the network', async () => {
  const plan = setup('terraform.plan');
  for (const [url, init] of [
    ['https://api.cloudflare.com/client/v4/zones', { method: 'POST', body: '{}' }],
    ['https://evil.example/exfiltrate', {}],
    [`${R2}/tf-state/infra/terraform.tfstate`, { method: 'PUT', body: 'x' }],
    [`${R2}/other-bucket/infra/terraform.tfstate`, {}],
    ['http://api.cloudflare.com/client/v4/zones', {}],
  ] as Array<[string, RequestInit]>) {
    const response = await plan.call(url, init);
    assert.equal(response.status, 403, url);
  }
  const verify = setup('release.verify');
  assert.equal((await verify.call('https://api.github.com/repos/a/b/attestations/sha256:x')).status, 403);
  assert.equal(plan.sent.length + verify.sent.length, 0);
});

test('a job that is not running gets no egress, and props must name the running job', async () => {
  const plan = setup('terraform.plan');
  plan.stop();
  assert.equal((await plan.call('https://api.cloudflare.com/client/v4/zones')).status, 403);
  const other = setup('terraform.plan');
  const forged = await handleEgress(new Request('https://api.cloudflare.com/client/v4/zones'), { jobId: JOB_ID, type: 'terraform.apply' }, other.deps);
  assert.equal(forged.status, 403);
  const malformed = await handleEgress(new Request('https://api.cloudflare.com/client/v4/zones'), { jobId: 'nope' }, other.deps);
  assert.equal(malformed.status, 403);
  assert.equal(plan.sent.length + other.sent.length, 0);
});

test('R2 requests are re-signed with SigV4 using the token id and SHA-256 of the token value', async () => {
  const apply = setup('terraform.apply');
  const response = await apply.call(`${R2}/tf-state/infra/terraform.tfstate.tflock`, {
    method: 'PUT',
    body: '{"ID":"lock"}',
    headers: {
      authorization: 'AWS4-HMAC-SHA256 Credential=signed-by-egress-gate/20261015/auto/s3/aws4_request, SignedHeaders=host, Signature=00',
      'if-none-match': '*',
      'content-type': 'application/json',
      'x-amz-security-token': 'nope',
      'amz-sdk-invocation-id': 'abc',
    },
  });
  assert.equal(response.status, 200);
  const sent = apply.sent[0];
  assert.ok(sent);
  assert.equal(sent.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
  assert.equal(sent.headers['if-none-match'], '*');
  assert.equal(sent.headers['x-amz-security-token'], undefined);
  assert.equal(sent.headers['amz-sdk-invocation-id'], undefined);
  assert.match(sent.headers['authorization'] ?? '', new RegExp(`^AWS4-HMAC-SHA256 Credential=${TOKEN_IDS.R2_STATE_RW_TOKEN_ID}/20261015/auto/s3/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`));
  // Recompute independently with the expected derived secret.
  const expected = await signV4(
    {
      method: 'PUT',
      url: new URL(sent.url),
      headers: { 'content-type': 'application/json', 'if-none-match': '*', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      payloadHash: 'UNSIGNED-PAYLOAD',
      region: 'auto',
      service: 's3',
      now: new Date(NOW_MS),
    },
    { accessKeyId: TOKEN_IDS.R2_STATE_RW_TOKEN_ID, secretAccessKey: sha256(SECRETS.R2_STATE_RW) },
  );
  assert.equal(sent.headers['authorization'], expected.headers['authorization']);

  const plan = setup('terraform.plan');
  await plan.call(`${R2}/tf-state/infra/terraform.tfstate`);
  assert.match(plan.sent[0]?.headers['authorization'] ?? '', new RegExp(`Credential=${TOKEN_IDS.R2_STATE_RO_TOKEN_ID}/`));
});

test('aws-chunked uploads are refused; archive writes are forced create-only', async () => {
  const apply = setup('terraform.apply');
  const chunked = await apply.call(`${R2}/tf-state/infra/terraform.tfstate`, { method: 'PUT', body: 'x', headers: { 'content-encoding': 'aws-chunked' } });
  assert.equal(chunked.status, 502);
  const streaming = await apply.call(`${R2}/tf-state/infra/terraform.tfstate`, { method: 'PUT', body: 'x', headers: { 'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' } });
  assert.equal(streaming.status, 502);
  assert.equal(apply.sent.length, 0);
  await apply.call(`${R2}/tf-state-archive/infra/${TREE}/${JOB_ID}/before.tfstate`, { method: 'PUT', body: 'encrypted-state' });
  assert.equal(apply.sent[0]?.headers['if-none-match'], '*');
});

test('redirects: refused unless the target is allowed for the same job', async () => {
  const evil = setup('terraform.plan', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/collect?d=1' } }));
  const refused = await evil.call('https://api.cloudflare.com/client/v4/zones');
  assert.equal(refused.status, 502);
  assert.deepEqual(await refused.json(), { error: 'redirect_refused' });
  const fine = setup('terraform.plan', () => new Response(null, { status: 301, headers: { location: 'https://api.cloudflare.com/client/v4/zones/' } }));
  const passed = await fine.call('https://api.cloudflare.com/client/v4/zones');
  assert.equal(passed.status, 301);
  assert.equal(passed.headers.get('location'), 'https://api.cloudflare.com/client/v4/zones/');
});

test('artifacts: create-only, size-limited, scoped to the job tree; apply may only read the plan', async () => {
  const plan = setup('terraform.plan');
  const first = await plan.call('https://artifacts.runner.internal/plan.json', { method: 'PUT', body: '{"a":1}' });
  assert.equal(first.status, 201);
  assert.equal(plan.plans.text(`infra/${TREE}/plan.json`), '{"a":1}');
  const again = await plan.call('https://artifacts.runner.internal/plan.json', { method: 'PUT', body: '{"a":2}' });
  assert.equal(again.status, 409);
  assert.equal(plan.plans.text(`infra/${TREE}/plan.json`), '{"a":1}');
  const big = await plan.call('https://artifacts.runner.internal/summary.json', { method: 'PUT', body: 'x'.repeat(256 * 1024 + 1) });
  assert.equal(big.status, 413);
  assert.equal((await plan.call('https://artifacts.runner.internal/other.bin', { method: 'PUT', body: 'x' })).status, 403);
  assert.equal(plan.sent.length, 0);

  const apply = setup('terraform.apply');
  apply.plans.putText(`infra/${TREE}/plan.tfplan`, 'PLANBYTES');
  const got = await apply.call('https://artifacts.runner.internal/plan.tfplan');
  assert.equal(got.status, 200);
  assert.equal(await got.text(), 'PLANBYTES');
  assert.equal((await apply.call('https://artifacts.runner.internal/plan.tfplan', { method: 'PUT', body: 'x' })).status, 403);
});

test('credentials fail closed when a binding or token id is missing', async () => {
  const env = secretEnv() as unknown as Record<string, unknown>;
  delete env['CF_APPLY'];
  await assert.rejects(cloudflareToken(env as unknown as RunnerEnv, 'terraform.apply'), { code: 'credential_unbound' });
  const env2 = secretEnv() as unknown as Record<string, unknown>;
  env2['R2_STATE_RO_TOKEN_ID'] = '';
  await assert.rejects(stateCredentials(env2 as unknown as RunnerEnv, 'terraform.plan'), { code: 'credential_unconfigured' });
  await assert.rejects(cloudflareToken(secretEnv() as unknown as RunnerEnv, 'release.verify'), { code: 'credential_not_granted' });
});
