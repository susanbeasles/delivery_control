import { fail } from './errors.ts';

/**
 * JSON handling for untrusted input.
 *
 * `parseStrictJson` is a small RFC 8259 parser that rejects what `JSON.parse` silently accepts or
 * resolves ambiguously: duplicate object keys (a classic parser-differential vector), numbers that
 * are not safe integers, lone surrogates, and excessive nesting. Every contract in this system
 * uses integers only, so rejecting fractions and exponents loses nothing.
 *
 * `canonicalize` is RFC 8785 (JCS) for that same value space. Digests are SHA-256 over its bytes.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const MAX_DEPTH = 64;
const encoder = new TextEncoder();

export function decodeUtf8(bytes: Uint8Array, code = 'invalid_json'): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return fail(code, 'input is not valid UTF-8');
  }
}

export function parseStrictJsonBytes(bytes: Uint8Array, maxBytes: number, code = 'invalid_json'): Json {
  if (bytes.byteLength > maxBytes) fail(code, `document exceeds ${maxBytes} bytes`);
  return parseStrictJson(decodeUtf8(bytes, code), code);
}

export function parseStrictJson(text: string, code = 'invalid_json'): Json {
  let i = 0;
  const err = (what: string): never => fail(code, `${what} at offset ${i}`);

  const ws = (): void => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) err('nesting too deep');
    ws();
    const c = text[i];
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return string();
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === 'n') return literal('null', null);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    return err('unexpected token');
  };

  const literal = <T extends Json>(word: string, result: T): T => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return result;
    }
    return err('invalid literal');
  };

  const number = (): number => {
    const match = /^-?(0|[1-9][0-9]*)/.exec(text.slice(i, i + 32));
    if (!match) return err('invalid number');
    const next = text[i + match[0].length];
    if (next === '.' || next === 'e' || next === 'E') err('only integers are accepted');
    if (match[0] === '-0') err('negative zero is not accepted');
    const n = Number(match[0]);
    if (!Number.isSafeInteger(n)) err('integer outside the safe range');
    i += match[0].length;
    return n;
  };

  const string = (): string => {
    i++; // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) err('unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        break;
      }
      if (c < 0x20) err('control character in string');
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        if (e === '"' || e === '\\' || e === '/') out += e;
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'u') {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) err('invalid unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else err('invalid escape');
        continue;
      }
      out += text[i];
      i++;
    }
    if (hasLoneSurrogate(out)) err('lone surrogate in string');
    return out;
  };

  const array = (depth: number): Json[] => {
    i++;
    const out: Json[] = [];
    ws();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(value(depth + 1));
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return out;
      }
      err('expected , or ]');
    }
  };

  const object = (depth: number): { [key: string]: Json } => {
    i++;
    const out: { [key: string]: Json } = Object.create(null);
    ws();
    if (text[i] === '}') {
      i++;
      return toPlain(out);
    }
    for (;;) {
      ws();
      if (text[i] !== '"') err('expected object key');
      const key = string();
      if (Object.prototype.hasOwnProperty.call(out, key)) err(`duplicate key ${JSON.stringify(key).slice(0, 80)}`);
      ws();
      if (text[i] !== ':') err('expected :');
      i++;
      out[key] = value(depth + 1);
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return toPlain(out);
      }
      err('expected , or }');
    }
  };

  const result = value(0);
  ws();
  if (i !== text.length) err('trailing content');
  return result;
}

/** Objects are built without a prototype (so `__proto__` is just a key), then copied to plain. */
function toPlain(source: { [key: string]: Json }): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(source)) {
    Object.defineProperty(out, key, { value: source[key], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function hasLoneSurrogate(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(k + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      k++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Narrowing guard for parsed JSON values (usable with `Json[].filter`). */
export function isJsonObject(value: Json | undefined): value is { [key: string]: Json } {
  return isPlainObject(value);
}

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) fail('invalid_canonical', 'nesting too deep');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) fail('invalid_canonical', 'lone surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('invalid_canonical', 'only safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v, depth + 1)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${canonicalize(k, depth + 1)}:${canonicalize(value[k], depth + 1)}`).join(',')}}`;
  }
  return fail('invalid_canonical', `unsupported value of type ${typeof value}`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalize(value));
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

export async function digestOf(value: unknown): Promise<string> {
  return sha256Hex(canonicalBytes(value));
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Parse a document that the contract says must already be canonical, and prove it is. */
export function parseCanonicalJsonBytes(bytes: Uint8Array, maxBytes: number, code: string): Json {
  const value = parseStrictJsonBytes(bytes, maxBytes, code);
  const again = canonicalBytes(value);
  if (again.byteLength !== bytes.byteLength || !again.every((b, k) => b === bytes[k])) {
    fail(code, 'document is not in canonical form (RFC 8785)');
  }
  return value;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let k = 0; k < a.length; k++) diff |= a.charCodeAt(k) ^ b.charCodeAt(k);
  return diff === 0;
}
