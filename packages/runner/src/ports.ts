// Ports the controller depends on. Production binds them to the Durable Object container, SQLite storage, alarms,
// R2 and Secrets Store; tests bind fakes. The controller never imports a Cloudflare module.
import type { Envelope } from './envelope.ts';
import type { InstanceType, JobTypeRegistry, JobTypeSpec } from './job-type.ts';
import type { JobRecord } from './records.ts';

export interface ProcessHandle {
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

export interface ContainerStartOptions {
  readonly image: string;
  readonly instance: InstanceType;
  readonly enableInternet: false;
  readonly labels?: Record<string, string>;
}

export interface ContainerExecOptions {
  readonly env?: Record<string, string>;
  readonly stdin?: ReadableStream<Uint8Array>;
  readonly stdout: 'pipe';
  readonly stderr: 'pipe';
}

/** The target of intercepted container egress: a Worker entrypoint stub. */
export interface OutboundBinding {
  fetch(request: Request): Promise<Response>;
}

/** Structural subset of the Durable Object `Container` interface used by the controller. */
export interface ContainerHandle {
  readonly running: boolean;
  readonly images: Readonly<Record<string, string>>;
  start(options: ContainerStartOptions): void;
  exec(command: readonly string[], options: ContainerExecOptions): Promise<ProcessHandle>;
  monitor(): Promise<void>;
  destroy(): Promise<void>;
  interceptAllOutboundHttp(binding: OutboundBinding): Promise<void>;
  interceptOutboundHttps(address: string, binding: OutboundBinding): Promise<void>;
}

/** One record per Durable Object: the job it owns. */
export interface JobStore {
  get(): JobRecord | undefined;
  put(record: JobRecord): void;
}

export interface Alarms {
  set(atMs: number): Promise<void>;
  clear(): Promise<void>;
}

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects when `signal` aborts first. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface LogSink {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface SecretSource {
  /** Resolve one secret the job type declared. The envelope lets a source scope a minted credential to the job. */
  get(name: string, envelope: Envelope): Promise<string>;
}

export interface StagedFile {
  /** Path relative to the job type's stage directory. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ControllerEvent {
  readonly stage: 'log_upload' | 'artifact_upload' | 'outcome_upload' | 'destroy' | 'alarm';
  readonly job_id: string;
  readonly detail: string;
}

export interface ControllerDeps {
  readonly container: ContainerHandle;
  readonly store: JobStore;
  readonly alarms: Alarms;
  readonly clock: Clock;
  readonly sink: LogSink;
  readonly secrets: SecretSource;
  /** The egress gate stub for one job: the job type's allowlist, and the envelope for anything the gate injects. */
  readonly outbound: (spec: JobTypeSpec, envelope: Envelope) => OutboundBinding;
  readonly jobTypes: JobTypeRegistry;
  /** Files to write into the container before the job runs, for job types that declare `stage`. */
  readonly stage?: (spec: JobTypeSpec, envelope: Envelope) => Promise<readonly StagedFile[]>;
  /** Key prefix in the log sink; default `logs/`. */
  readonly logPrefix?: string;
  /** Best-effort failures the controller survived; wire to console or metrics. */
  readonly observe?: (event: ControllerEvent) => void;
}
