import { fail } from './errors.ts';
import { isPlainObject } from './json.ts';

/**
 * Fatal, exact-shape validation. A `Shape` reader is created per document with the error code
 * that document's failures should carry; every accessor names the path that failed.
 */
export class Shape {
  readonly code: string;
  readonly path: string;
  private readonly value: Record<string, unknown>;

  constructor(value: unknown, code: string, path: string, required: readonly string[], optional: readonly string[] = []) {
    this.code = code;
    this.path = path;
    if (!isPlainObject(value)) fail(code, `${path}: expected an object`);
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) fail(code, `${path}: unexpected field ${JSON.stringify(key).slice(0, 80)}`);
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code, `${path}: missing field ${key}`);
    }
    this.value = value;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.value, key);
  }

  raw(key: string): unknown {
    return this.value[key];
  }

  string(key: string, pattern: RegExp, maxLength = 1024): string {
    const v = this.value[key];
    if (typeof v !== 'string' || v.length > maxLength || !pattern.test(v)) {
      fail(this.code, `${this.path}.${key}: invalid value`);
    }
    return v;
  }

  literal<T extends string>(key: string, expected: T): T {
    if (this.value[key] !== expected) fail(this.code, `${this.path}.${key}: expected ${expected}`);
    return expected;
  }

  oneOf<T extends string>(key: string, options: readonly T[]): T {
    const v = this.value[key];
    if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) {
      fail(this.code, `${this.path}.${key}: expected one of ${options.join(', ')}`);
    }
    return v as T;
  }

  int(key: string, min: number, max: number): number {
    const v = this.value[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
      fail(this.code, `${this.path}.${key}: expected an integer in [${min}, ${max}]`);
    }
    return v;
  }

  bool(key: string): boolean {
    const v = this.value[key];
    if (typeof v !== 'boolean') fail(this.code, `${this.path}.${key}: expected a boolean`);
    return v;
  }

  nullable<T>(key: string, read: (shape: Shape, key: string) => T): T | null {
    return this.value[key] === null ? null : read(this, key);
  }

  object(key: string, required: readonly string[], optional: readonly string[] = []): Shape {
    return new Shape(this.value[key], this.code, `${this.path}.${key}`, required, optional);
  }

  array(key: string, min: number, max: number): unknown[] {
    const v = this.value[key];
    if (!Array.isArray(v) || v.length < min || v.length > max) {
      fail(this.code, `${this.path}.${key}: expected ${min} to ${max} items`);
    }
    return v;
  }

  stringArray(key: string, pattern: RegExp, min: number, max: number, maxLength = 256): string[] {
    const items = this.array(key, min, max);
    const out: string[] = [];
    for (const [index, item] of items.entries()) {
      if (typeof item !== 'string' || item.length > maxLength || !pattern.test(item)) {
        fail(this.code, `${this.path}.${key}[${index}]: invalid value`);
      }
      out.push(item);
    }
    if (new Set(out).size !== out.length) fail(this.code, `${this.path}.${key}: duplicate entries`);
    return out;
  }
}

export const PATTERNS = {
  application: /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/,
  environment: /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/,
  targetId: /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/,
  releaseTag: /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/,
  repository: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
  commit: /^[a-f0-9]{40}$/,
  sha256: /^[a-f0-9]{64}$/,
  uuidv7: /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  scriptName: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  hex32: /^[a-f0-9]{32}$/,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /** Relative archive path: no empty, `.` or `..` segments, no leading slash, no backslash. */
  archivePath: /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/,
  bindingName: /^[A-Z][A-Z0-9_]{0,63}$/,
  githubWorkflow: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/,
  ownerOrigin: /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  any: /^[\s\S]*$/,
} as const;

export function isTimestamp(value: string): boolean {
  if (!PATTERNS.timestamp.test(value)) return false;
  const ms = Date.parse(value);
  // Date.parse accepts some impossible dates by rolling them over; the round trip rejects those.
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
