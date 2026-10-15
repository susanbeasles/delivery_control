// The runner: one job per controller. Lease, container start with egress interception, envelope on stdin,
// bounded log capture, hard timeout, independent watchdog, container destroyed before the lease is released,
// outcome recorded once and never retried when uncertain. Never throws out of `run` or `watchdog`.
import { EnvelopeError, envelopeDigest, parseEnvelope, serializeEnvelope, sha256Hex, type Envelope } from './envelope.ts';
import type { JobTypeSpec } from './job-type.ts';
import { captureStream, renderCapture, type Captured } from './capture.ts';
import { createRedactor, type Redactor } from './redact.ts';
import type { ControllerDeps, ProcessHandle } from './ports.ts';
import type { ArtifactRef, JobRecord, LogRef, Outcome, OutcomeReason, OutcomeStatus, RunResult } from './records.ts';

export const TIMING = Object.freeze({
  /** Added to the job timeout to form the lease deadline: time the controller gets to kill, collect, upload and destroy. */
  deadlineGraceMs: 120_000,
  /** Between SIGTERM and SIGKILL at timeout. */
  killGraceMs: 5_000,
  /** How long log capture may continue after the job ended before it is cut off. */
  captureGraceMs: 5_000,
  /** Cap on the artifact listing itself. */
  listingBytes: 1_048_576,
});

const RELATIVE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/** A path under a directory: plain segments only, never `.` or `..`. */
export function isRelativePath(value: string): boolean {
  return RELATIVE_PATH.test(value) && value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

const STAGE_SCRIPT = 'umask 077 && mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

const CA_PATH = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
/**
 * Containers re-sign intercepted HTTPS with a Cloudflare CA. Because every HTTPS request is intercepted into the
 * outbound gate, that CA alone is the trust store for the job's tools.
 * Source: developers.cloudflare.com/containers/configuration/outbound-traffic (verified 2026-10-15).
 */
export const CONTAINER_TRUST_ENV: Readonly<Record<string, string>> = Object.freeze({
  SSL_CERT_FILE: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  NODE_EXTRA_CA_CERTS: CA_PATH,
});

const SIGTERM = 15;
const SIGKILL = 9;

type Verdict = { status: OutcomeStatus; reason: OutcomeReason; exitCode: number | null };

function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 512 ? `${text.slice(0, 512)}…` : text;
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const swallow = (): undefined => undefined;

export class JobController {
  readonly #deps: ControllerDeps;
  readonly #prefix: string;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
    this.#prefix = deps.logPrefix ?? 'logs/';
  }

  /** Submit a job. Idempotent per job id: a repeat returns the live state or the recorded outcome. */
  async run(bytes: Uint8Array): Promise<RunResult> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(bytes);
    } catch (error) {
      if (error instanceof EnvelopeError) return { kind: 'rejected', code: error.code };
      throw error;
    }
    const spec = this.#deps.jobTypes.get(envelope.job_type);
    if (spec === undefined) return { kind: 'rejected', code: 'unknown_job_type' };
    const digest = await envelopeDigest(envelope);
    const existing = this.#deps.store.get();
    if (existing !== undefined) {
      if (existing.job_id !== envelope.job_id || existing.envelope_digest !== digest) return { kind: 'rejected', code: 'envelope_mismatch' };
      if (existing.state === 'done' && existing.outcome !== null) return { kind: 'done', outcome: existing.outcome };
      if (existing.deadline_at > this.#deps.clock.now()) return { kind: 'running', job_id: existing.job_id, deadline_at: existing.deadline_at };
      // The controller that started this job never finished it. Nothing is retried: settle it for a human.
      return { kind: 'done', outcome: await this.#settleLost(existing) };
    }
    const now = this.#deps.clock.now();
    const record: JobRecord = {
      job_id: envelope.job_id,
      job_type: envelope.job_type,
      idempotency_key: envelope.idempotency_key,
      envelope_digest: digest,
      state: 'running',
      attempt: 1,
      started_at: now,
      deadline_at: now + spec.timeoutMs + TIMING.deadlineGraceMs,
      outcome: null,
    };
    this.#deps.store.put(record);
    await this.#deps.alarms.set(record.deadline_at);
    const outcome = await this.#execute(envelope, spec, record);
    return { kind: 'done', outcome: await this.#settle(record, outcome) };
  }

  /** Alarm handler: settles a job whose lease expired without an outcome. Re-arms when called early. */
  async watchdog(): Promise<void> {
    const record = this.#deps.store.get();
    if (record === undefined || record.state === 'done') return;
    if (this.#deps.clock.now() < record.deadline_at) {
      await this.#deps.alarms.set(record.deadline_at);
      return;
    }
    await this.#settleLost(record);
  }

  async #settleLost(record: JobRecord): Promise<Outcome> {
    const notes = ['lease expired without an outcome; the job may or may not have completed'];
    await this.#destroy(record.job_id, notes);
    const finishedAt = this.#deps.clock.now();
    return this.#settle(record, {
      v: 1,
      job_id: record.job_id,
      job_type: record.job_type,
      idempotency_key: record.idempotency_key,
      attempt: record.attempt,
      status: 'uncertain',
      reason: 'watchdog',
      exit_code: null,
      started_at: new Date(record.started_at).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      duration_ms: finishedAt - record.started_at,
      logs: { stdout: null, stderr: null },
      artifacts: [],
      notes,
    });
  }

  /** Record the outcome exactly once. If another path (the watchdog) already settled the job, its outcome stands. */
  async #settle(record: JobRecord, outcome: Outcome): Promise<Outcome> {
    const current = this.#deps.store.get();
    if (current !== undefined && current.state === 'done' && current.outcome !== null) return current.outcome;
    this.#deps.store.put({ ...record, state: 'done', outcome });
    try {
      await this.#deps.sink.put(this.#key(record, 'outcome.json'), new TextEncoder().encode(JSON.stringify(outcome)), 'application/json');
    } catch (error) {
      this.#deps.observe?.({ stage: 'outcome_upload', job_id: record.job_id, detail: describe(error) });
    }
    try {
      await this.#deps.alarms.clear();
    } catch (error) {
      this.#deps.observe?.({ stage: 'alarm', job_id: record.job_id, detail: describe(error) });
    }
    return outcome;
  }

  #key(record: JobRecord, file: string): string {
    return `${this.#prefix}${record.job_type}/${record.job_id}/${file}`;
  }

  async #execute(envelope: Envelope, spec: JobTypeSpec, record: JobRecord): Promise<Outcome> {
    const { container, clock } = this.#deps;
    const notes: string[] = [];
    const abort = new AbortController();
    const stopCapture = new AbortController();
    let phase: 'starting' | 'running' = 'starting';
    let secrets: Record<string, string> = {};
    let verdict: Verdict;
    let stdout: Promise<Captured> | undefined;
    let stderr: Promise<Captured> | undefined;
    try {
      secrets = await this.#resolveSecrets(spec, envelope);
      const image = container.images[spec.image];
      if (image === undefined) throw new Error(`container image "${spec.image}" is not configured on this Worker`);
      container.start({ image, instance: spec.instance, enableInternet: false, labels: { job_id: envelope.job_id, job_type: envelope.job_type } });
      const outbound = this.#deps.outbound(spec, envelope);
      await container.interceptAllOutboundHttp(outbound);
      await container.interceptOutboundHttps('*', outbound);
      const env: Record<string, string> = {
        ...CONTAINER_TRUST_ENV,
        ...secrets,
        RUNNER_JOB_ID: envelope.job_id,
        RUNNER_JOB_TYPE: envelope.job_type,
        RUNNER_ATTEMPT: String(record.attempt),
      };
      await this.#stageFiles(spec, envelope, notes);
      const proc = await container.exec(spec.command, { env, stdin: bytesStream(serializeEnvelope(envelope)), stdout: 'pipe', stderr: 'pipe' });
      phase = 'running';
      stdout = captureStream(proc.stdout, spec.maxLogBytes, stopCapture.signal);
      stderr = captureStream(proc.stderr, spec.maxLogBytes, stopCapture.signal);
      verdict = await this.#await(proc, spec, abort.signal, notes);
    } catch (error) {
      verdict = phase === 'starting' ? { status: 'failed', reason: 'start_failed', exitCode: null } : { status: 'uncertain', reason: 'controller_error', exitCode: null };
      notes.push(`${phase}: ${describe(error)}`);
    }
    const redactor = createRedactor(secrets);
    const artifacts = phase === 'running' ? await this.#collectArtifacts(spec, record, notes, abort.signal) : [];
    const logs = await this.#storeLogs(record, stdout, stderr, stopCapture, redactor, notes, abort.signal);
    await this.#destroy(record.job_id, notes);
    abort.abort();
    const finishedAt = clock.now();
    return {
      v: 1,
      job_id: envelope.job_id,
      job_type: envelope.job_type,
      idempotency_key: envelope.idempotency_key,
      attempt: record.attempt,
      status: verdict.status,
      reason: verdict.reason,
      exit_code: verdict.exitCode,
      started_at: new Date(record.started_at).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      duration_ms: finishedAt - record.started_at,
      logs,
      artifacts,
      notes: notes.map((note) => redactor.apply(note)),
    };
  }

  /** Write the files the consumer stages for this job into the container before the job runs. Any failure is a start failure. */
  async #stageFiles(spec: JobTypeSpec, envelope: Envelope, notes: string[]): Promise<void> {
    const stage = this.#deps.stage;
    const cfg = spec.stage;
    if (stage === undefined || cfg === undefined) return;
    const files = await stage(spec, envelope);
    if (files.length > cfg.maxFiles) throw new Error(`stage: ${files.length} files exceed the limit of ${cfg.maxFiles}`);
    let budget = cfg.maxBytes;
    const seen = new Set<string>();
    for (const file of files) {
      if (!isRelativePath(file.path) || seen.has(file.path)) throw new Error(`stage: unsafe or duplicate path ${file.path}`);
      seen.add(file.path);
      budget -= file.bytes.byteLength;
      if (budget < 0) throw new Error(`stage: files exceed the budget of ${cfg.maxBytes} bytes`);
      const proc = await this.#deps.container.exec(['/bin/sh', '-c', STAGE_SCRIPT, 'stage', `${cfg.dir}/${file.path}`], {
        stdin: bytesStream(file.bytes),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exit = await proc.exitCode;
      if (exit !== 0) throw new Error(`stage: writing ${file.path} exited ${exit}`);
    }
    if (files.length > 0) notes.push(`staged ${files.length} file(s) under ${cfg.dir}`);
  }

  /** Copy the job's output files out of the container before it is destroyed. Bounded, sorted, never fatal. */
  async #collectArtifacts(spec: JobTypeSpec, record: JobRecord, notes: string[], signal: AbortSignal): Promise<ArtifactRef[]> {
    const cfg = spec.artifacts;
    const { container } = this.#deps;
    if (cfg === undefined || !container.running) return [];
    const collected: ArtifactRef[] = [];
    try {
      const paths = await this.#listArtifacts(cfg.dir, signal);
      if (paths === undefined) {
        notes.push('artifact listing failed');
        return [];
      }
      const selected = paths.slice(0, cfg.maxFiles);
      if (paths.length > selected.length) notes.push(`${paths.length - selected.length} artifact files beyond the limit of ${cfg.maxFiles} were not collected`);
      let budget = cfg.maxBytes;
      for (const path of selected) {
        const relative = path.slice(cfg.dir.length + 1);
        if (!path.startsWith(`${cfg.dir}/`) || !isRelativePath(relative)) {
          notes.push(`artifact skipped: unsafe path`);
          continue;
        }
        const proc = await container.exec(['cat', path], { stdout: 'pipe', stderr: 'pipe' });
        const captured = await captureStream(proc.stdout, Math.max(budget, 1), signal);
        const exit = await proc.exitCode.then((code) => code, () => -1);
        if (exit !== 0 || captured.interrupted) {
          notes.push(`artifact skipped: ${relative} could not be read`);
          continue;
        }
        if (captured.truncated || captured.totalBytes > budget) {
          notes.push(`artifact skipped: ${relative} (${captured.totalBytes} bytes) exceeds the remaining budget of ${budget} bytes`);
          continue;
        }
        const key = this.#key(record, `artifacts/${relative}`);
        await this.#deps.sink.put(key, captured.head, 'application/octet-stream');
        budget -= captured.totalBytes;
        collected.push({ path: relative, key, bytes: captured.totalBytes, sha256: await sha256Hex(captured.head) });
      }
    } catch (error) {
      const detail = describe(error);
      notes.push(`artifact collection failed: ${detail}`);
      this.#deps.observe?.({ stage: 'artifact_upload', job_id: record.job_id, detail });
    }
    return collected;
  }

  async #listArtifacts(dir: string, signal: AbortSignal): Promise<string[] | undefined> {
    const proc = await this.#deps.container.exec(['find', dir, '-type', 'f', '-print0'], { stdout: 'pipe', stderr: 'pipe' });
    const listing = await captureStream(proc.stdout, TIMING.listingBytes, signal);
    const exit = await proc.exitCode.then((code) => code, () => -1);
    if (exit !== 0 || listing.truncated || listing.interrupted) return undefined;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(listing.head)
      .split('\0')
      .filter((path) => path.length > 0)
      .sort();
  }

  async #resolveSecrets(spec: JobTypeSpec, envelope: Envelope): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const name of spec.secrets) {
      const value = await this.#deps.secrets.get(name, envelope);
      if (typeof value !== 'string' || value.length === 0) throw new Error(`secret ${name} is empty`);
      values[name] = value;
    }
    return values;
  }

  async #await(proc: ProcessHandle, spec: JobTypeSpec, signal: AbortSignal, notes: string[]): Promise<Verdict> {
    const { container, clock } = this.#deps;
    const result = await Promise.race([
      proc.exitCode.then(
        (code) => ({ kind: 'exit' as const, code }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      clock.sleep(spec.timeoutMs, signal).then(
        () => ({ kind: 'timeout' as const }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      container.monitor().then(
        () => ({ kind: 'died' as const }),
        () => ({ kind: 'died' as const }),
      ),
    ]);
    switch (result.kind) {
      case 'exit':
        return result.code === 0 ? { status: 'succeeded', reason: 'exit_zero', exitCode: 0 } : { status: 'failed', reason: 'exit_nonzero', exitCode: result.code };
      case 'timeout':
        notes.push(`killed after ${spec.timeoutMs} ms`);
        await this.#kill(proc, signal);
        return { status: 'failed', reason: 'timeout', exitCode: null };
      case 'died':
        notes.push('container exited before the job reported');
        return { status: 'uncertain', reason: 'container_exited', exitCode: null };
      case 'error':
        notes.push(`exit status unavailable: ${describe(result.error)}`);
        return { status: 'uncertain', reason: 'controller_error', exitCode: null };
    }
  }

  async #kill(proc: ProcessHandle, signal: AbortSignal): Promise<void> {
    try {
      proc.kill(SIGTERM);
    } catch {
      return;
    }
    await Promise.race([proc.exitCode.then(swallow, swallow), this.#deps.clock.sleep(TIMING.killGraceMs, signal).then(swallow, swallow)]);
    try {
      proc.kill(SIGKILL);
    } catch {
      // already gone
    }
  }

  async #storeLogs(
    record: JobRecord,
    stdout: Promise<Captured> | undefined,
    stderr: Promise<Captured> | undefined,
    stopCapture: AbortController,
    redactor: Redactor,
    notes: string[],
    signal: AbortSignal,
  ): Promise<Outcome['logs']> {
    if (stdout === undefined || stderr === undefined) return { stdout: null, stderr: null };
    void this.#deps.clock.sleep(TIMING.captureGraceMs, signal).then(() => stopCapture.abort(), swallow);
    const [out, err] = await Promise.all([stdout, stderr]);
    return {
      stdout: await this.#putLog(record, 'stdout', out, redactor, notes),
      stderr: await this.#putLog(record, 'stderr', err, redactor, notes),
    };
  }

  async #putLog(record: JobRecord, name: 'stdout' | 'stderr', captured: Captured, redactor: Redactor, notes: string[]): Promise<LogRef | null> {
    const key = this.#key(record, `${name}.log`);
    const body = renderCapture(captured, redactor);
    try {
      await this.#deps.sink.put(key, body, 'text/plain; charset=utf-8');
      return { key, bytes: body.byteLength, truncated: captured.truncated };
    } catch (error) {
      const detail = describe(error);
      notes.push(`${name} upload failed: ${detail}`);
      this.#deps.observe?.({ stage: 'log_upload', job_id: record.job_id, detail });
      return null;
    }
  }

  async #destroy(jobId: string, notes: string[]): Promise<void> {
    const { container } = this.#deps;
    if (!container.running) return;
    try {
      await container.destroy();
    } catch (error) {
      const detail = describe(error);
      notes.push(`container destroy failed: ${detail}`);
      this.#deps.observe?.({ stage: 'destroy', job_id: jobId, detail });
    }
  }
}
