import { createHash, generateKeyPairSync } from 'node:crypto';
import type { HashFactory } from '../../worker/runner/streams.ts';
import { IMAGE } from '../../worker/runner/limits.ts';

/** In-memory stand-ins for the platform pieces the runner touches. */

export const nodeHashes: HashFactory = () => {
  const hash = createHash('sha256');
  return {
    update: async (chunk: Uint8Array) => {
      hash.update(chunk);
    },
    hex: async () => hash.digest('hex'),
  };
};

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export class FakeClock {
  ms: number;
  constructor(ms = Date.parse('2026-10-15T12:00:00.000Z')) {
    this.ms = ms;
  }
  now(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** `ctx.storage` subset: sync KV with copy semantics, transactionSync with rollback, one alarm. */
export class FakeStorage {
  readonly map = new Map<string, unknown>();
  alarm: number | null = null;
  readonly alarms: number[] = [];
  readonly kv = {
    get: (key: string): unknown => (this.map.has(key) ? structuredClone(this.map.get(key)) : undefined),
    put: (key: string, value: unknown): void => {
      this.map.set(key, structuredClone(value));
    },
    delete: (key: string): boolean => this.map.delete(key),
  };
  transactionSync<T>(closure: () => T): T {
    const snapshot = new Map([...this.map].map(([k, v]) => [k, structuredClone(v)]));
    try {
      return closure();
    } catch (error) {
      this.map.clear();
      for (const [k, v] of snapshot) this.map.set(k, v);
      throw error;
    }
  }
  async setAlarm(ms: number): Promise<void> {
    this.alarm = ms;
    this.alarms.push(ms);
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

interface Stored {
  bytes: Uint8Array;
  contentType?: string;
}

/** R2 binding subset: head/get/put (create-only via etagDoesNotMatch "*"), multipart uploads. */
export class FakeBucket {
  readonly objects = new Map<string, Stored>();
  failPuts = false;

  async head(key: string): Promise<{ size: number } | null> {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.byteLength } : null;
  }
  async get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    const bytes = o.bytes;
    // Deliver in small chunks so streaming code paths are exercised.
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + 7));
        offset += 7;
      },
    });
    return { size: bytes.byteLength, body };
  }
  async put(key: string, value: Uint8Array | ReadableStream<Uint8Array> | string, options?: { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType: string } }): Promise<unknown> {
    if (this.failPuts) throw new Error('r2 unavailable');
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
    return { key };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async createMultipartUpload(key: string) {
    const parts = new Map<number, Uint8Array>();
    return {
      uploadPart: async (partNumber: number, value: Uint8Array) => {
        parts.set(partNumber, value.slice());
        return { partNumber, etag: `etag-${partNumber}` };
      },
      complete: async (list: Array<{ partNumber: number }>) => {
        const chunks = list.map((p) => parts.get(p.partNumber) ?? new Uint8Array(0));
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.byteLength;
        }
        this.objects.set(key, { bytes: out });
        return { key };
      },
      abort: async () => undefined,
      partSizes: () => [...parts.values()].map((p) => p.byteLength),
    };
  }
  text(key: string): string | null {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.bytes) : null;
  }
  putText(key: string, text: string): void {
    this.objects.set(key, { bytes: new TextEncoder().encode(text) });
  }
}

export interface AgentCall {
  cmd: string[];
  env: Record<string, string>;
  user: string;
  cwd: string;
  stdin: Uint8Array;
}

export type AgentScript = (call: AgentCall) => Promise<{ stdout: string; stderr?: string; exitCode: number } | 'hang'>;

class FakeProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exitCode: Promise<number>;
  killed = false;
  private resolveExit!: (code: number) => void;
  private outCtl!: ReadableStreamDefaultController<Uint8Array>;
  private errCtl!: ReadableStreamDefaultController<Uint8Array>;

  constructor(onStdin: (bytes: Uint8Array) => void) {
    this.exitCode = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.stdout = new ReadableStream({ start: (c) => void (this.outCtl = c) });
    this.stderr = new ReadableStream({ start: (c) => void (this.errCtl = c) });
    const chunks: Uint8Array[] = [];
    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => void chunks.push(chunk.slice()),
      close: () => onStdin(Buffer.concat(chunks)),
    });
  }

  finish(stdout: string, stderr: string, code: number): void {
    if (this.killed) return;
    if (stderr) this.errCtl.enqueue(new TextEncoder().encode(stderr));
    if (stdout) this.outCtl.enqueue(new TextEncoder().encode(stdout));
    this.close(code);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.close(137);
  }

  private close(code: number): void {
    try {
      this.outCtl.close();
      this.errCtl.close();
    } catch {
      // already closed
    }
    this.resolveExit(code);
  }
}

/** The platform `Container` as the runner uses it. */
export class FakeContainer {
  running = false;
  exists = false;
  readonly images: Record<string, string> = { runner: 'registry.cloudflare.com/acct/runner@sha256:' + 'a'.repeat(64) };
  readonly starts: Array<Record<string, unknown>> = [];
  readonly intercepts: Array<{ kind: 'http' | 'https'; addr: string; binding: unknown }> = [];
  readonly calls: AgentCall[] = [];
  readonly processes: FakeProcess[] = [];
  destroys = 0;
  /** When true, destroy() has no effect (cleanup cannot be confirmed). */
  stuck = false;
  probeFailures = 0;
  script: AgentScript;

  constructor(script: AgentScript) {
    this.script = script;
  }

  start(options: Record<string, unknown>): void {
    this.running = true;
    this.exists = true;
    this.starts.push(options);
  }
  async destroy(): Promise<void> {
    this.destroys += 1;
    if (this.stuck) throw new Error('destroy failed');
    for (const p of this.processes) p.kill();
    this.running = false;
    this.exists = false;
  }
  async inspect(): Promise<{ image: string; labels: Record<string, string> } | null> {
    return this.exists ? { image: this.images['runner'] ?? '', labels: {} } : null;
  }
  async interceptOutboundHttps(addr: string, binding: unknown): Promise<void> {
    this.intercepts.push({ kind: 'https', addr, binding });
  }
  async interceptOutboundHttp(addr: string, binding: unknown): Promise<void> {
    this.intercepts.push({ kind: 'http', addr, binding });
  }
  async exec(cmd: string[], options: { env?: Record<string, string>; user?: string; cwd?: string }): Promise<FakeProcess> {
    if (!this.running) throw new Error('container not running');
    if (cmd[1] === IMAGE.probe) {
      const probe = new FakeProcess(() => undefined);
      probe.finish('{"ready":true}\n', '', this.probeFailures-- > 0 ? 1 : 0);
      return probe;
    }
    const process = new FakeProcess((stdin) => {
      const call: AgentCall = { cmd, env: options.env ?? {}, user: options.user ?? '', cwd: options.cwd ?? '', stdin };
      this.calls.push(call);
      void this.script(call).then((out) => {
        if (out !== 'hang') process.finish(out.stdout, out.stderr ?? '', out.exitCode);
      });
    });
    this.processes.push(process);
    return process;
  }
}

/** A real RSA key so worker/github/app.ts can sign App JWTs in tests. */
export function testPrivateKeyPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export const fixedRandom = (bytes: Uint8Array): Uint8Array => {
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
  return bytes;
};
