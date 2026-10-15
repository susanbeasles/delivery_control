import { DeployError } from '../lib/errors.ts';
import type { InputFile } from './framing.ts';
import type { LogSink } from './log-sink.ts';

/**
 * Runs the agent once through `container.exec` and plumbs its three streams concurrently, so a
 * chatty stderr can never block stdin and a stalled stdin can never hide the exit status:
 *
 * - stdin: framing header, then each input file (R2 streams verify their digest on the way);
 * - stdout: the single result document, bounded; overflow kills the process;
 * - stderr: redacted into the log sink, always drained.
 */

export interface ExecProcessPort {
  readonly stdin: WritableStream | null;
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

export interface ExecOptions {
  env: Record<string, string>;
  cwd: string;
  user: string;
  stdin: 'pipe';
  stdout: 'pipe';
  stderr: 'pipe';
}

export interface ExecPort {
  exec(cmd: string[], options: ExecOptions): Promise<ExecProcessPort>;
}

export interface AgentLaunch {
  cmd: string[];
  env: Record<string, string>;
  cwd: string;
  user: string;
  header: Uint8Array;
  files: readonly InputFile[];
  resultMaxBytes: number;
  log: LogSink;
}

export interface AgentExit {
  exitCode: number | null;
  /** Result bytes, or `null` when stdout overflowed or could not be read. */
  stdout: Uint8Array | null;
  /** Set when the runner itself rejected the run (input digest mismatch, oversized result). */
  failure: { code: string; message: string } | null;
}

export interface AgentRun {
  kill(): void;
  done: Promise<AgentExit>;
}

const SIGKILL = 9;

export async function launchAgent(port: ExecPort, spec: AgentLaunch): Promise<AgentRun> {
  const process = await port.exec(spec.cmd, { env: spec.env, cwd: spec.cwd, user: spec.user, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let failure: AgentExit['failure'] = null;
  const kill = (): void => {
    try {
      process.kill(SIGKILL);
    } catch {
      // Already gone; the container is destroyed during cleanup regardless.
    }
  };
  const reject = (code: string, message: string): void => {
    failure ??= { code, message };
    kill();
  };

  const stdin = pumpStdin(process.stdin, spec.header, spec.files).catch((error: unknown) => {
    // A DeployError here is the runner refusing its own input (for example a staging digest
    // mismatch); any other write error means the agent stopped reading, which its exit reports.
    if (error instanceof DeployError) reject(error.code, error.message);
  });
  const stdout = readBoundedOutput(process.stdout, spec.resultMaxBytes).then((bytes) => {
    if (bytes === null) reject('result_too_large', `result exceeds ${spec.resultMaxBytes} bytes`);
    return bytes;
  });
  const stderr = drainInto(process.stderr, spec.log);
  const done = (async (): Promise<AgentExit> => {
    const exitCode = await process.exitCode.catch(() => null);
    const [, bytes] = await Promise.all([stdin, stdout.catch(() => null), stderr.catch(() => undefined)]);
    return { exitCode, stdout: failure ? null : bytes, failure };
  })();
  return { kill, done };
}

async function pumpStdin(stdin: WritableStream | null, header: Uint8Array, files: readonly InputFile[]): Promise<void> {
  if (stdin === null) throw new Error('exec returned no stdin');
  const writer = stdin.getWriter();
  try {
    await writer.write(header);
    for (const file of files) {
      const reader = file.open().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}

/** Reads all of stdout; returns `null` as soon as `maxBytes` is exceeded (and stops reading). */
async function readBoundedOutput(stream: ReadableStream | null, maxBytes: number): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = toBytes(value);
      size += chunk.byteLength;
      if (size > maxBytes) return null;
      chunks.push(chunk);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function drainInto(stream: ReadableStream | null, log: LogSink): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    await log.write(toBytes(value));
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new TextEncoder().encode(String(value));
}
