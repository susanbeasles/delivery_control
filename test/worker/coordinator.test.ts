import { test } from 'node:test';
import { DeployError } from '../../worker/lib/errors.ts';
import assert from 'node:assert/strict';
import { CoordinatorEngine, type EngineDeps } from '../../worker/coordinator/engine.ts';
import { createStepRunner, type StepDeps } from '../../worker/coordinator/steps.ts';
import { MemoryStore } from '../../worker/coordinator/store.ts';
import { isTerminal, type DeploymentRecord, type PromotionRequest } from '../../worker/coordinator/types.ts';
import { parseRegistry } from '../../worker/registry/registry.ts';
import { uuidv7 } from '../../worker/lib/runtime.ts';
import { sha256Hex } from '../../worker/lib/json.ts';
import { ACCOUNT, COMMIT, registryDoc } from './helpers/fixtures.ts';
import { FakeBucket, FakeCloudflare, FakeGitHub, FakeQueue, FakeRunner, ManualClock, buildRelease, type BuiltRelease } from './helpers/fakes.ts';

const SCRIPT = 'prosrus-api';
const ORIGIN = 'https://jobs.susanb.dev';

function harness(options: { registry?: unknown; environment?: string; script?: string } = {}) {
  const clock = new ManualClock();
  const store = new MemoryStore();
  const staging = new FakeBucket();
  const releases = new FakeBucket(['releases/']);
  const state = new FakeBucket(['ledger/']);
  const cf = new FakeCloudflare(ACCOUNT, ORIGIN, options.script ?? SCRIPT);
  cf.tokens.set(SCRIPT, 'token-WORKER_PROSRUS_API');
  const runner = new FakeRunner();
  const queue = new FakeQueue();
  const github = new FakeGitHub();
  const assetBytes = new Map<number, Uint8Array>();
  const tampered = new Set<number>();
  let downloads = 0;
  const registry = parseRegistry((options.registry ?? registryDoc()) as any);
  const steps: StepDeps = {
    clock,
    registry: async () => registry,
    storage: { staging: staging as unknown as R2Bucket, releases: releases as unknown as R2Bucket },
    assetSource: () => async (_name, ref) => {
      downloads++;
      const bytes = assetBytes.get(ref.id);
      if (!bytes) throw new Error(`no asset ${ref.id}`);
      const served = tampered.has(ref.id) ? Uint8Array.from(bytes, (b, i) => (i === 0 ? b ^ 1 : b)) : bytes;
      return new Blob([served]).stream();
    },
    runner,
    cloudflare: async (credential) => ({ fetcher: cf.fetch, accountId: ACCOUNT, token: `token-${credential}` }),
    fetcher: cf.fetch,
    state: state as unknown as R2Bucket,
    verifyPollMs: 10_000,
  };
  const alarms: number[] = [];
  const environment = options.environment ?? 'production';
  const engineDeps: EngineDeps = {
    store,
    clock,
    key: { application: 'prosrus', environment },
    steps: createStepRunner(steps),
    ledger: state as unknown as R2Bucket,
    github,
    queue,
    setAlarm: async (at) => {
      alarms.push(at);
    },
    environmentUrl: () => ORIGIN,
  };
  const engine = new CoordinatorEngine(engineDeps);

  const publish = (release: BuiltRelease) => {
    for (const [name, ref] of Object.entries({ 'release.manifest.json': release.assets.manifest, 'release.zip': release.assets.archive, 'attestation.sigstore.json': release.assets.attestation })) {
      assetBytes.set(ref.id, release.bytes[name as keyof BuiltRelease['bytes']]);
    }
  };

  const request = (release: BuiltRelease, overrides: Partial<PromotionRequest> = {}): PromotionRequest => ({
    schema: 'promotion-request/v1',
    requestId: uuidv7(clock.now()),
    intent: 'deploy',
    application: 'prosrus',
    environment,
    repository: 'susanbeasles/ProsRUs',
    repositoryId: 1412827677,
    releaseTag: release.tag,
    sourceCommit: COMMIT,
    releaseManifestSha256: release.assets.manifest.sha256,
    assets: release.assets,
    expectedCurrentGeneration: null,
    registryRevision: 3,
    githubDeploymentId: null,
    requestedAt: new Date(clock.now()).toISOString(),
    ...overrides,
  });

  let tokens = 0;
  const admit = (req: PromotionRequest, tokenHash = `${'0'.repeat(56)}${String(++tokens).padStart(8, '0')}`) => engine.admit(req, tokenHash, environment);

  const record = (id: string) => store.get<DeploymentRecord>(`dep:${id}`)!;

  /** Drive like the queue and alarm would, jumping the clock over waits. */
  const drive = async (id: string, limit = 400) => {
    for (let i = 0; i < limit; i++) {
      const r = record(id);
      if (isTerminal(r.phase)) {
        await engine.flush();
        return r;
      }
      const meta = store.get<any>('meta');
      const active = meta.active ? record(meta.active) : undefined;
      if (active && active.nextAttemptAt > clock.now()) clock.t = active.nextAttemptAt;
      await engine.advance();
    }
    throw new Error(`deployment ${id} did not finish; phase ${record(id).phase}`);
  };

  return { clock, store, staging, releases, state, cf, runner, queue, github, engine, restart: () => new CoordinatorEngine(engineDeps), publish, request, admit, record, drive, alarms, tampered, downloads: () => downloads };
}

async function deployed(h: ReturnType<typeof harness>, tag: string, options: Parameters<typeof buildRelease>[1] = {}) {
  const release = await buildRelease(tag, options);
  h.publish(release);
  const admission = await h.admit(h.request(release));
  assert.equal(admission.status, 'QUEUED');
  if (admission.status !== 'QUEUED') throw new Error('not queued');
  return { release, id: admission.deploymentId, final: await h.drive(admission.deploymentId) };
}

test('first deploy from absent code: script created, healthy, committed, ledgered, reported', async () => {
  const h = harness();
  const { id, final } = await deployed(h, 'v1.0.0');
  assert.equal(final.phase, 'SUCCEEDED', JSON.stringify(final.lastError));
  assert.equal(final.generation, 1);
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
  assert.equal(h.cf.scripts.get(SCRIPT)!.subdomainEnabled, false);
  assert.ok(h.cf.calls.includes(`PUT ${SCRIPT}`), 'script created through the create path');

  const pointer = h.state.json('pointers/prosrus/production/current.json');
  assert.equal(pointer.schema, 'deployment-pointer/v1');
  assert.equal(pointer.release.tag, 'v1.0.0');
  assert.equal(pointer.generation, 1);
  assert.equal(pointer.deploymentId, id);

  const ledger = h.state.keys(`ledger/prosrus/production/${id}/`);
  assert.ok(ledger.includes(`ledger/prosrus/production/${id}/accepted.json`));
  assert.ok(ledger.includes(`ledger/prosrus/production/${id}/result.json`));
  const phases = ledger.filter((k) => k.includes('/events/')).map((k) => h.state.json(k).phase);
  assert.deepEqual(phases, ['AUTHORIZED', 'QUEUED', 'VERIFYING', 'PLANNED', 'DEPLOYING_TARGETS', 'HEALTH_CHECKING', 'COMMITTING', 'SUCCEEDED']);

  for (const name of ['release.manifest.json', 'release.zip', 'attestation.sigstore.json', 'ingest.json']) {
    assert.ok(h.releases.objects.has(`releases/prosrus/v1.0.0/${name}`), `${name} in the immutable bucket`);
  }
  assert.deepEqual(h.github.statuses.map((s) => s.state), ['queued', 'in_progress', 'success']);
  assert.equal(h.github.deployments[0]!.ref, COMMIT);
});

test('second release uploads a version, deploys it, records the prior release', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const { final } = await deployed(h, 'v1.1.0');
  assert.equal(final.phase, 'SUCCEEDED');
  assert.equal(final.generation, 2);
  assert.deepEqual(final.priorRelease?.tag, 'v1.0.0');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.1.0');
  assert.equal(h.cf.calls.filter((c) => c === `POST ${SCRIPT}/versions`).length, 1);
  assert.equal(h.state.json('pointers/prosrus/production/rollback.json').release.tag, 'v1.0.0');
});

test('replays and duplicates never create a second deployment', async () => {
  const h = harness();
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  const token = 'a'.repeat(64);
  const first = await h.admit(h.request(release), token);
  const again = await h.admit(h.request(release), token);
  assert.equal(first.status, 'QUEUED');
  assert.deepEqual(again.status === 'QUEUED' && again.deploymentId, first.status === 'QUEUED' && first.deploymentId);
  const joined = await h.admit(h.request(release));
  assert.equal(joined.status === 'QUEUED' && joined.deploymentId, first.status === 'QUEUED' && first.deploymentId, 'same release in flight is joined');
  const replaced = await h.admit({ ...h.request(release), releaseManifestSha256: 'f'.repeat(64) });
  assert.deepEqual(replaced, { status: 'REJECTED', error: 'release_conflict' }, 'same tag, different bytes in flight');
  await h.drive((first as any).deploymentId);
  const current = await h.admit(h.request(release));
  assert.equal(current.status, 'ALREADY_CURRENT');
});

test('an older release never overtakes a newer one', async () => {
  const h = harness();
  await deployed(h, 'v1.2.0');
  const older = await buildRelease('v1.1.9');
  h.publish(older);
  assert.deepEqual(await h.admit(h.request(older)), { status: 'REJECTED', error: 'stale_release' });
});

test('concurrent admissions share one GitHub deployment and its statuses', async () => {
  const h = harness();
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  const create = h.github.createDeployment;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  h.github.createDeployment = async (input) => { await blocked; return create(input); };
  const first = h.admit(h.request(release));
  const second = h.admit(h.request(release));
  unblock();
  const admissions = await Promise.all([first, second]);
  assert.equal(admissions[0]!.status, 'QUEUED');
  assert.deepEqual(admissions[1], admissions[0]);
  const id = (admissions[0] as { deploymentId: string }).deploymentId;
  assert.equal((await h.drive(id)).phase, 'SUCCEEDED');
  assert.equal(h.github.deployments.length, 1, 'no orphan GitHub deployment');
  assert.ok(h.github.statuses.every((s) => s.id === h.record(id).githubDeploymentId));
  assert.deepEqual(h.github.statuses.map((s) => s.state), ['queued', 'in_progress', 'success']);
});

test('rollback can restore a committed release older than the recent history window', async () => {
  const h = harness();
  for (let minor = 0; minor < 55; minor++) {
    assert.equal((await deployed(h, `v1.${minor}.0`)).final.phase, 'SUCCEEDED');
  }
  const downloads = h.downloads();
  const rollback = await h.restart().admit({ ...h.request(await buildRelease('v1.0.0')), intent: 'rollback', assets: null, releaseManifestSha256: null }, 'f'.repeat(64), 'production');
  assert.equal(rollback.status, 'QUEUED');
  if (rollback.status !== 'QUEUED') throw new Error('rollback was rejected');
  const final = await h.drive(rollback.deploymentId);
  assert.equal(final.phase, 'SUCCEEDED', JSON.stringify(final.lastError));
  assert.equal(final.generation, 56);
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
  assert.equal(h.downloads(), downloads, 'rollback uses immutable retained bytes');
});

test('next in line: newest pending request wins, superseded one ends REJECTED', async () => {
  const h = harness();
  const [a, b, c] = await Promise.all(['v1.0.0', 'v1.1.0', 'v1.2.0'].map((t) => buildRelease(t)));
  for (const r of [a!, b!, c!]) h.publish(r);
  const first = (await h.admit(h.request(a!))) as any;
  const second = (await h.admit(h.request(b!))) as any;
  const third = (await h.admit(h.request(c!))) as any;
  assert.equal(h.record(second.deploymentId).phase, 'REJECTED');
  assert.equal(h.record(second.deploymentId).lastError?.code, 'superseded');
  assert.equal((await h.drive(first.deploymentId)).phase, 'SUCCEEDED');
  assert.equal((await h.drive(third.deploymentId)).phase, 'SUCCEEDED');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.2.0');
  assert.ok(h.github.statuses.some((s) => s.state === 'inactive'));
});

test('waiting next in line does not use up the deployment budget', async () => {
  const h = harness();
  const [a, b] = await Promise.all(['v1.0.0', 'v1.1.0'].map((t) => buildRelease(t)));
  for (const r of [a!, b!]) h.publish(r);
  const first = (await h.admit(h.request(a!))) as any;
  const second = (await h.admit(h.request(b!))) as any;
  const admittedDeadline = h.record(second.deploymentId).deadlineAt;
  h.clock.advance(70 * 60_000);
  await h.drive(first.deploymentId);
  assert.ok(h.record(second.deploymentId).deadlineAt > admittedDeadline, 'budget restarts on promotion');
  assert.equal((await h.drive(second.deploymentId)).phase, 'SUCCEEDED');
});

test('stale expected generation is refused', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const r = await buildRelease('v1.1.0');
  h.publish(r);
  assert.deepEqual(await h.admit(h.request(r, { expectedCurrentGeneration: 0 })), { status: 'REJECTED', error: 'stale_generation' });
});

test('tampered asset bytes are refused before anything is touched', async () => {
  const h = harness();
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  h.tampered.add(release.assets.archive.id);
  const admission = (await h.admit(h.request(release))) as any;
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'asset_digest_mismatch');
  assert.equal(h.cf.calls.length, 0);
  assert.equal(h.releases.objects.size, 0);
});

test('a module that does not match its digest is refused before anything is touched', async () => {
  const h = harness();
  const { final } = await deployed(h, 'v1.0.0', { tamperModule: true });
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'artifact_digest_mismatch');
  assert.equal(h.cf.calls.length, 0);
});

test('a release whose ingested bytes differ from the authorized digest is refused, not redeployed', async () => {
  const h = harness();
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  await h.releases.put('releases/prosrus/v1.0.0/release.zip', 'different bytes', { sha256: await sha256Hex('different bytes') });
  await h.releases.put('releases/prosrus/v1.0.0/ingest.json', '{}');
  const admission = (await h.admit(h.request(release))) as any;
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.lastError?.code, 'release_bytes_conflict');
  assert.equal(h.cf.calls.length, 0);
});

test('a release naming an unregistered target is refused', async () => {
  const h = harness();
  const { final } = await deployed(h, 'v1.0.0', { targets: [{ id: 'admin', bindings: [] }] });
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'target_not_registered');
  assert.equal(h.cf.calls.length, 0);
});

test('an artifact asking for an unregistered binding is refused', async () => {
  const h = harness();
  const { final } = await deployed(h, 'v1.0.0', { targets: [{ id: 'api', bindings: ['DB', 'ADMIN_TOKEN'] }] });
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'binding_not_registered');
  assert.equal(h.cf.calls.length, 0);
});

test('a failed attestation is refused and nothing reaches the immutable bucket', async () => {
  const h = harness();
  h.runner.mode = 'fail';
  const { final } = await deployed(h, 'v1.0.0');
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'attestation_invalid');
  assert.equal(h.releases.objects.size, 0);
});

test('attestation signed by an unexpected workflow is refused', async () => {
  const h = harness();
  h.runner.signerWorkflow = 'someone/else/.github/workflows/release.yml';
  const { final } = await deployed(h, 'v1.0.0');
  assert.equal(final.lastError?.code, 'attestation_invalid');
});

test('verification waits for the runner and resumes', async () => {
  const h = harness();
  h.runner.mode = { runningPolls: 3 };
  const { final } = await deployed(h, 'v1.0.0');
  assert.equal(final.phase, 'SUCCEEDED');
  assert.ok(h.queue.sent.some((k) => k.delaySeconds === 10), 'a delayed kick was scheduled while waiting');
});

test('health failure after an upgrade rolls back to the prior version', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  h.cf.unhealthy.add('v1.1.0');
  const { final } = await deployed(h, 'v1.1.0');
  assert.equal(final.phase, 'ROLLED_BACK');
  assert.equal(final.lastError?.code, 'health_failed');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
  assert.equal(h.state.json('pointers/prosrus/production/current.json').release.tag, 'v1.0.0', 'pointer never moved');
  assert.equal(h.github.statuses.at(-1)!.state, 'failure');
});

test('a first deploy commits with health unverified: its domain is attached only after the script exists', async () => {
  const h = harness();
  h.cf.unhealthy.add('v1.0.0');
  const { final } = await deployed(h, 'v1.0.0');
  assert.equal(final.phase, 'SUCCEEDED');
  assert.equal(h.state.json('pointers/prosrus/production/current.json').release.tag, 'v1.0.0');
  // Once its domain is attached the first release serves; the next release is checked in full and
  // rolls back to it.
  h.cf.unhealthy.delete('v1.0.0');
  h.cf.unhealthy.add('v1.1.0');
  const second = await deployed(h, 'v1.1.0');
  assert.equal(second.final.phase, 'ROLLED_BACK');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
});

test('a crash after the version upload reconciles by operation id instead of uploading twice', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  h.cf.failAfter = { method: 'POST', suffix: '/versions' };
  const { final } = await deployed(h, 'v1.1.0');
  assert.equal(final.phase, 'SUCCEEDED');
  assert.equal(h.cf.calls.filter((c) => c === `POST ${SCRIPT}/versions`).length, 1);
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.1.0');
});

test('a crash after the deployment call is reconciled without a second deployment', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  h.cf.failAfter = { method: 'POST', suffix: '/deployments' };
  const { final } = await deployed(h, 'v1.1.0');
  assert.equal(final.phase, 'SUCCEEDED');
  assert.equal(h.cf.calls.filter((c) => c === `POST ${SCRIPT}/deployments`).length, 1);
});

test('only one advance runs at a time', async () => {
  const h = harness();
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  await h.admit(h.request(release));
  const [x, y] = await Promise.all([h.engine.advance(), h.engine.advance()]);
  assert.ok([x, y].includes('busy'), `one call must be refused, got ${x} and ${y}`);
});

test('an expired lease is taken over', async () => {
  const h = harness();
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  const meta = h.store.get<any>('meta');
  meta.lease = { holder: 'crashed', fence: 9, expiresAt: h.clock.now() + 1000 };
  h.store.put('meta', meta);
  assert.equal(await h.engine.advance(), 'busy');
  h.clock.advance(2000);
  assert.equal((await h.drive(admission.deploymentId)).phase, 'SUCCEEDED');
});

test('transient failures back off and recover', async () => {
  const h = harness();
  h.queue.failNext = 2;
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  assert.ok(h.store.list('outbox:').length > 0, 'unsent kick stays in the outbox');
  assert.equal((await h.drive(admission.deploymentId)).phase, 'SUCCEEDED');
  assert.equal(h.store.list('outbox:').length, 0);
});

test('rollback intent redeploys a previously committed release from the immutable bucket', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  await deployed(h, 'v1.1.0');
  const downloads = h.downloads();
  const rollback = await h.admit({ ...h.request(await buildRelease('v1.0.0')), intent: 'rollback', assets: null, releaseManifestSha256: null });
  assert.equal(rollback.status, 'QUEUED');
  const final = await h.drive((rollback as any).deploymentId);
  assert.equal(final.phase, 'SUCCEEDED', JSON.stringify(final.lastError));
  assert.equal(final.generation, 3);
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
  assert.equal(h.downloads(), downloads, 'no GitHub download for a rollback');
  const unknown = await h.admit({ ...h.request(await buildRelease('v0.9.0')), intent: 'rollback', assets: null, releaseManifestSha256: null });
  assert.deepEqual(unknown, { status: 'REJECTED', error: 'not_previously_deployed' });
});

test('a pointer changed behind our back is refused before anything is deployed', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const release = await buildRelease('v1.1.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  const current = h.state.objects.get('pointers/prosrus/production/current.json')!;
  current.bytes = new TextEncoder().encode(JSON.stringify({ deploymentId: 'someone-else' }));
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'pointer_conflict');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0', 'production was never touched');
});

test('a pointer that keeps the deployment id but edits any other field is refused', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const release = await buildRelease('v1.1.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  const current = h.state.objects.get('pointers/prosrus/production/current.json')!;
  const doc = JSON.parse(new TextDecoder().decode(current.bytes));
  current.bytes = new TextEncoder().encode(JSON.stringify({ ...doc, generation: doc.generation + 5 }));
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'pointer_conflict');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
});

test('a crash after the pointer write keeps record and pointer identical, so later releases still deploy', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const original = h.state.put.bind(h.state);
  let crashed = false;
  (h.state as any).put = async (key: string, value: unknown, options?: any) => {
    const result = await original(key, value, options);
    if (!crashed && key === 'pointers/prosrus/production/current.json') {
      crashed = true;
      throw new DeployError('r2_unavailable', 'worker died after the pointer write', { retryable: true });
    }
    return result;
  };
  const second = await deployed(h, 'v1.1.0');
  assert.ok(crashed);
  assert.equal(second.final.phase, 'SUCCEEDED');
  const third = await deployed(h, 'v1.2.0');
  assert.equal(third.final.phase, 'SUCCEEDED', String(third.final.lastError?.code));
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.2.0');
});

test('an unreadable pointer is refused as pointer_conflict before anything is deployed', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const release = await buildRelease('v1.1.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  h.state.objects.get('pointers/prosrus/production/current.json')!.bytes = new TextEncoder().encode('{not json');
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'pointer_conflict');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
});

test('a pointer edited after planning is caught again at the commit, not overwritten', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const release = await buildRelease('v1.1.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  // The first read of current.json is the planning check; edit the pointer right after it, so the
  // edit lands while targets deploy and only the commit-time swap can see it.
  const key = 'pointers/prosrus/production/current.json';
  const original = h.state.get.bind(h.state);
  let reads = 0;
  let doc: any;
  (h.state as any).get = async (k: string, options?: any) => {
    const result = await original(k, options);
    if (k === key && ++reads === 1) {
      const current = h.state.objects.get(key)!;
      doc = JSON.parse(new TextDecoder().decode(current.bytes));
      current.bytes = new TextEncoder().encode(JSON.stringify({ ...doc, generation: doc.generation + 1 }));
    }
    return result;
  };
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.lastError?.code, 'pointer_conflict');
  assert.notEqual(final.phase, 'SUCCEEDED');
  assert.equal(JSON.parse(new TextDecoder().decode(h.state.objects.get('pointers/prosrus/production/current.json')!.bytes)).generation, doc.generation + 1, 'the edited pointer was not overwritten');
});

test('a pointer that exists before any release is committed is refused', async () => {
  const h = harness();
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  await h.state.put('pointers/prosrus/production/current.json', '{"deploymentId":null}');
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'pointer_conflict');
});

test('a missing pointer while a release is committed is refused before anything is deployed', async () => {
  const h = harness();
  await deployed(h, 'v1.0.0');
  const release = await buildRelease('v1.1.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  h.state.objects.delete('pointers/prosrus/production/current.json');
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.phase, 'REJECTED');
  assert.equal(h.cf.activeRelease(SCRIPT), 'v1.0.0');
});

test('the deadline turns a stuck deployment into a terminal state', async () => {
  const h = harness();
  h.runner.mode = { runningPolls: 1_000_000 };
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  const admission = (await h.admit(h.request(release))) as any;
  const final = await h.drive(admission.deploymentId, 2000);
  assert.equal(final.phase, 'REJECTED');
  assert.equal(final.lastError?.code, 'deadline_exceeded');
});

test('the same release reaching a second environment reuses the ingested bytes', async () => {
  const doc = registryDoc() as any;
  const staging = structuredClone(doc.applications[0].environments[0]);
  staging.environment = 'staging';
  staging.githubEnvironment = 'staging';
  staging.targets[0].scriptName = 'prosrus-api-staging';
  staging.targets[0].credential = 'WORKER_PROSRUS_API_STAGING';
  doc.applications[0].environments.push(staging);
  const h = harness({ registry: doc, environment: 'staging', script: 'prosrus-api-staging' });
  h.cf.tokens.set('prosrus-api-staging', 'token-WORKER_PROSRUS_API_STAGING');
  const release = await buildRelease('v1.0.0');
  h.publish(release);
  // Pretend production ingested it already.
  for (const [name, bytes] of Object.entries(release.bytes)) await h.releases.put(`releases/prosrus/v1.0.0/${name}`, bytes, { sha256: await sha256Hex(bytes) });
  await h.releases.put('releases/prosrus/v1.0.0/ingest.json', '{}');
  const admission = (await h.admit(h.request(release))) as any;
  const final = await h.drive(admission.deploymentId);
  assert.equal(final.phase, 'SUCCEEDED', JSON.stringify(final.lastError));
  assert.equal(h.downloads(), 0, 'nothing downloaded from GitHub');
  assert.equal(h.runner.jobs.size, 0, 'no second attestation run');
  assert.equal(h.cf.activeRelease('prosrus-api-staging'), 'v1.0.0');
});
