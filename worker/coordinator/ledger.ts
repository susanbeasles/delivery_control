import { fail } from '../lib/errors.ts';
import { canonicalBytes, parseStrictJsonBytes, sha256Hex, toHex, type Json } from '../lib/json.ts';
import type { CommittedRelease } from './types.ts';

/**
 * The durable deployment record in the `deploy-state` bucket (CONTRACTS.md section 8).
 *
 * `ledger/` is bucket-locked and written create-only: rewriting identical bytes is a no-op (a
 * retried flush), different bytes for an existing key is a conflict. `pointers/` is mutable and
 * every write is an etag compare-and-swap, so a stale writer can never overwrite a newer pointer.
 */

export const ledgerPrefix = (application: string, environment: string, deploymentId: string): string =>
  `ledger/${application}/${environment}/${deploymentId}`;

export const eventKey = (application: string, environment: string, deploymentId: string, seq: number): string =>
  `${ledgerPrefix(application, environment, deploymentId)}/events/${String(seq).padStart(8, '0')}.json`;

export const pointerKey = (application: string, environment: string, name: 'current' | 'rollback' | 'promote'): string =>
  `pointers/${application}/${environment}/${name}.json`;

export async function putCreateOnly(bucket: R2Bucket, key: string, body: unknown): Promise<'created' | 'identical'> {
  const bytes = canonicalBytes(body);
  const sha256 = await sha256Hex(bytes);
  const written = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256,
    httpMetadata: { contentType: 'application/json' },
  });
  if (written !== null) return 'created';
  const existing = await bucket.head(key);
  if (!existing) fail('ledger_write', `create-only write to ${key} was refused but no object exists`, { retryable: true });
  const existingSha = existing.checksums.sha256 ? toHex(new Uint8Array(existing.checksums.sha256)) : null;
  if (existingSha !== sha256) fail('ledger_conflict', `${key} already exists with different content`);
  return 'identical';
}

export interface PointerDocument {
  schema: 'deployment-pointer/v1';
  application: string;
  environment: string;
  generation: number;
  deploymentId: string;
  release: { tag: string; manifestSha256: string; sourceCommit: string };
  targets: Record<string, { adapter: string; scriptName: string; versionId: string | null }>;
  committedAt: string;
}

export function pointerDocument(application: string, environment: string, c: CommittedRelease): PointerDocument {
  return {
    schema: 'deployment-pointer/v1',
    application,
    environment,
    generation: c.generation,
    deploymentId: c.deploymentId,
    release: { tag: c.releaseTag, manifestSha256: c.manifestSha256, sourceCommit: c.sourceCommit },
    targets: Object.fromEntries(Object.entries(c.targets).map(([id, t]) => [id, { ...t }])),
    committedAt: c.committedAt,
  };
}

/**
 * Refuse, before anything is deployed, when `current.json` does not name the deployment the
 * coordinator believes is committed (restored from backup, edited by hand, storage reset). The
 * swap at commit time checks again, but by then production has already changed.
 */
export async function checkCurrentPointer(bucket: R2Bucket, application: string, environment: string, committed: CommittedRelease | null): Promise<void> {
  const key = pointerKey(application, environment, 'current');
  const existing = await bucket.get(key);
  if (existing === null) {
    if (committed !== null) fail('pointer_conflict', `${key} is missing but deployment ${committed.deploymentId} is committed`);
    return;
  }
  // Nothing committed means no pointer may exist; otherwise the whole document must be exactly the one
  // the last commit wrote, so an edited generation, release or target list is caught as well.
  if (committed === null) fail('pointer_conflict', `${key} exists but no release is committed`);
  const stored = parseStrictJsonBytes(new Uint8Array(await existing.arrayBuffer()), 256 * 1024, 'pointer_invalid') as Json;
  const expected = pointerDocument(application, environment, committed);
  if (!bytesEqual(canonicalBytes(stored), canonicalBytes(expected))) {
    fail('pointer_conflict', `${key} differs from the committed deployment ${committed.deploymentId}`);
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Move `current.json` from the expected deployment to the new one. Returns normally when the
 * pointer now names `next` (including when a previous attempt already moved it).
 */
export async function swapCurrentPointer(
  bucket: R2Bucket,
  application: string,
  environment: string,
  expectedDeploymentId: string | null,
  next: PointerDocument,
): Promise<void> {
  const key = pointerKey(application, environment, 'current');
  const existing = await bucket.get(key);
  let condition: R2Conditional;
  if (existing === null) {
    if (expectedDeploymentId !== null) fail('pointer_conflict', `${key} is missing but deployment ${expectedDeploymentId} was expected`);
    condition = { etagDoesNotMatch: '*' };
  } else {
    const doc = parseStrictJsonBytes(new Uint8Array(await existing.arrayBuffer()), 256 * 1024, 'pointer_invalid') as Json;
    const current = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc['deploymentId'] : undefined;
    if (current === next.deploymentId) return; // already moved by an earlier attempt
    if (current !== expectedDeploymentId) fail('pointer_conflict', `${key} names ${String(current)}, expected ${String(expectedDeploymentId)}`);
    condition = { etagMatches: existing.etag };
  }
  const bytes = canonicalBytes(next);
  const written = await bucket.put(key, bytes, { onlyIf: condition, sha256: await sha256Hex(bytes), httpMetadata: { contentType: 'application/json' } });
  if (written === null) fail('pointer_conflict', `${key} changed during the swap`, { retryable: true });
}

/** Best-effort snapshots outside the critical path (rollback target, in-flight view). */
export async function putPointer(bucket: R2Bucket, key: string, body: unknown): Promise<void> {
  const bytes = canonicalBytes(body);
  await bucket.put(key, bytes, { sha256: await sha256Hex(bytes), httpMetadata: { contentType: 'application/json' } });
}
