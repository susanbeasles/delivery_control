// Bounded capture of a process stream: keep the head and the tail, count everything, never block the process.
import type { Redactor } from './redact.ts';

export interface Captured {
  readonly head: Uint8Array;
  readonly tail: Uint8Array;
  readonly totalBytes: number;
  readonly truncated: boolean;
  /** True when capture stopped before the stream ended (grace period expired). */
  readonly interrupted: boolean;
}

const MAX_TAIL = 65_536;

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Keeps the last `limit` bytes pushed into it. */
class TailRing {
  readonly #limit: number;
  #chunks: Uint8Array[] = [];
  #bytes = 0;
  constructor(limit: number) {
    this.#limit = limit;
  }
  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.#limit) {
      this.#chunks = [chunk.subarray(chunk.byteLength - this.#limit)];
      this.#bytes = this.#limit;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.#limit) {
      const first = this.#chunks[0];
      if (first === undefined) break;
      const excess = this.#bytes - this.#limit;
      if (first.byteLength <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.byteLength;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#bytes -= excess;
      }
    }
  }
  bytes(): Uint8Array {
    return concat(this.#chunks, this.#bytes);
  }
}

/**
 * Read `stream` to its end or until `stop` aborts. At most `limit` bytes are retained: the first part as head,
 * the last part as tail. Bytes beyond the limit are still consumed so the writer never blocks on a full pipe.
 */
export async function captureStream(stream: ReadableStream<Uint8Array> | null, limit: number, stop: AbortSignal): Promise<Captured> {
  const empty = new Uint8Array(0);
  if (stream === null) return { head: empty, tail: empty, totalBytes: 0, truncated: false, interrupted: false };
  const tailLimit = Math.min(MAX_TAIL, Math.floor(limit / 4));
  const headLimit = limit - tailLimit;
  const reader = stream.getReader();
  const collected: Uint8Array[] = [];
  let collectedBytes = 0;
  let head: Uint8Array | undefined;
  let tail: TailRing | undefined;
  let total = 0;
  let interrupted = false;
  const onStop = () => {
    interrupted = true;
    void reader.cancel().catch(() => undefined);
  };
  if (stop.aborted) onStop();
  else stop.addEventListener('abort', onStop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
      total += chunk.byteLength;
      if (tail !== undefined) {
        tail.push(chunk);
        continue;
      }
      if (collectedBytes + chunk.byteLength <= limit) {
        collected.push(chunk);
        collectedBytes += chunk.byteLength;
        continue;
      }
      // Limit crossed: freeze the head and keep the rest in the tail ring.
      const all = concat([...collected, chunk], collectedBytes + chunk.byteLength);
      head = all.subarray(0, headLimit);
      tail = new TailRing(tailLimit);
      tail.push(all.subarray(headLimit));
    }
  } catch {
    interrupted = true;
  } finally {
    stop.removeEventListener('abort', onStop);
    reader.releaseLock();
  }
  if (tail === undefined || head === undefined) {
    return { head: concat(collected, collectedBytes), tail: empty, totalBytes: total, truncated: false, interrupted };
  }
  return { head, tail: tail.bytes(), totalBytes: total, truncated: true, interrupted };
}

/** Text for the log sink: decoded leniently, truncation marked, secrets scrubbed. */
export function renderCapture(captured: Captured, redactor: Redactor): Uint8Array {
  const decoder = new TextDecoder('utf-8');
  let text = decoder.decode(captured.head);
  if (captured.truncated) {
    const omitted = captured.totalBytes - captured.head.byteLength - captured.tail.byteLength;
    text += `\n[runner: ${omitted} bytes omitted]\n${new TextDecoder('utf-8').decode(captured.tail)}`;
  }
  if (captured.interrupted) text += '\n[runner: capture stopped before the stream ended]\n';
  return new TextEncoder().encode(redactor.apply(text));
}
