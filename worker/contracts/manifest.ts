import { fail } from '../lib/errors.ts';
import { parseCanonicalJsonBytes } from '../lib/json.ts';
import { PATTERNS, Shape, isTimestamp } from '../lib/validate.ts';

/** `release-manifest/v2` (CONTRACTS.md section 1.1). The bytes must already be canonical JSON. */

export type AdapterName = 'cloudflare-worker/v1';

export interface HealthContract {
  path: string;
  expectStatus: number;
  expectReleaseTag: boolean;
}

export interface ManifestTarget {
  id: string;
  adapter: AdapterName;
  artifactPath: string;
  sha256: string;
  dependsOn: string[];
  healthContract: HealthContract;
}

export interface ReleaseManifest {
  schema: 'release-manifest/v2';
  application: string;
  repository: string;
  repositoryId: number;
  releaseTag: string;
  sourceCommit: string;
  createdAt: string;
  artifact: { path: 'release.zip'; sha256: string; sizeBytes: number; mediaType: 'application/zip' };
  targets: ManifestTarget[];
}

const CODE = 'manifest_invalid';
export const MAX_MANIFEST_BYTES = 1024 * 1024;
// Lookaheads anchor at the start so `//host` (protocol-relative) and dot segments are refused.
const HEALTH_PATH = /^(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))\/[A-Za-z0-9._~\/-]{0,255}$/;

export function parseReleaseManifest(bytes: Uint8Array): ReleaseManifest {
  const value = parseCanonicalJsonBytes(bytes, MAX_MANIFEST_BYTES, CODE);
  const s = new Shape(value, CODE, 'manifest', [
    'schema',
    'application',
    'repository',
    'repositoryId',
    'releaseTag',
    'sourceCommit',
    'createdAt',
    'artifact',
    'targets',
  ]);
  s.literal('schema', 'release-manifest/v2');
  const createdAt = s.string('createdAt', PATTERNS.timestamp);
  if (!isTimestamp(createdAt)) fail(CODE, 'manifest.createdAt: not a valid timestamp');

  const a = s.object('artifact', ['path', 'sha256', 'sizeBytes', 'mediaType']);
  const artifact = {
    path: a.literal('path', 'release.zip'),
    sha256: a.string('sha256', PATTERNS.sha256),
    sizeBytes: a.int('sizeBytes', 1, 256 * 1024 * 1024),
    mediaType: a.literal('mediaType', 'application/zip'),
  };

  const targets = s.array('targets', 1, 32).map((raw, index) => parseTarget(raw, index));
  const ids = new Set(targets.map((t) => t.id));
  if (ids.size !== targets.length) fail(CODE, 'manifest.targets: duplicate target ids');
  const paths = new Set(targets.map((t) => t.artifactPath));
  if (paths.size !== targets.length) fail(CODE, 'manifest.targets: duplicate artifact paths');
  for (const t of targets) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) fail(CODE, `manifest.targets.${t.id}.dependsOn: unknown target ${dep}`);
      if (dep === t.id) fail(CODE, `manifest.targets.${t.id}.dependsOn: self dependency`);
    }
  }
  topologicalOrder(targets); // throws on cycles

  return {
    schema: 'release-manifest/v2',
    application: s.string('application', PATTERNS.application),
    repository: s.string('repository', PATTERNS.repository),
    repositoryId: s.int('repositoryId', 1, Number.MAX_SAFE_INTEGER),
    releaseTag: s.string('releaseTag', PATTERNS.releaseTag),
    sourceCommit: s.string('sourceCommit', PATTERNS.commit),
    createdAt,
    artifact,
    targets,
  };
}

function parseTarget(raw: unknown, index: number): ManifestTarget {
  const t = new Shape(raw, CODE, `manifest.targets[${index}]`, ['id', 'adapter', 'artifactPath', 'sha256', 'dependsOn', 'healthContract']);
  const adapter = t.oneOf('adapter', ['cloudflare-worker/v1'] as const);
  const h = t.object('healthContract', ['path', 'expectStatus', 'expectReleaseTag']);
  return {
    id: t.string('id', PATTERNS.targetId),
    adapter,
    artifactPath: t.string('artifactPath', PATTERNS.archivePath, 256),
    sha256: t.string('sha256', PATTERNS.sha256),
    dependsOn: t.stringArray('dependsOn', PATTERNS.targetId, 0, 31),
    healthContract: {
      path: h.string('path', HEALTH_PATH, 256),
      expectStatus: h.int('expectStatus', 200, 299),
      expectReleaseTag: h.bool('expectReleaseTag'),
    },
  };
}

/** Deterministic Kahn ordering, ties broken by id. Throws `manifest_invalid` on a cycle. */
export function topologicalOrder(targets: ReadonlyArray<Pick<ManifestTarget, 'id' | 'dependsOn'>>): string[] {
  const pending = new Map(targets.map((t) => [t.id, new Set(t.dependsOn)]));
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) fail(CODE, 'manifest.targets: dependency cycle');
    for (const id of ready) {
      order.push(id);
      pending.delete(id);
      for (const deps of pending.values()) deps.delete(id);
    }
  }
  return order;
}
