import type { HealthContract } from '../contracts/manifest.ts';
import { fail } from '../lib/errors.ts';
import { readBounded, type Fetcher } from '../lib/fetch.ts';
import { isPlainObject, parseStrictJsonBytes } from '../lib/json.ts';
import type { HealthSettings } from '../registry/registry.ts';

/**
 * One health probe. The host comes only from the registry; the path comes from the manifest and is
 * already restricted to a plain absolute path. The URL is assembled and then re-checked so no
 * combination can leave the registered origin. Redirects are failures.
 */

export interface ProbeResult {
  healthy: boolean;
  status: number | null;
  reason: string;
}

const MAX_BODY = 64 * 1024;

export function healthUrl(settings: HealthSettings, contract: HealthContract): string {
  const url = new URL(`${settings.origin}${contract.path}`);
  if (url.origin !== settings.origin || url.pathname !== contract.path || url.search !== '' || url.hash !== '') {
    fail('health_url_invalid', 'health URL escapes the registered origin');
  }
  return url.toString();
}

export async function probe(fetcher: Fetcher, settings: HealthSettings, contract: HealthContract, releaseTag: string): Promise<ProbeResult> {
  const url = healthUrl(settings, contract);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'deployer-health' },
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch {
    return { healthy: false, status: null, reason: 'unreachable' };
  }
  let body: Uint8Array;
  try {
    body = await readBounded(response.body, MAX_BODY, 'health_body');
  } catch {
    return { healthy: false, status: response.status, reason: 'body unreadable or too large' };
  }
  if (response.status >= 300 && response.status < 400) return { healthy: false, status: response.status, reason: 'redirected' };
  if (response.status !== contract.expectStatus) return { healthy: false, status: response.status, reason: `expected ${contract.expectStatus}` };
  if (!contract.expectReleaseTag) return { healthy: true, status: response.status, reason: 'ok' };
  try {
    const doc = parseStrictJsonBytes(body, MAX_BODY, 'health_body');
    if (isPlainObject(doc) && doc['release'] === releaseTag) return { healthy: true, status: response.status, reason: 'ok' };
    return { healthy: false, status: response.status, reason: 'serving a different release' };
  } catch {
    return { healthy: false, status: response.status, reason: 'body is not the health document' };
  }
}
