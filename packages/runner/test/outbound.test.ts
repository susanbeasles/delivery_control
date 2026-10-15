import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobTypeError } from '../src/job-type.ts';
import { createOutboundFetch, decideOutbound } from '../src/outbound.ts';

const hosts: ReadonlySet<string> = new Set(['api.cloudflare.com', 'github.com']);

test('only exact allowlisted hosts over https on port 443 pass', () => {
  assert.deepEqual(decideOutbound('https://api.cloudflare.com/client/v4/user', hosts), { allow: true, host: 'api.cloudflare.com' });
  assert.deepEqual(decideOutbound('https://API.CLOUDFLARE.COM:443/', hosts), { allow: true, host: 'api.cloudflare.com' });
  assert.deepEqual(decideOutbound('http://api.cloudflare.com/', hosts), { allow: false, reason: 'not_https' });
  assert.deepEqual(decideOutbound('https://api.cloudflare.com:8443/', hosts), { allow: false, reason: 'port_not_allowed' });
  assert.deepEqual(decideOutbound('https://user:pw@api.cloudflare.com/', hosts), { allow: false, reason: 'credentials_in_url' });
  assert.deepEqual(decideOutbound('https://evil.api.cloudflare.com/', hosts), { allow: false, reason: 'host_not_allowed' });
  assert.deepEqual(decideOutbound('https://api.cloudflare.com.evil.example/', hosts), { allow: false, reason: 'host_not_allowed' });
  assert.deepEqual(decideOutbound('https://1.2.3.4/', hosts), { allow: false, reason: 'host_not_allowed' });
  assert.deepEqual(decideOutbound('not a url', hosts), { allow: false, reason: 'bad_url' });
});

test('the fetch handler refuses with 403 and passes allowed requests upstream without following redirects', async () => {
  const seen: Request[] = [];
  const handler = createOutboundFetch(['api.cloudflare.com'], async (request) => {
    seen.push(request);
    return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
  });
  const refused = await handler(new Request('https://github.com/x'));
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /host_not_allowed/);
  assert.equal(seen.length, 0);
  const plain = await handler(new Request('http://api.cloudflare.com/'));
  assert.equal(plain.status, 403);
  const passed = await handler(new Request('https://api.cloudflare.com/client/v4/zones', { headers: { authorization: 'Bearer t' } }));
  assert.equal(passed.status, 302);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.redirect, 'manual');
  assert.equal(seen[0]?.headers.get('authorization'), 'Bearer t');
});

test('a malformed allowlist is refused at construction', () => {
  assert.throws(() => createOutboundFetch(['*.cloudflare.com']), (e: unknown) => e instanceof JobTypeError && e.code === 'bad_host');
});
