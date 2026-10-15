import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Fetcher as FetchFn } from './lib/fetch.ts';
import { systemClock } from './lib/runtime.ts';
import type { RunnerJobStatus } from './runner/api.ts';
import type { RunnerEnv, SecretBinding } from './runner/env.ts';
import { rootJobStatus, rootRunJob, type AuthorizerRpc, type RootRunResult } from './runner/root.ts';

/**
 * The root runner Worker (wrangler.root-runner.jsonc): the same runner code as the deployer with
 * root bindings. No route, no workers.dev; reachable only through the authorizer's service binding
 * to the `RootRunner` entrypoint. Deployed only by the bootstrap path, never by the deployer.
 */

export { RunnerJob, EgressGate } from './runner/platform.ts';

interface RootRunnerEnv extends RunnerEnv {
  AUTHORIZER: Fetcher;
  CF_SECRETS_WRITE?: SecretBinding;
  SECRETS_STORE_ID: string;
}

const fetcher: FetchFn = (input, init) => fetch(input, init);

export class RootRunner extends WorkerEntrypoint<RootRunnerEnv> {
  async runJob(input: unknown): Promise<RootRunResult> {
    const env = this.env;
    const secretsWrite = env.CF_SECRETS_WRITE;
    return rootRunJob(
      {
        authorizer: env.AUTHORIZER as unknown as AuthorizerRpc,
        runner: env,
        secrets: secretsWrite
          ? { fetcher, token: () => secretsWrite.get(), accountId: env.ACCOUNT_ID, storeId: env.SECRETS_STORE_ID, random: (b) => crypto.getRandomValues(b) }
          : null,
        clock: systemClock,
      },
      input,
    );
  }

  async jobStatus(input: unknown): Promise<RunnerJobStatus | null> {
    return rootJobStatus({ runner: this.env }, input);
  }

  override async fetch(): Promise<Response> {
    return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
}

export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  },
};
