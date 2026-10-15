import { DeployError, fail } from '../lib/errors.ts';
import { fetchBounded, isRetryableStatus, statusError, type Fetcher } from '../lib/fetch.ts';
import { isPlainObject, parseStrictJsonBytes } from '../lib/json.ts';
import { GITHUB_API, headers, type GitHubApp } from './app.ts';

/**
 * GitHub calls the deployer makes: release asset download and Deployments reporting.
 * GitHub is the audit surface, never the source of truth; reporting failures never change a
 * deployment's outcome.
 */

/** Hosts GitHub redirects release-asset downloads to (signed, unauthenticated URLs). VERIFY on first live run. */
export const ASSET_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const DOWNLOAD_TIMEOUT_MS = 120_000;

export async function downloadReleaseAsset(
  github: GitHubApp,
  fetcher: Fetcher,
  repository: string,
  repositoryId: number,
  assetId: number,
  expectedSize: number,
): Promise<ReadableStream<Uint8Array>> {
  const token = await github.repositoryToken(repository, repositoryId, { contents: 'read' });
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(`${GITHUB_API}/repos/${repository}/releases/assets/${assetId}`, {
      headers: { ...headers(`Bearer ${token}`), accept: 'application/octet-stream' },
      redirect: 'manual',
      signal,
    });
  } catch (cause) {
    return fail('asset_download', 'release asset request failed', { retryable: true, cause });
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    const target = location ? safeUrl(location) : null;
    // The signed storage URL carries its own authorization; ours must never follow it there.
    if (!target || target.protocol !== 'https:' || !ASSET_HOSTS.has(target.hostname) || target.username || target.password) {
      fail('asset_redirect_refused', 'release asset redirected to an unexpected location');
    }
    try {
      response = await fetcher(target.toString(), { headers: { 'user-agent': 'deployer', accept: 'application/octet-stream' }, redirect: 'manual', signal });
    } catch (cause) {
      return fail('asset_download', 'release asset storage request failed', { retryable: true, cause });
    }
  }
  if (response.status === 404) {
    await response.body?.cancel();
    fail('asset_missing', `release asset ${assetId} does not exist`);
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new DeployError('asset_download', `release asset download returned HTTP ${response.status}`, { retryable: isRetryableStatus(response.status) });
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== expectedSize) {
    await response.body.cancel();
    fail('asset_digest_mismatch', `release asset ${assetId} has ${length} bytes, expected ${expectedSize}`);
  }
  return response.body;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export interface GitHubReporter {
  createDeployment(input: {
    repository: string;
    repositoryId: number;
    ref: string;
    environment: string;
    production: boolean;
    releaseTag: string;
    deploymentId: string;
  }): Promise<number>;
  createStatus(input: {
    repository: string;
    repositoryId: number;
    githubDeploymentId: number;
    state: 'queued' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive';
    description: string;
    environmentUrl: string | null;
  }): Promise<void>;
}

export function githubReporter(github: GitHubApp, fetcher: Fetcher): GitHubReporter {
  const post = async (repository: string, repositoryId: number, path: string, body: unknown, what: string) => {
    const token = await github.repositoryToken(repository, repositoryId, { deployments: 'write' });
    const response = await fetchBounded(
      fetcher,
      `${GITHUB_API}/repos/${repository}${path}`,
      { method: 'POST', headers: { ...headers(`Bearer ${token}`), 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 10_000, maxBytes: 256 * 1024 },
      'github_report',
    );
    if (response.status !== 201) throw statusError('github_report', what, response.status);
    return parseStrictJsonBytes(response.bytes, 256 * 1024, 'github_report');
  };
  return {
    async createDeployment(input) {
      const result = await post(
        input.repository,
        input.repositoryId,
        '/deployments',
        {
          ref: input.ref,
          task: 'deploy',
          auto_merge: false,
          required_contexts: [],
          environment: input.environment,
          description: `${input.releaseTag} via deployer`,
          transient_environment: false,
          production_environment: input.production,
          payload: { deploymentId: input.deploymentId, releaseTag: input.releaseTag },
        },
        'create deployment',
      );
      const id = isPlainObject(result) ? result['id'] : undefined;
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) fail('github_report', 'deployment response has no id');
      return id;
    },
    async createStatus(input) {
      await post(
        input.repository,
        input.repositoryId,
        `/deployments/${input.githubDeploymentId}/statuses`,
        {
          state: input.state,
          description: input.description.slice(0, 140),
          ...(input.environmentUrl ? { environment_url: input.environmentUrl } : {}),
          auto_inactive: true,
        },
        'create deployment status',
      );
    },
  };
}
