import { fail } from '../lib/errors.ts';
import { readBounded } from '../lib/fetch.ts';
import { canonicalBytes, parseStrictJsonBytes } from '../lib/json.ts';
import { LIMITS } from './limits.ts';
import { parsePlanSummary, type PlanSummary } from './plan-summary.ts';
import type { StackName } from './profiles.ts';
import { planObjectKey } from './egress/rules.ts';
import type { HashFactory } from './streams.ts';
import { digestStream } from './streams.ts';

/**
 * The `tf-plans` bucket: plans by `{stack}/{treeSha}/` and stack locks under `locks/`. Only the
 * narrow subset of the R2 binding the runner uses is declared, so tests can supply a map.
 */

export interface StoredObject {
  size: number;
}

export interface StoredBody extends StoredObject {
  body: ReadableStream<Uint8Array>;
}

export interface PlanBucket {
  head(key: string): Promise<StoredObject | null>;
  get(key: string): Promise<StoredBody | null>;
  /** Create-only when `onlyIf.etagDoesNotMatch` is `*`: resolves `null` if the key exists. */
  put(key: string, value: Uint8Array | ReadableStream<Uint8Array>, options?: { onlyIf?: { etagDoesNotMatch: string }; httpMetadata?: { contentType: string } }): Promise<unknown>;
}

export function stackLockKey(stack: StackName): string {
  return `locks/${stack}.json`;
}

export interface StackLock {
  schema: 'stack-lock/v1';
  stack: StackName;
  jobId: string;
  type: string;
  commit: string;
  treeSha: string;
  reason: string;
  lockedAt: string;
}

export async function isStackLocked(bucket: PlanBucket, stack: StackName): Promise<boolean> {
  return (await bucket.head(stackLockKey(stack))) !== null;
}

/** Create-only. An existing lock (from this or an earlier job) already blocks applies, which is the goal. */
export async function writeStackLock(bucket: PlanBucket, lock: StackLock): Promise<'created' | 'exists'> {
  const result = await bucket.put(stackLockKey(lock.stack), canonicalBytes(lock), {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  return result === null ? 'exists' : 'created';
}

export type StoredPlanState = { kind: 'absent' } | { kind: 'complete'; summary: PlanSummary } | { kind: 'incomplete' };

/** `summary.json` is uploaded last, so it marks a complete plan; plan files without it are debris. */
export async function storedPlanState(bucket: PlanBucket, stack: StackName, treeSha: string): Promise<StoredPlanState> {
  const summary = await readPlanSummary(bucket, stack, treeSha);
  if (summary) return { kind: 'complete', summary };
  for (const name of ['plan.tfplan', 'plan.json']) {
    if (await bucket.head(planObjectKey(stack, treeSha, name))) return { kind: 'incomplete' };
  }
  return { kind: 'absent' };
}

export async function readPlanSummary(bucket: PlanBucket, stack: StackName, treeSha: string): Promise<PlanSummary | null> {
  const object = await bucket.get(planObjectKey(stack, treeSha, 'summary.json'));
  if (!object) return null;
  const bytes = await readBounded(object.body, LIMITS.planSummaryBytes, 'plan_summary_invalid');
  const summary = parsePlanSummary(parseStrictJsonBytes(bytes, LIMITS.planSummaryBytes, 'plan_summary_invalid'), 'plan_summary_invalid');
  if (summary.stack !== stack || summary.treeSha !== treeSha) fail('plan_summary_invalid', 'stored summary does not describe this stack and tree');
  return summary;
}

/** SHA-256 of a stored object, streamed; `null` when the object does not exist. */
export async function digestStoredObject(bucket: PlanBucket, key: string, maxBytes: number, hashes: HashFactory): Promise<{ sha256: string; size: number } | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > maxBytes) {
    await object.body.cancel();
    fail('plan_too_large', `${key} exceeds ${maxBytes} bytes`);
  }
  return digestStream(object.body, maxBytes, hashes, 'plan_unreadable');
}
