/**
 * Small runtime primitives: clock, ids, semver, structured logging. Kept free of platform imports
 * so every module that uses them runs unchanged under `node --test`.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

/** RFC 9562 UUIDv7: 48-bit millisecond timestamp, version 7, variant 10, 74 random bits. */
export function uuidv7(nowMs: number, random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  let ts = BigInt(nowMs);
  for (let k = 5; k >= 0; k--) {
    bytes[k] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let k = 0; k < binary.length; k++) out[k] = binary.charCodeAt(k);
  return out;
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseReleaseTag(tag: string): Semver | null {
  const m = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative when a < b, zero when equal, positive when a > b. Both must be valid release tags. */
export function compareReleaseTags(a: string, b: string): number {
  const x = parseReleaseTag(a);
  const y = parseReleaseTag(b);
  if (!x || !y) throw new Error('compareReleaseTags requires valid release tags');
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

export type LogValue = string | number | boolean | null;

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|credential|private|passphrase|signature/i;
const MAX_FIELD = 300;

/**
 * One JSON line per event. Only scalar fields are accepted, keys that look sensitive are dropped,
 * and strings are truncated, so a careless call site cannot leak a credential or a body.
 */
export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, LogValue> = {}): void {
  const line: Record<string, LogValue> = { level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) continue;
    line[key] = typeof value === 'string' && value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}…` : value;
  }
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
