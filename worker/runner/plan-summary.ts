import { fail } from '../lib/errors.ts';
import type { Json } from '../lib/json.ts';
import { PATTERNS, Shape } from '../lib/validate.ts';
import type { StackName } from './profiles.ts';

/**
 * `terraform-plan-summary/v1`: written by the agent as `summary.json` next to the plan (last, so its
 * presence marks a complete plan) and returned as the plan job's result. The apply job is bound to
 * it: same stack and tree, `planSha256` equal to the stored plan file, policy passed, and state
 * serial and lineage unchanged since the plan.
 */

export type PolicyOutcome = 'pass' | 'fail' | 'warn' | 'exception' | 'skip';

export interface PolicyResult {
  rule: string;
  result: PolicyOutcome;
  messages: string[];
}

export interface PlanSummary {
  schema: 'terraform-plan-summary/v1';
  jobId: string;
  stack: StackName;
  repository: string;
  commit: string;
  treeSha: string;
  /** infra-root `main` commit the policy bundle was taken from. */
  policyCommit: string;
  addCount: number;
  changeCount: number;
  destroyCount: number;
  policy: PolicyResult[];
  policyPassed: boolean;
  /** `null` when no state existed yet (first plan of a stack). */
  stateSerial: number | null;
  stateLineage: string | null;
  planSha256: string;
  planJsonSha256: string;
}

const KEYS = [
  'schema', 'jobId', 'stack', 'repository', 'commit', 'treeSha', 'policyCommit', 'addCount', 'changeCount', 'destroyCount',
  'policy', 'policyPassed', 'stateSerial', 'stateLineage', 'planSha256', 'planJsonSha256',
] as const;

const MAX_POLICY_RESULTS = 200;
const MAX_MESSAGES = 50;
const LINEAGE = /^[A-Za-z0-9-]{1,64}$/;

export function parsePlanSummary(value: unknown, code: string): PlanSummary {
  const s = new Shape(value, code, 'summary', KEYS);
  s.literal('schema', 'terraform-plan-summary/v1');
  const policy = s.array('policy', 0, MAX_POLICY_RESULTS).map((item, index) => {
    const p = new Shape(item, code, `summary.policy[${index}]`, ['rule', 'result', 'messages']);
    return {
      rule: p.string('rule', /^[A-Za-z0-9_.:*-]{1,80}$/, 80),
      result: p.oneOf('result', ['pass', 'fail', 'warn', 'exception', 'skip'] as const),
      messages: p.stringArray('messages', /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/, 0, MAX_MESSAGES, 1000),
    };
  });
  const stateSerial = s.nullable('stateSerial', (shape, key) => shape.int(key, 0, Number.MAX_SAFE_INTEGER));
  const stateLineage = s.nullable('stateLineage', (shape, key) => shape.string(key, LINEAGE, 64));
  if ((stateSerial === null) !== (stateLineage === null)) fail(code, 'summary: stateSerial and stateLineage must both be null or both set');
  const summary: PlanSummary = {
    schema: 'terraform-plan-summary/v1',
    jobId: s.string('jobId', PATTERNS.uuidv7, 36),
    stack: s.oneOf('stack', ['infra', 'infra-root'] as const),
    repository: s.string('repository', PATTERNS.repository, 201),
    commit: s.string('commit', PATTERNS.commit, 40),
    treeSha: s.string('treeSha', PATTERNS.commit, 40),
    policyCommit: s.string('policyCommit', PATTERNS.commit, 40),
    addCount: s.int('addCount', 0, 100_000),
    changeCount: s.int('changeCount', 0, 100_000),
    destroyCount: s.int('destroyCount', 0, 100_000),
    policy,
    policyPassed: s.bool('policyPassed'),
    stateSerial,
    stateLineage,
    planSha256: s.string('planSha256', PATTERNS.sha256, 64),
    planJsonSha256: s.string('planJsonSha256', PATTERNS.sha256, 64),
  };
  // A summary claiming success while listing a failing rule is internally inconsistent.
  // (`exception` is a denial the policy itself excused; it does not fail the plan.)
  if (summary.policyPassed && policy.some((p) => p.result === 'fail')) {
    fail(code, 'summary: policyPassed contradicts a failing policy result');
  }
  return summary;
}

export function summaryJson(summary: PlanSummary): Json {
  return summary as unknown as Json;
}
