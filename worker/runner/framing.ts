import { canonicalBytes, type Json } from '../lib/json.ts';
import type { RunnerJobType } from './api.ts';

/**
 * stdin framing for the agent, the writer side (the agent's parser is `container/agent/framing.mjs`):
 *
 *   line 1: the `runner-job/v1` envelope, canonical JSON, then `\n`
 *   line 2: `{"files":[{"name","sha256","size"}, …]}`, canonical JSON, then `\n`
 *   then:   the raw bytes of each file, exactly `size` bytes each, in the order listed, then EOF
 *
 * The envelope and file list never carry a secret; the agent verifies every file's size and digest.
 */

export interface RunnerJobEnvelope {
  schema: 'runner-job/v1';
  jobId: string;
  type: RunnerJobType;
  deadlineAt: number;
  input: Json;
}

export interface FramedFile {
  name: string;
  size: number;
  sha256: string;
}

/** A file delivered on stdin; `open` is called once, when the pump reaches it. */
export interface InputFile extends FramedFile {
  open(): ReadableStream<Uint8Array>;
}

const NEWLINE = new Uint8Array([0x0a]);

export function frameHeader(envelope: RunnerJobEnvelope, files: readonly FramedFile[]): Uint8Array {
  const list = { files: files.map(({ name, size, sha256 }) => ({ name, sha256, size })) };
  const parts = [canonicalBytes(envelope), NEWLINE, canonicalBytes(list), NEWLINE];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
