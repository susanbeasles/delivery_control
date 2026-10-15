import { DeployError, summarize, type ErrorSummary } from '../lib/errors.ts';
import { compareReleaseTags, isoAt, log, uuidv7, type Clock } from '../lib/runtime.ts';
import type { GitHubReporter } from '../github/github-api.ts';
import { eventKey, ledgerPrefix, putCreateOnly } from './ledger.ts';
import type { TxStore } from './store.ts';
import {
  isTerminal,
  type CommittedRelease,
  publicState,
  type AdmissionResult,
  type DeployKick,
  type DeploymentRecord,
  type DeploymentState,
  type GitHubStatusState,
  type Meta,
  type OutboxEntry,
  type Phase,
  type PromotionRequest,
  type StoredError,
} from './types.ts';

/**
 * The per-application-environment coordinator. One instance owns one `application:environment`
 * key. It is the only writer of that key's deployment state, so every decision is a synchronous
 * transaction over its own storage; external effects happen between transactions under a fenced
 * lease and are recorded before and after they run.
 */

export const SLICE_MS = 50_000;
export const LEASE_MS = 5 * 60_000;
export const DEPLOY_BUDGET_MS = 60 * 60_000;
export const RECOVERY_BUDGET_MS = 20 * 60_000;
export const MAX_RETRIES = 6;
const HISTORY_LIMIT = 50;
const WATCHDOG_MS = 60_000;

/** What a step reports back to the loop. */
export type StepResult =
  | { kind: 'transition'; to: Phase; patch?: Partial<DeploymentRecord>; detail?: string; commit?: CommittedRelease }
  | { kind: 'progress'; patch: Partial<DeploymentRecord> }
  | { kind: 'wait'; untilMs: number; patch?: Partial<DeploymentRecord> };

/** Lets a step persist intermediate progress under the lease before an irreversible call. */
export interface StepContext {
  record: DeploymentRecord;
  meta: Meta;
  save(patch: Partial<DeploymentRecord>): DeploymentRecord;
}

export type StepRunner = (phase: Phase, ctx: StepContext) => Promise<StepResult>;

export interface EngineDeps {
  store: TxStore;
  clock: Clock;
  key: { application: string; environment: string };
  steps: StepRunner;
  ledger: R2Bucket;
  github: GitHubReporter | null;
  queue: { send(body: DeployKick, delaySeconds: number): Promise<void> };
  setAlarm(atMs: number): Promise<void>;
  /** Called on SUCCEEDED commit; returns the public environment URL for GitHub, if any. */
  environmentUrl(record: DeploymentRecord): string | null;
}

const META = 'meta';
const depKey = (id: string): string => `dep:${id}`;
const tokenKey = (hash: string): string => `token:${hash}`;
const outboxKey = (seq: number): string => `outbox:${String(seq).padStart(12, '0')}`;

/** Phases in which nothing that serves traffic has changed, so failure means REJECTED. */
const PRE_MUTATION: ReadonlySet<Phase> = new Set(['REQUESTED', 'AUTHORIZED', 'QUEUED', 'VERIFYING', 'PLANNED']);

export class CoordinatorEngine {
  private readonly d: EngineDeps;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;

  constructor(deps: EngineDeps) {
    this.d = deps;
  }

  // ---------------------------------------------------------------------------------------------
  // Reads

  private meta(): Meta {
    return (
      this.d.store.get<Meta>(META) ?? {
        key: `${this.d.key.application}:${this.d.key.environment}`,
        committed: null,
        history: [],
        active: null,
        next: null,
        lease: null,
        fence: 0,
        outboxSeq: 0,
        kick: 0,
      }
    );
  }

  private record(id: string): DeploymentRecord | undefined {
    return this.d.store.get<DeploymentRecord>(depKey(id));
  }

  status(deploymentId: string): DeploymentState | null {
    const r = this.record(deploymentId);
    return r ? publicState(r) : null;
  }

  committed(): Meta['committed'] {
    return this.meta().committed;
  }

  // ---------------------------------------------------------------------------------------------
  // Admission

  async admit(request: PromotionRequest, tokenHash: string, githubEnvironment: string): Promise<AdmissionResult> {
    const now = this.d.clock.now();
    const decision = this.d.store.transaction((): AdmissionResult => {
      const seen = this.d.store.get<string>(tokenKey(tokenHash));
      if (seen !== undefined) return this.admissionView(seen);

      const meta = this.meta();
      const committed = meta.committed;
      if (request.expectedCurrentGeneration !== null && request.expectedCurrentGeneration !== (committed?.generation ?? 0)) {
        return { status: 'REJECTED', error: 'stale_generation' };
      }

      let manifestSha = request.releaseManifestSha256;
      if (request.intent === 'deploy') {
        if (committed) {
          const order = compareReleaseTags(request.releaseTag, committed.releaseTag);
          if (order < 0) return { status: 'REJECTED', error: 'stale_release' };
          if (order === 0) {
            if (committed.manifestSha256 === manifestSha) return { status: 'ALREADY_CURRENT', deploymentId: committed.deploymentId, githubDeploymentId: null };
            return { status: 'REJECTED', error: 'release_conflict' };
          }
        }
        for (const slot of [meta.active, meta.next]) {
          const other = slot ? this.record(slot) : undefined;
          if (!other || isTerminal(other.phase) || other.intent !== 'deploy') continue;
          const order = compareReleaseTags(request.releaseTag, other.requestedReleaseTag);
          if (order < 0) return { status: 'REJECTED', error: 'stale_release' };
          if (order === 0) {
            // The same release is already on its way; this request joins it instead of duplicating it.
            this.d.store.put(tokenKey(tokenHash), other.deploymentId);
            return { status: 'QUEUED', deploymentId: other.deploymentId, githubDeploymentId: other.githubDeploymentId };
          }
        }
      } else {
        const earlier = meta.history.find((h) => h.releaseTag === request.releaseTag);
        if (!earlier) return { status: 'REJECTED', error: 'not_previously_deployed' };
        if (committed?.releaseTag === request.releaseTag) return { status: 'ALREADY_CURRENT', deploymentId: committed.deploymentId, githubDeploymentId: null };
        manifestSha = earlier.manifestSha256;
      }

      const record = this.newRecord(request, tokenHash, githubEnvironment, manifestSha, now);
      this.d.store.put(tokenKey(tokenHash), record.deploymentId);
      this.writeRecord(record);
      this.ledger(meta, `${ledgerPrefix(record.application, record.environment, record.deploymentId)}/accepted.json`, {
        schema: 'deployment-accepted/v1',
        deploymentId: record.deploymentId,
        request,
        acceptedAt: isoAt(now),
      });
      this.event(meta, record, 'AUTHORIZED', null, 'authorizer grant consumed');
      record.phase = 'QUEUED';
      this.event(meta, record, 'QUEUED', null, null);
      this.githubStatus(meta, record, 'queued', describe(record, 'QUEUED'));

      if (meta.active === null) {
        meta.active = record.deploymentId;
        this.enqueueKick(meta, record.deploymentId, 0);
      } else {
        if (meta.next !== null) this.supersede(meta, meta.next, record.requestedReleaseTag, now);
        meta.next = record.deploymentId;
      }
      this.writeRecord(record);
      this.d.store.put(META, meta);
      return { status: 'QUEUED', deploymentId: record.deploymentId, githubDeploymentId: null };
    });

    if (decision.status === 'QUEUED') {
      const githubDeploymentId = await this.ensureGitHubDeployment(decision.deploymentId);
      await this.flush();
      await this.scheduleWatchdog();
      return { ...decision, githubDeploymentId };
    }
    return decision;
  }

  private admissionView(deploymentId: string): AdmissionResult {
    const r = this.record(deploymentId);
    if (!r) return { status: 'REJECTED', error: 'internal' };
    if (r.phase === 'REJECTED') return { status: 'REJECTED', error: r.lastError?.code ?? 'rejected' };
    return { status: 'QUEUED', deploymentId: r.deploymentId, githubDeploymentId: r.githubDeploymentId };
  }

  private newRecord(request: PromotionRequest, tokenHash: string, githubEnvironment: string, manifestSha: string | null, now: number): DeploymentRecord {
    const at = isoAt(now);
    return {
      schema: 'deployment-state/v1',
      deploymentId: uuidv7(now),
      application: request.application,
      environment: request.environment,
      intent: request.intent,
      requestedReleaseTag: request.releaseTag,
      requestedManifestSha256: manifestSha,
      sourceCommit: request.sourceCommit,
      expectedCurrentGeneration: request.expectedCurrentGeneration,
      generation: 0,
      phase: 'REQUESTED',
      currentTarget: null,
      completedTargets: [],
      priorRelease: null,
      attempt: 0,
      startedAt: at,
      updatedAt: at,
      lastError: null,
      request,
      tokenHash,
      githubDeploymentId: request.githubDeploymentId,
      githubEnvironment,
      ingest: { staged: {}, reused: false, manifestChecked: false, archiveChecked: false, verifyJobId: null, verifyDeadlineAt: null, verified: false, promoted: false },
      plan: null,
      mutated: false,
      health: null,
      recovery: null,
      nextAttemptAt: 0,
      deadlineAt: now + DEPLOY_BUDGET_MS,
      eventSeq: 0,
    };
  }

  private supersede(meta: Meta, deploymentId: string, byTag: string, now: number): void {
    const old = this.record(deploymentId);
    if (!old || isTerminal(old.phase)) return;
    const error: StoredError = { code: 'superseded', message: `superseded by ${byTag}`, at: isoAt(now) };
    this.finish(meta, old, 'REJECTED', error, 'inactive');
  }

  // ---------------------------------------------------------------------------------------------
  // Execution

  /**
   * Drive the active deployment for one slice. Safe to call from any number of places at once:
   * only the caller holding the lease does work; the rest return immediately.
   */
  async advance(): Promise<'busy' | 'idle' | 'continue' | 'waiting' | 'done'> {
    const holder = crypto.randomUUID();
    const acquired = this.d.store.transaction(() => {
      const meta = this.meta();
      const now = this.d.clock.now();
      if (meta.active === null) return null;
      if (meta.lease && meta.lease.expiresAt > now) return 'busy' as const;
      meta.fence += 1;
      meta.lease = { holder, fence: meta.fence, expiresAt: now + LEASE_MS };
      this.d.store.put(META, meta);
      return meta.active;
    });
    if (acquired === null) {
      await this.flush();
      return 'idle';
    }
    if (acquired === 'busy') return 'busy';

    const started = this.d.clock.now();
    let outcome: 'continue' | 'waiting' | 'done' = 'continue';
    try {
      for (;;) {
        const record = this.record(acquired);
        if (!record || isTerminal(record.phase)) {
          outcome = 'done';
          break;
        }
        const now = this.d.clock.now();
        if (record.nextAttemptAt > now) {
          // A kick for that time is already queued and the alarm backs it up; do not add another.
          outcome = 'waiting';
          break;
        }
        if (now - started > SLICE_MS) {
          this.withLease(holder, (meta) => this.enqueueKick(meta, record.deploymentId, 0));
          outcome = 'continue';
          break;
        }
        let result: 'progressed' | 'waiting';
        try {
          result = await this.step(holder, record);
        } catch (error) {
          if (error instanceof DeployError && error.code === 'lease_lost') {
            log('warn', 'coordinator.lease_lost', { deploymentId: record.deploymentId });
            outcome = 'continue';
            break;
          }
          throw error;
        }
        if (result === 'waiting') {
          outcome = 'waiting';
          break;
        }
      }
    } finally {
      this.d.store.transaction(() => {
        const meta = this.meta();
        if (meta.lease?.holder === holder) {
          meta.lease = null;
          this.d.store.put(META, meta);
        }
      });
      await this.flush();
      await this.scheduleWatchdog();
    }
    return outcome;
  }

  private async step(holder: string, record: DeploymentRecord): Promise<'progressed' | 'waiting'> {
    const now = this.d.clock.now();
    if (now > record.deadlineAt) {
      this.fail(holder, record.deploymentId, { code: 'deadline_exceeded', message: 'deployment exceeded its time budget', retryable: false });
      return 'progressed';
    }
    const ctx: StepContext = {
      record,
      meta: this.meta(),
      save: (patch) =>
        this.withLease(holder, () => {
          const fresh = this.mustRecord(record.deploymentId);
          Object.assign(fresh, patch, { updatedAt: isoAt(this.d.clock.now()) });
          this.writeRecord(fresh);
          return fresh;
        }),
    };
    let result: StepResult;
    try {
      result = await this.d.steps(record.phase, ctx);
    } catch (error) {
      const summary = summarize(error);
      if (error instanceof DeployError && error.code === 'lease_lost') throw error;
      this.fail(holder, record.deploymentId, summary);
      return 'progressed';
    }

    return this.withLease(holder, (meta) => {
      const fresh = this.mustRecord(record.deploymentId);
      const at = this.d.clock.now();
      if (result.patch) Object.assign(fresh, result.patch);
      fresh.updatedAt = isoAt(at);
      if (result.kind === 'wait') {
        fresh.nextAttemptAt = result.untilMs;
        this.writeRecord(fresh);
        this.enqueueKick(meta, fresh.deploymentId, Math.max(0, Math.ceil((result.untilMs - at) / 1000)));
        return 'waiting';
      }
      if (result.kind === 'transition') {
        fresh.attempt = 0;
        fresh.lastError = null;
        fresh.nextAttemptAt = 0;
        if (result.commit) this.recordCommit(meta, fresh, result.commit);
        if (isTerminal(result.to)) {
          // A completed rollback is still a failed deployment: keep the reason it was rolled back.
          const reason = result.to === 'ROLLED_BACK' ? (fresh.recovery?.reason ?? null) : null;
          this.finish(meta, fresh, result.to, reason, result.to === 'SUCCEEDED' ? 'success' : 'failure');
        } else {
          fresh.phase = result.to;
          this.event(meta, fresh, result.to, null, result.detail ?? null);
          this.writeRecord(fresh);
          const github = githubStateFor(result.to);
          if (github) this.githubStatus(meta, fresh, github, describe(fresh, result.to));
        }
        return 'progressed';
      }
      this.writeRecord(fresh);
      return 'progressed';
    });
  }

  /** Route a failure: retry, reject, recover, or stop for a human. */
  private fail(holder: string, deploymentId: string, error: ErrorSummary): void {
    this.withLease(holder, (meta) => {
      const r = this.mustRecord(deploymentId);
      const now = this.d.clock.now();
      const stored: StoredError = { code: error.code, message: error.message, at: isoAt(now) };
      r.lastError = stored;
      r.updatedAt = stored.at;
      if (error.retryable && r.attempt < MAX_RETRIES && now <= r.deadlineAt) {
        r.attempt += 1;
        r.nextAttemptAt = now + Math.min(5_000 * 2 ** (r.attempt - 1), 5 * 60_000);
        this.event(meta, r, r.phase, stored, `retry ${r.attempt} of ${MAX_RETRIES}`);
        this.writeRecord(r);
        log('warn', 'deploy.retry', { deploymentId, phase: r.phase, code: error.code, attempt: r.attempt });
        return;
      }
      log('error', 'deploy.failure', { deploymentId, phase: r.phase, code: error.code });
      if (PRE_MUTATION.has(r.phase) || (r.phase === 'DEPLOYING_TARGETS' && !r.mutated)) {
        this.finish(meta, r, 'REJECTED', stored, 'failure');
      } else if (r.phase === 'DEPLOYING_TARGETS' || r.phase === 'HEALTH_CHECKING') {
        r.phase = 'RECOVERING';
        r.attempt = 0;
        r.nextAttemptAt = 0;
        // Recovery gets its own budget; the deployment's may be what just ran out.
        r.deadlineAt = now + RECOVERY_BUDGET_MS;
        r.recovery = { reason: stored, reverted: [], health: null };
        this.event(meta, r, 'RECOVERING', stored, 'reverting completed targets');
        this.writeRecord(r);
        this.githubStatus(meta, r, 'in_progress', `rolling back: ${stored.code}`);
      } else {
        // COMMITTING or RECOVERING: the system cannot prove a safe state on its own.
        this.finish(meta, r, 'RECOVERY_FAILED', stored, 'error');
      }
    });
  }

  /** Terminal transition: ledger result, GitHub status, and hand the slot to the next request. */
  private finish(meta: Meta, r: DeploymentRecord, phase: Phase, error: StoredError | null, github: GitHubStatusState): void {
    const now = this.d.clock.now();
    r.phase = phase;
    if (error) r.lastError = error;
    r.updatedAt = isoAt(now);
    r.nextAttemptAt = 0;
    this.event(meta, r, phase, error, null);
    this.ledger(meta, `${ledgerPrefix(r.application, r.environment, r.deploymentId)}/result.json`, {
      schema: 'deployment-result/v1',
      deploymentId: r.deploymentId,
      phase,
      state: publicState(r),
      finishedAt: isoAt(now),
    });
    this.writeRecord(r);
    this.githubStatus(meta, r, github, describe(r, phase));
    if (meta.active === r.deploymentId) {
      meta.active = meta.next;
      meta.next = null;
      if (meta.active) this.enqueueKick(meta, meta.active, 0);
    } else if (meta.next === r.deploymentId) {
      meta.next = null;
    }
    this.d.store.put(META, meta);
    log(phase === 'SUCCEEDED' ? 'info' : 'warn', 'deploy.finished', { deploymentId: r.deploymentId, phase, code: error?.code ?? null });
  }

  /** Applied inside the lease transaction when the COMMITTING step reports a successful swap. */
  private recordCommit(meta: Meta, r: DeploymentRecord, committed: CommittedRelease): void {
    r.priorRelease = meta.committed
      ? { tag: meta.committed.releaseTag, manifestSha256: meta.committed.manifestSha256, generation: meta.committed.generation }
      : null;
    meta.committed = committed;
    r.generation = committed.generation;
    const entry = {
      generation: committed.generation,
      deploymentId: committed.deploymentId,
      releaseTag: committed.releaseTag,
      manifestSha256: committed.manifestSha256,
      sourceCommit: committed.sourceCommit,
    };
    meta.history = [...meta.history.filter((h) => h.releaseTag !== committed.releaseTag), entry].slice(-HISTORY_LIMIT);
  }

  /** Run `fn` in a transaction only while `holder` still holds a live lease; renew it. */
  withLease<T>(holder: string, fn: (meta: Meta) => T): T {
    return this.d.store.transaction(() => {
      const meta = this.meta();
      const now = this.d.clock.now();
      if (meta.lease?.holder !== holder || meta.lease.expiresAt <= now) {
        throw new DeployError('lease_lost', 'coordinator lease expired or was taken over', { retryable: true });
      }
      meta.lease.expiresAt = now + LEASE_MS;
      // fn mutates this same meta object (slots, outbox sequence, commit); it is persisted once.
      const result = fn(meta);
      this.d.store.put(META, meta);
      return result;
    });
  }

  private mustRecord(id: string): DeploymentRecord {
    const r = this.record(id);
    if (!r) throw new DeployError('internal', `deployment ${id} vanished`);
    return r;
  }

  private writeRecord(r: DeploymentRecord): void {
    this.d.store.put(depKey(r.deploymentId), r);
  }

  // ---------------------------------------------------------------------------------------------
  // Outbox: ledger events, GitHub statuses, queue kicks. Written in the same transaction as the
  // state change they describe; delivered afterwards, at least once.

  private push(meta: Meta, entry: OutboxEntry): void {
    meta.outboxSeq += 1;
    this.d.store.put(outboxKey(meta.outboxSeq), entry);
  }

  private event(meta: Meta, r: DeploymentRecord, phase: Phase, error: StoredError | null, detail: string | null): void {
    r.eventSeq += 1;
    this.ledger(meta, eventKey(r.application, r.environment, r.deploymentId, r.eventSeq), {
      schema: 'deployment-event/v1',
      deploymentId: r.deploymentId,
      seq: r.eventSeq,
      at: isoAt(this.d.clock.now()),
      phase,
      error,
      detail,
    });
  }

  private ledger(meta: Meta, key: string, body: unknown): void {
    this.push(meta, { kind: 'ledger', key, body, attempts: 0 });
  }

  private githubStatus(meta: Meta, r: DeploymentRecord, state: GitHubStatusState, description: string): void {
    this.push(meta, { kind: 'github-status', deploymentId: r.deploymentId, state, description, attempts: 0 });
  }

  enqueueKick(meta: Meta, deploymentId: string, delaySeconds: number): void {
    this.push(meta, { kind: 'kick', deploymentId, delaySeconds: Math.min(delaySeconds, 12 * 60 * 60), attempts: 0 });
  }

  /** Kick the active deployment now; used when a runner job finishes. */
  async nudge(): Promise<void> {
    this.d.store.transaction(() => {
      const meta = this.meta();
      if (meta.active) {
        const r = this.record(meta.active);
        if (r && !isTerminal(r.phase)) {
          r.nextAttemptAt = 0;
          this.writeRecord(r);
        }
        this.enqueueKick(meta, meta.active, 0);
        this.d.store.put(META, meta);
      }
    });
    await this.flush();
  }

  /** Deliver the outbox. Concurrent callers share one delivery loop so no entry goes out twice. */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        await this.flushOnce();
      } while (this.flushAgain);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    const entries = this.d.store.list<OutboxEntry>('outbox:', 200);
    const blockedGitHub = new Set<string>();
    for (const [key, entry] of entries) {
      try {
        if (entry.kind === 'kick') {
          const meta = this.meta();
          await this.d.queue.send(
            { schema: 'deploy-kick/v1', application: this.d.key.application, environment: this.d.key.environment, deploymentId: entry.deploymentId, kick: meta.kick + 1 },
            entry.delaySeconds,
          );
          this.d.store.transaction(() => {
            const m = this.meta();
            m.kick += 1;
            this.d.store.put(META, m);
            this.d.store.delete(key);
          });
        } else if (entry.kind === 'ledger') {
          await putCreateOnly(this.d.ledger, entry.key, entry.body);
          this.d.store.delete(key);
        } else {
          // Statuses for one deployment must land in order; a failure holds back the later ones.
          if (blockedGitHub.has(entry.deploymentId)) continue;
          await this.deliverStatus(entry);
          this.d.store.delete(key);
        }
      } catch (error) {
        const summary = summarize(error);
        const attempts = entry.attempts + 1;
        const giveUp = entry.kind === 'github-status' ? attempts >= 8 : entry.kind === 'ledger' && summary.code === 'ledger_conflict' ? attempts >= 3 : false;
        if (entry.kind === 'github-status') blockedGitHub.add(entry.deploymentId);
        if (giveUp) {
          log('error', 'outbox.dropped', { kind: entry.kind, code: summary.code, attempts });
          this.d.store.delete(key);
        } else {
          this.d.store.put(key, { ...entry, attempts });
          log('warn', 'outbox.retry', { kind: entry.kind, code: summary.code, attempts });
        }
      }
    }
  }

  private async deliverStatus(entry: Extract<OutboxEntry, { kind: 'github-status' }>): Promise<void> {
    if (!this.d.github) return;
    const r = this.record(entry.deploymentId);
    if (!r) return;
    const id = r.githubDeploymentId ?? (await this.ensureGitHubDeployment(r.deploymentId));
    if (id === null) throw new DeployError('github_report', 'no GitHub deployment yet', { retryable: true });
    await this.d.github.createStatus({
      repository: r.request.repository,
      repositoryId: r.request.repositoryId,
      githubDeploymentId: id,
      state: entry.state,
      description: entry.description,
      environmentUrl: entry.state === 'success' ? this.d.environmentUrl(r) : null,
    });
  }

  /** Create the GitHub Deployment for a record once; best effort, retried through statuses. */
  private async ensureGitHubDeployment(deploymentId: string): Promise<number | null> {
    const r = this.record(deploymentId);
    if (!r) return null;
    if (r.githubDeploymentId !== null || !this.d.github) return r.githubDeploymentId;
    try {
      const id = await this.d.github.createDeployment({
        repository: r.request.repository,
        repositoryId: r.request.repositoryId,
        ref: r.sourceCommit,
        environment: r.githubEnvironment,
        production: r.environment === 'production',
        releaseTag: r.requestedReleaseTag,
        deploymentId: r.deploymentId,
      });
      this.d.store.transaction(() => {
        const fresh = this.record(deploymentId);
        if (fresh && fresh.githubDeploymentId === null) {
          fresh.githubDeploymentId = id;
          this.writeRecord(fresh);
        }
      });
      return id;
    } catch (error) {
      log('warn', 'github.deployment.create_failed', { deploymentId, code: summarize(error).code });
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Watchdog

  async scheduleWatchdog(): Promise<void> {
    const meta = this.meta();
    const pending = this.d.store.list('outbox:', 1).length > 0;
    if (meta.active === null && !pending) return;
    const now = this.d.clock.now();
    let at = now + WATCHDOG_MS;
    if (meta.lease) at = Math.min(at, meta.lease.expiresAt + 1_000);
    const active = meta.active ? this.record(meta.active) : undefined;
    if (active && active.nextAttemptAt > now) at = Math.min(at, active.nextAttemptAt + 500);
    await this.d.setAlarm(at);
  }

  /** Alarm handler: deliver the outbox and drive the active deployment even if no kick arrives. */
  async alarm(): Promise<void> {
    await this.flush();
    if (this.meta().active !== null) await this.advance();
    await this.scheduleWatchdog();
  }
}

function githubStateFor(phase: Phase): GitHubStatusState | null {
  if (phase === 'VERIFYING') return 'in_progress';
  return null;
}

function describe(r: DeploymentRecord, phase: Phase): string {
  const base = `${r.requestedReleaseTag} ${phase.toLowerCase().replace(/_/g, ' ')}`;
  return r.lastError && phase !== 'SUCCEEDED' ? `${base}: ${r.lastError.code}` : base;
}
