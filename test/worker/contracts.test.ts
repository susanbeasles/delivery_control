import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictJson, canonicalize, parseCanonicalJsonBytes, sha256Hex } from '../../worker/lib/json.ts';
import { parseReleaseManifest, topologicalOrder } from '../../worker/contracts/manifest.ts';
import { parseWorkerArtifact } from '../../worker/contracts/artifact.ts';
import { parseDeploySubject } from '../../worker/contracts/subject.ts';
import { parseRegistry } from '../../worker/registry/registry.ts';
import { registryDoc, manifestDoc, workerArtifactDoc, subjectDoc, bytesOf } from './helpers/fixtures.ts';

const code = (c: string) => (e: any) => e.code === c;
const H = 'a'.repeat(64);

test('strict JSON rejects duplicates, floats, -0, lone surrogates, trailing data, deep nesting', () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /duplicate key/);
  assert.throws(() => parseStrictJson('{"a":1.5}'), /only integers/);
  assert.throws(() => parseStrictJson('{"a":1e3}'), /only integers/);
  assert.throws(() => parseStrictJson('-0'), /negative zero/);
  assert.throws(() => parseStrictJson('9007199254740993'), /safe range/);
  assert.throws(() => parseStrictJson('"\\ud800"'), /lone surrogate/);
  assert.throws(() => parseStrictJson('{} x'), /trailing/);
  assert.throws(() => parseStrictJson('[1,]'), /unexpected token/);
  assert.throws(() => parseStrictJson('01'), /trailing/);
  assert.throws(() => parseStrictJson('['.repeat(100) + ']'.repeat(100)), /too deep/);
  assert.deepEqual(parseStrictJson(' {"b":[true,null,"x\\n"],"a":-5} '), { b: [true, null, 'x\n'], a: -5 });
});

test('__proto__ is just a key and cannot pollute', () => {
  const v = parseStrictJson('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(Object.keys(v), ['__proto__']);
});

test('canonicalize follows RFC 8785 for the integer subset', async () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'é\u0007'], c: { z: 0, y: -1 } }), '{"a":[true,null,"é\\u0007"],"b":1,"c":{"y":-1,"z":0}}');
  assert.throws(() => canonicalize({ a: 0.5 }));
  assert.throws(() => canonicalize({ a: undefined }));
  assert.throws(() => parseCanonicalJsonBytes(new TextEncoder().encode('{"b":1,"a":2}'), 100, 'x'), /canonical/);
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('manifest: valid document parses and orders targets', () => {
  const doc = manifestDoc(H, 10, [
    { id: 'web', adapter: 'cloudflare-worker/v1', artifactPath: 'targets/web/worker-artifact.json', sha256: H, dependsOn: ['api'], healthContract: { path: '/healthz', expectStatus: 200, expectReleaseTag: true } },
    { id: 'api', adapter: 'cloudflare-worker/v1', artifactPath: 'targets/api/worker-artifact.json', sha256: H, dependsOn: [], healthContract: { path: '/', expectStatus: 204, expectReleaseTag: false } },
  ]);
  const m = parseReleaseManifest(bytesOf(doc));
  assert.deepEqual(topologicalOrder(m.targets), ['api', 'web']);
});

test('manifest: rejects non-canonical bytes, cycles, unknown adapters, hostile health paths', () => {
  const t = (over: Record<string, unknown>) => ({ id: 'api', adapter: 'cloudflare-worker/v1', artifactPath: 'a.json', sha256: H, dependsOn: [], healthContract: { path: '/h', expectStatus: 200, expectReleaseTag: false }, ...over });
  assert.throws(() => parseReleaseManifest(new TextEncoder().encode(JSON.stringify(manifestDoc(H, 1, [t({})]), null, 2))), code('manifest_invalid'));
  assert.throws(() => parseReleaseManifest(bytesOf(manifestDoc(H, 1, [t({ id: 'aa', dependsOn: ['bb'], artifactPath: 'a' }), t({ id: 'bb', dependsOn: ['aa'], artifactPath: 'b' })]))), /cycle/);
  assert.throws(() => parseReleaseManifest(bytesOf(manifestDoc(H, 1, [t({ adapter: 'host-agent/v1' })]))), code('manifest_invalid'));
  for (const path of ['https://evil.example/x', '//evil.example', '/a/../b', '/a//b', 'relative', '/a?x=1', '/@evil']) {
    assert.throws(() => parseReleaseManifest(bytesOf(manifestDoc(H, 1, [t({ healthContract: { path, expectStatus: 200, expectReleaseTag: false } })]))), code('manifest_invalid'), path);
  }
  assert.throws(() => parseReleaseManifest(bytesOf(manifestDoc(H, 1, [t({ artifactPath: '../x' })]))), code('manifest_invalid'));
  assert.throws(() => parseReleaseManifest(bytesOf({ ...manifestDoc(H, 1, [t({})]), extra: 1 })), /unexpected field/);
});

test('worker artifact: reserved bindings, bad main module, duplicate names', () => {
  const mods = [{ name: 'index.js', path: 'targets/api/index.js', type: 'esm', sha256: H }];
  assert.equal(parseWorkerArtifact(bytesOf(workerArtifactDoc(mods))).mainModule, 'index.js');
  assert.throws(() => parseWorkerArtifact(bytesOf(workerArtifactDoc(mods, ['DEPLOY_ID']))), /reserved/);
  assert.throws(() => parseWorkerArtifact(bytesOf({ ...workerArtifactDoc(mods), mainModule: 'nope.js' })), /mainModule/);
  assert.throws(() => parseWorkerArtifact(bytesOf(workerArtifactDoc([mods[0]!, mods[0]!]))), /duplicate/);
  assert.throws(() => parseWorkerArtifact(bytesOf(workerArtifactDoc([{ ...mods[0]!, type: 'text' }]))), /mainModule/);
});

test('deploy subject: deploy requires assets, rollback may omit them', () => {
  const assets = { manifest: { id: 1, sha256: H, size: 10 }, archive: { id: 2, sha256: H, size: 10 }, attestation: { id: 3, sha256: H, size: 10 } };
  assert.equal(parseDeploySubject(subjectDoc(assets)).releaseTag, 'v1.4.2');
  assert.throws(() => parseDeploySubject(subjectDoc(null)), /required for intent deploy/);
  assert.equal(parseDeploySubject(subjectDoc(null, { intent: 'rollback' })).assets, null);
  assert.throws(() => parseDeploySubject(subjectDoc(assets, { releaseTag: 'v1.2.3-rc1' })), code('subject_invalid'));
  assert.throws(() => parseDeploySubject(subjectDoc(assets, { authorizedAt: '2026-13-45T00:00:00.000Z' })), code('subject_invalid'));
});

test('registry: valid, and every guard fires', () => {
  const r = parseRegistry(registryDoc() as any);
  assert.equal(r.applications[0]!.environments[0]!.targets[0]!.bindings.length, 2);
  const mutate = (fn: (d: any) => void) => { const d = registryDoc() as any; fn(d); return d; };
  const target = (d: any) => d.applications[0].environments[0].targets[0];
  assert.throws(() => parseRegistry(mutate((d) => (target(d).scriptName = 'deployer'))), /control-plane/);
  assert.throws(() => parseRegistry(mutate((d) => (target(d).adapter = 'static-assets/v1'))), code('adapter_not_implemented'));
  assert.throws(() => parseRegistry(mutate((d) => (target(d).health.origin = 'http://jobs.susanb.dev'))), code('registry_invalid'));
  assert.throws(() => parseRegistry(mutate((d) => (target(d).health.origin = 'https://jobs.susanb.dev/path'))), code('registry_invalid'));
  assert.throws(() => parseRegistry(mutate((d) => target(d).bindings.push({ name: 'DEPLOY_X', type: 'plain_text', text: 'x' }))), /reserved/);
  assert.throws(() => parseRegistry(mutate((d) => target(d).bindings.push({ name: 'X', type: 'd1', id: 'x', extra: 'y' }))), /unexpected field/);
  assert.throws(() => parseRegistry(mutate((d) => target(d).bindings.push({ name: 'DB', type: 'plain_text', text: 'x' }))), /duplicate/);
  assert.throws(() => parseRegistry(mutate((d) => (target(d).credential = 'CF_APPLY'))), code('registry_invalid'));
  assert.throws(() => parseRegistry(mutate((d) => d.applications.push(structuredClone(d.applications[0])))), /duplicate/);
});
