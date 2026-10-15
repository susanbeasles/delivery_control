import { fail } from '../lib/errors.ts';
import { fetchBounded, statusError, type Fetcher } from '../lib/fetch.ts';
import { parseStrictJsonBytes, isPlainObject } from '../lib/json.ts';
import { base64url, base64ToBytes, type Clock } from '../lib/runtime.ts';

/**
 * GitHub App authentication inside a Worker: RS256 App JWTs over WebCrypto with a non-extractable
 * key, and installation tokens narrowed to one repository and the exact permissions a call needs.
 * The private key never leaves this module; tokens are cached in memory only until five minutes
 * before they expire.
 */

export const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'deployer';

export type Permission = 'read' | 'write';
export type Permissions = Partial<Record<'contents' | 'deployments' | 'checks' | 'actions' | 'attestations' | 'metadata' | 'pull_requests', Permission>>;

export interface GitHubAppConfig {
  appId: number;
  /** PEM, PKCS#1 (`RSA PRIVATE KEY`, GitHub's default) or PKCS#8. */
  privateKeyPem: () => Promise<string>;
  fetcher: Fetcher;
  clock: Clock;
}

export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  if (typeof pem !== 'string' || pem.length > 12_000) fail('github_app_key_invalid', 'App key has an invalid size');
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+)-----END \1-----\s*$/.exec(pem.trim() + '\n');
  if (!match || match[2] === undefined) return fail('github_app_key_invalid', 'App key is not a PEM private key');
  let der = base64ToBytes(match[2].replace(/\s/g, ''));
  if (match[1] === 'RSA PRIVATE KEY') der = pkcs1ToPkcs8(der);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    return fail('github_app_key_invalid', 'App key could not be imported');
  }
  const modulusLength = (key.algorithm as { modulusLength?: number }).modulusLength ?? 0;
  if (modulusLength < 2048) fail('github_app_key_invalid', 'App key is weaker than 2048 bits');
  return key;
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo so WebCrypto can import it. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const rsaAlgorithmIdentifier = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  return der(0x30, concat(version, rsaAlgorithmIdentifier, der(0x04, pkcs1)));
}

function der(tag: number, value: Uint8Array): Uint8Array {
  const n = value.byteLength;
  const length =
    n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return concat(new Uint8Array([tag, ...length]), value);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

const encoder = new TextEncoder();

export async function signAppJwt(appId: number, key: CryptoKey, nowSeconds: number): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  // iat is backdated 60 s for clock skew; GitHub caps exp at 10 minutes.
  const body = base64url(encoder.encode(JSON.stringify({ iss: String(appId), iat: nowSeconds - 60, exp: nowSeconds + 540 })));
  const signing = `${header}.${body}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signing)));
  return `${signing}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class GitHubApp {
  private readonly config: GitHubAppConfig;
  private keyPromise: Promise<CryptoKey> | null = null;
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<string, CachedToken>();

  constructor(config: GitHubAppConfig) {
    if (!Number.isSafeInteger(config.appId) || config.appId <= 0) fail('github_app_unconfigured', 'GitHub App id is not configured');
    this.config = config;
  }

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= this.config.privateKeyPem().then(importAppPrivateKey);
    // A failed import must not poison the cache for the lifetime of the isolate.
    this.keyPromise.catch(() => {
      this.keyPromise = null;
    });
    return this.keyPromise;
  }

  private async appJwt(): Promise<string> {
    return signAppJwt(this.config.appId, await this.key(), Math.floor(this.config.clock.now() / 1000));
  }

  async installationId(repository: string): Promise<number> {
    const cached = this.installations.get(repository);
    if (cached !== undefined) return cached;
    const response = await fetchBounded(
      this.config.fetcher,
      `${GITHUB_API}/repos/${repository}/installation`,
      { method: 'GET', headers: headers(`Bearer ${await this.appJwt()}`), timeoutMs: 10_000, maxBytes: 64 * 1024, redirect: 'error' },
      'github_installation',
    );
    if (response.status === 404) fail('github_app_not_installed', `deployer App is not installed on ${repository}`);
    if (response.status !== 200) throw statusError('github_installation', 'installation lookup', response.status);
    const body = parseStrictJsonBytes(response.bytes, 64 * 1024, 'github_installation');
    const id = isPlainObject(body) ? body['id'] : undefined;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) fail('github_installation', 'installation id missing');
    this.installations.set(repository, id);
    return id;
  }

  /** An installation token limited to one repository id and the given permissions. */
  async repositoryToken(repository: string, repositoryId: number, permissions: Permissions): Promise<string> {
    const cacheKey = `${repositoryId}:${JSON.stringify(Object.entries(permissions).sort())}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAtMs - this.config.clock.now() > 5 * 60_000) return cached.token;
    const installationId = await this.installationId(repository);
    const response = await fetchBounded(
      this.config.fetcher,
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: { ...headers(`Bearer ${await this.appJwt()}`), 'content-type': 'application/json' },
        body: JSON.stringify({ repository_ids: [repositoryId], permissions }),
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
        redirect: 'error',
      },
      'github_token',
    );
    if (response.status !== 201) throw statusError('github_token', 'installation token request', response.status);
    const body = parseStrictJsonBytes(response.bytes, 64 * 1024, 'github_token');
    if (!isPlainObject(body) || typeof body['token'] !== 'string' || typeof body['expires_at'] !== 'string') {
      return fail('github_token', 'installation token response is malformed');
    }
    const expiresAtMs = Date.parse(body['expires_at']);
    if (!Number.isFinite(expiresAtMs)) fail('github_token', 'installation token expiry is malformed');
    this.tokens.set(cacheKey, { token: body['token'], expiresAtMs });
    return body['token'];
  }
}

export function headers(authorization: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
  };
}
