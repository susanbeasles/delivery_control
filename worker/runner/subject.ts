import { fail } from '../lib/errors.ts';
import { PATTERNS, Shape } from '../lib/validate.ts';
import { STACKS, type StackName } from './profiles.ts';

/**
 * `terraform-subject/v1`: what the authorizer granted for a plan or an apply. Built by the
 * authorizer from verified GitHub evidence; the runner re-validates it fatally and binds it to the
 * pinned repository of its stack.
 */
export interface RequestedBy {
  actorId: number;
  runId: number;
  runAttempt: number;
  workflowRef: string;
  jobWorkflowRef: string;
  eventName: string;
}

export interface TerraformSubject {
  schema: 'terraform-subject/v1';
  operation: 'plan' | 'apply';
  stack: StackName;
  repository: string;
  repositoryId: number;
  /** Pull request the plan was requested for; absent for drift plans and applies. */
  pullRequest: number | null;
  /** For plans: the merge commit. For applies: the commit on `main` (the promoter's squash commit). */
  commit: string;
  /** Tree of `commit`. Plans are stored by tree because the squash merge keeps the tree. */
  treeSha: string;
  /** Pull request head, where the plan check run is posted. */
  headSha: string | null;
  requestedBy: RequestedBy;
}

const CODE = 'invalid_terraform_subject';
const MAX_ID = Number.MAX_SAFE_INTEGER;
const WORKFLOW_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml@refs\/[A-Za-z0-9_./-]{1,200}$/;

export function parseTerraformSubject(value: unknown, expected: { stack: StackName; operation: 'plan' | 'apply' }): TerraformSubject {
  const s = new Shape(
    value,
    CODE,
    'subject',
    ['schema', 'operation', 'stack', 'repository', 'repositoryId', 'commit', 'treeSha', 'requestedBy'],
    ['pullRequest', 'headSha'],
  );
  s.literal('schema', 'terraform-subject/v1');
  const operation = s.oneOf('operation', ['plan', 'apply'] as const);
  const stack = s.oneOf('stack', ['infra', 'infra-root'] as const);
  if (operation !== expected.operation) fail(CODE, `subject.operation must be ${expected.operation}`);
  if (stack !== expected.stack) fail(CODE, `subject.stack must be ${expected.stack}`);
  const repository = s.string('repository', PATTERNS.repository, 201);
  const repositoryId = s.int('repositoryId', 1, MAX_ID);
  const pinned = STACKS[stack];
  if (repository !== pinned.repository || repositoryId !== pinned.repositoryId) {
    fail(CODE, `subject.repository is not the pinned repository of stack ${stack}`);
  }
  const pullRequest = optional(s, 'pullRequest', () => s.int('pullRequest', 1, MAX_ID));
  const headSha = optional(s, 'headSha', () => s.string('headSha', PATTERNS.commit, 40));
  const by = s.object('requestedBy', ['actorId', 'runId', 'runAttempt', 'workflowRef', 'jobWorkflowRef', 'eventName']);
  return {
    schema: 'terraform-subject/v1',
    operation,
    stack,
    repository,
    repositoryId,
    pullRequest,
    commit: s.string('commit', PATTERNS.commit, 40),
    treeSha: s.string('treeSha', PATTERNS.commit, 40),
    headSha,
    requestedBy: {
      actorId: by.int('actorId', 1, MAX_ID),
      runId: by.int('runId', 1, MAX_ID),
      runAttempt: by.int('runAttempt', 1, 1000),
      workflowRef: by.string('workflowRef', WORKFLOW_REF, 420),
      jobWorkflowRef: by.string('jobWorkflowRef', WORKFLOW_REF, 420),
      eventName: by.string('eventName', /^[a-z_]{1,40}$/, 40),
    },
  };
}

/** Optional fields may be absent or `null`; both mean "not given". */
function optional<T>(s: Shape, key: string, read: () => T): T | null {
  return !s.has(key) || s.raw(key) === null ? null : read();
}
