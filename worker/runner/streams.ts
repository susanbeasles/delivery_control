import { DeployError, fail } from '../lib/errors.ts';

/**
 * Byte-stream helpers for inputs the runner forwards to a container: incremental SHA-256 (the
 * platform provides `crypto.DigestStream`; tests provide node:crypto), bounded capture that keeps
 * chunks instead of concatenating (one copy in memory), and a pass-through that verifies a declared
 * size and digest while bytes flow to the container.
 */

export interface IncrementalHash {
  update(chunk: Uint8Array): Promise<void>;
  hex(): Promise<string>;
}

export type HashFactory = () => IncrementalHash;

/** Bytes held as the chunks they arrived in. */
export interface ChunkedBytes {
  chunks: Uint8Array[];
  size: number;
  sha256: string;
}

export function streamOfChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[index++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

/** Read a body fully, bounded, hashing as it goes. Aborts as soon as `maxBytes` is crossed. */
export async function captureChunks(body: ReadableStream<Uint8Array>, maxBytes: number, hashes: HashFactory, code: string): Promise<ChunkedBytes> {
  const reader = body.getReader();
  const hash = hashes();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail(code, `body exceeds ${maxBytes} bytes`);
      chunks.push(value);
      await hash.update(value);
    }
  } catch (cause) {
    if (cause instanceof DeployError) throw cause;
    return fail(code, 'body could not be read', { retryable: true, cause });
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return { chunks, size, sha256: await hash.hex() };
}

export async function digestStream(body: ReadableStream<Uint8Array>, maxBytes: number, hashes: HashFactory, code: string): Promise<{ sha256: string; size: number }> {
  const reader = body.getReader();
  const hash = hashes();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail(code, `body exceeds ${maxBytes} bytes`);
      await hash.update(value);
    }
  } catch (cause) {
    if (cause instanceof DeployError) throw cause;
    return fail(code, 'body could not be read', { retryable: true, cause });
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return { sha256: await hash.hex(), size };
}

/**
 * Pass bytes through while checking them against a declared size and SHA-256. The stream errors
 * with `code` the moment the size is exceeded, and at the end if size or digest differ, so the
 * consumer (the stdin pump) aborts the job before the agent's result could be trusted.
 */
export function verifyingStream(source: ReadableStream<Uint8Array>, expected: { size: number; sha256: string }, hashes: HashFactory, code: string): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const hash = hashes();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (size !== expected.size) fail(code, `stream has ${size} bytes, expected ${expected.size}`);
          if ((await hash.hex()) !== expected.sha256) fail(code, 'stream digest does not match the declared SHA-256');
          controller.close();
          return;
        }
        size += value.byteLength;
        if (size > expected.size) fail(code, `stream exceeds the declared ${expected.size} bytes`);
        await hash.update(value);
        controller.enqueue(value);
      } catch (cause) {
        reader.cancel().catch(() => undefined);
        controller.error(cause instanceof DeployError ? cause : new DeployError(code, 'stream could not be read', { retryable: true, cause }));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
