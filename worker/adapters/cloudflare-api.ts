import { DeployError, fail } from '../lib/errors.ts';
import { fetchBounded, isRetryableStatus, type Fetcher } from '../lib/fetch.ts';
import { isJsonObject, isPlainObject, parseStrictJsonBytes, type Json } from '../lib/json.ts';
import { PATTERNS } from '../lib/validate.ts';

/**
 * The slice of the Cloudflare Workers API the `cloudflare-worker/v1` adapter uses. Every call is
 * bounded (timeout and response size), never follows redirects, and maps failures to stable codes
 * with correct retry semantics. The API token is supplied per call and never logged.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE = 2 * 1024 * 1024;

export interface ApiContext {
  fetcher: Fetcher;
  accountId: string;
  token: string;
}

export interface ScriptVersion {
  id: string;
  message: string | null;
  tag: string | null;
}

export interface ActiveDeployment {
  deploymentId: string;
  /** The single version serving 100 % of traffic, or null when traffic is split. */
  versionId: string | null;
}

export interface UploadModule {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Worker version metadata, exactly as the API expects it. */
export interface VersionMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Array<Record<string, string>>;
  keep_bindings?: string[];
  annotations: { 'workers/message': string; 'workers/tag': string };
}

/** Script-not-found as reported by the API (error code 10007). */
export const SCRIPT_NOT_FOUND = 'script_not_found';

async function call(ctx: ApiContext, method: string, path: string, body: BodyInit | null, contentType: string | null, what: string): Promise<Json> {
  const headers: Record<string, string> = { authorization: `Bearer ${ctx.token}`, accept: 'application/json' };
  if (contentType) headers['content-type'] = contentType;
  const response = await fetchBounded(
    ctx.fetcher,
    `${CLOUDFLARE_API}/accounts/${ctx.accountId}${path}`,
    { method, headers, body, timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE, redirect: 'manual' },
    'cloudflare_api',
  );
  let parsed: Json = null;
  if (response.bytes.byteLength > 0) {
    try {
      parsed = parseStrictJsonBytes(response.bytes, MAX_RESPONSE, 'cloudflare_api');
    } catch {
      parsed = null; // non-JSON error pages are handled by status below
    }
  }
  const apiErrors = isPlainObject(parsed) && Array.isArray(parsed['errors']) ? parsed['errors'] : [];
  const codes = apiErrors.map((e) => (isPlainObject(e) && typeof e['code'] === 'number' ? e['code'] : 0));
  if (codes.includes(10007) || (response.status === 404 && what.startsWith('read'))) {
    throw new DeployError(SCRIPT_NOT_FOUND, `${what}: Worker script does not exist`);
  }
  if (response.status >= 300 || !isPlainObject(parsed) || parsed['success'] !== true) {
    const detail = apiErrors
      .slice(0, 3)
      .map((e) => (isPlainObject(e) ? `${String(e['code'] ?? '?')}:${String(e['message'] ?? '').slice(0, 120)}` : '?'))
      .join('; ');
    const retryable = isRetryableStatus(response.status);
    throw new DeployError(response.status === 401 || response.status === 403 ? 'cloudflare_forbidden' : 'cloudflare_api', `${what} failed with HTTP ${response.status}${detail ? ` (${detail})` : ''}`, { retryable });
  }
  return parsed['result'] ?? null;
}

const scriptPath = (script: string): string => {
  if (!PATTERNS.scriptName.test(script)) fail('cloudflare_api', 'invalid script name');
  return `/workers/scripts/${script}`;
};

/** The deployment currently serving the script, or null for a script with no deployments. */
export async function readActiveDeployment(ctx: ApiContext, script: string): Promise<ActiveDeployment | null> {
  const result = await call(ctx, 'GET', `${scriptPath(script)}/deployments`, null, null, 'read deployments');
  const list = isPlainObject(result) && Array.isArray(result['deployments']) ? result['deployments'] : null;
  if (list === null) fail('cloudflare_api', 'read deployments: malformed response');
  const latest = list[0];
  if (latest === undefined) return null;
  if (!isPlainObject(latest) || typeof latest['id'] !== 'string' || !Array.isArray(latest['versions'])) {
    return fail('cloudflare_api', 'read deployments: malformed deployment');
  }
  const versions = latest['versions'].filter(isJsonObject);
  const full = versions.find((v) => v['percentage'] === 100 && typeof v['version_id'] === 'string');
  return { deploymentId: latest['id'], versionId: full ? (full['version_id'] as string) : null };
}

/** Recent versions of a script, newest first. Used to reconcile an upload by operation id. */
export async function listVersions(ctx: ApiContext, script: string): Promise<ScriptVersion[]> {
  const result = await call(ctx, 'GET', `${scriptPath(script)}/versions`, null, null, 'read versions');
  const items = isPlainObject(result) && Array.isArray(result['items']) ? result['items'] : null;
  if (items === null) fail('cloudflare_api', 'read versions: malformed response');
  return items.filter(isJsonObject).flatMap((item) => {
    if (typeof item['id'] !== 'string') return [];
    const annotations = isPlainObject(item['annotations']) ? item['annotations'] : {};
    const message = annotations['workers/message'];
    const tag = annotations['workers/tag'];
    return [{ id: item['id'], message: typeof message === 'string' ? message : null, tag: typeof tag === 'string' ? tag : null }];
  });
}

function multipart(metadata: VersionMetadata | (VersionMetadata & Record<string, unknown>), modules: UploadModule[]): FormData {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const m of modules) form.append(m.name, new Blob([m.bytes], { type: m.contentType }), m.name);
  return form;
}

/** Upload a new version of an existing script without deploying it. Returns the version id. */
export async function uploadVersion(ctx: ApiContext, script: string, metadata: VersionMetadata, modules: UploadModule[]): Promise<string> {
  const result = await call(ctx, 'POST', `${scriptPath(script)}/versions`, multipart(metadata, modules), null, 'upload version');
  const id = isPlainObject(result) ? result['id'] : undefined;
  if (typeof id !== 'string' || !PATTERNS.uuid.test(id)) fail('cloudflare_api', 'upload version: response has no version id');
  return id;
}

/**
 * Create a script that does not exist yet by uploading and deploying in one call (the versions API
 * requires an existing script). The new script serves this version at 100 %.
 */
export async function createScript(ctx: ApiContext, script: string, metadata: VersionMetadata, modules: UploadModule[]): Promise<void> {
  await call(ctx, 'PUT', scriptPath(script), multipart(metadata, modules), null, 'create script');
}

/** Route 100 % of traffic to one version. */
export async function deployVersion(ctx: ApiContext, script: string, versionId: string, message: string): Promise<string> {
  const body = JSON.stringify({
    strategy: 'percentage',
    versions: [{ version_id: versionId, percentage: 100 }],
    annotations: { 'workers/message': message },
  });
  const result = await call(ctx, 'POST', `${scriptPath(script)}/deployments`, body, 'application/json', 'create deployment');
  const id = isPlainObject(result) ? result['id'] : undefined;
  if (typeof id !== 'string') fail('cloudflare_api', 'create deployment: response has no id');
  return id;
}

/** Keep a deployer-managed script off workers.dev and preview URLs; ingress is Terraform's. */
export async function disableSubdomain(ctx: ApiContext, script: string): Promise<void> {
  const body = JSON.stringify({ enabled: false, previews_enabled: false });
  await call(ctx, 'POST', `${scriptPath(script)}/subdomain`, body, 'application/json', 'disable workers.dev');
}
