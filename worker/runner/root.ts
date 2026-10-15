import { fail, summarize } from '../lib/errors.ts';
import type { Json } from '../lib/json.ts';
import { sha256Hex } from '../lib/json.ts';
import { log, uuidv7, type Clock } from '../lib/runtime.ts';
import { PATTERNS } from '../lib/validate.ts';
import type { RunnerJobRequest, RunnerJobStatus } from './api.ts';
import { runnerStub, type RunnerNamespace } from './index.ts';
import { JOB_PROFILES } from './profiles.ts';
import { checkDeadline, parseJobRequest } from './request.ts';
import { ensureGeneratedSecrets, type SecretsStoreDeps } from './secrets-generate.ts';
import { parseTerraformSubject } from './subject.ts';

/**
 * The root runner's RPC surface, as pure logic. Called by the authorizer with
 * `{ token, job: { type: 'terraform.plan' | 'terraform.apply', subject } }` where `subject` is a
 * `terraform-subject/v1` for stack `infra-root`. The grant (`root.plan` / `root.apply`) is consumed
 * before anything else happens; only `ok: true` submits a RunnerJob of type `root.plan` /
 * `root.apply`. Before submitting, the generated passphrases are ensured (create-only).
 */

export type ConsumeResult =
  | { ok: true; grant: { action: string; subjectDigest: string; sub: string; jti: string; expiresAt: number } }
  | { ok: false; error: 'unknown' | 'replay' | 'expired' | 'mismatch' };

export interface AuthorizerRpc {
  consume(input: { tokenHash: string; action: string; subject: unknown }): Promise<ConsumeResult>;
}

export interface RootDeps {
  authorizer: AuthorizerRpc;
  runner: { RUNNER: RunnerNamespace };
  secrets: SecretsStoreDeps | null;
  clock: Clock;
}

export type RootRunResult = RunnerJobStatus | { state: 'rejected'; error: string };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export async function rootRunJob(deps: RootDeps, input: unknown): Promise<RootRunResult> {
  try {
    const { token, type, subject } = readInput(input);
    const operation = type === 'terraform.plan' ? 'plan' : 'apply';
    // Validate before consuming: a malformed request must not burn the grant.
    parseTerraformSubject(subject, { stack: 'infra-root', operation });
    const action = operation === 'plan' ? 'root.plan' : 'root.apply';
    const tokenHash = await sha256Hex(token);
    const consumed = await deps.authorizer.consume({ tokenHash, action, subject });
    if (!consumed.ok) return { state: 'rejected', error: `grant_${consumed.error}` };
    if (consumed.grant.action !== action) return { state: 'rejected', error: 'grant_mismatch' };

    await ensureSecrets(deps);
    const now = deps.clock.now();
    const jobType = operation === 'plan' ? 'root.plan' : 'root.apply';
    const request: RunnerJobRequest = {
      jobId: uuidv7(now),
      type: jobType,
      deadlineAt: Math.floor(now / 1000) + JOB_PROFILES[jobType].defaultRuntimeSeconds,
      input: subject as Json,
      notify: null,
    };
    parseJobRequest(request, 'root');
    checkDeadline(request, now);
    return await runnerStub(deps.runner, request.jobId).submit(request);
  } catch (error) {
    const s = summarize(error);
    log('warn', 'root.run_rejected', { code: s.code });
    return { state: 'rejected', error: s.code };
  }
}

export async function rootJobStatus(deps: Pick<RootDeps, 'runner'>, input: unknown): Promise<RunnerJobStatus | null> {
  const jobId = typeof input === 'object' && input !== null ? (input as { jobId?: unknown }).jobId : undefined;
  if (typeof jobId !== 'string' || !PATTERNS.uuidv7.test(jobId)) return null;
  return runnerStub(deps.runner, jobId).status();
}

function readInput(input: unknown): { token: string; type: 'terraform.plan' | 'terraform.apply'; subject: unknown } {
  const value = input as { token?: unknown; job?: { type?: unknown; subject?: unknown } } | null;
  const token = value?.token;
  const type = value?.job?.type;
  if (typeof token !== 'string' || !TOKEN.test(token)) return fail('grant_malformed', 'token is not a 43-character base64url string');
  if (type !== 'terraform.plan' && type !== 'terraform.apply') return fail('bad_job_type', 'job.type must be terraform.plan or terraform.apply');
  return { token, type, subject: value?.job?.subject };
}

/**
 * `secrets.generate`, run as the first step of every granted root job. Create-only and idempotent,
 * so running it on each grant is safe; failures are logged and the job continues (a missing
 * passphrase then fails the job closed when it is read).
 */
async function ensureSecrets(deps: RootDeps): Promise<void> {
  if (deps.secrets === null) return;
  try {
    const outcomes = await ensureGeneratedSecrets(deps.secrets);
    for (const o of outcomes) if (o.outcome === 'created') log('info', 'root.secret_generated', { name: o.name });
  } catch (error) {
    log('error', 'root.secret_generation_failed', { code: summarize(error).code });
  }
}
