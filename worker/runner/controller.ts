import { DeployError, fail, summarize } from '../lib/errors.ts';
import { digestOf } from '../lib/json.ts';
import { isoAt, log, type Clock } from '../lib/runtime.ts';
import type { RunnerJobRequest, RunnerJobStatus, RunnerNotify } from './api.ts';
import { bootContainer, destroyAndConfirm, type ContainerPort } from './container.ts';
import type { EgressContext } from './egress/rules.ts';
import { launchAgent, type AgentExit, type AgentRun } from './exec.ts';
import { frameHeader, type RunnerJobEnvelope } from './framing.ts';
import { IMAGE, LIMITS } from './limits.ts';
import { LogSink, type LogBucket } from './log-sink.ts';
import { writeStackLock, type PlanBucket } from './plan-store.ts';
import type { Preparation } from './prepare.ts';
import { JOB_PROFILES, type RunnerRole } from './profiles.ts';
import { checkDeadline, parseJobRequest } from './request.ts';
import { interpretExit } from './result.ts';
import { parseTerraformSubject } from './subject.ts';
import { failed, unknownEnding, type JobRecord, type Outcome } from './types.ts';

/**
 * One runner job, driven by the Durable Object's alarm. Every transition is a synchronous storage
 * transaction; intent is persisted before each side effect (in particular `running` is written
 * before `exec`, so a lost exec of a mutating job can only ever be reported `uncertain`).
 *
 * While the agent runs, a heartbeat alarm every 30 s keeps the object resident and makes the
 * watchdog prompt. If the object restarts mid-run, the exec is lost with the old isolate; the next
 * alarm finds `running` with nothing in flight and ends the job `failed` or `uncertain`.
 */

export interface JobStorage {
  kv: { get(key: string): unknown; put(key: string, value: unknown): void; delete(key: string): boolean };
  transactionSync<T>(closure: () => T): T;
  setAlarm(scheduledTimeMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface EgressProps {
  jobId: string;
  type: RunnerJobRequest['type'];
}

export interface ControllerDeps<Gate> {
  storage: JobStorage;
  container: ContainerPort<Gate> | null;
  /** The `EgressGate` loopback binding with this job's props (`ctx.exports.EgressGate({ props })`). */
  gate(props: EgressProps): Gate;
  clock: Clock;
  sleep(ms: number): Promise<void>;
  role: RunnerRole;
  accountId: string;
  /** `ctx.id.name`: the object is addressed by jobId, so a mismatch is a routing bug. */
  objectName: string | null;
  prepare(request: RunnerJobRequest): Promise<Preparation>;
  logs: LogBucket;
  plans: PlanBucket;
  /** Best-effort GitHub reporting after the job is terminal. */
  report(record: JobRecord, status: RunnerJobStatus): Promise<void>;
  /** Best-effort coordinator nudge after the job is terminal. */
  notify(notify: RunnerNotify, jobId: string): Promise<void>;
}

const RECORD = 'job';

/** Fixed, credential-free environment for the agent process. */
export const EXEC_BASE_ENV: Readonly<Record<string, string>> = {
  PATH: '/opt/runner/bin:/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  HOME: '/tmp/job/home',
  NODE_EXTRA_CA_CERTS: IMAGE.cloudflareCa,
};

/** Name of the one secret a terraform agent receives, in its `exec` environment only. */
export const PASSPHRASE_ENV = 'RUNNER_TF_PASSPHRASE';

export class JobController<Gate> {
  private readonly deps: ControllerDeps<Gate>;
  private inflight: { run: AgentRun; recorded: Promise<void> } | null = null;
  private busy = false;

  constructor(deps: ControllerDeps<Gate>) {
    this.deps = deps;
  }

  // ── RPC ────────────────────────────────────────────────────────────────────────────────────

  async submit(raw: unknown): Promise<RunnerJobStatus> {
    const request = parseJobRequest(raw, this.deps.role);
    if (this.deps.objectName !== null && this.deps.objectName !== request.jobId) fail('job_misrouted', 'request reached the object of another job');
    const digest = await digestOf(request);
    const now = this.deps.clock.now();
    const created = this.deps.storage.transactionSync(() => {
      const existing = this.read();
      if (existing) {
        if (existing.requestDigest !== digest) fail('job_conflict', `job ${request.jobId} exists with a different request`);
        return false;
      }
      checkDeadline(request, now);
      this.write({
        schema: 'runner-job-record/v1',
        request,
        requestDigest: digest,
        phase: 'queued',
        outcome: null,
        submittedAt: isoAt(now),
        startedAt: null,
        finishedAt: null,
        logKey: null,
        prepareAttempts: 0,
        cleanupAttempts: 0,
        stackLocked: false,
        reported: false,
        notified: false,
      });
      return true;
    });
    if (created) {
      await this.deps.storage.setAlarm(now);
      log('info', 'runner.job_submitted', { jobId: request.jobId, type: request.type, deadlineAt: request.deadlineAt });
    }
    return toStatus(this.mustRead());
  }

  status(): RunnerJobStatus | null {
    const record = this.read();
    return record ? toStatus(record) : null;
  }

  /** What the egress gate may allow, and only while the agent is running and no outcome exists. */
  egressContext(): EgressContext | null {
    const record = this.read();
    if (!record || record.phase !== 'running' || record.outcome !== null) return null;
    const profile = JOB_PROFILES[record.request.type];
    if (profile.stack === null || profile.operation === 'verify') {
      return { jobId: record.request.jobId, type: record.request.type, stack: null, treeSha: null, accountId: this.deps.accountId };
    }
    const subject = parseTerraformSubject(record.request.input, { stack: profile.stack, operation: profile.operation });
    return { jobId: record.request.jobId, type: record.request.type, stack: subject.stack, treeSha: subject.treeSha, accountId: this.deps.accountId };
  }

  async alarm(): Promise<void> {
    if (this.busy) {
      // The previous alarm is still preparing in this isolate; just keep the heartbeat going.
      await this.heartbeat();
      return;
    }
    this.busy = true;
    try {
      await this.step();
    } catch (error) {
      // Never let the platform retry blindly: log, and come back on our own schedule.
      const s = summarize(error);
      log('error', 'runner.alarm_failed', { jobId: this.read()?.request.jobId ?? null, code: s.code });
      if (this.read()?.phase !== 'done') await this.deps.storage.setAlarm(this.deps.clock.now() + LIMITS.cleanupRetryMs);
    } finally {
      this.busy = false;
    }
  }

  /** Resolves once a running agent's exit has been recorded (tests and graceful shutdown). */
  async settled(): Promise<void> {
    await this.inflight?.recorded;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────

  private async step(): Promise<void> {
    const record = this.read();
    if (!record || record.phase === 'done') return;
    if (record.outcome === null && this.deps.clock.now() >= record.request.deadlineAt * 1000) {
      this.watchdog(record);
      return this.cleanup();
    }
    switch (record.phase) {
      case 'queued':
      case 'preparing':
        return this.prepareAndRun(record);
      case 'starting':
        // The isolate that was starting the container is gone; exec was never issued.
        this.decide(failed('start_interrupted', 'the runner restarted while starting the container'));
        return this.cleanup();
      case 'running':
        if (this.inflight === null) {
          this.decide(unknownEnding(this.mutating(record), 'execution_lost', 'the runner lost the agent (object restarted)'));
          return this.cleanup();
        }
        return this.heartbeat();
      case 'cleanup':
        return this.cleanup();
    }
  }

  private watchdog(record: JobRecord): void {
    const ran = record.phase === 'running';
    const outcome = ran
      ? unknownEnding(this.mutating(record), 'deadline_exceeded', 'the job overran its deadline and its container was destroyed')
      : failed('deadline_exceeded', 'the job reached its deadline before the agent started');
    this.decide(outcome);
    this.inflight?.run.kill();
    log('warn', 'runner.watchdog', { jobId: record.request.jobId, type: record.request.type, phase: record.phase, state: outcome.state });
  }

  private async prepareAndRun(record: JobRecord): Promise<void> {
    const { request } = record;
    const attempts = record.prepareAttempts + 1;
    this.update((r) => {
      r.phase = 'preparing';
      r.prepareAttempts = attempts;
      r.startedAt ??= isoAt(this.deps.clock.now());
    });
    await this.heartbeat();

    let preparation: Preparation;
    try {
      preparation = await this.deps.prepare(request);
    } catch (error) {
      const s = summarize(error);
      if (s.retryable && attempts < LIMITS.prepareAttempts) {
        log('warn', 'runner.prepare_retry', { jobId: request.jobId, code: s.code, attempt: attempts });
        await this.deps.storage.setAlarm(this.deps.clock.now() + LIMITS.prepareRetryMs);
        return;
      }
      this.decide(failed(s.code, s.message));
      return this.cleanup();
    }
    if (preparation.kind === 'finished') {
      this.decide(preparation.outcome);
      return this.cleanup();
    }

    const container = this.deps.container;
    if (!this.advance('preparing', 'starting')) return this.cleanup();
    try {
      if (container === null) fail('container_unavailable', 'no container is bound to this runner');
      await bootContainer(container, { gate: this.deps.gate({ jobId: request.jobId, type: request.type }), env: {}, sleep: this.deps.sleep });
    } catch (error) {
      const s = summarize(error);
      this.decide(failed(s.code === 'internal' ? 'container_start_failed' : s.code, s.message));
      return this.cleanup();
    }

    if (this.deps.clock.now() >= request.deadlineAt * 1000) {
      this.decide(failed('deadline_exceeded', 'the job reached its deadline before the agent started'));
      return this.cleanup();
    }
    // Intent before effect: from here on, a lost result of a mutating job is `uncertain`.
    if (!this.advance('starting', 'running')) return this.cleanup();
    const secrets = preparation.passphrase === null ? [] : [preparation.passphrase];
    const sink = new LogSink(this.deps.logs, `jobs/${request.type}/${request.jobId}/stderr.log`, secrets, { maxBytes: LIMITS.logBytes, partBytes: LIMITS.logPartBytes });
    const envelope: RunnerJobEnvelope = { schema: 'runner-job/v1', jobId: request.jobId, type: request.type, deadlineAt: request.deadlineAt, input: preparation.agentInput };
    const env: Record<string, string> = { ...EXEC_BASE_ENV };
    if (preparation.passphrase !== null) env[PASSPHRASE_ENV] = preparation.passphrase;
    let run: AgentRun;
    try {
      run = await launchAgent(container as ContainerPort<Gate>, {
        cmd: [IMAGE.node, IMAGE.agent],
        env,
        cwd: IMAGE.cwd,
        user: IMAGE.user,
        header: frameHeader(envelope, preparation.files),
        files: preparation.files,
        resultMaxBytes: LIMITS.resultBytes,
        log: sink,
      });
    } catch {
      this.decide(unknownEnding(this.mutating(record), 'exec_failed', 'the agent could not be started'));
      return this.cleanup();
    }
    log('info', 'runner.agent_started', { jobId: request.jobId, type: request.type });
    this.inflight = { run, recorded: run.done.then((exit) => this.record(exit, sink)) };
    await this.heartbeat();
  }

  /** Runs when the agent exits (outside the alarm): decide, then let the alarm clean up. */
  private async record(exit: AgentExit, sink: LogSink): Promise<void> {
    try {
      const logKey = await sink.close();
      const record = this.mustRead();
      this.decide(interpretExit(record.request, exit), logKey);
      log('info', 'runner.agent_exited', { jobId: record.request.jobId, exitCode: exit.exitCode, state: this.mustRead().outcome?.state ?? null });
    } catch (error) {
      log('error', 'runner.record_failed', { code: summarize(error).code });
    } finally {
      this.inflight = null;
      // Cleanup runs from the alarm; a late exit after the watchdog finished the job needs none.
      if (this.read()?.phase !== 'done') await this.deps.storage.setAlarm(this.deps.clock.now());
    }
  }

  private async cleanup(): Promise<void> {
    const record = this.mustRead();
    const outcome = record.outcome;
    if (outcome === null) throw new DeployError('internal', 'cleanup without an outcome');
    const { request } = record;
    const profile = JOB_PROFILES[request.type];

    // An uncertain apply blocks every later apply on its stack until a human clears the lock.
    if (outcome.state === 'uncertain' && profile.operation === 'apply' && profile.stack !== null && !record.stackLocked) {
      const subject = parseTerraformSubject(request.input, { stack: profile.stack, operation: 'apply' });
      try {
        const written = await writeStackLock(this.deps.plans, {
          schema: 'stack-lock/v1',
          stack: subject.stack,
          jobId: request.jobId,
          type: request.type,
          commit: subject.commit,
          treeSha: subject.treeSha,
          reason: outcome.error?.code ?? 'uncertain',
          lockedAt: isoAt(this.deps.clock.now()),
        });
        this.update((r) => {
          r.stackLocked = true;
        });
        log('error', 'runner.stack_locked', { jobId: request.jobId, stack: subject.stack, lock: written });
      } catch (error) {
        log('error', 'runner.stack_lock_failed', { jobId: request.jobId, code: summarize(error).code });
        await this.deps.storage.setAlarm(this.deps.clock.now() + LIMITS.cleanupRetryMs);
        return;
      }
    }

    if (this.deps.container !== null && !(await destroyAndConfirm(this.deps.container))) {
      this.update((r) => {
        r.cleanupAttempts += 1;
      });
      log('error', 'runner.cleanup_unconfirmed', { jobId: request.jobId, attempts: this.mustRead().cleanupAttempts });
      await this.deps.storage.setAlarm(this.deps.clock.now() + LIMITS.cleanupRetryMs);
      return;
    }

    this.update((r) => {
      r.phase = 'done';
      r.finishedAt = isoAt(this.deps.clock.now());
    });
    await this.deps.storage.deleteAlarm();
    log(outcome.state === 'succeeded' ? 'info' : 'warn', 'runner.job_finished', { jobId: request.jobId, type: request.type, state: outcome.state, code: outcome.error?.code ?? null });
    await this.afterTerminal();
  }

  private async afterTerminal(): Promise<void> {
    const record = this.mustRead();
    const status = toStatus(record);
    if (!record.reported) {
      this.update((r) => {
        r.reported = true;
      });
      await this.deps.report(record, status).catch((error: unknown) => log('warn', 'runner.report_failed', { jobId: status.jobId, code: summarize(error).code }));
    }
    const notify = record.request.notify;
    if (notify !== null && !record.notified) {
      this.update((r) => {
        r.notified = true;
      });
      await this.deps.notify(notify, status.jobId).catch((error: unknown) => log('warn', 'runner.notify_failed', { jobId: status.jobId, code: summarize(error).code }));
    }
  }

  // ── Storage ────────────────────────────────────────────────────────────────────────────────

  /** First outcome wins; later deciders (a late exit after the watchdog) only add the log key. */
  private decide(outcome: Outcome, logKey: string | null = null): void {
    this.update((r) => {
      if (logKey !== null) r.logKey ??= logKey;
      if (r.outcome !== null || r.phase === 'done') return;
      r.outcome = outcome;
      r.phase = 'cleanup';
    });
  }

  private advance(from: JobRecord['phase'], to: JobRecord['phase']): boolean {
    return this.deps.storage.transactionSync(() => {
      const r = this.mustRead();
      if (r.phase !== from || r.outcome !== null) return false;
      r.phase = to;
      this.write(r);
      return true;
    });
  }

  private async heartbeat(): Promise<void> {
    const record = this.read();
    if (!record || record.phase === 'done') return;
    const now = this.deps.clock.now();
    await this.deps.storage.setAlarm(Math.max(now, Math.min(now + LIMITS.heartbeatMs, record.request.deadlineAt * 1000)));
  }

  private mutating(record: JobRecord): boolean {
    return JOB_PROFILES[record.request.type].mutating;
  }

  private read(): JobRecord | null {
    return (this.deps.storage.kv.get(RECORD) as JobRecord | undefined) ?? null;
  }

  private mustRead(): JobRecord {
    const record = this.read();
    if (!record) throw new DeployError('job_not_found', 'no job recorded in this object');
    return record;
  }

  private write(record: JobRecord): void {
    this.deps.storage.kv.put(RECORD, record);
  }

  private update(change: (record: JobRecord) => void): void {
    this.deps.storage.transactionSync(() => {
      const record = this.mustRead();
      change(record);
      this.write(record);
    });
  }
}

export function toStatus(record: JobRecord): RunnerJobStatus {
  const terminal = record.phase === 'done' ? record.outcome : null;
  return {
    jobId: record.request.jobId,
    type: record.request.type,
    state: record.phase === 'queued' ? 'queued' : terminal ? terminal.state : 'running',
    result: terminal?.state === 'succeeded' ? terminal.result : null,
    error: terminal ? terminal.error : null,
    logKey: record.logKey,
    submittedAt: record.submittedAt,
    finishedAt: record.finishedAt,
  };
}
