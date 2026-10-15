import { fail } from '../lib/errors.ts';
import { PATTERNS, Shape, isTimestamp } from '../lib/validate.ts';

/** `deploy-subject/v1`, built by the authorizer from verified evidence (CONTRACTS.md section 3). */

export type DeployIntent = 'deploy' | 'rollback';

export interface AssetRef {
  id: number;
  sha256: string;
  size: number;
}

export interface ReleaseAssets {
  manifest: AssetRef;
  archive: AssetRef;
  attestation: AssetRef;
}

export interface DeploySubject {
  schema: 'deploy-subject/v1';
  intent: DeployIntent;
  application: string;
  environment: string;
  repository: string;
  repositoryId: number;
  releaseTag: string;
  releaseId: number;
  sourceCommit: string;
  assets: ReleaseAssets | null;
  requestedBy: {
    actorId: number;
    runId: number;
    runAttempt: number;
    workflowRef: string;
    jobWorkflowRef: string;
    eventName: string;
  };
  authorizedAt: string;
}

const CODE = 'subject_invalid';
const MAX_ASSET_BYTES = 256 * 1024 * 1024;

function assetRef(shape: Shape, key: string): AssetRef {
  const a = shape.object(key, ['id', 'sha256', 'size']);
  return { id: a.int('id', 1, Number.MAX_SAFE_INTEGER), sha256: a.string('sha256', PATTERNS.sha256), size: a.int('size', 1, MAX_ASSET_BYTES) };
}

export function parseDeploySubject(value: unknown): DeploySubject {
  const s = new Shape(value, CODE, 'subject', [
    'schema',
    'intent',
    'application',
    'environment',
    'repository',
    'repositoryId',
    'releaseTag',
    'releaseId',
    'sourceCommit',
    'assets',
    'requestedBy',
    'authorizedAt',
  ]);
  s.literal('schema', 'deploy-subject/v1');
  const intent = s.oneOf('intent', ['deploy', 'rollback'] as const);
  const assets = s.nullable('assets', (shape, key) => {
    const a = shape.object(key, ['manifest', 'archive', 'attestation']);
    return { manifest: assetRef(a, 'manifest'), archive: assetRef(a, 'archive'), attestation: assetRef(a, 'attestation') };
  });
  if (intent === 'deploy' && assets === null) fail(CODE, 'subject.assets: required for intent deploy');
  const r = s.object('requestedBy', ['actorId', 'runId', 'runAttempt', 'workflowRef', 'jobWorkflowRef', 'eventName']);
  const authorizedAt = s.string('authorizedAt', PATTERNS.timestamp);
  if (!isTimestamp(authorizedAt)) fail(CODE, 'subject.authorizedAt: not a valid timestamp');
  return {
    schema: 'deploy-subject/v1',
    intent,
    application: s.string('application', PATTERNS.application),
    environment: s.string('environment', PATTERNS.environment),
    repository: s.string('repository', PATTERNS.repository),
    repositoryId: s.int('repositoryId', 1, Number.MAX_SAFE_INTEGER),
    releaseTag: s.string('releaseTag', PATTERNS.releaseTag),
    releaseId: s.int('releaseId', 1, Number.MAX_SAFE_INTEGER),
    sourceCommit: s.string('sourceCommit', PATTERNS.commit),
    assets,
    requestedBy: {
      actorId: r.int('actorId', 1, Number.MAX_SAFE_INTEGER),
      runId: r.int('runId', 1, Number.MAX_SAFE_INTEGER),
      runAttempt: r.int('runAttempt', 1, 10_000),
      workflowRef: r.string('workflowRef', /^[A-Za-z0-9_.\/@-]{1,400}$/),
      jobWorkflowRef: r.string('jobWorkflowRef', /^[A-Za-z0-9_.\/@-]{1,400}$/),
      eventName: r.string('eventName', /^[a-z_]{1,64}$/),
    },
    authorizedAt,
  };
}
