import { concatBytes } from '../lib/fetch.ts';
import { log } from '../lib/runtime.ts';
import { Redactor } from './redact.ts';

/**
 * Streams redacted container stderr to the `runner-logs` bucket, bounded. Parts are exactly
 * `partBytes` (R2 requires equal parts except the last), so memory stays at one part. Log storage
 * is best effort: a failure is recorded as an event and never changes a job's outcome.
 */

export interface MultipartUpload {
  uploadPart(partNumber: number, value: Uint8Array): Promise<{ partNumber: number; etag: string }>;
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
  abort(): Promise<void>;
}

export interface LogBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType: string } }): Promise<unknown>;
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType: string } }): Promise<MultipartUpload>;
}

const CONTENT_TYPE = { httpMetadata: { contentType: 'text/plain; charset=utf-8' } };
const encoder = new TextEncoder();

export class LogSink {
  readonly key: string;
  private readonly bucket: LogBucket;
  private readonly maxBytes: number;
  private readonly partBytes: number;
  private readonly redactor: Redactor;
  private readonly decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  private buffer: Uint8Array[] = [];
  private buffered = 0;
  private written = 0;
  private truncated = false;
  private failed = false;
  private upload: MultipartUpload | null = null;
  private readonly parts: Array<{ partNumber: number; etag: string }> = [];

  constructor(bucket: LogBucket, key: string, secrets: readonly string[], limits: { maxBytes: number; partBytes: number }) {
    this.bucket = bucket;
    this.key = key;
    this.maxBytes = limits.maxBytes;
    this.partBytes = limits.partBytes;
    this.redactor = new Redactor(secrets);
  }

  /** Raw stderr bytes from the container. Always accepted (the pipe must keep draining). */
  async write(chunk: Uint8Array): Promise<void> {
    if (this.truncated || this.failed) return;
    await this.append(this.redactor.push(this.decoder.decode(chunk, { stream: true })));
  }

  /** A line written by the runner itself (lifecycle notes), redacted like everything else. */
  async note(text: string): Promise<void> {
    if (this.truncated || this.failed) return;
    await this.append(this.redactor.push(`[runner] ${text}\n`));
  }

  /** Flush and store. Returns the key when anything was stored, else `null`. */
  async close(): Promise<string | null> {
    if (!this.failed && !this.truncated) await this.append(this.redactor.push(this.decoder.decode()) + this.redactor.flush());
    if (this.failed) return null;
    const rest = concatBytes(this.buffer);
    this.buffer = [];
    this.buffered = 0;
    try {
      if (this.upload === null) {
        if (rest.byteLength === 0) return null;
        await this.bucket.put(this.key, rest, CONTENT_TYPE);
        return this.key;
      }
      if (rest.byteLength > 0) this.parts.push(await this.upload.uploadPart(this.parts.length + 1, rest));
      await this.upload.complete(this.parts);
      return this.key;
    } catch {
      await this.abort();
      return null;
    }
  }

  private async append(text: string): Promise<void> {
    if (text === '') return;
    let bytes = encoder.encode(text);
    if (this.written + bytes.byteLength > this.maxBytes) {
      bytes = bytes.subarray(0, Math.max(0, this.maxBytes - this.written));
      this.truncated = true;
    }
    this.written += bytes.byteLength;
    if (bytes.byteLength > 0) {
      this.buffer.push(bytes);
      this.buffered += bytes.byteLength;
    }
    if (this.truncated) {
      const marker = encoder.encode(`\n[runner] log truncated at ${this.maxBytes} bytes\n`);
      this.buffer.push(marker);
      this.buffered += marker.byteLength;
    }
    while (this.buffered >= this.partBytes && !this.failed) await this.flushPart();
  }

  private async flushPart(): Promise<void> {
    const all = concatBytes(this.buffer);
    const part = all.subarray(0, this.partBytes);
    const rest = all.slice(this.partBytes);
    this.buffer = rest.byteLength > 0 ? [rest] : [];
    this.buffered = rest.byteLength;
    try {
      this.upload ??= await this.bucket.createMultipartUpload(this.key, CONTENT_TYPE);
      this.parts.push(await this.upload.uploadPart(this.parts.length + 1, part.slice()));
    } catch {
      await this.abort();
    }
  }

  private async abort(): Promise<void> {
    if (!this.failed) log('warn', 'runner.log_store_failed', { logKey: this.key });
    this.failed = true;
    this.buffer = [];
    this.buffered = 0;
    if (this.upload) await this.upload.abort().catch(() => undefined);
  }
}
