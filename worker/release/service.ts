import type { AssetRef } from '../contracts/subject.ts';
import type { AssetName, StagedFile } from '../coordinator/types.ts';
import { DeployError, fail } from '../lib/errors.ts';
import { readBounded } from '../lib/fetch.ts';
import { canonicalBytes, sha256Hex, toHex } from '../lib/json.ts';
import type { RangeSource } from './zip.ts';
import { r2RangeSource } from './zip.ts';

/**
 * Release bytes move through two buckets:
 *   staging  `release-staging/staging/{deploymentId}/{asset}`  unverified, deleted by lifecycle
 *   releases `releases/releases/{application}/{releaseTag}/{asset}` verified, bucket-locked
 * Every write passes the expected SHA-256 to R2, which refuses the object if the bytes differ, and
 * releases are written create-only. A conflicting second copy of a release is an incident, not
 * something to overwrite.
 */

export interface ReleaseStorage {
  staging: R2Bucket;
  releases: R2Bucket;
}

export type AssetSource = (name: AssetName, ref: AssetRef) => Promise<ReadableStream<Uint8Array>>;

export const stagingKey = (deploymentId: string, name: AssetName): string => `staging/${deploymentId}/${name}`;
export const releaseKey = (application: string, releaseTag: string, name: AssetName | 'ingest.json'): string =>
  `releases/${application}/${releaseTag}/${name}`;

function checksumHex(object: R2Object): string | null {
  return object.checksums.sha256 ? toHex(new Uint8Array(object.checksums.sha256)) : null;
}

/** R2 needs a known length for streamed puts; Workers provide FixedLengthStream for that. */
function withKnownLength(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!Fixed) return body; // local test runtime
  return body.pipeThrough(new Fixed(size));
}

function classifyPutError(error: unknown, what: string): never {
  if (error instanceof DeployError) throw error;
  const message = error instanceof Error ? error.message : '';
  if (/checksum|digest|sha-?256|length|size/i.test(message)) {
    fail('asset_digest_mismatch', `${what}: bytes do not match the authorized digest or size`);
  }
  return fail('storage_write', `${what}: write failed`, { retryable: true, cause: error });
}

/** Download one asset into staging, bound to the authorized digest. Idempotent. */
export async function stageAsset(storage: ReleaseStorage, source: AssetSource, deploymentId: string, name: AssetName, ref: AssetRef): Promise<StagedFile> {
  const key = stagingKey(deploymentId, name);
  const existing = await storage.staging.head(key);
  if (existing && existing.size === ref.size && checksumHex(existing) === ref.sha256) return { key, sha256: ref.sha256, size: ref.size };
  const body = await source(name, ref);
  try {
    await storage.staging.put(key, withKnownLength(body, ref.size), { sha256: ref.sha256 });
  } catch (error) {
    classifyPutError(error, `staging ${name}`);
  }
  const written = await storage.staging.head(key);
  if (!written || written.size !== ref.size || checksumHex(written) !== ref.sha256) fail('asset_digest_mismatch', `staged ${name} does not match its digest`);
  return { key, sha256: ref.sha256, size: ref.size };
}

export async function readObject(bucket: R2Bucket, key: string, maxBytes: number, expectedSha256: string | null): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object) fail('object_missing', `${key} does not exist`);
  if (object.size > maxBytes) fail('object_too_large', `${key} exceeds ${maxBytes} bytes`);
  const bytes = await readBounded(object.body, maxBytes, 'object_too_large');
  if (expectedSha256 !== null && (await sha256Hex(bytes)) !== expectedSha256) fail('asset_digest_mismatch', `${key} does not match its digest`);
  return bytes;
}

export function stagedArchive(storage: ReleaseStorage, file: StagedFile): RangeSource {
  return r2RangeSource(storage.staging, file.key, file.size);
}

export function releasedArchive(storage: ReleaseStorage, application: string, releaseTag: string, size: number): RangeSource {
  return r2RangeSource(storage.releases, releaseKey(application, releaseTag, 'release.zip'), size);
}

/** Copy verified staged assets into the locked releases bucket and record how they were verified. */
export async function promoteRelease(
  storage: ReleaseStorage,
  application: string,
  releaseTag: string,
  staged: Record<AssetName, StagedFile>,
  ingestRecord: unknown,
): Promise<void> {
  for (const name of Object.keys(staged) as AssetName[]) {
    const file = staged[name];
    const key = releaseKey(application, releaseTag, name);
    const existing = await storage.releases.head(key);
    if (existing) {
      if (checksumHex(existing) !== file.sha256 || existing.size !== file.size) {
        fail('release_bytes_conflict', `${key} already exists with different bytes; releases are immutable`);
      }
      continue;
    }
    const source = await storage.staging.get(file.key);
    if (!source) fail('staging_missing', `${file.key} disappeared before promotion`, { retryable: true });
    let written: R2Object | null;
    try {
      written = await storage.releases.put(key, withKnownLength(source.body, file.size), { sha256: file.sha256, onlyIf: { etagDoesNotMatch: '*' } });
    } catch (error) {
      classifyPutError(error, `promote ${name}`);
    }
    if (written === null) {
      // Lost a race with ourselves (a retried slice); verify what won.
      const raced = await storage.releases.head(key);
      if (!raced || checksumHex(raced) !== file.sha256) fail('release_bytes_conflict', `${key} was written concurrently with different bytes`);
    }
  }
  const ingestKey = releaseKey(application, releaseTag, 'ingest.json');
  const bytes = canonicalBytes(ingestRecord);
  const digest = await sha256Hex(bytes);
  const written = await storage.releases.put(ingestKey, bytes, { sha256: digest, onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
  if (written === null) {
    // A release can be ingested once. A later deployment of the same release reuses that record.
    const existing = await storage.releases.head(ingestKey);
    if (!existing) fail('storage_write', `${ingestKey} create refused but missing`, { retryable: true });
  }
}
