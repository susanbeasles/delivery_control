import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { GitHubApp, importAppPrivateKey, signAppJwt } from '../../worker/github/app.ts';
import { downloadReleaseAsset } from '../../worker/github/github-api.ts';
import { healthUrl, probe } from '../../worker/adapters/health.ts';
import { loadRegistry, resetRegistryCache } from '../../worker/registry/loader.ts';
import { canonicalBytes } from '../../worker/lib/json.ts';
import { ManualClock } from './helpers/fakes.ts';
import { ACCOUNT, registryDoc } from './helpers/fixtures.ts';

const rsa = (bits: number) => generateKeyPairSync('rsa', { modulusLength: bits, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });

test('GitHub App keys: PKCS#1 imports, signs a verifiable RS256 JWT; weak keys are refused', async () => {
  const { privateKey, publicKey } = rsa(2048);
  const key = await importAppPrivateKey(privateKey);
  assert.equal(key.extractable, false);
  const jwt = await signAppJwt(12345, key, 1_760_000_000);
  const [h, b, sig] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${b}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(sig!, 'base64url')));
  const claims = JSON.parse(Buffer.from(b!, 'base64url').toString());
  assert.deepEqual(claims, { iss: '12345', iat: 1_760_000_000 - 60, exp: 1_760_000_000 + 540 });
  await assert.rejects(importAppPrivateKey(rsa(1024).privateKey), (e: any) => e.code === 'github_app_key_invalid');
  await assert.rejects(importAppPrivateKey('not a key'), (e: any) => e.code === 'github_app_key_invalid');
});

test('installation tokens are narrowed to one repository and cached', async () => {
  const { privateKey } = rsa(2048);
  const calls: Array<{ url: string; body: any }> = [];
  const fetcher = async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/installation')) return Response.json({ id: 77 });
    return Response.json({ token: 'ghs_x', expires_at: '2026-10-15T13:00:00Z' }, { status: 201 });
  };
  const app = new GitHubApp({ appId: 1, privateKeyPem: async () => privateKey, fetcher, clock: new ManualClock() });
  assert.equal(await app.repositoryToken('o/r', 42, { contents: 'read' }), 'ghs_x');
  assert.equal(await app.repositoryToken('o/r', 42, { contents: 'read' }), 'ghs_x');
  assert.equal(calls.length, 2, 'second call served from cache');
  assert.deepEqual(calls[1]!.body, { repository_ids: [42], permissions: { contents: 'read' } });
  assert.ok(calls[1]!.url.endsWith('/app/installations/77/access_tokens'));
});

test('asset download follows one redirect to GitHub storage without our token', async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const github = { repositoryToken: async () => 'ghs_secret' } as unknown as GitHubApp;
  const make = (location: string, body = 'abc', length?: string) => async (input: any, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 302, headers: { location } });
    return new Response(body, { status: 200, headers: length ? { 'content-length': length } : {} });
  };
  const stream = await downloadReleaseAsset(github, make('https://release-assets.githubusercontent.com/x?sig=1'), 'o/r', 1, 9, 3);
  assert.equal(await new Response(stream).text(), 'abc');
  assert.equal(seen[0]!.auth, 'Bearer ghs_secret');
  assert.equal(seen[1]!.auth, null, 'token never sent to storage');
  await assert.rejects(downloadReleaseAsset(github, make('https://evil.example/x'), 'o/r', 1, 9, 3), (e: any) => e.code === 'asset_redirect_refused');
  await assert.rejects(downloadReleaseAsset(github, make('http://objects.githubusercontent.com/x'), 'o/r', 1, 9, 3), (e: any) => e.code === 'asset_redirect_refused');
  await assert.rejects(downloadReleaseAsset(github, make('https://objects.githubusercontent.com/x', 'abcd', '4'), 'o/r', 1, 9, 3), (e: any) => e.code === 'asset_digest_mismatch');
  const missing = async () => new Response('nope', { status: 404 });
  await assert.rejects(downloadReleaseAsset(github, missing, 'o/r', 1, 9, 3), (e: any) => e.code === 'asset_missing' && !e.retryable);
  const flaky = async () => new Response('busy', { status: 503 });
  await assert.rejects(downloadReleaseAsset(github, flaky, 'o/r', 1, 9, 3), (e: any) => e.code === 'asset_download' && e.retryable);
});

test('health: release tag must match, redirects and oversize bodies fail, URL stays on the origin', async () => {
  const settings = { origin: 'https://jobs.susanb.dev', timeoutMs: 1000, attempts: 1, intervalMs: 1000 };
  const contract = { path: '/healthz', expectStatus: 200, expectReleaseTag: true };
  assert.equal(healthUrl(settings, contract), 'https://jobs.susanb.dev/healthz');
  const reply = (status: number, body: string, headers: Record<string, string> = {}) => async () => new Response(status === 204 || body === '' ? null : body, { status, headers });
  assert.equal((await probe(reply(200, '{"release":"v1.0.0"}'), settings, contract, 'v1.0.0')).healthy, true);
  assert.equal((await probe(reply(200, '{"release":"v0.9.0"}'), settings, contract, 'v1.0.0')).reason, 'serving a different release');
  assert.equal((await probe(reply(302, '', { location: 'https://x' }), settings, contract, 'v1.0.0')).reason, 'redirected');
  assert.equal((await probe(reply(500, '{}'), settings, contract, 'v1.0.0')).healthy, false);
  assert.equal((await probe(reply(200, 'x'.repeat(70_000)), settings, contract, 'v1.0.0')).healthy, false);
  assert.equal((await probe(reply(200, 'not json'), settings, contract, 'v1.0.0')).healthy, false);
  assert.equal((await probe(async () => { throw new TypeError('down'); }, settings, contract, 'v1.0.0')).reason, 'unreachable');
  assert.equal((await probe(reply(204, ''), settings, { ...contract, expectStatus: 204, expectReleaseTag: false }, 'v1.0.0')).healthy, true);
});

test('registry loader: missing, wrong account, valid', async () => {
  const clock = new ManualClock();
  const kv = (value: Uint8Array | null) => ({ get: async () => (value ? value.slice().buffer : null) }) as unknown as KVNamespace;
  resetRegistryCache();
  await assert.rejects(loadRegistry(kv(null), clock, ACCOUNT), (e: any) => e.code === 'registry_unavailable');
  resetRegistryCache();
  await assert.rejects(loadRegistry(kv(canonicalBytes(registryDoc())), clock, 'f'.repeat(32)), (e: any) => e.code === 'registry_invalid');
  resetRegistryCache();
  const r = await loadRegistry(kv(canonicalBytes(registryDoc())), clock, ACCOUNT);
  assert.equal(r.revision, 3);
  resetRegistryCache();
});
