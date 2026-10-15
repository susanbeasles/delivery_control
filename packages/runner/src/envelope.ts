// Job envelope: the only input a job ever receives. Parsed with a fatal parser, bounded in size and depth,
// exact keys, stable error codes. Secrets never travel in it; they are resolved by name from the job type.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export interface RequestedBy {
  readonly sub: string;
  readonly run_id?: string;
}

export interface Envelope {
  readonly v: 1;
  readonly job_id: string;
  readonly job_type: string;
  readonly idempotency_key: string;
  readonly inputs: JsonObject;
  readonly requested_by: RequestedBy;
  readonly created_at: string;
}

export type EnvelopeErrorCode =
  | 'too_large'
  | 'bad_encoding'
  | 'bad_json'
  | 'bad_shape'
  | 'unknown_key'
  | 'bad_version'
  | 'bad_job_id'
  | 'bad_job_type'
  | 'bad_idempotency_key'
  | 'bad_inputs'
  | 'bad_requested_by'
  | 'bad_created_at'
  | 'unknown_job_type';

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  constructor(code: EnvelopeErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

export const ENVELOPE_LIMITS = Object.freeze({
  maxBytes: 65_536,
  maxDepth: 8,
  maxStringLength: 4_096,
  maxKeyLength: 64,
  maxArrayLength: 256,
  maxObjectKeys: 64,
});

const ENVELOPE_KEYS = ['v', 'job_id', 'job_type', 'idempotency_key', 'inputs', 'requested_by', 'created_at'] as const;
const REQUESTED_BY_KEYS = ['sub', 'run_id'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9:_./@-]{0,255}$/;
const RUN_ID = /^[1-9][0-9]{0,18}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Job type names: one to four lowercase dotted segments, e.g. `terraform.plan`. */
export const JOB_TYPE_NAME = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,31}){0,3}$/;

function fail(code: EnvelopeErrorCode, detail?: string): never {
  throw new EnvelopeError(code, detail);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('unknown_key', key);
  for (const key of allowed) if (!optional.includes(key) && !Object.hasOwn(value, key)) fail('bad_shape', `missing ${key}`);
}

function validateJson(value: unknown, depth: number): asserts value is JsonValue {
  if (depth > ENVELOPE_LIMITS.maxDepth) fail('bad_inputs', 'too deep');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > ENVELOPE_LIMITS.maxStringLength) fail('bad_inputs', 'string too long');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('bad_inputs', 'non-finite number');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > ENVELOPE_LIMITS.maxArrayLength) fail('bad_inputs', 'array too long');
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (!isPlainObject(value)) fail('bad_inputs', 'unsupported value');
  const keys = Object.keys(value);
  if (keys.length > ENVELOPE_LIMITS.maxObjectKeys) fail('bad_inputs', 'too many keys');
  for (const key of keys) {
    if (key.length === 0 || key.length > ENVELOPE_LIMITS.maxKeyLength || FORBIDDEN_KEYS.has(key)) fail('bad_inputs', `bad key ${key}`);
    validateJson(value[key], depth + 1);
  }
}

function validateRequestedBy(value: unknown): RequestedBy {
  if (!isPlainObject(value)) fail('bad_requested_by');
  try {
    exactKeys(value, REQUESTED_BY_KEYS, ['run_id']);
  } catch {
    fail('bad_requested_by');
  }
  const sub = value['sub'];
  if (typeof sub !== 'string' || !SUBJECT.test(sub)) fail('bad_requested_by', 'sub');
  if (!Object.hasOwn(value, 'run_id')) return { sub };
  const runId = value['run_id'];
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) fail('bad_requested_by', 'run_id');
  return { sub, run_id: runId };
}

function validateCreatedAt(value: unknown): string {
  if (typeof value !== 'string' || !RFC3339_UTC.test(value)) fail('bad_created_at');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('bad_created_at');
  // The calendar fields must round-trip: 2026-02-31 parses in some engines but is not a date.
  const canonical = new Date(parsed).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) fail('bad_created_at', 'not a calendar date');
  return value;
}

/** Validate an already-parsed value as an envelope. */
export function validateEnvelope(value: unknown): Envelope {
  if (!isPlainObject(value)) fail('bad_shape');
  exactKeys(value, ENVELOPE_KEYS, []);
  if (value['v'] !== 1) fail('bad_version');
  const jobId = value['job_id'];
  if (typeof jobId !== 'string' || !UUID.test(jobId)) fail('bad_job_id');
  const jobType = value['job_type'];
  if (typeof jobType !== 'string' || !JOB_TYPE_NAME.test(jobType)) fail('bad_job_type');
  const key = value['idempotency_key'];
  if (typeof key !== 'string' || !HEX64.test(key)) fail('bad_idempotency_key');
  const inputs = value['inputs'];
  if (!isPlainObject(inputs)) fail('bad_inputs', 'not an object');
  validateJson(inputs, 1);
  return Object.freeze({
    v: 1,
    job_id: jobId,
    job_type: jobType,
    idempotency_key: key,
    inputs: inputs as JsonObject,
    requested_by: Object.freeze(validateRequestedBy(value['requested_by'])),
    created_at: validateCreatedAt(value['created_at']),
  });
}

/** Parse envelope bytes: bounded, fatal UTF-8, JSON, then validated. */
export function parseEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.byteLength === 0) fail('bad_json', 'empty');
  if (bytes.byteLength > ENVELOPE_LIMITS.maxBytes) fail('too_large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('bad_encoding');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('bad_json');
  }
  return validateEnvelope(parsed);
}

/** Deterministic JSON: sorted object keys, no whitespace. The same envelope always has the same bytes and digest. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as readonly JsonValue[]).map(canonicalJson).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(',')}}`;
}

export function serializeEnvelope(envelope: Envelope): Uint8Array {
  const requestedBy: Record<string, JsonValue> = { sub: envelope.requested_by.sub };
  if (envelope.requested_by.run_id !== undefined) requestedBy['run_id'] = envelope.requested_by.run_id;
  return new TextEncoder().encode(
    canonicalJson({
      v: envelope.v,
      job_id: envelope.job_id,
      job_type: envelope.job_type,
      idempotency_key: envelope.idempotency_key,
      inputs: envelope.inputs,
      requested_by: requestedBy,
      created_at: envelope.created_at,
    }),
  );
}

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  return hex(await crypto.subtle.digest('SHA-256', copy));
}

/** SHA-256 of the canonical envelope bytes; used to refuse a resubmission that changed the envelope under a job id. */
export function envelopeDigest(envelope: Envelope): Promise<string> {
  return sha256Hex(serializeEnvelope(envelope));
}
