import { fail } from '../lib/errors.ts';
import type { Json } from '../lib/json.ts';
import { systemClock, uuidv7, type Clock } from '../lib/runtime.ts';
import { PATTERNS } from '../lib/validate.ts';
import type { RunnerJobRequest, RunnerJobRpc, RunnerJobStatus } from './api.ts';
import { JOB_PROFILES } from './profiles.ts';
import { checkDeadline, parseJobRequest } from './request.ts';
import { parseTerraformSubject } from './subject.ts';

/**
 * What the deployer's `Deployer` entrypoint calls after it has consumed an authorizer grant.
 * Validation runs here, in the caller's isolate, so a malformed subject surfaces as a DeployError
 * with its code instead of an opaque error from across the RPC boundary.
 */

export interface RunnerNamespace {
  getByName(name: string): unknown;
}

export function runnerStub(env: { RUNNER: RunnerNamespace }, jobId: string): RunnerJobRpc {
  return env.RUNNER.getByName(jobId) as RunnerJobRpc;
}

export async function submitTerraformJob(
  env: { RUNNER: RunnerNamespace },
  subject: unknown,
  consumedAction: 'infra.plan' | 'infra.apply',
  options: { clock?: Clock } = {},
): Promise<RunnerJobStatus> {
  const type = consumedAction === 'infra.plan' ? 'terraform.plan' : consumedAction === 'infra.apply' ? 'terraform.apply' : fail('invalid_job_request', 'unknown action');
  const profile = JOB_PROFILES[type];
  parseTerraformSubject(subject, { stack: 'infra', operation: type === 'terraform.plan' ? 'plan' : 'apply' });
  const now = (options.clock ?? systemClock).now();
  // A fresh job per consumed grant: the grant is single-use, so a repeat call cannot reach here.
  const request: RunnerJobRequest = {
    jobId: uuidv7(now),
    type,
    deadlineAt: Math.floor(now / 1000) + profile.defaultRuntimeSeconds,
    input: subject as Json,
    notify: null,
  };
  parseJobRequest(request, 'deployer');
  checkDeadline(request, now);
  return runnerStub(env, request.jobId).submit(request);
}

export async function getRunnerJobStatus(env: { RUNNER: RunnerNamespace }, jobId: string): Promise<RunnerJobStatus | null> {
  if (typeof jobId !== 'string' || !PATTERNS.uuidv7.test(jobId)) fail('invalid_job_id', 'jobId must be a UUIDv7');
  return runnerStub(env, jobId).status();
}
