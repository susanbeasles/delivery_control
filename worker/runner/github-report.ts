import { fail } from '../lib/errors.ts';
import { fetchBounded, statusError, type Fetcher } from '../lib/fetch.ts';
import { isPlainObject, parseStrictJsonBytes } from '../lib/json.ts';
import { GITHUB_API, headers } from '../github/app.ts';
import type { RunnerJobRequest, RunnerJobStatus } from './api.ts';
import type { RepositoryTokens } from './github-source.ts';
import { parsePlanSummary, type PlanSummary } from './plan-summary.ts';
import { JOB_PROFILES } from './profiles.ts';
import { parseTerraformSubject, type TerraformSubject } from './subject.ts';

/**
 * GitHub is the audit surface for terraform jobs: a check run on the pull request head after a
 * plan, and a Deployment with a status on the applied commit. Reporting is best effort and runs
 * after the job is terminal; it can never change an outcome.
 */

export interface ReportDeps {
  tokens: RepositoryTokens;
  fetcher: Fetcher;
}

const OUTPUT_LIMIT = 60_000;

async function post(deps: ReportDeps, subject: TerraformSubject, path: string, body: unknown, permission: 'checks' | 'deployments'): Promise<unknown> {
  const token = await deps.tokens.repositoryToken(subject.repository, subject.repositoryId, { [permission]: 'write' });
  const response = await fetchBounded(
    deps.fetcher,
    `${GITHUB_API}/repos/${subject.repository}${path}`,
    { method: 'POST', headers: { ...headers(`Bearer ${token}`), 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 10_000, maxBytes: 256 * 1024, redirect: 'manual' },
    'github_report',
  );
  if (response.status !== 201) throw statusError('github_report', path, response.status);
  return parseStrictJsonBytes(response.bytes, 256 * 1024, 'github_report');
}

export function planCheckName(subject: TerraformSubject): string {
  return `terraform plan / ${subject.stack}`;
}

/** Check-run body for a finished plan job. Pure, so its content is unit-tested. */
export function planCheckRun(subject: TerraformSubject, status: RunnerJobStatus, summary: PlanSummary | null): Record<string, unknown> {
  const ok = status.state === 'succeeded' && summary !== null;
  const conclusion = ok && summary.policyPassed ? 'success' : 'failure';
  const title = ok
    ? `${summary.addCount} to add, ${summary.changeCount} to change, ${summary.destroyCount} to destroy${summary.policyPassed ? '' : ' (policy failed)'}`
    : `plan ${status.state}: ${status.error?.code ?? 'unknown'}`;
  const lines = [`Job \`${status.jobId}\` on tree \`${subject.treeSha}\` (commit \`${subject.commit}\`).`];
  if (ok) {
    lines.push('', `Policy from \`infra-root\` main at \`${summary.policyCommit}\`.`, '', '| Rule | Result | Messages |', '|---|---|---|');
    for (const p of summary.policy) lines.push(`| ${cell(p.rule)} | ${p.result} | ${cell(p.messages.join('; ')) || '-'} |`);
    lines.push('', `State serial ${summary.stateSerial ?? 'none'}, plan SHA-256 \`${summary.planSha256}\`.`);
  } else if (status.error) {
    lines.push('', `Error \`${status.error.code}\`: ${cell(status.error.message)}`);
  }
  if (status.logKey) lines.push('', `Log: \`runner-logs/${status.logKey}\`.`);
  return {
    name: planCheckName(subject),
    head_sha: subject.headSha,
    status: 'completed',
    conclusion,
    external_id: status.jobId,
    output: { title: title.slice(0, 255), summary: lines.join('\n').slice(0, OUTPUT_LIMIT) },
  };
}

/** Table cells: no pipes, no HTML, no newlines; the text is from our own policy and tools. */
function cell(text: string): string {
  return text.replace(/[|<>`\r\n]/g, ' ').slice(0, 1000);
}

export async function reportPlan(deps: ReportDeps, subject: TerraformSubject, status: RunnerJobStatus, summary: PlanSummary | null): Promise<void> {
  if (subject.headSha === null) return;
  await post(deps, subject, '/check-runs', planCheckRun(subject, status, summary), 'checks');
}

export function deploymentState(status: RunnerJobStatus): 'success' | 'failure' | 'error' {
  return status.state === 'succeeded' ? 'success' : status.state === 'uncertain' ? 'error' : 'failure';
}

export async function reportApply(deps: ReportDeps, subject: TerraformSubject, status: RunnerJobStatus): Promise<void> {
  const deployment = await post(
    deps,
    subject,
    '/deployments',
    {
      ref: subject.commit,
      task: 'terraform.apply',
      auto_merge: false,
      required_contexts: [],
      environment: subject.stack,
      description: `terraform apply ${subject.stack} via runner`,
      transient_environment: false,
      production_environment: true,
      payload: { jobId: status.jobId, treeSha: subject.treeSha },
    },
    'deployments',
  );
  const id = isPlainObject(deployment) ? deployment['id'] : undefined;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) fail('github_report', 'deployment response has no id');
  const description = status.state === 'succeeded' ? 'applied' : `${status.state}: ${status.error?.code ?? 'unknown'}`;
  await post(deps, subject, `/deployments/${id}/statuses`, { state: deploymentState(status), description: description.slice(0, 140), auto_inactive: true }, 'deployments');
}

/** Dispatch by job type; release verification is reported by the coordinator, not here. */
export async function reportTerraformJob(deps: ReportDeps | null, request: RunnerJobRequest, status: RunnerJobStatus): Promise<void> {
  const profile = JOB_PROFILES[request.type];
  if (deps === null || profile.stack === null || profile.operation === 'verify') return;
  const subject = parseTerraformSubject(request.input, { stack: profile.stack, operation: profile.operation });
  if (profile.operation === 'plan') {
    const summary = status.state === 'succeeded' ? parsePlanSummary(status.result, 'result_invalid') : null;
    await reportPlan(deps, subject, status, summary);
  } else {
    await reportApply(deps, subject, status);
  }
}
