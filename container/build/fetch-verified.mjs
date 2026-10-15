import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { gunzipBounded, parseTar, safeRelativePath } from '../agent/tar.mjs';

/**
 * Build-time only, zero dependencies (runs in the image's own Node):
 *
 *   download <url> <sha256> <out>     fetch over HTTPS, refuse redirects to non-GitHub hosts,
 *                                     write only if the SHA-256 matches
 *   unzip <zip> <dir>                 extract every regular file (provider mirrors hash the whole
 *                                     directory), refusing unsafe names, symlinks and ZIP64
 *   untar <tar.gz> <member> <out>     extract one regular file from a tarball
 *
 * A missing or malformed checksum is a hard failure: the Dockerfile has no defaults for checksums
 * nobody has reviewed yet.
 */

const MAX_DOWNLOAD = 512 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function die(message) {
  process.stderr.write(`fetch-verified: ${message}\n`);
  process.exit(1);
}

async function download(url, expected, out) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) die(`no reviewed SHA-256 supplied for ${url}`);
  let target = new URL(url);
  let response;
  for (let hop = 0; hop < 3; hop++) {
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) die(`refusing ${target.origin}`);
    response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    if (response.status < 300 || response.status >= 400) break;
    target = new URL(response.headers.get('location') ?? die('redirect without location'), target);
  }
  if (response.status !== 200) die(`${url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD) die(`${url} is larger than ${MAX_DOWNLOAD} bytes`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) die(`${url}: SHA-256 ${actual} does not match the pinned ${expected}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes, { flag: 'wx', mode: 0o644 });
}

function unzip(zipPath, dest) {
  const zip = readFileSync(zipPath);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) die('zip has no end of central directory');
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) die('ZIP64 is not supported');
  for (let n = 0; n < entries; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) die('corrupt central directory');
    const method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16);
    const compressed = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const unixMode = zip.readUInt32LE(offset + 38) >>> 16;
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if ((unixMode & 0o170000) !== 0 && (unixMode & 0o170000) !== 0o100000) die(`${name} is not a regular file`);
    const { path } = safeRelativePath(name, 0);
    if (zip.readUInt32LE(local) !== 0x04034b50) die('corrupt local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: size }) : die(`${name}: compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) die(`${name}: size or CRC mismatch`);
    const out = join(dest, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data, { flag: 'wx' });
    chmodSync(out, unixMode & 0o111 ? 0o755 : 0o644);
  }
}

function untar(tarPath, member, out) {
  for (const entry of parseTar(gunzipBounded(readFileSync(tarPath), MAX_DOWNLOAD))) {
    if (entry.type === 'file' && entry.path === member) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, entry.data, { flag: 'wx', mode: 0o755 });
      return;
    }
  }
  die(`${member} not found in ${tarPath}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'download' && args.length === 3) await download(args[0], args[1], args[2]);
else if (command === 'unzip' && args.length === 2) unzip(args[0], args[1]);
else if (command === 'untar' && args.length === 3) untar(args[0], args[1], args[2]);
else die('usage: download <url> <sha256> <out> | unzip <zip> <dir> | untar <tar.gz> <member> <out>');
