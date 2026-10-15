import { parseWorkerArtifact, MAX_MODULE_TOTAL_BYTES, type WorkerArtifact } from '../contracts/artifact.ts';
import { MAX_MANIFEST_BYTES, parseReleaseManifest, topologicalOrder, type ReleaseManifest } from '../contracts/manifest.ts';
import type { ApiContext } from '../adapters/cloudflare-api.ts';
import { composeBindings, deployWorker, readPriorVersion, rollbackWorker, type ResolvedModule } from '../adapters/cloudflare-worker.ts';
import { probe } from '../adapters/health.ts';
import { fail } from '../lib/errors.ts';
import type { Fetcher } from '../lib/fetch.ts';
import { isJsonObject, sha256Hex, type Json } from '../lib/json.ts';
import { compareReleaseTags, isoAt, log, uuidv7, type Clock } from '../lib/runtime.ts';
import { resolveEnvironment, type Registry, type RegistryApplication, type RegistryEnvironment } from '../registry/registry.ts';
import { openZip, readEntry, type RangeSource, type ZipDirectory } from '../release/zip.ts';
import {
  promoteRelease,
  readObject,
  releaseKey,
  releasedArchive,
  stageAsset,
  stagedArchive,
  type AssetSource,
  type ReleaseStorage,
} from '../release/service.ts';
import type { ReleaseVerifyInput, RunnerJobRequest, RunnerJobStatus } from '../runner/api.ts';
import type { StepContext, StepResult, StepRunner } from './engine.ts';
import { pointerDocument, pointerKey, putPointer, swapCurrentPointer } from './ledger.ts';
import { ASSET_NAMES, type AssetName, type CommittedRelease, type DeploymentRecord, type HealthProgress, type Phase, type Plan, type StagedFile, type TargetPlan } from './types.ts';

/**
 * One function per phase. Each reads the record, does at most one bounded unit of external work,
 * and reports progress, a wait, or a transition. All decisions about failure routing live in the
 * engine; steps only throw stable error codes.
 */

export interface StepDeps {
  clock: Clock;
  registry(): Promise<Registry>;
  storage: ReleaseStorage;
  /** Downloads a release asset of `record`'s repository from GitHub. */
  assetSource(record: DeploymentRecord): AssetSource;
  runner: {
    submit(request: RunnerJobRequest): Promise<RunnerJobStatus>;
    status(jobId: string): Promise<RunnerJobStatus | null>;
  };
  /** API context with the token held by the named Secrets Store binding. */
  cloudflare(credential: string): Promise<ApiContext>;
  fetcher: Fetcher;
  state: R2Bucket;
  verifyPollMs: number;
}

const VERIFY_JOB_SECONDS = 600;

export function createStepRunner(deps: StepDeps): StepRunner {
  return async (phase: Phase, ctx: StepContext): Promise<StepResult> => {
    switch (phase) {
      case 'REQUESTED':
      case 'AUTHORIZED':
      case 'QUEUED':
        return start(deps, ctx);
      case 'VERIFYING':
        return ctx.record.intent === 'deploy' ? verify(deps, ctx) : verifyRollback(deps, ctx);
      case 'PLANNED':
        return plan(deps, ctx);
      case 'DEPLOYING_TARGETS':
        return deployNext(deps, ctx);
      case 'HEALTH_CHECKING':
        return healthCheck(deps, ctx, ctx.record.health, (health) => ({ health }), 'COMMITTING', 'health_failed');
      case 'COMMITTING':
        return commit(deps, ctx);
      case 'RECOVERING':
        return recover(deps, ctx);
      default:
        return fail('internal', `no step for phase ${phase}`);
    }
  };
}

// -------------------------------------------------------------------------------------------------
// QUEUED → VERIFYING

async function start(deps: StepDeps, ctx: StepContext): Promise<StepResult> {
  const r = ctx.record;
  const committed = ctx.meta.committed;
  if (r.intent === 'deploy' && committed && compareReleaseTags(r.requestedReleaseTag, committed.releaseTag) <= 0) {
    fail('stale_release', `${r.requestedReleaseTag} is not newer than the committed ${committed.releaseTag}`);
  }
  await environment(deps, r); // registry must still list this application and environment
  return { kind: 'transition', to: 'VERIFYING' };
}

async function environment(deps: StepDeps, r: DeploymentRecord): Promise<{ app: RegistryApplication; env: RegistryEnvironment; registry: Registry }> {
  const registry = await deps.registry();
  const { application, environment: env } = resolveEnvironment(registry, r.application, r.environment);
  if (application.repositoryId !== r.request.repositoryId || application.repository !== r.request.repository) {
    fail('repository_mismatch', 'the registry maps this application to a different repository');
  }
  return { app: application, env, registry };
}

// -------------------------------------------------------------------------------------------------
// VERIFYING (deploy): stage → manifest → archive → attestation → promote

async function verify(deps: StepDeps, ctx: StepContext): Promise<StepResult> {
  const r = ctx.record;
  const assets = r.request.assets;
  if (!assets) return fail('subject_invalid', 'deploy intent without assets');
  const ingest = r.ingest;
  const { app, env } = await environment(deps, r);

  const nothingStaged = Object.keys(ingest.staged).length === 0;
  if (nothingStaged && !ingest.verified && !ingest.reused && (await alreadyIngested(deps, r))) {
    log('info', 'release.reused', { deploymentId: r.deploymentId, releaseTag: r.requestedReleaseTag });
    return { kind: 'progress', patch: { ingest: { ...ingest, reused: true, verified: true, promoted: true } } };
  }

  if (!ingest.reused) {
    for (const name of ASSET_NAMES) {
      if (ingest.staged[name]) continue;
      const ref = name === 'release.zip' ? assets.archive : name === 'release.manifest.json' ? assets.manifest : assets.attestation;
      const staged = await stageAsset(deps.storage, deps.assetSource(r), r.deploymentId, name, ref);
      return { kind: 'progress', patch: { ingest: { ...ingest, staged: { ...ingest.staged, [name]: staged } } } };
    }
  }

  if (!ingest.manifestChecked) {
    await loadManifest(deps, r, app, env);
    return { kind: 'progress', patch: { ingest: { ...ingest, manifestChecked: true } } };
  }
  if (!ingest.archiveChecked) {
    const manifest = await loadManifest(deps, r, app, env);
    await checkArchive(r, manifest, env, archiveSource(deps, r, manifest));
    return { kind: 'progress', patch: { ingest: { ...ingest, archiveChecked: true } } };
  }
  if (!ingest.verified) return attest(deps, ctx, app);
  if (!ingest.promoted) {
    const staged = allStaged(r);
    await promoteRelease(deps.storage, r.application, r.requestedReleaseTag, staged, {
      schema: 'release-ingest/v1',
      application: r.application,
      releaseTag: r.requestedReleaseTag,
      repository: r.request.repository,
      repositoryId: r.request.repositoryId,
      sourceCommit: r.sourceCommit,
      files: Object.fromEntries(ASSET_NAMES.map((n) => [n, { sha256: staged[n].sha256, size: staged[n].size }])),
      attestation: { jobId: ingest.verifyJobId, signerWorkflow: app.releaseWorkflow },
      ingestedBy: r.deploymentId,
      ingestedAt: isoAt(deps.clock.now()),
    });
    return { kind: 'progress', patch: { ingest: { ...ingest, promoted: true } } };
  }
  return { kind: 'transition', to: 'PLANNED', detail: ingest.reused ? 'release already ingested' : 'release ingested' };
}

function allStaged(r: DeploymentRecord): Record<AssetName, StagedFile> {
  const out = {} as Record<AssetName, StagedFile>;
  for (const name of ASSET_NAMES) {
    const file = r.ingest.staged[name];
    if (!file) fail('internal', `asset ${name} is not staged`);
    out[name] = file;
  }
  return out;
}

/** A release ingested by an earlier deployment is reused only if every authorized digest matches. */
async function alreadyIngested(deps: StepDeps, r: DeploymentRecord): Promise<boolean> {
  const assets = r.request.assets;
  if (!assets) return false;
  const marker = await deps.storage.releases.head(releaseKey(r.application, r.requestedReleaseTag, 'ingest.json'));
  if (!marker) return false;
  for (const name of ASSET_NAMES) {
    const ref = name === 'release.zip' ? assets.archive : name === 'release.manifest.json' ? assets.manifest : assets.attestation;
    const object = await deps.storage.releases.head(releaseKey(r.application, r.requestedReleaseTag, name));
    const sha = object?.checksums.sha256 ? [...new Uint8Array(object.checksums.sha256)].map((b) => b.toString(16).padStart(2, '0')).join('') : null;
    if (!object || object.size !== ref.size || sha !== ref.sha256) {
      // The tag exists in the immutable bucket with different bytes: never silently redeploy it.
      fail('release_bytes_conflict', `${r.requestedReleaseTag} was ingested before with different ${name}`);
    }
  }
  return true;
}

function manifestLocation(deps: StepDeps, r: DeploymentRecord): { bucket: R2Bucket; key: string; sha256: string | null } {
  if (r.ingest.promoted || r.ingest.reused || r.intent === 'rollback') {
    return { bucket: deps.storage.releases, key: releaseKey(r.application, r.requestedReleaseTag, 'release.manifest.json'), sha256: r.requestedManifestSha256 };
  }
  const staged = r.ingest.staged['release.manifest.json'];
  if (!staged) return fail('internal', 'manifest is not staged');
  return { bucket: deps.storage.staging, key: staged.key, sha256: staged.sha256 };
}

function archiveSource(deps: StepDeps, r: DeploymentRecord, manifest: ReleaseManifest): RangeSource {
  if (r.ingest.promoted || r.ingest.reused || r.intent === 'rollback') {
    return releasedArchive(deps.storage, r.application, r.requestedReleaseTag, manifest.artifact.sizeBytes);
  }
  const staged = r.ingest.staged['release.zip'];
  if (!staged) return fail('internal', 'archive is not staged');
  return stagedArchive(deps.storage, staged);
}

async function loadManifest(deps: StepDeps, r: DeploymentRecord, app: RegistryApplication, env: RegistryEnvironment): Promise<ReleaseManifest> {
  const where = manifestLocation(deps, r);
  const bytes = await readObject(where.bucket, where.key, MAX_MANIFEST_BYTES, where.sha256);
  const m = parseReleaseManifest(bytes);
  const mismatch = (field: string): never => fail('manifest_mismatch', `manifest ${field} does not match the authorized release`);
  if (m.application !== r.application) mismatch('application');
  if (m.repository !== app.repository || m.repository !== r.request.repository) mismatch('repository');
  if (m.repositoryId !== app.repositoryId || m.repositoryId !== r.request.repositoryId) mismatch('repositoryId');
  if (m.releaseTag !== r.requestedReleaseTag) mismatch('releaseTag');
  if (m.sourceCommit !== r.sourceCommit) mismatch('sourceCommit');
  if (m.artifact.sizeBytes > app.maxArtifactBytes) fail('artifact_too_large', `release.zip exceeds ${app.maxArtifactBytes} bytes`);
  const archive = r.request.assets?.archive;
  if (archive && (m.artifact.sha256 !== archive.sha256 || m.artifact.sizeBytes !== archive.size)) mismatch('artifact digest');
  for (const t of m.targets) {
    const registered = env.targets.find((x) => x.id === t.id);
    if (!registered) fail('target_not_registered', `release targets ${t.id}, which ${r.application}/${r.environment} does not register`);
    if (registered.adapter !== t.adapter) fail('target_not_registered', `${t.id} uses ${t.adapter}, registry says ${registered.adapter}`);
  }
  return m;
}

/** Read and verify every byte a deployment will upload, before anything is changed. */
async function checkArchive(r: DeploymentRecord, manifest: ReleaseManifest, env: RegistryEnvironment, source: RangeSource): Promise<void> {
  const directory = await openZip(source);
  for (const t of manifest.targets) {
    const registered = env.targets.find((x) => x.id === t.id);
    if (!registered) fail('target_not_registered', t.id);
    const { artifact } = await loadWorker(directory, source, t.artifactPath, t.sha256);
    composeBindings(registered, artifact, r.requestedReleaseTag, r.deploymentId);
  }
}

async function loadWorker(directory: ZipDirectory, source: RangeSource, artifactPath: string, artifactSha256: string): Promise<{ artifact: WorkerArtifact; modules: ResolvedModule[] }> {
  const bytes = await readEntry(source, directory, artifactPath);
  if ((await sha256Hex(bytes)) !== artifactSha256) fail('artifact_digest_mismatch', `${artifactPath} does not match the manifest digest`);
  const artifact = parseWorkerArtifact(bytes);
  const modules: ResolvedModule[] = [];
  let total = 0;
  for (const m of artifact.modules) {
    const content = await readEntry(source, directory, m.path);
    if ((await sha256Hex(content)) !== m.sha256) fail('artifact_digest_mismatch', `${m.path} does not match its digest`);
    total += content.byteLength;
    if (total > MAX_MODULE_TOTAL_BYTES) fail('artifact_too_large', `modules exceed ${MAX_MODULE_TOTAL_BYTES} bytes`);
    modules.push({ name: m.name, type: m.type, bytes: content });
  }
  return { artifact, modules };
}

async function attest(deps: StepDeps, ctx: StepContext, app: RegistryApplication): Promise<StepResult> {
  let r = ctx.record;
  const now = deps.clock.now();
  if (r.ingest.verifyJobId === null || r.ingest.verifyDeadlineAt === null) {
    // Persist the job identity first so a crash here resubmits the identical request.
    r = ctx.save({ ingest: { ...r.ingest, verifyJobId: uuidv7(now), verifyDeadlineAt: Math.floor(now / 1000) + VERIFY_JOB_SECONDS } });
  }
  const jobId = r.ingest.verifyJobId as string;
  const staged = allStaged(r);
  const input: ReleaseVerifyInput = {
    repository: r.request.repository,
    sourceCommit: r.sourceCommit,
    releaseTag: r.requestedReleaseTag,
    signerWorkflow: app.releaseWorkflow,
    files: ASSET_NAMES.map((name) => ({ name, key: staged[name].key, sha256: staged[name].sha256, size: staged[name].size })),
  };
  let status = await deps.runner.status(jobId);
  if (status === null) {
    status = await deps.runner.submit({
      jobId,
      type: 'release.verify',
      deadlineAt: r.ingest.verifyDeadlineAt as number,
      input: input as unknown as Json,
      notify: { application: r.application, environment: r.environment, deploymentId: r.deploymentId },
    });
  }
  if (status.state === 'queued' || status.state === 'running') return { kind: 'wait', untilMs: now + deps.verifyPollMs };
  if (status.state !== 'succeeded') {
    fail('attestation_invalid', `release attestation was not verified (${status.error?.code ?? status.state})`);
  }
  checkVerification(status.result, r, app, staged);
  return { kind: 'progress', patch: { ingest: { ...r.ingest, verified: true } } };
}

const stripGitHub = (value: string): string => value.replace(/^https:\/\/github\.com\//, '').replace(/@.*$/, '');

function checkVerification(result: Json, r: DeploymentRecord, app: RegistryApplication, staged: Record<AssetName, StagedFile>): void {
  const bad = (what: string): never => fail('attestation_invalid', `verification result: ${what}`);
  if (!isJsonObject(result) || result['verified'] !== true) return bad('not verified');
  const subjects = Array.isArray(result['subjects']) ? result['subjects'].filter(isJsonObject) : [];
  for (const name of ['release.zip', 'release.manifest.json'] as const) {
    if (!subjects.some((s) => s['name'] === name && s['sha256'] === staged[name].sha256)) bad(`${name} not covered`);
  }
  const sourceRepository = result['sourceRepository'];
  const signerWorkflow = result['signerWorkflow'];
  if (result['sourceDigest'] !== r.sourceCommit) bad('source commit differs');
  if (typeof sourceRepository !== 'string' || stripGitHub(sourceRepository) !== r.request.repository) bad('source repository differs');
  if (typeof signerWorkflow !== 'string' || stripGitHub(signerWorkflow) !== app.releaseWorkflow) bad('signer workflow differs');
}

// -------------------------------------------------------------------------------------------------
// VERIFYING (rollback): the release must already be in the locked bucket with its ingest record.

async function verifyRollback(deps: StepDeps, ctx: StepContext): Promise<StepResult> {
  const r = ctx.record;
  const { app, env } = await environment(deps, r);
  const marker = await deps.storage.releases.head(releaseKey(r.application, r.requestedReleaseTag, 'ingest.json'));
  if (!marker) fail('release_not_ingested', `${r.requestedReleaseTag} has no ingest record; it cannot be a rollback target`);
  const manifest = await loadManifest(deps, r, app, env);
  await checkArchive(r, manifest, env, archiveSource(deps, r, manifest));
  return {
    kind: 'transition',
    to: 'PLANNED',
    patch: { ingest: { ...r.ingest, reused: true, manifestChecked: true, archiveChecked: true, verified: true, promoted: true } },
    detail: 'rollback release re-validated',
  };
}

// -------------------------------------------------------------------------------------------------
// PLANNED: order, prior versions, fencing

async function plan(deps: StepDeps, ctx: StepContext): Promise<StepResult> {
  const r = ctx.record;
  const { app, env, registry } = await environment(deps, r);
  const committed = ctx.meta.committed;
  if (r.expectedCurrentGeneration !== null && r.expectedCurrentGeneration !== (committed?.generation ?? 0)) {
    fail('stale_generation', 'the environment changed since this request was made');
  }
  const manifest = await loadManifest(deps, r, app, env);
  const manifestSha256 = r.requestedManifestSha256;
  if (manifestSha256 === null) return fail('internal', 'planning without a verified manifest digest');
  const order = topologicalOrder(manifest.targets);
  const targets: Record<string, TargetPlan> = {};
  for (const id of order) {
    const t = manifest.targets.find((x) => x.id === id);
    const registered = env.targets.find((x) => x.id === id);
    if (!t || !registered) return fail('target_not_registered', id);
    const api = await deps.cloudflare(registered.credential);
    targets[id] = {
      id,
      registryTarget: registered,
      priorVersionId: await readPriorVersion(api, registered.scriptName),
      artifactPath: t.artifactPath,
      artifactSha256: t.sha256,
      healthContract: t.healthContract,
    };
  }
  const planned: Plan = {
    registryRevision: registry.revision,
    generation: (committed?.generation ?? 0) + 1,
    expectedPriorDeploymentId: committed?.deploymentId ?? null,
    order,
    targets,
    archive: { key: releaseKey(r.application, r.requestedReleaseTag, 'release.zip'), size: manifest.artifact.sizeBytes },
    manifestSha256,
  };
  const priorRelease = committed ? { tag: committed.releaseTag, manifestSha256: committed.manifestSha256, generation: committed.generation } : null;
  return { kind: 'transition', to: 'DEPLOYING_TARGETS', patch: { plan: planned, priorRelease }, detail: `targets: ${order.join(', ')}` };
}

// -------------------------------------------------------------------------------------------------
// DEPLOYING_TARGETS: one target per step, checkpointed

export async function operationId(deploymentId: string, targetId: string, kind: 'deploy' | 'rollback'): Promise<string> {
  return (await sha256Hex(`${kind}:${deploymentId}:${targetId}`)).slice(0, 24);
}

async function deployNext(deps: StepDeps, ctx: StepContext): Promise<StepResult> {
  let r = ctx.record;
  const p = r.plan;
  if (!p) return fail('internal', 'deploying without a plan');
  const nextId = p.order.find((id) => !r.completedTargets.some((c) => c.id === id));
  if (nextId === undefined) {
    const health: HealthProgress = { targets: [...p.order], index: 0, attempt: 0, nextAt: deps.clock.now(), expectTag: r.requestedReleaseTag };
    return { kind: 'transition', to: 'HEALTH_CHECKING', patch: { health, currentTarget: null } };
  }
  const t = p.targets[nextId];
  if (!t) return fail('internal', `plan has no target ${nextId}`);
  const source = releasedArchive(deps.storage, r.application, r.requestedReleaseTag, p.archive.size);
  const { artifact, modules } = await loadWorker(await openZip(source), source, t.artifactPath, t.artifactSha256);
  const api = await deps.cloudflare(t.registryTarget.credential);
  const op = await operationId(r.deploymentId, t.id, 'deploy');

  // From here on the serving state may change; recovery must consider this target.
  r = ctx.save({ currentTarget: t.id, mutated: true });
  const result = await deployWorker({ api, target: t.registryTarget, artifact, modules, operationId: op, deploymentId: r.deploymentId, releaseTag: r.requestedReleaseTag });
  log('info', 'deploy.target', { deploymentId: r.deploymentId, target: t.id, versionId: result.versionId, created: result.created });
  return {
    kind: 'progress',
    patch: { currentTarget: null, completedTargets: [...r.completedTargets, { id: t.id, operationId: op, versionId: result.versionId }] },
  };
}

// -------------------------------------------------------------------------------------------------
// HEALTH_CHECKING (also used by recovery)

async function healthCheck(
  deps: StepDeps,
  ctx: StepContext,
  progress: HealthProgress | null,
  persist: (h: HealthProgress) => Partial<DeploymentRecord>,
  then: Phase,
  failCode: string,
): Promise<StepResult> {
  const r = ctx.record;
  if (!progress || !r.plan) return fail('internal', 'health check without progress');
  const id = progress.targets[progress.index];
  if (id === undefined) return { kind: 'transition', to: then };
  const now = deps.clock.now();
  if (progress.nextAt > now) return { kind: 'wait', untilMs: progress.nextAt };
  const t = r.plan.targets[id];
  if (!t) return fail('internal', `plan has no target ${id}`);
  const settings = t.registryTarget.health;
  const contract = { ...t.healthContract, expectReleaseTag: t.healthContract.expectReleaseTag && progress.expectTag !== null };
  const result = await probe(deps.fetcher, settings, contract, progress.expectTag ?? '');
  if (result.healthy) {
    return { kind: 'progress', patch: persist({ ...progress, index: progress.index + 1, attempt: 0, nextAt: now }) };
  }
  const attempt = progress.attempt + 1;
  if (attempt >= settings.attempts) fail(failCode, `${id} unhealthy after ${attempt} probes: ${result.reason}`);
  return { kind: 'wait', untilMs: now + settings.intervalMs, patch: persist({ ...progress, attempt, nextAt: now + settings.intervalMs }) };
}

// -------------------------------------------------------------------------------------------------
// COMMITTING: the pointer swap is the commit

async function commit(deps: StepDeps, ctx: StepContext): Promise<StepResult> {
  const r = ctx.record;
  const p = r.plan;
  if (!p) return fail('internal', 'committing without a plan');
  const previous = ctx.meta.committed;
  if ((previous?.deploymentId ?? null) !== p.expectedPriorDeploymentId) {
    fail('pointer_conflict', 'the committed release changed while this deployment ran');
  }
  const targets: CommittedRelease['targets'] = { ...(previous?.targets ?? {}) };
  for (const c of r.completedTargets) {
    const t = p.targets[c.id];
    if (t) targets[c.id] = { adapter: 'cloudflare-worker/v1', scriptName: t.registryTarget.scriptName, versionId: c.versionId };
  }
  const committed: CommittedRelease = {
    generation: p.generation,
    deploymentId: r.deploymentId,
    releaseTag: r.requestedReleaseTag,
    manifestSha256: p.manifestSha256,
    sourceCommit: r.sourceCommit,
    targets,
    committedAt: isoAt(deps.clock.now()),
  };
  await swapCurrentPointer(deps.state, r.application, r.environment, p.expectedPriorDeploymentId, pointerDocument(r.application, r.environment, committed));
  if (previous) {
    try {
      await putPointer(deps.state, pointerKey(r.application, r.environment, 'rollback'), pointerDocument(r.application, r.environment, previous));
    } catch {
      log('warn', 'pointer.rollback_snapshot_failed', { deploymentId: r.deploymentId });
    }
  }
  return { kind: 'transition', to: 'SUCCEEDED', commit: committed, detail: `generation ${committed.generation}` };
}

// -------------------------------------------------------------------------------------------------
// RECOVERING: reverse order to prior versions, then health against the prior release

async function recover(deps: StepDeps, ctx: StepContext): Promise<StepResult> {
  const r = ctx.record;
  const p = r.plan;
  const rec = r.recovery;
  if (!p || !rec) return fail('internal', 'recovering without a plan');
  const touched = p.order.filter((id) => r.completedTargets.some((c) => c.id === id) || r.currentTarget === id).reverse();
  const pending = touched.find((id) => !rec.reverted.includes(id));
  if (pending !== undefined) {
    const t = p.targets[pending];
    if (!t) return fail('internal', `plan has no target ${pending}`);
    if (t.priorVersionId === null) {
      fail('no_prior_version', `${pending} had no previous version to return to (first deploy); manual action required`);
    }
    const api = await deps.cloudflare(t.registryTarget.credential);
    await rollbackWorker(api, t.registryTarget.scriptName, t.priorVersionId, await operationId(r.deploymentId, pending, 'rollback'));
    return { kind: 'progress', patch: { recovery: { ...rec, reverted: [...rec.reverted, pending] } } };
  }
  const health: HealthProgress = rec.health ?? {
    targets: [...rec.reverted],
    index: 0,
    attempt: 0,
    nextAt: deps.clock.now(),
    expectTag: ctx.meta.committed?.releaseTag ?? null,
  };
  return healthCheck(deps, ctx, health, (h) => ({ recovery: { ...rec, health: h } }), 'ROLLED_BACK', 'recovery_health_failed');
}
