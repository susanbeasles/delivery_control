import { DeployError, fail } from '../lib/errors.ts';
import { fetchBounded, isRetryableStatus, statusError, type Fetcher } from '../lib/fetch.ts';
import { decodeUtf8, isPlainObject, parseStrictJsonBytes } from '../lib/json.ts';
import { GITHUB_API, headers, type Permissions } from '../github/app.ts';
import { captureChunks, type ChunkedBytes, type HashFactory } from './streams.ts';

/**
 * The GitHub reads a terraform job needs, done by the Durable Object (never by the container):
 * the tree of the commit (to bind plans by tree), the commit `main` points at (policy source), and
 * repository tarballs. Installation tokens are narrowed to one repository and `contents: read`.
 */

export interface RepositoryTokens {
  repositoryToken(repository: string, repositoryId: number, permissions: Permissions): Promise<string>;
}

export interface SourceDeps {
  tokens: RepositoryTokens;
  fetcher: Fetcher;
  hashes: HashFactory;
}

export interface RepositoryRef {
  repository: string;
  repositoryId: number;
}

const CODELOAD_HOST = 'codeload.github.com';
const READ: Permissions = { contents: 'read' };
const SMALL = 64 * 1024;

async function authHeaders(deps: SourceDeps, repo: RepositoryRef): Promise<Record<string, string>> {
  return headers(`Bearer ${await deps.tokens.repositoryToken(repo.repository, repo.repositoryId, READ)}`);
}

/** Tree SHA of a commit, from the git database API. */
export async function commitTree(deps: SourceDeps, repo: RepositoryRef, commit: string): Promise<string> {
  const response = await fetchBounded(
    deps.fetcher,
    `${GITHUB_API}/repos/${repo.repository}/git/commits/${commit}`,
    { method: 'GET', headers: await authHeaders(deps, repo), timeoutMs: 15_000, maxBytes: SMALL, redirect: 'manual' },
    'github_commit',
  );
  if (response.status === 404) fail('commit_not_found', `commit ${commit} does not exist in ${repo.repository}`);
  if (response.status !== 200) throw statusError('github_commit', 'commit lookup', response.status);
  const body = parseStrictJsonBytes(response.bytes, SMALL, 'github_commit');
  const tree = isPlainObject(body) && isPlainObject(body['tree']) ? body['tree']['sha'] : undefined;
  if (typeof tree !== 'string' || !/^[a-f0-9]{40}$/.test(tree)) fail('github_commit', 'commit response has no tree');
  return tree;
}

/** The commit a branch points at, using the `application/vnd.github.sha` media type (plain 40 hex). */
export async function branchHead(deps: SourceDeps, repo: RepositoryRef, branch: string): Promise<string> {
  const response = await fetchBounded(
    deps.fetcher,
    `${GITHUB_API}/repos/${repo.repository}/commits/${encodeURIComponent(branch)}`,
    { method: 'GET', headers: { ...(await authHeaders(deps, repo)), accept: 'application/vnd.github.sha' }, timeoutMs: 15_000, maxBytes: 1024, redirect: 'manual' },
    'github_branch',
  );
  if (response.status !== 200) throw statusError('github_branch', `${branch} lookup`, response.status);
  const sha = decodeUtf8(response.bytes, 'github_branch').trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) fail('github_branch', `${branch} did not resolve to a commit`);
  return sha;
}

/**
 * Repository tarball at an exact commit. GitHub answers with a redirect to a short-lived codeload
 * URL that carries its own authorization; exactly one redirect is followed, only to codeload over
 * HTTPS, and our token is never sent there. The Location is never logged (it embeds a token).
 */
export async function downloadTarball(deps: SourceDeps, repo: RepositoryRef, commit: string, maxBytes: number): Promise<ChunkedBytes> {
  const signal = AbortSignal.timeout(120_000);
  let response = await send(deps.fetcher, `${GITHUB_API}/repos/${repo.repository}/tarball/${commit}`, { headers: await authHeaders(deps, repo), redirect: 'manual', signal });
  if (response.status >= 300 && response.status < 400) {
    const target = parseLocation(response.headers.get('location'));
    await response.body?.cancel();
    if (!target || target.protocol !== 'https:' || target.hostname !== CODELOAD_HOST || target.username || target.password || target.port) {
      fail('tarball_redirect_refused', 'tarball redirected somewhere other than codeload.github.com');
    }
    response = await send(deps.fetcher, target.toString(), { headers: { 'user-agent': 'deployer-runner' }, redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail('tarball_redirect_refused', 'codeload redirected again');
    }
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new DeployError('tarball_download', `tarball download returned HTTP ${response.status}`, { retryable: isRetryableStatus(response.status) });
  }
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > maxBytes) {
    await response.body.cancel();
    fail('tarball_too_large', `tarball exceeds ${maxBytes} bytes`);
  }
  return captureChunks(response.body, maxBytes, deps.hashes, 'tarball_download');
}

async function send(fetcher: Fetcher, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (cause) {
    return fail('tarball_download', 'tarball request failed', { retryable: true, cause });
  }
}

function parseLocation(value: string | null): URL | null {
  if (value === null) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
