// Fakes for the controller's ports. Deterministic: the clock only moves when a test advances it.
import type { Alarms, Clock, ContainerExecOptions, ContainerHandle, ContainerStartOptions, JobStore, LogSink, OutboundBinding, ProcessHandle, SecretSource } from '../src/ports.ts';
import type { JobRecord } from '../src/records.ts';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export class FakeClock implements Clock {
  #now: number;
  #timers: { due: number; resolve: () => void; reject: (error: Error) => void }[] = [];
  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = { due: this.#now + ms, resolve, reject };
      this.#timers.push(timer);
      signal.addEventListener(
        'abort',
        () => {
          this.#timers = this.#timers.filter((t) => t !== timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
  }
  /** Move time forward and fire every timer that became due, letting promise chains settle in between. */
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.due <= this.#now).sort((a, b) => a.due - b.due);
      if (due.length === 0) break;
      for (const timer of due) {
        this.#timers = this.#timers.filter((t) => t !== timer);
        timer.resolve();
      }
      await settle();
    }
  }
  pending(): number {
    return this.#timers.length;
  }
}

/** Let queued microtasks and already-resolved promise chains run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Wait until `condition` holds. Async work such as `crypto.subtle.digest` runs off-thread, so a fixed number of
 * event-loop turns is not enough under load. */
export async function until(condition: () => boolean, what = 'condition', maxRounds = 5_000): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export class MemoryStore implements JobStore {
  record: JobRecord | undefined;
  puts = 0;
  get(): JobRecord | undefined {
    return this.record;
  }
  put(record: JobRecord): void {
    this.puts++;
    this.record = structuredClone(record);
  }
}

export class FakeAlarms implements Alarms {
  at: number | null = null;
  calls: string[] = [];
  failClear = false;
  async set(atMs: number): Promise<void> {
    this.calls.push(`set:${atMs}`);
    this.at = atMs;
  }
  async clear(): Promise<void> {
    this.calls.push('clear');
    if (this.failClear) throw new Error('alarm storage down');
    this.at = null;
  }
}

export class MemorySink implements LogSink {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();
  failKeys = new Set<string>();
  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    if ([...this.failKeys].some((suffix) => key.endsWith(suffix))) throw new Error(`sink refused ${key}`);
    this.objects.set(key, { body: new Uint8Array(body), contentType });
  }
  text(key: string): string {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error(`no object ${key}`);
    return decoder.decode(object.body);
  }
  json(key: string): unknown {
    return JSON.parse(this.text(key));
  }
}

export class MemorySecrets implements SecretSource {
  readonly values: Record<string, string>;
  constructor(values: Record<string, string>) {
    this.values = values;
  }
  async get(name: string): Promise<string> {
    const value = this.values[name];
    if (value === undefined) throw new Error(`missing secret ${name}`);
    return value;
  }
}

export class FakeOutbound implements OutboundBinding {
  readonly allowedHosts: readonly string[];
  constructor(allowedHosts: readonly string[]) {
    this.allowedHosts = allowedHosts;
  }
  async fetch(): Promise<Response> {
    return new Response('fake');
  }
}

/** A scripted process: the test pushes output, ends it, or lets it hang. */
export class FakeProcess implements ProcessHandle {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exitCode: Promise<number>;
  readonly signals: number[] = [];
  stdinBytes: Uint8Array = new Uint8Array(0);
  #out!: ReadableStreamDefaultController<Uint8Array>;
  #err!: ReadableStreamDefaultController<Uint8Array>;
  #exit!: (code: number) => void;
  #fail!: (error: Error) => void;
  #closed = false;
  readonly killBehaviour: 'exit' | 'ignore';
  constructor(killBehaviour: 'exit' | 'ignore' = 'exit') {
    this.killBehaviour = killBehaviour;
    const chunks: Uint8Array[] = [];
    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => {
        chunks.push(chunk);
        this.stdinBytes = concat([...chunks]);
      },
    });
    this.stdout = new ReadableStream<Uint8Array>({ start: (c) => void (this.#out = c) });
    this.stderr = new ReadableStream<Uint8Array>({ start: (c) => void (this.#err = c) });
    this.exitCode = new Promise<number>((resolve, reject) => {
      this.#exit = resolve;
      this.#fail = reject;
    });
  }
  out(text: string): void {
    this.#out.enqueue(encoder.encode(text));
  }
  err(text: string): void {
    this.#err.enqueue(encoder.encode(text));
  }
  outBytes(bytes: Uint8Array): void {
    this.#out.enqueue(bytes);
  }
  breakStdout(): void {
    this.#out.error(new Error('stream reset'));
  }
  exit(code: number): void {
    this.closeStreams();
    this.#exit(code);
  }
  /** Exit while a child keeps the pipes open. */
  exitWithoutClosing(code: number): void {
    this.#exit(code);
  }
  failExit(): void {
    this.closeStreams();
    this.#fail(new Error('exit status lost'));
  }
  closeStreams(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#out.close();
    } catch {
      // already errored
    }
    try {
      this.#err.close();
    } catch {
      // already errored
    }
  }
  kill(signal = 15): void {
    this.signals.push(signal);
    if (this.killBehaviour === 'exit') this.exit(128 + signal);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class FakeContainer implements ContainerHandle {
  running = false;
  images: Record<string, string> = { deployer: 'registry.cloudflare.com/acct/deployer@sha256:' + 'ab'.repeat(32) };
  starts: ContainerStartOptions[] = [];
  execs: { command: readonly string[]; options: ContainerExecOptions; process: FakeProcess }[] = [];
  intercepts: { kind: 'http' | 'https'; address: string | null; binding: OutboundBinding }[] = [];
  destroys = 0;
  failStart: Error | undefined;
  failExec: Error | undefined;
  failDestroy: Error | undefined;
  nextProcess: () => FakeProcess = () => new FakeProcess();
  #died!: () => void;
  #monitor = new Promise<void>((resolve) => {
    this.#died = resolve;
  });
  start(options: ContainerStartOptions): void {
    if (this.failStart) throw this.failStart;
    this.starts.push(options);
    this.running = true;
  }
  async exec(command: readonly string[], options: ContainerExecOptions): Promise<FakeProcess> {
    if (!this.running) throw new Error('container not running');
    if (this.failExec) throw this.failExec;
    const process = this.nextProcess();
    this.execs.push({ command, options, process });
    void options.stdin.pipeTo(process.stdin);
    return process;
  }
  monitor(): Promise<void> {
    return this.#monitor;
  }
  /** Simulate the container going away underneath the job. */
  die(): void {
    this.running = false;
    for (const e of this.execs) e.process.closeStreams();
    this.#died();
  }
  async destroy(): Promise<void> {
    if (this.failDestroy) throw this.failDestroy;
    this.destroys++;
    this.running = false;
    for (const e of this.execs) e.process.closeStreams();
    this.#died();
  }
  async interceptAllOutboundHttp(binding: OutboundBinding): Promise<void> {
    this.intercepts.push({ kind: 'http', address: null, binding });
  }
  async interceptOutboundHttps(address: string, binding: OutboundBinding): Promise<void> {
    this.intercepts.push({ kind: 'https', address, binding });
  }
}
