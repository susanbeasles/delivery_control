import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFrames } from '../../container/agent/framing.mjs';
import { frameHeader } from '../../worker/runner/framing.ts';
import { JOB_ID, NOW } from './builders.ts';
import { sha256 } from './fakes.ts';

const envelope = { schema: 'runner-job/v1' as const, jobId: JOB_ID, type: 'terraform.apply' as const, deadlineAt: NOW + 600, input: { stack: 'infra' } };
const a = Buffer.from('first file bytes '.repeat(50));
const b = Buffer.from('second');

function framed(files: Array<[string, Buffer]>, declared?: Array<{ name: string; size: number; sha256: string }>): Buffer {
  const list = declared ?? files.map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) }));
  return Buffer.concat([Buffer.from(frameHeader(envelope, list)), ...files.map(([, bytes]) => bytes)]);
}

async function collect(bytes: Buffer, chunkSize: number) {
  async function* source() {
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
  }
  const out = { envelope: null as unknown, files: [] as unknown[], contents: new Map<string, Buffer>(), ended: [] as string[] };
  for await (const event of readFrames(source())) {
    if (event.kind === 'envelope') out.envelope = event.value;
    if (event.kind === 'files') out.files = event.value;
    if (event.kind === 'chunk') out.contents.set(event.file.name, Buffer.concat([out.contents.get(event.file.name) ?? Buffer.alloc(0), Buffer.from(event.bytes)]));
    if (event.kind === 'file-end') out.ended.push(event.file.name);
  }
  return out;
}

test('round trip with the Durable Object writer, at every chunk size', async () => {
  const bytes = framed([['source.tar.gz', a], ['plan.tfplan', b]]);
  for (const size of [1, 2, 7, 64, 511, bytes.length]) {
    const out = await collect(bytes, size);
    assert.deepEqual(out.envelope, envelope);
    assert.deepEqual(out.ended, ['source.tar.gz', 'plan.tfplan']);
    assert.deepEqual(out.contents.get('source.tar.gz'), a);
    assert.deepEqual(out.contents.get('plan.tfplan'), b);
  }
});

test('a file whose bytes differ from the declared digest is rejected', async () => {
  const bytes = framed([['source.tar.gz', a]], [{ name: 'source.tar.gz', size: a.length, sha256: sha256('other') }]);
  await assert.rejects(collect(bytes, 100), { code: 'input_digest_mismatch' });
});

test('truncation, trailing bytes and malformed headers are rejected', async () => {
  const good = framed([['source.tar.gz', a]]);
  await assert.rejects(collect(good.subarray(0, good.length - 1), 50), { code: 'stdin_invalid' });
  await assert.rejects(collect(Buffer.concat([good, Buffer.from('x')]), 50), { code: 'stdin_invalid' });
  await assert.rejects(collect(Buffer.from('not json\n{"files":[]}\n'), 5), { code: 'stdin_invalid' });
  await assert.rejects(collect(Buffer.from(`${JSON.stringify(envelope)}\n`), 5), { code: 'stdin_invalid' });
  const dup = Buffer.from(`${JSON.stringify(envelope)}\n${JSON.stringify({ files: [{ name: 'a', sha256: sha256(''), size: 1 }, { name: 'a', sha256: sha256(''), size: 1 }] })}\n`);
  await assert.rejects(collect(dup, 64), { code: 'stdin_invalid' });
  const traversal = Buffer.from(`${JSON.stringify(envelope)}\n${JSON.stringify({ files: [{ name: '../etc/passwd', sha256: sha256(''), size: 1 }] })}\n`);
  await assert.rejects(collect(traversal, 64), { code: 'stdin_invalid' });
  const extraKey = Buffer.from(`${JSON.stringify(envelope)}\n${JSON.stringify({ files: [], secret: 'x' })}\n`);
  await assert.rejects(collect(extraKey, 64), { code: 'stdin_invalid' });
});
