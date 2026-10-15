import { readFrames } from '../../container/agent/framing.mjs';
import type { RunnerJobRequest, RunnerJobStatus, RunnerNotify } from '../../worker/runner/api.ts';
import { JobController, type ControllerDeps, type EgressProps } from '../../worker/runner/controller.ts';
import { statePassphrase, type RunnerEnv } from '../../worker/runner/env.ts';
import { prepareJob } from '../../worker/runner/prepare.ts';
import type { JobRecord } from '../../worker/runner/types.ts';
import { ACCOUNT, JOB_ID, NOW_MS, fakeGitHub, secretEnv } from './builders.ts';
import { FakeBucket, FakeClock, FakeContainer, FakeStorage, nodeHashes, type AgentCall, type AgentScript } from './fakes.ts';

/** Parses what the controller wrote to the agent's stdin, with the agent's own parser. */
export async function readStdin(bytes: Uint8Array): Promise<{ envelope: Record<string, unknown>; files: Map<string, Uint8Array> }> {
  let envelope: Record<string, unknown> = {};
  const files = new Map<string, Uint8Array>();
  const parts = new Map<string, Uint8Array[]>();
  async function* source() {
    yield bytes;
  }
  for await (const event of readFrames(source())) {
    if (event.kind === 'envelope') envelope = event.value as Record<string, unknown>;
    if (event.kind === 'chunk') parts.set(event.file.name, [...(parts.get(event.file.name) ?? []), event.bytes.slice()]);
    if (event.kind === 'file-end') files.set(event.file.name, Buffer.concat(parts.get(event.file.name) ?? []));
  }
  return { envelope, files };
}

export function resultDoc(outcome: 'succeeded' | 'failed' | 'uncertain', result: unknown, error: { code: string; message: string } | null = null, jobId = JOB_ID): string {
  return `${JSON.stringify({ schema: 'runner-result/v1', jobId, outcome, result, error })}\n`;
}

export interface HarnessOptions {
  role?: 'deployer' | 'root';
  script?: AgentScript;
  github?: ReturnType<typeof fakeGitHub>;
  objectName?: string | null;
  storage?: FakeStorage;
  container?: FakeContainer;
  plans?: FakeBucket;
  notify?: (notify: RunnerNotify, jobId: string) => Promise<void>;
}

export function harness(options: HarnessOptions = {}) {
  const storage = options.storage ?? new FakeStorage();
  const container = options.container ?? new FakeContainer(options.script ?? (async () => ({ stdout: '', exitCode: 1 })));
  const plans = options.plans ?? new FakeBucket();
  const logs = new FakeBucket();
  const staging = new FakeBucket();
  const clock = new FakeClock(NOW_MS);
  const env = secretEnv() as unknown as RunnerEnv;
  const github = options.github ?? fakeGitHub();
  const gates: EgressProps[] = [];
  const reports: Array<{ record: JobRecord; status: RunnerJobStatus }> = [];
  const notifications: Array<{ notify: RunnerNotify; jobId: string }> = [];
  const deps: ControllerDeps<{ gate: EgressProps }> = {
    storage,
    container: container as unknown as ControllerDeps<{ gate: EgressProps }>['container'],
    gate: (props) => {
      gates.push(props);
      return { gate: props };
    },
    clock,
    sleep: async () => undefined,
    role: options.role ?? 'deployer',
    accountId: ACCOUNT,
    objectName: options.objectName === undefined ? JOB_ID : options.objectName,
    prepare: (request: RunnerJobRequest) =>
      prepareJob(request, {
        plans,
        staging,
        source: { tokens: github.tokens, fetcher: github.fetcher, hashes: nodeHashes },
        passphrase: (r) => statePassphrase(env, r.type),
        accountId: ACCOUNT,
        hashes: nodeHashes,
      }),
    logs: logs as unknown as ControllerDeps<unknown>['logs'],
    plans,
    report: async (record, status) => {
      reports.push({ record, status });
    },
    notify:
      options.notify ??
      (async (notify, jobId) => {
        notifications.push({ notify, jobId });
      }),
  };
  const controller = new JobController(deps);

  /** Runs alarms until the job is terminal or `max` alarms have fired. */
  async function drive(max = 10): Promise<RunnerJobStatus | null> {
    for (let i = 0; i < max; i++) {
      const status = controller.status();
      if (status && ['succeeded', 'failed', 'uncertain'].includes(status.state)) return status;
      await controller.alarm();
      await controller.settled();
    }
    return controller.status();
  }

  const lastCall = (): AgentCall | undefined => container.calls.at(-1);
  return { storage, container, plans, logs, staging, clock, env, github, gates, reports, notifications, deps, controller, drive, lastCall };
}
