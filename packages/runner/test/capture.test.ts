import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureStream, renderCapture } from '../src/capture.ts';
import { createRedactor } from '../src/redact.ts';
import { decoder, encoder } from './fakes.ts';

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const never = new AbortController().signal;

test('a stream within the limit is kept whole', async () => {
  const captured = await captureStream(stream([encoder.encode('hello '), encoder.encode('world')]), 4_096, never);
  assert.equal(decoder.decode(captured.head), 'hello world');
  assert.equal(captured.totalBytes, 11);
  assert.equal(captured.truncated, false);
  assert.equal(decoder.decode(renderCapture(captured, createRedactor({}))), 'hello world');
});

test('a null stream yields an empty capture', async () => {
  const captured = await captureStream(null, 4_096, never);
  assert.equal(captured.totalBytes, 0);
});

test('beyond the limit the head and tail are kept, the rest is counted and drained', async () => {
  const limit = 4_096;
  const chunks = Array.from({ length: 100 }, (_, i) => encoder.encode(`line ${String(i).padStart(4, '0')} ${'x'.repeat(90)}\n`));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const captured = await captureStream(stream(chunks), limit, never);
  assert.equal(captured.truncated, true);
  assert.equal(captured.totalBytes, total);
  assert.ok(captured.head.byteLength + captured.tail.byteLength <= limit);
  assert.equal(captured.head.byteLength, limit - 1_024);
  assert.equal(captured.tail.byteLength, 1_024);
  const text = decoder.decode(renderCapture(captured, createRedactor({})));
  assert.ok(text.startsWith('line 0000 '));
  assert.ok(text.endsWith(`line 0099 ${'x'.repeat(90)}\n`));
  assert.match(text, new RegExp(`\\[runner: ${total - limit} bytes omitted\\]`));
});

test('a single oversized chunk is cut to head and tail', async () => {
  const captured = await captureStream(stream([new Uint8Array(100_000).fill(65)]), 8_192, never);
  assert.equal(captured.truncated, true);
  assert.equal(captured.head.byteLength, 8_192 - 2_048);
  assert.equal(captured.tail.byteLength, 2_048);
});

test('capture stops when told and says so', async () => {
  const stop = new AbortController();
  const pending = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('partial'));
    },
  });
  const promise = captureStream(pending, 4_096, stop.signal);
  await new Promise((resolve) => setImmediate(resolve));
  stop.abort();
  const captured = await promise;
  assert.equal(captured.interrupted, true);
  assert.equal(decoder.decode(captured.head), 'partial');
  assert.match(decoder.decode(renderCapture(captured, createRedactor({}))), /capture stopped/);
});

test('a stream error ends the capture as interrupted', async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('before'));
      controller.error(new Error('reset'));
    },
  });
  const captured = await captureStream(broken, 4_096, never);
  assert.equal(captured.interrupted, true);
  // Chunks queued before the error may be dropped by the stream implementation; what was read is kept.
  assert.ok(captured.totalBytes <= 6);
  assert.match(decoder.decode(renderCapture(captured, createRedactor({}))), /capture stopped/);
});

test('secret values are scrubbed from rendered logs, longest first, short values ignored', () => {
  const redactor = createRedactor({ TOKEN: 'abcdefghij', LONGER: 'abcdefghijklmnop', SHORT: 'abc' });
  assert.equal(redactor.apply('x abcdefghijklmnop y abcdefghij z abc'), 'x [redacted:LONGER] y [redacted:TOKEN] z abc');
  const captured = { head: encoder.encode('token=abcdefghij'), tail: new Uint8Array(0), totalBytes: 16, truncated: false, interrupted: false };
  assert.equal(decoder.decode(renderCapture(captured, redactor)), 'token=[redacted:TOKEN]');
});
