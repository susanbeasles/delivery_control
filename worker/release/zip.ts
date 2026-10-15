import { DeployError, fail } from '../lib/errors.ts';
import { PATTERNS } from '../lib/validate.ts';

/**
 * A defensive ZIP reader over a random-access source (R2 range reads). It never extracts to a
 * filesystem and never trusts local headers over the central directory. Anything outside the
 * contract (CONTRACTS.md section 1.2) is rejected with `archive_invalid`: encryption, ZIP64,
 * multi-disk archives, methods other than stored and deflate, symlinks and special files,
 * traversal or absolute names, case-insensitive duplicates, overlapping entries, oversize entries
 * and suspicious compression ratios.
 */

export interface RangeSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2048,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 200,
};

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipDirectory {
  entries: Map<string, ZipEntry>;
  totalUncompressed: number;
}

const CODE = 'archive_invalid';
const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

const u16 = (b: Uint8Array, o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, o: number): number => ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;

export async function openZip(source: RangeSource, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipDirectory> {
  if (source.size < EOCD_MIN) fail(CODE, 'archive is too small to be a ZIP');
  const tailLength = Math.min(source.size, EOCD_MIN + MAX_COMMENT);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);

  // Scan backwards for an end-of-central-directory record whose comment length exactly reaches
  // the end of the file, so a signature embedded inside a comment cannot be mistaken for it.
  let eocd = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (u32(tail, i) === EOCD_SIG && i + EOCD_MIN + u16(tail, i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail(CODE, 'end of central directory not found');
  if (eocd >= 20 && u32(tail, eocd - 20) === ZIP64_LOCATOR_SIG) fail(CODE, 'ZIP64 archives are not accepted');

  const diskNumber = u16(tail, eocd + 4);
  const cdDisk = u16(tail, eocd + 6);
  const entriesOnDisk = u16(tail, eocd + 8);
  const totalEntries = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) fail(CODE, 'multi-disk archives are not accepted');
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail(CODE, 'ZIP64 archives are not accepted');
  if (totalEntries > limits.maxEntries) fail(CODE, `archive has more than ${limits.maxEntries} entries`);
  const eocdAbsolute = tailStart + eocd;
  if (cdOffset + cdSize !== eocdAbsolute) fail(CODE, 'central directory does not end at the end record');

  const cd = await source.read(cdOffset, cdSize);
  const entries = new Map<string, ZipEntry>();
  const folded = new Set<string>();
  const spans: Array<[number, number]> = [];
  let totalUncompressed = 0;
  let p = 0;
  for (let n = 0; n < totalEntries; n++) {
    if (p + 46 > cd.length || u32(cd, p) !== CDH_SIG) fail(CODE, 'malformed central directory');
    const versionMadeBy = u16(cd, p + 4);
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const crc32 = u32(cd, p + 16);
    const compressedSize = u32(cd, p + 20);
    const uncompressedSize = u32(cd, p + 24);
    const nameLength = u16(cd, p + 28);
    const extraLength = u16(cd, p + 30);
    const commentLength = u16(cd, p + 32);
    const diskStart = u16(cd, p + 34);
    const externalAttributes = u32(cd, p + 38);
    const localHeaderOffset = u32(cd, p + 42);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > cd.length) fail(CODE, 'central directory entry overruns the directory');
    const name = asciiName(cd.subarray(p + 46, p + 46 + nameLength));
    p = end;

    if (flags & 0x0001 || flags & 0x0040) fail(CODE, `${name}: encrypted entries are not accepted`);
    if (diskStart !== 0) fail(CODE, `${name}: multi-disk entry`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      fail(CODE, `${name}: ZIP64 entries are not accepted`);
    }

    const unixMode = versionMadeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    const isDirectory = name.endsWith('/');
    if (isDirectory) {
      if (compressedSize !== 0 || uncompressedSize !== 0) fail(CODE, `${name}: directory entry with content`);
      if (fileType !== 0 && fileType !== 0o040000) fail(CODE, `${name}: directory entry with a non-directory type`);
      if (!PATTERNS.archivePath.test(name.slice(0, -1))) fail(CODE, `invalid entry name ${JSON.stringify(name).slice(0, 120)}`);
      continue; // implied directories carry nothing; they are validated and ignored
    }
    if (fileType !== 0 && fileType !== 0o100000) fail(CODE, `${name}: only regular files are accepted`);
    if (!PATTERNS.archivePath.test(name) || name.length > 256) fail(CODE, `invalid entry name ${JSON.stringify(name).slice(0, 120)}`);
    if (method !== 0 && method !== 8) fail(CODE, `${name}: compression method ${method} is not accepted`);
    if (method === 0 && compressedSize !== uncompressedSize) fail(CODE, `${name}: stored entry with mismatched sizes`);
    if (uncompressedSize > limits.maxEntryBytes) fail(CODE, `${name}: entry exceeds ${limits.maxEntryBytes} bytes`);
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxRatio)) {
      fail(CODE, `${name}: compression ratio exceeds ${limits.maxRatio}:1`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalBytes) fail(CODE, `archive expands beyond ${limits.maxTotalBytes} bytes`);

    const key = name.toLowerCase();
    if (folded.has(key)) fail(CODE, `${name}: duplicate entry name`);
    folded.add(key);
    entries.set(name, { name, method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    // Lower bound of the bytes this entry occupies; overlap means a crafted archive.
    spans.push([localHeaderOffset, localHeaderOffset + 30 + nameLength + compressedSize]);
  }
  if (p !== cd.length) fail(CODE, 'trailing bytes in central directory');

  spans.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < spans.length; k++) {
    const [start, stop] = spans[k] as [number, number];
    if (stop > cdOffset) fail(CODE, 'entry data overlaps the central directory');
    const next = spans[k + 1];
    if (next && next[0] < stop) fail(CODE, 'entries overlap');
    if (start < 0) fail(CODE, 'negative offset');
  }
  return { entries, totalUncompressed };
}

/** Read and fully verify one entry: local header agreement, exact size, CRC-32. */
export async function readEntry(source: RangeSource, directory: ZipDirectory, name: string): Promise<Uint8Array> {
  const entry = directory.entries.get(name);
  if (!entry) fail('archive_entry_missing', `archive has no entry ${name}`);
  const header = await source.read(entry.localHeaderOffset, 30);
  if (u32(header, 0) !== LFH_SIG) fail(CODE, `${name}: local header signature mismatch`);
  if (u16(header, 8) !== entry.method) fail(CODE, `${name}: local header method mismatch`);
  const nameLength = u16(header, 26);
  const extraLength = u16(header, 28);
  const localName = asciiName(await source.read(entry.localHeaderOffset + 30, nameLength));
  if (localName !== name) fail(CODE, `${name}: local header name mismatch`);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > source.size) fail(CODE, `${name}: entry data overruns the archive`);
  const compressed = await source.read(dataOffset, entry.compressedSize);
  const bytes = entry.method === 0 ? compressed : await inflateExact(compressed, entry.uncompressedSize, name);
  if (bytes.byteLength !== entry.uncompressedSize) fail(CODE, `${name}: size mismatch`);
  if (crc32(bytes) !== entry.crc32) fail(CODE, `${name}: CRC-32 mismatch`);
  return bytes;
}

async function inflateExact(compressed: Uint8Array, expected: number, name: string): Promise<Uint8Array> {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expected) fail(CODE, `${name}: inflates beyond its declared size`);
      out.set(value, offset);
      offset += value.byteLength;
    }
  } catch (cause) {
    if (cause instanceof DeployError) throw cause;
    return fail(CODE, `${name}: corrupt deflate stream`, { cause });
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (offset !== expected) fail(CODE, `${name}: inflates short of its declared size`);
  return out;
}

function asciiName(bytes: Uint8Array): string {
  let name = '';
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) fail(CODE, 'entry name contains non-printable or non-ASCII bytes');
    name += String.fromCharCode(b);
  }
  if (name.includes('\\')) fail(CODE, 'entry name contains a backslash');
  return name;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A RangeSource over an R2 object, one ranged GET per read. */
export function r2RangeSource(bucket: R2Bucket, key: string, size: number): RangeSource {
  return {
    size,
    async read(offset, length) {
      if (length === 0) return new Uint8Array(0);
      if (offset < 0 || offset + length > size) fail(CODE, 'read outside the archive');
      const object = await bucket.get(key, { range: { offset, length } });
      if (!object) fail('staging_missing', `staged object ${key} disappeared`, { retryable: true });
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== length) fail('staging_read', `short read from ${key}`, { retryable: true });
      return bytes;
    },
  };
}
