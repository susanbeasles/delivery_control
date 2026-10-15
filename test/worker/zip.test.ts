import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openZip, readEntry, crc32 } from '../../worker/release/zip.ts';
import { buildZip, memorySource } from './helpers/zip-builder.ts';

const rejects = async (bytes: Uint8Array, pattern: RegExp) => {
  await assert.rejects(async () => {
    const src = memorySource(bytes);
    const dir = await openZip(src);
    for (const name of dir.entries.keys()) await readEntry(src, dir, name);
  }, (e: any) => e.code === 'archive_invalid' && pattern.test(e.message));
};

test('crc32 known answer', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('reads stored and deflated entries exactly', async () => {
  const big = 'x'.repeat(5000) + 'tail';
  const zip = await buildZip([
    { name: 'release.manifest.json', data: '{"a":1}', method: 0 },
    { name: 'targets/api/index.js', data: big, method: 8 },
  ]);
  const src = memorySource(zip);
  const dir = await openZip(src);
  assert.deepEqual([...dir.entries.keys()].sort(), ['release.manifest.json', 'targets/api/index.js']);
  assert.equal(new TextDecoder().decode(await readEntry(src, dir, 'targets/api/index.js')), big);
  assert.equal(new TextDecoder().decode(await readEntry(src, dir, 'release.manifest.json')), '{"a":1}');
});

test('implied directory entries are tolerated and ignored', async () => {
  const zip = await buildZip([{ name: 'targets/', data: '', method: 0, unixMode: 0o040755 }, { name: 'targets/a.js', data: 'a' }]);
  const dir = await openZip(memorySource(zip));
  assert.deepEqual([...dir.entries.keys()], ['targets/a.js']);
});

test('missing entry is a distinct error', async () => {
  const zip = await buildZip([{ name: 'a.js', data: 'a' }]);
  const src = memorySource(zip);
  const dir = await openZip(src);
  await assert.rejects(() => readEntry(src, dir, 'b.js'), (e: any) => e.code === 'archive_entry_missing');
});

test('rejects path traversal and absolute names', async () => {
  await rejects(await buildZip([{ name: '../evil.js', data: 'x' }]), /invalid entry name/);
  await rejects(await buildZip([{ name: 'a/../../evil.js', data: 'x' }]), /invalid entry name/);
  await rejects(await buildZip([{ name: '/etc/passwd', data: 'x' }]), /invalid entry name/);
  await rejects(await buildZip([{ name: 'a\\b.js', data: 'x' }]), /backslash/);
  await rejects(await buildZip([{ name: 'a/./b.js', data: 'x' }]), /invalid entry name/);
});

test('rejects symlinks and special files', async () => {
  await rejects(await buildZip([{ name: 'link', data: '/etc/passwd', method: 0, unixMode: 0o120777 }]), /regular files/);
  await rejects(await buildZip([{ name: 'fifo', data: '', method: 0, unixMode: 0o010644 }]), /regular files/);
});

test('rejects case-insensitive duplicates', async () => {
  await rejects(await buildZip([{ name: 'A.js', data: '1' }, { name: 'a.js', data: '2' }]), /duplicate/);
});

test('rejects encryption, unsupported methods and ZIP64 markers', async () => {
  await rejects(await buildZip([{ name: 'a.js', data: 'x', flags: 1 }]), /encrypted/);
  const z = await buildZip([{ name: 'a.js', data: 'x', method: 0 }], { centralOverride: (_i, h) => { h[10] = 12; return h; } });
  await rejects(z, /method 12/);
  const z64 = await buildZip([{ name: 'a.js', data: 'x', method: 0 }], { centralOverride: (_i, h) => { h[24] = h[25] = h[26] = h[27] = 0xff; return h; } });
  await rejects(z64, /ZIP64/);
});

test('rejects zip bombs by ratio and by declared size lies', async () => {
  await rejects(await buildZip([{ name: 'bomb.txt', data: 'a'.repeat(2_000_000) }]), /ratio/);
  await rejects(await buildZip([{ name: 'liar.txt', data: 'hello world hello world', declaredSize: 5 }]), /beyond its declared size|ratio/);
});

test('rejects CRC mismatch', async () => {
  await rejects(await buildZip([{ name: 'a.js', data: 'abc', crcOverride: 1234 }]), /CRC-32/);
});

test('ignores a fake end record hidden in the comment', async () => {
  const zip = await buildZip([{ name: 'a.js', data: 'x' }], { comment: 'PK\u0005\u0006 decoy' });
  const dir = await openZip(memorySource(zip));
  assert.ok(dir.entries.has('a.js'));
});

test('rejects overlapping entries', async () => {
  const zip = await buildZip([{ name: 'a.js', data: 'aaaa', method: 0 }, { name: 'b.js', data: 'bbbb', method: 0 }], {
    centralOverride: (i, h) => { if (i === 1) { h[42] = 0; h[43] = 0; h[44] = 0; h[45] = 0; } return h; },
  });
  await rejects(zip, /overlap/);
});

test('rejects truncated and non-zip input', async () => {
  await rejects(new Uint8Array(10), /too small/);
  await rejects(new TextEncoder().encode('x'.repeat(100)), /end of central directory/);
});
