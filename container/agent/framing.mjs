import { createHash } from 'node:crypto';
import { JobFailure } from './errors.mjs';

/**
 * Parser for the runner's stdin framing (writer: worker/runner/framing.ts):
 *
 *   line 1: `runner-job/v1` envelope (JSON) + `\n`
 *   line 2: `{"files":[{"name","sha256","size"}]}` + `\n`
 *   then the raw bytes of each file, exactly `size` bytes each, in order, then EOF.
 *
 * Pure and incremental: `readFrames` takes any async iterable of byte chunks and yields events.
 * Every file's size and SHA-256 are verified; truncation and trailing bytes are failures.
 */

const MAX_LINE = 1024 * 1024;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

const bad = (message) => new JobFailure('stdin_invalid', message);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function parseFileList(text, maxFileBytes) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw bad('file list is not JSON');
  }
  if (!exactKeys(value, ['files']) || !Array.isArray(value.files) || value.files.length > 16) throw bad('file list has an unexpected shape');
  const names = new Set();
  return value.files.map((file, index) => {
    if (!exactKeys(file, ['name', 'sha256', 'size'])) throw bad(`file ${index} has an unexpected shape`);
    if (typeof file.name !== 'string' || !FILE_NAME.test(file.name) || names.has(file.name)) throw bad(`file ${index} has an invalid or duplicate name`);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxFileBytes) throw bad(`file ${file.name} has an invalid size`);
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw bad(`file ${file.name} has an invalid digest`);
    names.add(file.name);
    return { name: file.name, size: file.size, sha256: file.sha256 };
  });
}

/**
 * @param {AsyncIterable<Uint8Array>} source
 * @param {{ maxFileBytes?: number, maxLine?: number }} [limits]
 * @returns {AsyncGenerator<{kind:'envelope',value:unknown}|{kind:'files',value:Array<{name:string,size:number,sha256:string}>}|{kind:'chunk',file:{name:string},bytes:Uint8Array}|{kind:'file-end',file:{name:string,size:number,sha256:string}}>}
 */
export async function* readFrames(source, limits = {}) {
  const maxLine = limits.maxLine ?? MAX_LINE;
  const maxFileBytes = limits.maxFileBytes ?? 512 * 1024 * 1024;
  let pending = new Uint8Array(0);
  let envelopeSeen = false;
  let files = null;
  let index = 0;
  let remaining = 0;
  let hash = null;

  const begin = () => {
    if (files && index < files.length) {
      remaining = files[index].size;
      hash = createHash('sha256');
    }
  };

  for await (const raw of source) {
    let chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    while (chunk.byteLength > 0) {
      if (files === null) {
        const newline = chunk.indexOf(0x0a);
        if (newline === -1) {
          pending = concat(pending, chunk);
          if (pending.byteLength > maxLine) throw bad('header line too long');
          break;
        }
        const line = concat(pending, chunk.subarray(0, newline));
        pending = new Uint8Array(0);
        chunk = chunk.subarray(newline + 1);
        if (line.byteLength > maxLine) throw bad('header line too long');
        let text;
        try {
          text = decoder.decode(line);
        } catch {
          throw bad('header is not UTF-8');
        }
        if (!envelopeSeen) {
          envelopeSeen = true;
          let envelope;
          try {
            envelope = JSON.parse(text);
          } catch {
            throw bad('envelope is not JSON');
          }
          yield { kind: 'envelope', value: envelope };
        } else {
          files = parseFileList(text, maxFileBytes);
          yield { kind: 'files', value: files };
          begin();
        }
        continue;
      }
      if (index >= files.length) throw bad('unexpected bytes after the last file');
      const take = Math.min(remaining, chunk.byteLength);
      const part = chunk.subarray(0, take);
      chunk = chunk.subarray(take);
      remaining -= take;
      hash.update(part);
      yield { kind: 'chunk', file: files[index], bytes: part };
      if (remaining === 0) {
        const file = files[index];
        if (hash.digest('hex') !== file.sha256) throw new JobFailure('input_digest_mismatch', `${file.name} does not match its declared SHA-256`);
        yield { kind: 'file-end', file };
        index += 1;
        begin();
      }
    }
  }
  if (!envelopeSeen || files === null) throw bad('stdin ended before the file list');
  if (index < files.length) throw bad(`stdin ended inside ${files[index].name}`);
}

function concat(a, b) {
  if (a.byteLength === 0) return b.slice();
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
