import type { RunnerJobType } from './api.ts';

/**
 * Everything that differs between job types, as data: which runner may execute it, whether it
 * mutates infrastructure, which stack it is bound to, and which credential the egress gate injects
 * for it. Code reads these tables; it never branches on a credential name by hand.
 */

/** The deployer Worker runs `release.verify` and `terraform.*`; the root runner runs `root.*` only. */
export type RunnerRole = 'deployer' | 'root';

export type StackName = 'infra' | 'infra-root';

export interface StackDefinition {
  stack: StackName;
  repository: string;
  repositoryId: number;
}

/** Pinned, so a subject naming another repository for a stack is refused even if a grant exists. */
export const STACKS: Readonly<Record<StackName, StackDefinition>> = {
  infra: { stack: 'infra', repository: 'susanbeasles/infra', repositoryId: 1417590199 },
  'infra-root': { stack: 'infra-root', repository: 'susanbeasles/infra-root', repositoryId: 1419989558 },
};

/** Policy is always judged from infra-root `main`, never from the change under review. */
export const POLICY_SOURCE = {
  repository: 'susanbeasles/infra-root',
  repositoryId: 1419989558,
  branch: 'main',
  directory: 'policy',
} as const;

export type CloudflareSecretName = 'CF_PLAN' | 'CF_APPLY' | 'CF_ROOT_PLAN' | 'CF_ROOT_APPLY';
export type StateSecretName = 'R2_STATE_RO' | 'R2_STATE_RW' | 'R2_STATE_ROOT';
export type StateTokenIdName = 'R2_STATE_RO_TOKEN_ID' | 'R2_STATE_RW_TOKEN_ID' | 'R2_STATE_ROOT_TOKEN_ID';
export type PassphraseSecretName = 'TF_ENCRYPTION_INFRA' | 'TF_ENCRYPTION_ROOT';

export interface CloudflareGrant {
  secret: CloudflareSecretName;
  /** HTTP methods the gate forwards to `api.cloudflare.com/client/v4/…` for this job type. */
  methods: readonly string[];
}

export interface StateGrant {
  secret: StateSecretName;
  tokenId: StateTokenIdName;
  /** `read`: state GET/HEAD and workspace listing only. `write`: also lock file and state PUT, archive PUT. */
  access: 'read' | 'write';
}

export interface JobProfile {
  type: RunnerJobType;
  role: RunnerRole;
  operation: 'verify' | 'plan' | 'apply';
  /** A mutating job that ends without an authoritative result is `uncertain`, never `failed`. */
  mutating: boolean;
  stack: StackName | null;
  cloudflare: CloudflareGrant | null;
  state: StateGrant | null;
  passphrase: PassphraseSecretName | null;
  /** Default budget used when the runner itself chooses the deadline. */
  defaultRuntimeSeconds: number;
}

const READ_METHODS = ['GET', 'HEAD'] as const;
const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const JOB_PROFILES: Readonly<Record<RunnerJobType, JobProfile>> = {
  'release.verify': {
    type: 'release.verify',
    role: 'deployer',
    operation: 'verify',
    mutating: false,
    stack: null,
    cloudflare: null,
    state: null,
    passphrase: null,
    defaultRuntimeSeconds: 10 * 60,
  },
  'terraform.plan': {
    type: 'terraform.plan',
    role: 'deployer',
    operation: 'plan',
    mutating: false,
    stack: 'infra',
    cloudflare: { secret: 'CF_PLAN', methods: READ_METHODS },
    state: { secret: 'R2_STATE_RO', tokenId: 'R2_STATE_RO_TOKEN_ID', access: 'read' },
    passphrase: 'TF_ENCRYPTION_INFRA',
    defaultRuntimeSeconds: 30 * 60,
  },
  'terraform.apply': {
    type: 'terraform.apply',
    role: 'deployer',
    operation: 'apply',
    mutating: true,
    stack: 'infra',
    cloudflare: { secret: 'CF_APPLY', methods: ALL_METHODS },
    state: { secret: 'R2_STATE_RW', tokenId: 'R2_STATE_RW_TOKEN_ID', access: 'write' },
    passphrase: 'TF_ENCRYPTION_INFRA',
    defaultRuntimeSeconds: 60 * 60,
  },
  'root.plan': {
    type: 'root.plan',
    role: 'root',
    operation: 'plan',
    mutating: false,
    stack: 'infra-root',
    cloudflare: { secret: 'CF_ROOT_PLAN', methods: READ_METHODS },
    // The root runner binds one state credential; `access: 'read'` keeps plan jobs to GET/HEAD.
    state: { secret: 'R2_STATE_ROOT', tokenId: 'R2_STATE_ROOT_TOKEN_ID', access: 'read' },
    passphrase: 'TF_ENCRYPTION_ROOT',
    defaultRuntimeSeconds: 30 * 60,
  },
  'root.apply': {
    type: 'root.apply',
    role: 'root',
    operation: 'apply',
    mutating: true,
    stack: 'infra-root',
    cloudflare: { secret: 'CF_ROOT_APPLY', methods: ALL_METHODS },
    state: { secret: 'R2_STATE_ROOT', tokenId: 'R2_STATE_ROOT_TOKEN_ID', access: 'write' },
    passphrase: 'TF_ENCRYPTION_ROOT',
    defaultRuntimeSeconds: 60 * 60,
  },
};

export const JOB_TYPES = Object.keys(JOB_PROFILES) as RunnerJobType[];

export function profileOf(type: RunnerJobType): JobProfile {
  return JOB_PROFILES[type];
}

/** `RUNNER_ROLE` is set to `root` only in `wrangler.root-runner.jsonc`; anything else is the deployer. */
export function roleOf(value: unknown): RunnerRole {
  return value === 'root' ? 'root' : 'deployer';
}
