import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBounded } from '../../worker/lib/fetch.ts';

// The Workers runtime throws on `redirect: 'error'`; Node does not, so unit tests alone would not
// notice. This pins the behaviour: always `manual`, and an unexpected 3xx is a refusal.
test('fetchBounded never asks the runtime for redirect:error and refuses unexpected redirects', async () => {
  const seen: Array<string | undefined> = [];
  const fetcher = async (_url: unknown, init?: RequestInit) => {
    seen.push(init?.redirect);
    return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
  };
  await assert.rejects(fetchBounded(fetcher, 'https://api.example/x', { timeoutMs: 1000, maxBytes: 10 }, 'probe'), (e: any) => e.code === 'probe' && /redirected/.test(e.message));
  const allowed = await fetchBounded(fetcher, 'https://api.example/x', { timeoutMs: 1000, maxBytes: 10, allowRedirect: true }, 'probe');
  assert.equal(allowed.status, 302);
  assert.deepEqual(seen, ['manual', 'manual']);
});

test('fetchBounded caps the body while streaming', async () => {
  const fetcher = async () => new Response('x'.repeat(100));
  await assert.rejects(fetchBounded(fetcher, 'https://api.example/x', { timeoutMs: 1000, maxBytes: 10 }, 'probe'), /exceeds 10 bytes/);
});
