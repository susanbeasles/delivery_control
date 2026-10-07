import test from 'node:test';
import assert from 'node:assert/strict';
import { API, OWNER_ID, nextVersion, parseVersion, validateRequest, release } from '../src/releases.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const request = { repository: 'susanbeasles/example', repositoryID: 123, sha: b, runID: 12 };
test('conventional messages drive stable semver; every other push patches', () => {
  assert.equal(nextVersion(null, ['chore: initial']), 'v0.0.1');
  assert.equal(nextVersion('v1.2.3', ['fix(core): correct']), 'v1.2.4');
  assert.equal(nextVersion('v1.2.3', ['feat(core): addition', 'fix: x']), 'v1.3.0');
  assert.equal(nextVersion('v0.2.3', ['feat(core)!: remove']), 'v1.0.0');
  assert.equal(nextVersion('v1.2.3', ['change\n\nBREAKING CHANGE: contract']), 'v2.0.0');
  assert.equal(nextVersion('v1.2.3', ['docs: mention feat: example']), 'v1.2.4');
  assert.equal(nextVersion('v1.2.3', ['BREAKING-CHANGE: contract']), 'v2.0.0');
});
test('reject invalid versions and source identities', () => {
  assert.equal(parseVersion('v01.2.3'), null);
  assert.equal(parseVersion('v1.2.3-beta.1'), null);
  for (const patch of [{ repository: 'attacker/x' }, { repository: 'susanbeasles/x\ny' }, { sha: 'main' }, { runID: '1e3' }, { repositoryID: 0 }]) assert.throws(() => validateRequest({ ...request, ...patch }));
});
function fixture() {
  const runs = [{ id: 11, run_number: 1, head_sha: a }, { id: 12, run_number: 2, head_sha: b }].map(r => ({ ...r, event: 'push', head_branch: 'main', workflow_id: 77, repository: { id: 123 } }));
  const tags = [], objects = new Map(), releases = new Map(), writes = [];
  const root = '/repos/susanbeasles/example';
  let failPublish = false;
  const api = {
    async pages(path, key) {
      if (path === `${root}/tags`) return [...tags];
      if (path.includes('/actions/workflows/77/runs')) return [...runs].reverse();
      if (path.includes('/commits?')) return [{ commit: { message: 'chore: initial' } }];
      if (path.includes('/compare/')) return [{ commit: { message: 'feat: new capability' } }];
      throw Error(`Unexpected pagination ${path} ${key}`);
    },
    async request(path, method = 'GET', body) {
      if (method !== 'GET') writes.push({ path, method, body });
      if (path === `${root}/immutable-releases`) return { enabled: true };
      if (path === root) return { id: 123, owner: { id: OWNER_ID, login: 'susanbeasles' }, default_branch: 'main' };
      if (path.includes('/actions/runs/')) return runs.find(r => r.id === Number(path.split('/').at(-1)));
      if (path.endsWith('/actions/workflows/77')) return { path: '.github/workflows/auto-release.yml' };
      if (path.endsWith('/git/ref/heads/main')) return { object: { sha: b } };
      if (path.includes('/compare/')) {
        const [base, head] = path.split('/').at(-1).split('...');
        return { status: base === head ? 'identical' : base === a && head === b ? 'ahead' : 'behind', ahead_by: 1 };
      }
      if (path.endsWith('/git/tags') && method === 'POST') { const sha = `${objects.size}`.padStart(40, '0'); objects.set(sha, { ...body, object: { type: 'commit', sha: body.object } }); return { sha }; }
      if (path.endsWith('/git/refs') && method === 'POST') { const obj = objects.get(body.sha); tags.push({ name: obj.tag, commit: { sha: obj.object.sha }, objectSHA: body.sha }); return {}; }
      if (path.includes('/git/ref/tags/')) { const tag = tags.find(t => t.name === path.split('/').at(-1)); return tag ? { object: { type: 'tag', sha: tag.objectSHA } } : null; }
      if (path.includes('/git/tags/')) return objects.get(path.split('/').at(-1));
      if (path.includes('/releases/tags/')) return releases.get(path.split('/').at(-1)) ?? null;
      if (path.endsWith('/releases') && method === 'POST') {
        if (failPublish) { failPublish = false; throw Error('Simulated interrupted publish'); }
        const result = { ...body, immutable: true, id: releases.size + 1, html_url: `https://github.com/susanbeasles/example/releases/tag/${body.tag_name}` }; releases.set(body.tag_name, result); return result;
      }
      throw Error(`Unexpected request ${method} ${path}`);
    },
  };
  return { api, runs, tags, objects, releases, writes, failNextPublish: () => { failPublish = true; } };
}
test('later dispatch reconciles both pushes in source order and binds tag targets', async () => {
  const f = fixture();
  const result = await release(request, f.api);
  assert.deepEqual(result.map(r => [r.tag, r.sha]), [['v0.0.1', a], ['v0.1.0', b]]);
  assert.equal(f.writes.filter(w => w.path.endsWith('/git/refs')).length, 2);
});
test('duplicate dispatch and older arrival never allocate another version', async () => {
  const f = fixture(); await release(request, f.api);
  await release(request, f.api);
  await release({ ...request, sha: a, runID: 11 }, f.api);
  assert.equal(f.tags.length, 2); assert.equal(f.releases.size, 2);
});
test('tag survives interrupted publication and rerun publishes without retagging', async () => {
  const f = fixture(); f.failNextPublish();
  await assert.rejects(release(request, f.api), /interrupted/);
  assert.equal(f.tags.length, 1); assert.equal(f.releases.size, 0);
  await release(request, f.api);
  assert.equal(f.tags.length, 2); assert.equal(f.releases.size, 2);
});
test('spoofed run SHA, wrong source workflow, repo identity and divergence fail before writes', async () => {
  for (const mode of ['sha', 'workflow', 'owner', 'diverged']) {
    const f = fixture(), original = f.api.request.bind(f.api);
    f.api.request = async (path, ...args) => {
      const value = await original(path, ...args);
      if (mode === 'sha' && path.includes('/actions/runs/')) return { ...value, head_sha: c };
      if (mode === 'workflow' && path.endsWith('/actions/workflows/77')) return { path: 'evil.yml' };
      if (mode === 'owner' && path === '/repos/susanbeasles/example') return { ...value, owner: { id: 9, login: 'susanbeasles' } };
      if (mode === 'diverged' && path.includes('/compare/')) return { status: 'diverged' };
      return value;
    };
    await assert.rejects(release(request, f.api)); assert.equal(f.writes.length, 0);
  }
});
test('pagination handles 100+ tags and commits instead of truncating', async () => {
  const calls = [];
  const api = new API('test-only', async (url, options) => {
    calls.push([url, options]);
    return { ok: true, status: 200, json: async () => url.includes('page=2') ? [{ id: 100 }] : Array.from({ length: 100 }, (_, id) => ({ id })) };
  });
  assert.equal((await api.pages('/repos/susanbeasles/example/tags')).length, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].redirect, 'error');
});
test('HTTP write failures never auto-retry uncertain mutations', async () => {
  let count = 0;
  const api = new API('test-only', async () => { count++; return { ok: false, status: 422 }; });
  await assert.rejects(api.request('/repos/susanbeasles/example/git/refs', 'POST', {}), /422/);
  assert.equal(count, 1);
});

test('missing or disabled immutable settings block before tag and release writes', async () => {
 for (const settings of [null, {}, {enabled:false}]) {
  const f=fixture(), original=f.api.request.bind(f.api);
  f.api.request=(path,...args)=>path.endsWith('/immutable-releases')?Promise.resolve(settings):original(path,...args);
  await assert.rejects(release(request,f.api),/Immutable releases/);assert.equal(f.writes.length,0);
 }
});
test('mutable new or existing managed releases never count as successful publication', async () => {
 const f=fixture(),original=f.api.request.bind(f.api);
 f.api.request=async(path,...args)=>{const v=await original(path,...args);return path.endsWith('/releases')&&args[0]==='POST'?{...v,immutable:false}:v;};
 await assert.rejects(release(request,f.api),/readback mismatch/);
 assert.equal(f.releases.size,1);
 f.api.request=original;
 for(const value of f.releases.values())value.immutable=false;
 const before=f.writes.length;
 await assert.rejects(release(request,f.api),/immutable release/);assert.equal(f.writes.length,before);
});
test('immutability drift during a multi-push release stops subsequent mutations',async()=>{
 const f=fixture(),original=f.api.request.bind(f.api);let checks=0;
 f.api.request=(path,...args)=>path.endsWith('/immutable-releases')?Promise.resolve({enabled:++checks<4}):original(path,...args);
 await assert.rejects(release(request,f.api),/Immutable releases/);
 assert.equal(f.tags.length,1);assert.equal(f.releases.size,1);
});
