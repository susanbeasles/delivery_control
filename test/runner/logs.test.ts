import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogSink, type LogBucket } from '../../worker/runner/log-sink.ts';
import { Redactor, redactText } from '../../worker/runner/redact.ts';
import { PASSPHRASE } from './builders.ts';
import { FakeBucket } from './fakes.ts';

test('token-shaped values are masked; digests and ordinary text survive', () => {
  const cases: Array<[string, string]> = [
    ['Authorization: Bearer abc.def.ghi', 'Authorization: [REDACTED]'],
    ['curl -H "authorization: token x"', 'curl -H "authorization: [REDACTED]'],
    ['got Bearer abcdefgh12345678 back', 'got Bearer [REDACTED] back'],
    ['token ghs_16C7e42F292c6912E7710c838347Ae178B4a here', 'token [REDACTED] here'],
    ['jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl end', 'jwt [REDACTED] end'],
    ['GET /x?X-Amz-Signature=abcdef0123&X-Amz-Credential=AKIA/2026', 'GET /x?X-Amz-Signature=[REDACTED]&X-Amz-Credential=[REDACTED]'],
    ['client_secret = "s3cr3t-value"', 'client_secret = "[REDACTED]"'],
    ['TF_ENCRYPTION_PASSPHRASE=abcdefgh', 'TF_ENCRYPTION_PASSPHRASE=[REDACTED]'],
    ['value Zk3pQ9vX2mL8nR4tY7wB1cD5eF6gH0jK here', 'value [REDACTED] here'],
  ];
  for (const [input, expected] of cases) assert.equal(redactText(input), expected, input);
  const digest = `plan sha256 ${'ab12'.repeat(16)} commit ${'c0ffee'.repeat(6)}ab`;
  assert.equal(redactText(digest), digest);
  assert.equal(redactText('Plan: 1 to add, 2 to change, 0 to destroy.'), 'Plan: 1 to add, 2 to change, 0 to destroy.');
});

test('known secrets are removed even when split across chunks, and PEM blocks entirely', () => {
  const r = new Redactor([PASSPHRASE]);
  const text = `before ${PASSPHRASE} after\n`;
  let out = '';
  for (let i = 0; i < text.length; i += 5) out += r.push(text.slice(i, i + 5));
  out += r.flush();
  assert.equal(out.includes(PASSPHRASE), false);
  assert.ok(out.includes('before [REDACTED] after'));
  const pem = redactText('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\ny\n');
  assert.equal(pem, 'x\n[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]\ny\n');
});

test('very long lines are cut outside tokens so a secret is never split', () => {
  const r = new Redactor([PASSPHRASE], 64);
  const line = `${'word '.repeat(30)}${PASSPHRASE} ${'tail '.repeat(30)}`;
  const out = r.push(line) + r.flush();
  assert.equal(out.includes(PASSPHRASE), false);
  assert.equal(out.includes(PASSPHRASE.slice(0, 20)), false);
});

test('the log sink stores redacted, bounded logs in equal multipart parts', async () => {
  const bucket = new FakeBucket();
  const sink = new LogSink(bucket as unknown as LogBucket, 'jobs/t/j/stderr.log', [PASSPHRASE], { maxBytes: 100, partBytes: 32 });
  await sink.write(new TextEncoder().encode(`line one ${PASSPHRASE}\n`));
  for (let i = 0; i < 20; i++) await sink.write(new TextEncoder().encode(`line ${i}\n`));
  const key = await sink.close();
  assert.equal(key, 'jobs/t/j/stderr.log');
  const text = bucket.text(key ?? '') ?? '';
  assert.equal(text.includes(PASSPHRASE), false);
  assert.match(text, /^line one \[REDACTED\]\n/);
  assert.match(text, /\[runner\] log truncated at 100 bytes\n$/);

  const small = new LogSink(bucket as unknown as LogBucket, 'small.log', [], { maxBytes: 1000, partBytes: 32 });
  await small.write(new TextEncoder().encode('hello\n'));
  assert.equal(await small.close(), 'small.log');
  assert.equal(bucket.text('small.log'), 'hello\n');
  const empty = new LogSink(bucket as unknown as LogBucket, 'empty.log', [], { maxBytes: 1000, partBytes: 32 });
  assert.equal(await empty.close(), null);

  const failing = new FakeBucket();
  failing.failPuts = true;
  const lost = new LogSink(failing as unknown as LogBucket, 'lost.log', [], { maxBytes: 1000, partBytes: 1024 });
  await lost.write(new TextEncoder().encode('x\n'));
  assert.equal(await lost.close(), null, 'log storage failures are swallowed');
});
