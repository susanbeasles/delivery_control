// Cloudflare bindings for the controller. A consumer Worker subclasses `RunnerJob` (one Durable Object per job,
// SQLite storage, `durable_object` container scheduling) and exports `RunnerOutbound` as the egress gate.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { JobController } from './controller.ts';
import { isHostname, type JobTypeRegistry } from './job-type.ts';
import { createOutboundFetch } from './outbound.ts';
import type { Alarms, Clock, ContainerHandle, LogSink, OutboundBinding, SecretSource } from './ports.ts';
import type { RunResult } from './records.ts';
import { SqlJobStore } from './sql-store.ts';

export interface RunnerJobEnv {
  /** R2 bucket `runner-logs`: stdout, stderr and outcome per job, 90-day lifecycle managed in infra-root. */
  readonly RUNNER_LOGS: R2Bucket;
}

export class R2LogSink implements LogSink {
  readonly #bucket: R2Bucket;
  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.#bucket.put(key, body, { httpMetadata: { contentType } });
  }
}

export class WorkersClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export class StorageAlarms implements Alarms {
  readonly #storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }
  set(atMs: number): Promise<void> {
    return this.#storage.setAlarm(atMs);
  }
  clear(): Promise<void> {
    return this.#storage.deleteAlarm();
  }
}

/** Maps secret names a job type declares to the Worker's Secrets Store bindings. Unknown names are refused. */
export class SecretsStoreSource implements SecretSource {
  readonly #bindings: Readonly<Record<string, SecretsStoreSecret>>;
  constructor(bindings: Readonly<Record<string, SecretsStoreSecret>>) {
    this.#bindings = bindings;
  }
  get(name: string): Promise<string> {
    const binding = this.#bindings[name];
    if (binding === undefined) return Promise.reject(new Error(`no Secrets Store binding for ${name}`));
    return binding.get();
  }
}

export interface OutboundProps {
  readonly allowedHosts: readonly string[];
}

/**
 * Egress gate entrypoint. Bind it per job with `ctx.exports.<ExportName>({ props: { allowedHosts } })` from the
 * `RunnerJob.outbound` implementation. Props are data from the Durable Object, re-validated here.
 */
export class RunnerOutbound<Env = unknown> extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const hosts: unknown = this.ctx.props?.allowedHosts;
    if (!Array.isArray(hosts) || !hosts.every((host): host is string => typeof host === 'string' && isHostname(host))) {
      return new Response('runner egress refused: no allowlist\n', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return createOutboundFetch(hosts)(request);
  }
}

export abstract class RunnerJob<Env extends RunnerJobEnv = RunnerJobEnv> extends DurableObject<Env> {
  #controller: JobController | undefined;

  /** The job types this Worker runs. Static configuration, reviewed by PR. */
  protected abstract jobTypes(): JobTypeRegistry;
  /** Resolves a secret name from a job type to its Secrets Store binding. */
  protected abstract secrets(): SecretSource;
  /** The egress gate stub for one job's allowlist, usually `this.ctx.exports.Outbound({ props: { allowedHosts } })`. */
  protected abstract outbound(allowedHosts: readonly string[]): OutboundBinding;

  protected controller(): JobController {
    if (this.#controller !== undefined) return this.#controller;
    const container = this.ctx.container;
    if (container === undefined) throw new Error('this Durable Object has no container; check the containers configuration');
    const handle: ContainerHandle = container;
    this.#controller = new JobController({
      container: handle,
      store: new SqlJobStore(this.ctx.storage.sql),
      alarms: new StorageAlarms(this.ctx.storage),
      clock: new WorkersClock(),
      sink: new R2LogSink(this.env.RUNNER_LOGS),
      secrets: this.secrets(),
      outbound: (hosts) => this.outbound(hosts),
      jobTypes: this.jobTypes(),
      observe: (event) => console.error(JSON.stringify({ runner: event })),
    });
    return this.#controller;
  }

  /** RPC entry: submit the envelope bytes. Safe to repeat. */
  run(bytes: ArrayBuffer | Uint8Array): Promise<RunResult> {
    return this.controller().run(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  override alarm(): Promise<void> {
    return this.controller().watchdog();
  }
}
