import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { DeployError } from '../lib/errors.ts';
import type { Fetcher as FetchFn } from '../lib/fetch.ts';
import { toHex } from '../lib/json.ts';
import { sleep, systemClock } from '../lib/runtime.ts';
import { GitHubApp } from '../github/app.ts';
import type { RunnerJobRequest, RunnerJobRpc, RunnerJobStatus } from './api.ts';
import { JobController, type EgressProps } from './controller.ts';
import { handleEgress, type GateProps } from './egress/gate.ts';
import type { EgressContext } from './egress/rules.ts';
import { cloudflareToken, stateCredentials, statePassphrase, type RunnerEnv } from './env.ts';
import { reportTerraformJob } from './github-report.ts';
import { notifyCoordinator } from './notify.ts';
import { prepareJob } from './prepare.ts';
import { roleOf } from './profiles.ts';
import type { HashFactory } from './streams.ts';

/**
 * Platform glue only: the `RunnerJob` Durable Object and the `EgressGate` entrypoint, both thin
 * wrappers that build their dependencies from bindings and delegate to pure, tested modules.
 * Both are exported by the deployer (`worker/index.ts`) and by the root runner (`worker/root-runner.ts`).
 */

const fetcher: FetchFn = (input, init) => fetch(input, init);

/** Incremental SHA-256 over the runtime's `crypto.DigestStream`. */
const hashes: HashFactory = () => {
  const stream = new crypto.DigestStream('SHA-256');
  const writer = stream.getWriter();
  return {
    update: (chunk) => writer.write(chunk),
    hex: async () => {
      await writer.close();
      return toHex(new Uint8Array(await stream.digest));
    },
  };
};

function githubApp(env: RunnerEnv): GitHubApp | null {
  const appId = Number(env.GITHUB_APP_ID);
  if (!Number.isSafeInteger(appId) || appId <= 0) return null;
  return new GitHubApp({ appId, privateKeyPem: () => env.GITHUB_APP_KEY.get(), fetcher, clock: systemClock });
}

interface EgressContextRpc {
  egressContext(): Promise<EgressContext | null>;
}

export class RunnerJob extends DurableObject<RunnerEnv> implements RunnerJobRpc {
  private readonly controller: JobController<Fetcher>;

  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);
    const app = githubApp(env);
    const container = ctx.container ?? null;
    this.controller = new JobController<Fetcher>({
      storage: ctx.storage,
      container,
      gate: (props: EgressProps) => ctx.exports.EgressGate({ props }),
      clock: systemClock,
      sleep,
      role: roleOf(env.RUNNER_ROLE),
      accountId: env.ACCOUNT_ID,
      objectName: ctx.id.name ?? null,
      prepare: (request: RunnerJobRequest) =>
        prepareJob(request, {
          plans: env.TF_PLANS,
          staging: env.STAGING ?? null,
          source: app ? { tokens: app, fetcher, hashes } : null,
          passphrase: (r) => statePassphrase(env, r.type),
          accountId: env.ACCOUNT_ID,
          hashes,
        }),
      logs: env.RUNNER_LOGS,
      plans: env.TF_PLANS,
      report: (record, status) => reportTerraformJob(app ? { tokens: app, fetcher } : null, record.request, status),
      notify: (notify, jobId) => notifyCoordinator(env.COORDINATOR, notify, jobId),
    });
  }

  async submit(request: RunnerJobRequest): Promise<RunnerJobStatus> {
    try {
      return await this.controller.submit(request);
    } catch (error) {
      // Only name and message cross the RPC boundary, so the stable code leads the message.
      if (error instanceof DeployError) throw Object.assign(new Error(`${error.code}: ${error.message}`), { name: 'DeployError' });
      throw error;
    }
  }

  async status(): Promise<RunnerJobStatus | null> {
    return this.controller.status();
  }

  /** Called by `EgressGate` for every intercepted request; `null` unless the agent is running. */
  async egressContext(): Promise<EgressContext | null> {
    return this.controller.egressContext();
  }

  override async alarm(): Promise<void> {
    await this.controller.alarm();
  }
}

export class EgressGate extends WorkerEntrypoint<RunnerEnv, GateProps> {
  override async fetch(request: Request): Promise<Response> {
    const env = this.env;
    return handleEgress(request, this.ctx.props, {
      context: (jobId) => (env.RUNNER.getByName(jobId) as unknown as EgressContextRpc).egressContext(),
      cloudflareToken: (type) => cloudflareToken(env, type),
      stateCredentials: (type) => stateCredentials(env, type),
      fetcher,
      plans: env.TF_PLANS,
      clock: systemClock,
    });
  }
}
