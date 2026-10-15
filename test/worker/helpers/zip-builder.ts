import { crc32 } from '../../../worker/release/zip.ts';

/** Builds ZIP archives for tests, including deliberately hostile ones. */

export interface BuildEntry {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8;
  /** Override the Unix mode stored in external attributes (e.g. 0o120777 for a symlink). */
  unixMode?: number;
  flags?: number;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
  /** Lie about the CRC. */
  crcOverride?: number;
}

const enc = new TextEncoder();

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function le16(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff]; }
function le32(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

export async function buildZip(entries: BuildEntry[], options: { comment?: string; centralOverride?: (index: number, header: number[]) => number[] } = {}): Promise<Uint8Array> {
  const locals: number[] = [];
  const central: number[] = [];
  for (const [index, e] of entries.entries()) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const method = e.method ?? 8;
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const name = enc.encode(e.name);
    const crc = e.crcOverride ?? crc32(raw);
    const usize = e.declaredSize ?? raw.byteLength;
    const flags = e.flags ?? 0;
    const offset = locals.length;
    locals.push(...le32(0x04034b50), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(body.byteLength), ...le32(usize), ...le16(name.length), ...le16(0), ...name, ...body);
    const mode = e.unixMode ?? 0o100644;
    let header = [...le32(0x02014b50), ...le16((3 << 8) | 20), ...le16(20), ...le16(flags), ...le16(method), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(body.byteLength), ...le32(usize), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32((mode << 16) >>> 0), ...le32(offset), ...name];
    if (options.centralOverride) header = options.centralOverride(index, header);
    central.push(...header);
  }
  const comment = enc.encode(options.comment ?? '');
  const eocd = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length), ...le32(central.length), ...le32(locals.length), ...le16(comment.length), ...comment];
  return new Uint8Array([...locals, ...central, ...eocd]);
}

export function memorySource(bytes: Uint8Array) {
  let reads = 0;
  return {
    size: bytes.byteLength,
    get reads() { return reads; },
    async read(offset: number, length: number) {
      reads++;
      if (offset < 0 || offset + length > bytes.byteLength) throw new Error('out of range');
      return bytes.slice(offset, offset + length);
    },
  };
}
