import { canonicalBytes, sha256Hex } from '../../../worker/lib/json.ts';

export const COMMIT = '0123456789abcdef0123456789abcdef01234567';
export const ACCOUNT = '1a799c6e699d2ef7e87398692ce3ad7b';

export function registryDoc(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'deploy-registry/v1',
    revision: 3,
    accountId: ACCOUNT,
    applications: [
      {
        application: 'prosrus',
        repository: 'susanbeasles/ProsRUs',
        repositoryId: 1412827677,
        releaseWorkflow: 'susanbeasles/workflow_depot/.github/workflows/release.yml',
        maxArtifactBytes: 16 * 1024 * 1024,
        environments: [
          {
            environment: 'production',
            githubEnvironment: 'production',
            targets: [
              {
                id: 'api',
                adapter: 'cloudflare-worker/v1',
                scriptName: 'prosrus-api',
                credential: 'WORKER_PROSRUS_API',
                health: { origin: 'https://jobs.susanb.dev', timeoutMs: 2000, attempts: 3, intervalMs: 1000 },
                bindings: [
                  { name: 'DB', type: 'd1', id: '11111111-2222-3333-4444-555555555555' },
                  { name: 'MODE', type: 'plain_text', text: 'production' },
                ],
                keepBindings: ['secret_text'],
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function workerArtifactDoc(modules: Array<{ name: string; path: string; type: string; sha256: string }>, bindings: string[] = ['DB']) {
  return {
    schema: 'worker-artifact/v1',
    mainModule: modules[0]!.name,
    compatibilityDate: '2026-10-01',
    compatibilityFlags: [],
    modules,
    bindings,
  };
}

export function manifestDoc(artifactSha: string, size: number, targets: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schema: 'release-manifest/v2',
    application: 'prosrus',
    repository: 'susanbeasles/ProsRUs',
    repositoryId: 1412827677,
    releaseTag: 'v1.4.2',
    sourceCommit: COMMIT,
    createdAt: '2026-10-15T12:00:00.000Z',
    artifact: { path: 'release.zip', sha256: artifactSha, sizeBytes: size, mediaType: 'application/zip' },
    targets,
    ...overrides,
  };
}

export function subjectDoc(assets: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schema: 'deploy-subject/v1',
    intent: 'deploy',
    application: 'prosrus',
    environment: 'production',
    repository: 'susanbeasles/ProsRUs',
    repositoryId: 1412827677,
    releaseTag: 'v1.4.2',
    releaseId: 987654,
    sourceCommit: COMMIT,
    assets,
    requestedBy: {
      actorId: 215839550,
      runId: 1234567890,
      runAttempt: 1,
      workflowRef: 'susanbeasles/ProsRUs/.github/workflows/deploy.yml@refs/heads/main',
      jobWorkflowRef: 'susanbeasles/workflow_depot/.github/workflows/deploy.yml@refs/heads/main',
      eventName: 'push',
    },
    authorizedAt: '2026-10-15T12:00:05.000Z',
    ...overrides,
  };
}

export const bytesOf = (value: unknown) => canonicalBytes(value);
export const digest = (bytes: Uint8Array) => sha256Hex(bytes);
