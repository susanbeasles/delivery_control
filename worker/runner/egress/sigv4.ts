import { sha256Hex, toHex } from '../../lib/json.ts';

/**
 * AWS Signature Version 4 over WebCrypto, for re-signing the container's S3 requests to R2 with
 * credentials the container never sees. Implements the header-based scheme only (no presigned
 * URLs, no chunked payload signing): the gate always sends `x-amz-content-sha256: UNSIGNED-PAYLOAD`.
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Input {
  method: string;
  url: URL;
  /** Headers to sign, any case. `host` and `x-amz-date` are added here; do not pass `authorization`. */
  headers: Record<string, string>;
  /** Hex SHA-256 of the payload, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  region: string;
  service: string;
  now: Date;
}

export interface SigV4Result {
  /** Every header to send, lowercase names, including `authorization`, `host` and `x-amz-date`. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const encoder = new TextEncoder();

export async function signV4(input: SigV4Input, credentials: SigV4Credentials): Promise<SigV4Result> {
  const amzDate = toAmzDate(input.now);
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  delete headers['authorization'];
  headers['host'] = input.url.host;
  headers['x-amz-date'] = amzDate;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${normalizeHeaderValue(headers[n] ?? '')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url.pathname, input.service),
    canonicalQuery(input.url.search),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const key = await signingKey(credentials.secretAccessKey, date, input.region, input.service);
  const signature = toHex(await hmac(key, stringToSign));
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}

export async function signingKey(secret: string, date: string, region: string, service: string): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)));
}

export function toAmzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** RFC 3986 unreserved characters stay; everything else is %XX with uppercase hex. */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = '';
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * S3 signs the path exactly as sent (each segment encoded once, no dot-segment normalization);
 * other services normalize and double-encode. The gate only signs for S3, the generic branch is
 * kept for the published test vectors.
 */
function canonicalUri(pathname: string, service: string): string {
  if (pathname === '') return '/';
  const segments = pathname.split('/').map((segment) => uriEncode(decodeSegment(segment), false));
  const encoded = segments.join('/');
  return service === 's3' ? encoded : segments.map((segment) => uriEncode(segment, false)).join('/');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Query parameters sorted by encoded name then value; `+` is a literal plus, not a space. */
export function canonicalQuery(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw === '') return '';
  const pairs = raw
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=');
      const name = eq === -1 ? part : part.slice(0, eq);
      const value = eq === -1 ? '' : part.slice(eq + 1);
      return [uriEncode(decodeSegment(name), false), uriEncode(decodeSegment(value), false)] as const;
    });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([n, v]) => `${n}=${v}`).join('&');
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
