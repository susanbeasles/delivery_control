import { linkSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { JobFailure } from './errors.mjs';

/**
 * Safe extraction of repository tarballs (GitHub's `git archive` output: ustar with pax headers).
 *
 * `parseTar` and `planExtraction` are pure. The plan refuses, for the whole archive:
 * absolute paths, `.`/`..` segments, backslashes and NULs, entries outside the single top-level
 * directory, duplicates, symlinks whose target leaves the root, any entry whose path passes
 * through a symlink, hard links to anything but an earlier regular file, and every other entry type
 * (devices, FIFOs, GNU extensions). Only then does `extractPlan` touch the filesystem, creating
 * files exclusively (`wx`) and symlinks last.
 */

const BLOCK = 512;
const MAX_ENTRIES = 50_000;
const MAX_PATH = 4096;
const MAX_SEGMENT = 255;

const bad = (message) => new JobFailure('archive_unsafe', message);

export function gunzipBounded(bytes, maxBytes) {
  try {
    return gunzipSync(bytes, { maxOutputLength: maxBytes });
  } catch {
    throw bad(`archive is not gzip or expands beyond ${maxBytes} bytes`);
  }
}

function cString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder('utf-8', { fatal: true }).decode(end === -1 ? slice : slice.subarray(0, end));
}

function numeric(block, start, length) {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    // GNU base-256: big-endian, first byte's high bit is the marker.
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
    if (!Number.isSafeInteger(value)) throw bad('numeric field out of range');
    return value;
  }
  const text = new TextDecoder().decode(field).replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw bad('numeric field is not octal');
  return parseInt(text, 8);
}

function checksumOk(block) {
  const expected = numeric(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  return sum === expected;
}

function parsePax(data) {
  const out = {};
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    const length = Number(text.slice(offset, space));
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) throw bad('malformed pax header');
    const record = text.slice(space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq === -1) throw bad('malformed pax record');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/** Yields `{ path, type, size, mode, linkpath, data }`; `type` is the raw typeflag for unsupported entries. */
export function* parseTar(bytes) {
  let offset = 0;
  let pax = null;
  let count = 0;
  while (offset + BLOCK <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.every((b) => b === 0)) return;
    if (!checksumOk(block)) throw bad('tar header checksum mismatch');
    if (++count > MAX_ENTRIES) throw bad('too many archive entries');
    const typeflag = String.fromCharCode(block[156] || 0x30);
    const size = numeric(block, 124, 12);
    const dataStart = offset + BLOCK;
    if (dataStart + size > bytes.byteLength) throw bad('archive is truncated');
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === 'g') continue; // global pax header (git archive puts the commit id here)
    if (typeflag === 'x') {
      pax = parsePax(data);
      continue;
    }
    const magic = cString(block, 257, 6);
    const prefix = magic === 'ustar' ? cString(block, 345, 155) : '';
    const name = cString(block, 0, 100);
    const path = pax?.path ?? (prefix ? `${prefix}/${name}` : name);
    const linkpath = pax?.linkpath ?? cString(block, 157, 100);
    if (pax?.size !== undefined && Number(pax.size) !== size) throw bad('pax size override is not supported');
    pax = null;
    const type = typeflag === '0' ? 'file' : typeflag === '5' ? 'directory' : typeflag === '2' ? 'symlink' : typeflag === '1' ? 'hardlink' : `unsupported:${typeflag}`;
    yield { path, type, size, mode: numeric(block, 100, 8), linkpath, data };
  }
  throw bad('archive has no end marker');
}

/** Normalizes an archive path and strips leading components; `null` for the stripped root itself. */
export function safeRelativePath(raw, strip) {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_PATH) throw bad('empty or overlong path');
  if (raw.includes('\0') || raw.includes('\\')) throw bad(`path contains a NUL or backslash: ${JSON.stringify(raw).slice(0, 120)}`);
  if (raw.startsWith('/')) throw bad(`absolute path: ${raw.slice(0, 120)}`);
  const segments = raw.replace(/\/+$/, '').split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw bad(`path has an empty, . or .. segment: ${raw.slice(0, 120)}`);
    if (segment.length > MAX_SEGMENT) throw bad('path segment too long');
  }
  if (segments.length <= strip) return { root: segments.join('/'), path: null };
  return { root: segments.slice(0, strip).join('/'), path: segments.slice(strip).join('/') };
}

/**
 * True when `target` (relative to the directory of `path`) stays inside the root. Targets may not
 * contain `..` at all: each link checked lexically on its own can still escape through a chain
 * (`x/y/u -> ..` plus `x/y/s -> u/../..` resolves outside the root), while links that only point
 * downward cannot, however they are chained.
 */
export function symlinkStaysInside(path, target) {
  if (target === '' || target.startsWith('/') || target.includes('\0') || target.includes('\\')) return false;
  if (target.split('/').includes('..')) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return resolved !== '..' && !resolved.startsWith('../') && !posix.isAbsolute(resolved);
}

/**
 * @param {Iterable<{path:string,type:string,mode:number,linkpath:string,data:Uint8Array}>} entries
 * @param {{ strip?: number }} [options]
 */
export function planExtraction(entries, options = {}) {
  const strip = options.strip ?? 1;
  const actions = [];
  const seen = new Set();
  const symlinks = new Set();
  const regularFiles = new Set();
  let root = null;

  const throughSymlink = (path) => {
    const segments = path.split('/');
    for (let i = 1; i <= segments.length; i++) if (symlinks.has(segments.slice(0, i).join('/'))) return true;
    return false;
  };

  for (const entry of entries) {
    const { root: top, path } = safeRelativePath(entry.path, strip);
    if (root === null) root = top;
    if (top !== root) throw bad('archive has more than one top-level directory');
    if (path === null) {
      if (entry.type !== 'directory') throw bad('archive root is not a directory');
      continue;
    }
    if (seen.has(path)) throw bad(`duplicate entry: ${path.slice(0, 120)}`);
    if (throughSymlink(path)) throw bad(`entry passes through a symlink: ${path.slice(0, 120)}`);
    seen.add(path);
    switch (entry.type) {
      case 'directory':
        actions.push({ op: 'dir', path });
        break;
      case 'file':
        regularFiles.add(path);
        actions.push({ op: 'file', path, data: entry.data, mode: entry.mode & 0o111 ? 0o755 : 0o644 });
        break;
      case 'symlink':
        if (!symlinkStaysInside(path, entry.linkpath)) throw bad(`symlink escapes the root: ${path.slice(0, 120)}`);
        symlinks.add(path);
        actions.push({ op: 'symlink', path, target: entry.linkpath });
        break;
      case 'hardlink': {
        const target = safeRelativePath(entry.linkpath, strip);
        if (target.root !== root || target.path === null || !regularFiles.has(target.path)) throw bad(`hard link to something other than an earlier file: ${path.slice(0, 120)}`);
        actions.push({ op: 'link', path, target: target.path });
        break;
      }
      default:
        throw bad(`unsupported entry type ${entry.type} at ${path.slice(0, 120)}`);
    }
  }
  if (root === null) throw bad('archive is empty');
  // Symlinks last: nothing is ever written through one.
  return [...actions.filter((a) => a.op !== 'symlink'), ...actions.filter((a) => a.op === 'symlink')];
}

/** Executes a plan under `dest` (which must not exist yet). */
export function extractPlan(plan, dest) {
  mkdirSync(dest, { recursive: false, mode: 0o700 });
  const realRoot = realpathSync(dest);
  const ensureParent = (full) => {
    const parent = dirname(full);
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    const real = realpathSync(parent);
    if (real !== realRoot && !real.startsWith(`${realRoot}/`)) throw bad('extraction escaped the destination');
  };
  for (const action of plan) {
    const full = join(dest, action.path);
    if (action.op === 'dir') {
      ensureParent(full);
      mkdirSync(full, { recursive: true, mode: 0o755 });
    } else if (action.op === 'file') {
      ensureParent(full);
      writeFileSync(full, action.data, { flag: 'wx', mode: action.mode });
    } else if (action.op === 'link') {
      ensureParent(full);
      linkSync(join(dest, action.target), full);
    } else {
      ensureParent(full);
      symlinkSync(action.target, full);
    }
  }
}

export function extractTarball(gzipped, dest, maxBytes) {
  const plan = planExtraction(parseTar(gunzipBounded(gzipped, maxBytes)), { strip: 1 });
  extractPlan(plan, dest);
  return plan.length;
}
