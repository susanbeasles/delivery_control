import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarball, parseTar, planExtraction, symlinkStaysInside } from '../../container/agent/tar.mjs';
import { tarBytes, tarGz, type TarEntry } from './builders.ts';

const ROOT = 'susanbeasles-infra-abc1234';
const plan = (entries: TarEntry[]) => planExtraction(parseTar(tarBytes(entries)), { strip: 1 });
const base: TarEntry[] = [{ path: `${ROOT}/`, type: '5' }];

test('a GitHub-style archive extracts with the top directory stripped and symlinks last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-tar-'));
  const dest = join(dir, 'src');
  const entries: TarEntry[] = [
    ...base,
    { path: `${ROOT}/modules/`, type: '5' },
    { path: `${ROOT}/link.tf`, type: '2', linkpath: 'modules/real.tf' },
    { path: `${ROOT}/modules/real.tf`, data: 'resource "x" "y" {}\n' },
    { path: `${ROOT}/scripts/run.sh`, data: '#!/bin/sh\n', mode: 0o4755 },
    { path: `${ROOT}/same.tf`, type: '1', linkpath: `${ROOT}/modules/real.tf` },
    { path: 'ignored', pax: { path: `${ROOT}/${'long-name-'.repeat(15)}.tf` }, data: 'pax' },
  ];
  assert.equal(extractTarball(tarGz(entries), dest, 1024 * 1024), 6);
  assert.equal(readFileSync(join(dest, 'modules/real.tf'), 'utf8'), 'resource "x" "y" {}\n');
  assert.equal(readlinkSync(join(dest, 'link.tf')), 'modules/real.tf');
  assert.equal(lstatSync(join(dest, 'scripts/run.sh')).mode & 0o7777, 0o755, 'setuid is dropped');
  assert.equal(readFileSync(join(dest, 'same.tf'), 'utf8'), 'resource "x" "y" {}\n');
  assert.equal(readFileSync(join(dest, `${'long-name-'.repeat(15)}.tf`), 'utf8'), 'pax');
  const ops = plan(entries).map((a: { op: string }) => a.op);
  assert.equal(ops.at(-1), 'symlink');
});

const unsafe: Array<[string, TarEntry[]]> = [
  ['absolute path', [{ path: '/etc/passwd', data: 'x' }]],
  ['parent segment', [...base, { path: `${ROOT}/../escape.tf`, data: 'x' }]],
  ['dot segment', [...base, { path: `${ROOT}/./a.tf`, data: 'x' }]],
  ['backslash', [...base, { path: `${ROOT}/a\\..\\b`, data: 'x' }]],
  ['second top-level directory', [...base, { path: 'other/a.tf', data: 'x' }]],
  ['duplicate entry', [...base, { path: `${ROOT}/a.tf`, data: 'x' }, { path: `${ROOT}/a.tf`, data: 'y' }]],
  ['absolute symlink', [...base, { path: `${ROOT}/l`, type: '2', linkpath: '/etc' }]],
  ['symlink escaping the root', [...base, { path: `${ROOT}/sub/l`, type: '2', linkpath: '../../outside' }]],
  ['write through a symlink', [...base, { path: `${ROOT}/l`, type: '2', linkpath: 'sub' }, { path: `${ROOT}/l/a.tf`, data: 'x' }]],
  ['symlink chain escape', [...base, { path: `${ROOT}/x`, type: '2', linkpath: '.' }, { path: `${ROOT}/x/y`, type: '2', linkpath: '..' }]],
  ['hard link to an unknown file', [...base, { path: `${ROOT}/h`, type: '1', linkpath: `${ROOT}/missing` }]],
  ['hard link outside the archive', [...base, { path: `${ROOT}/h`, type: '1', linkpath: '/etc/shadow' }]],
  ['character device', [...base, { path: `${ROOT}/dev`, type: '3' }]],
  ['fifo', [...base, { path: `${ROOT}/fifo`, type: '6' }]],
  ['file at the archive root', [{ path: 'README', data: 'x' }]],
];

for (const [name, entries] of unsafe) {
  test(`refuses: ${name}`, () => {
    assert.throws(() => plan(entries), { code: 'archive_unsafe' });
  });
}

test('symlink containment is lexical and relative only', () => {
  // Upward targets are refused outright: checked one by one, a chain of them can still escape.
  assert.equal(symlinkStaysInside('a/b/link', '../c'), false);
  assert.equal(symlinkStaysInside('x/y/s', 'u/../..'), false);
  assert.equal(symlinkStaysInside('a/link', 'b/c'), true);
  assert.equal(symlinkStaysInside('a/link', '../../c'), false);
  assert.equal(symlinkStaysInside('link', '/abs'), false);
  assert.equal(symlinkStaysInside('link', ''), false);
});

test('corrupt archives are refused', () => {
  const bytes = tarBytes([...base, { path: `${ROOT}/a.tf`, data: 'x' }]);
  bytes[600] ^= 0xff;
  assert.throws(() => [...parseTar(bytes)], { code: 'archive_unsafe' });
  assert.throws(() => [...parseTar(tarBytes(base).subarray(0, 512))], { code: 'archive_unsafe' });
  const dir = mkdtempSync(join(tmpdir(), 'runner-tar-'));
  assert.throws(() => extractTarball(Buffer.from('not gzip'), join(dir, 'x'), 1024), { code: 'archive_unsafe' });
  assert.equal(existsSync(join(dir, 'x')), false);
});
