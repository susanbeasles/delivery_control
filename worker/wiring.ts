import type { ApiContext } from './adapters/cloudflare-api.ts';
import { CoordinatorEngine, type EngineDeps } from './coordinator/engine.ts';
import { createStepRunner, type StepDeps } from './coordinator/steps.ts';
import type { TxStore } from './coordinator/store.ts';
import type { DeployKick } from './coordinator/types.ts';
import { GitHubApp } from './github/app.ts';
import { downloadReleaseAsset, githubReporter } from './github/github-api.ts';
import { fail } from './lib/errors.ts';
import type { Fetcher } from './lib/fetch.ts';
import { systemClock, type Clock } from './lib/runtime.ts';
import { loadRegistry } from './registry/loader.ts';
import type { RunnerJobRequest, RunnerJobStatus } from './runner/api.ts';

/**
 * Builds the coordinator's dependencies from Worker bindings. Everything platform-specific is here,
 * so the engine and steps stay testable with plain fakes.
 */

export const fetcher: Fetcher = (input, init) => fetch(input, init);

interface SecretBinding {
  get(): Promise<string>;
}

function isSecret(value: unknown): value is SecretBinding {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function';
}

/** Read a Secrets Store binding by name. Names come from the registry, never from a request. */
export async function secretValue(env: Env, binding: string): Promise<string> {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(binding)) fail('credential_missing', 'invalid credential binding name');
  const candidate = (env as unknown as Record<string, unknown>)[binding];
  if (!isSecret(candidate)) fail('credential_missing', `binding ${binding} is not configured on the deployer`);
  let value: string;
  try {
    value = await candidate.get();
  } catch (cause) {
    return fail('credential_missing', `secret ${binding} is not set in the Secrets Store`, { cause });
  }
  if (typeof value !== 'string' || value.length === 0) fail('credential_missing', `secret ${binding} is empty`);
  return value;
}

export function githubApp(env: Env, clock: Clock = systemClock): GitHubApp | null {
  const appId = Number(env.GITHUB_APP_ID);
  if (!Number.isSafeInteger(appId) || appId <= 0) return null;
  return new GitHubApp({ appId, privateKeyPem: () => env.GITHUB_APP_KEY.get(), fetcher, clock });
}

export function requireGitHubApp(env: Env): GitHubApp {
  const app = githubApp(env);
  if (!app) fail('github_app_unconfigured', 'GITHUB_APP_ID is not configured');
  return app;
}

export function registry(env: Env, clock: Clock = systemClock) {
  return () => loadRegistry(env.REGISTRY, clock, env.ACCOUNT_ID);
}

export function runnerClient(env: Env): StepDeps['runner'] {
  const stub = (jobId: string) => env.RUNNER.getByName(jobId);
  return {
    submit: (request: RunnerJobRequest) => stub(request.jobId).submit(request) as Promise<RunnerJobStatus>,
    status: (jobId: string) => stub(jobId).status() as Promise<RunnerJobStatus | null>,
  };
}

export function coordinatorEngine(
  env: Env,
  store: TxStore,
  key: { application: string; environment: string },
  setAlarm: (atMs: number) => Promise<void>,
): CoordinatorEngine {
  const clock = systemClock;
  const app = githubApp(env, clock);
  const steps: StepDeps = {
    clock,
    registry: registry(env, clock),
    storage: { staging: env.STAGING, releases: env.RELEASES },
    assetSource: (record) => async (_name, ref) => {
      if (!app) return fail('github_app_unconfigured', 'GITHUB_APP_ID is not configured');
      return downloadReleaseAsset(app, fetcher, record.request.repository, record.request.repositoryId, ref.id, ref.size);
    },
    runner: runnerClient(env),
    cloudflare: async (credential): Promise<ApiContext> => ({ fetcher, accountId: env.ACCOUNT_ID, token: await secretValue(env, credential) }),
    fetcher,
    state: env.STATE,
    verifyPollMs: 10_000,
  };
  const deps: EngineDeps = {
    store,
    clock,
    key,
    steps: createStepRunner(steps),
    ledger: env.STATE,
    github: app ? githubReporter(app, fetcher) : null,
    queue: {
      send: async (body: DeployKick, delaySeconds: number) => {
        await env.DEPLOY_QUEUE.send(body, { contentType: 'json', delaySeconds });
      },
    },
    setAlarm,
    environmentUrl: (record) => {
      const first = record.plan?.order[0];
      return first ? (record.plan?.targets[first]?.registryTarget.health.origin ?? null) : null;
    },
  };
  return new CoordinatorEngine(deps);
}
