import type { DeployIntent, ReleaseAssets } from '../contracts/subject.ts';
import type { HealthContract } from '../contracts/manifest.ts';
import type { RegistryTarget } from '../registry/registry.ts';

/** Records the coordinator persists. Only plain JSON values: Durable Object storage clones them. */

export type Phase =
  | 'REQUESTED'
  | 'AUTHORIZED'
  | 'QUEUED'
  | 'VERIFYING'
  | 'PLANNED'
  | 'DEPLOYING_TARGETS'
  | 'HEALTH_CHECKING'
  | 'COMMITTING'
  | 'SUCCEEDED'
  | 'RECOVERING'
  | 'ROLLED_BACK'
  | 'RECOVERY_FAILED'
  | 'REJECTED';

export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(['SUCCEEDED', 'ROLLED_BACK', 'RECOVERY_FAILED', 'REJECTED']);

export const isTerminal = (phase: Phase): boolean => TERMINAL_PHASES.has(phase);

export type AssetName = 'release.manifest.json' | 'release.zip' | 'attestation.sigstore.json';
export const ASSET_NAMES: readonly AssetName[] = ['release.manifest.json', 'attestation.sigstore.json', 'release.zip'];

/** `promotion-request/v1` (CONTRACTS.md section 6). */
export interface PromotionRequest {
  schema: 'promotion-request/v1';
  requestId: string;
  intent: DeployIntent;
  application: string;
  environment: string;
  repository: string;
  repositoryId: number;
  releaseTag: string;
  sourceCommit: string;
  releaseManifestSha256: string | null;
  assets: ReleaseAssets | null;
  expectedCurrentGeneration: number | null;
  registryRevision: number;
  githubDeploymentId: number | null;
  requestedAt: string;
}

export interface StoredError {
  code: string;
  message: string;
  at: string;
}

export interface CompletedTarget {
  id: string;
  operationId: string;
  versionId: string | null;
}

export interface StagedFile {
  key: string;
  sha256: string;
  size: number;
}

export interface IngestState {
  staged: Partial<Record<AssetName, StagedFile>>;
  /** True when the release was already ingested by an earlier deployment and is read from `releases`. */
  reused: boolean;
  manifestChecked: boolean;
  archiveChecked: boolean;
  verifyJobId: string | null;
  verifyDeadlineAt: number | null;
  verified: boolean;
  promoted: boolean;
}

export interface TargetPlan {
  id: string;
  /** The registry entry as it was when the plan was made; deploy and recovery use this snapshot. */
  registryTarget: RegistryTarget;
  priorVersionId: string | null;
  artifactPath: string;
  artifactSha256: string;
  healthContract: HealthContract;
}

export interface Plan {
  registryRevision: number;
  generation: number;
  expectedPriorDeploymentId: string | null;
  order: string[];
  targets: Record<string, TargetPlan>;
  archive: { key: string; size: number };
  manifestSha256: string;
}

export interface HealthProgress {
  /** Target ids to probe, in order, and the index of the one being probed. */
  targets: string[];
  index: number;
  attempt: number;
  nextAt: number;
  /** Release tag the health document must report, or null to check status only. */
  expectTag: string | null;
}

export interface RecoveryProgress {
  reason: StoredError;
  reverted: string[];
  health: HealthProgress | null;
}

/** `deployment-state/v1` plus the coordinator's private working fields. */
export interface DeploymentRecord {
  schema: 'deployment-state/v1';
  deploymentId: string;
  application: string;
  environment: string;
  intent: DeployIntent;
  requestedReleaseTag: string;
  requestedManifestSha256: string | null;
  sourceCommit: string;
  expectedCurrentGeneration: number | null;
  generation: number;
  phase: Phase;
  currentTarget: string | null;
  completedTargets: CompletedTarget[];
  priorRelease: { tag: string; manifestSha256: string; generation: number } | null;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  lastError: StoredError | null;

  request: PromotionRequest;
  tokenHash: string;
  githubDeploymentId: number | null;
  githubEnvironment: string;
  ingest: IngestState;
  plan: Plan | null;
  /** Set before the first call that can change what serves traffic. */
  mutated: boolean;
  health: HealthProgress | null;
  recovery: RecoveryProgress | null;
  nextAttemptAt: number;
  deadlineAt: number;
  eventSeq: number;
}

/** The public projection returned by `status()` and written to the ledger. */
export type DeploymentState = Pick<
  DeploymentRecord,
  | 'schema'
  | 'deploymentId'
  | 'application'
  | 'environment'
  | 'intent'
  | 'requestedReleaseTag'
  | 'requestedManifestSha256'
  | 'sourceCommit'
  | 'expectedCurrentGeneration'
  | 'generation'
  | 'phase'
  | 'currentTarget'
  | 'completedTargets'
  | 'priorRelease'
  | 'attempt'
  | 'startedAt'
  | 'updatedAt'
  | 'lastError'
>;

export function publicState(r: DeploymentRecord): DeploymentState {
  return {
    schema: r.schema,
    deploymentId: r.deploymentId,
    application: r.application,
    environment: r.environment,
    intent: r.intent,
    requestedReleaseTag: r.requestedReleaseTag,
    requestedManifestSha256: r.requestedManifestSha256,
    sourceCommit: r.sourceCommit,
    expectedCurrentGeneration: r.expectedCurrentGeneration,
    generation: r.generation,
    phase: r.phase,
    currentTarget: r.currentTarget,
    completedTargets: r.completedTargets.map((t) => ({ ...t })),
    priorRelease: r.priorRelease ? { ...r.priorRelease } : null,
    attempt: r.attempt,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    lastError: r.lastError ? { ...r.lastError } : null,
  };
}

export interface CommittedRelease {
  generation: number;
  deploymentId: string;
  releaseTag: string;
  manifestSha256: string;
  sourceCommit: string;
  targets: Record<string, { adapter: 'cloudflare-worker/v1'; scriptName: string; versionId: string | null }>;
  committedAt: string;
}

export interface HistoryEntry {
  generation: number;
  deploymentId: string;
  releaseTag: string;
  manifestSha256: string;
  sourceCommit: string;
}

export interface Lease {
  holder: string;
  fence: number;
  expiresAt: number;
}

export interface Meta {
  key: string;
  committed: CommittedRelease | null;
  /** Committed releases, newest last, bounded. Rollback may target any of them. */
  history: HistoryEntry[];
  active: string | null;
  next: string | null;
  lease: Lease | null;
  fence: number;
  outboxSeq: number;
  kick: number;
}

export type OutboxEntry =
  | { kind: 'kick'; deploymentId: string; delaySeconds: number; attempts: number }
  | { kind: 'ledger'; key: string; body: unknown; attempts: number }
  | { kind: 'github-status'; deploymentId: string; state: GitHubStatusState; description: string; attempts: number };

export type GitHubStatusState = 'queued' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive';

export type AdmissionResult =
  | { status: 'QUEUED'; deploymentId: string; githubDeploymentId: number | null }
  | { status: 'ALREADY_CURRENT'; deploymentId: string; githubDeploymentId: null }
  | { status: 'REJECTED'; error: string };

export interface DeployKick {
  schema: 'deploy-kick/v1';
  application: string;
  environment: string;
  deploymentId: string;
  kick: number;
}
