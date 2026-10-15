import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvelopeError, canonicalJson, envelopeDigest, parseEnvelope, serializeEnvelope, type EnvelopeErrorCode } from '../src/envelope.ts';
import { encoder } from './fakes.ts';
import { envelopeBytes, envelopeJson } from './helpers.ts';

// Built from text: a `__proto__` key in an object literal sets the prototype and never survives JSON.stringify.
const protoBytes = encoder.encode(JSON.stringify(envelopeJson()).replace('"inputs":{', '"inputs":{"__proto__":{"polluted":true},'));

function code(bytes: Uint8Array): EnvelopeErrorCode {
  try {
    parseEnvelope(bytes);
  } catch (error) {
    if (error instanceof EnvelopeError) return error.code;
    throw error;
  }
  throw new Error('expected EnvelopeError');
}

test('a valid envelope parses, freezes and keeps only declared keys', () => {
  const envelope = parseEnvelope(envelopeBytes());
  assert.equal(envelope.job_type, 'terraform.plan');
  assert.equal(envelope.requested_by.run_id, '123');
  assert.ok(Object.isFrozen(envelope));
  assert.deepEqual(Object.keys(envelope).sort(), ['created_at', 'idempotency_key', 'inputs', 'job_id', 'job_type', 'requested_by', 'v']);
});

test('run_id is optional', () => {
  const envelope = parseEnvelope(envelopeBytes({ requested_by: { sub: 'cron' } }));
  assert.deepEqual(envelope.requested_by, { sub: 'cron' });
});

test('every malformed envelope maps to a stable error code', () => {
  const cases: [EnvelopeErrorCode, Uint8Array][] = [
    ['bad_json', new Uint8Array(0)],
    ['too_large', encoder.encode(JSON.stringify(envelopeJson({ inputs: { pad: 'x'.repeat(70_000) } })))],
    ['bad_encoding', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    ['bad_json', encoder.encode('{"v":1,')],
    ['bad_shape', encoder.encode('[]')],
    ['bad_shape', encoder.encode('"text"')],
    ['unknown_key', envelopeBytes({ extra: true })],
    ['bad_shape', encoder.encode(JSON.stringify((({ created_at: _omit, ...rest }) => rest)(envelopeJson())))],
    ['bad_version', envelopeBytes({ v: 2 })],
    ['bad_version', envelopeBytes({ v: '1' })],
    ['bad_job_id', envelopeBytes({ job_id: 'JOB-1' })],
    ['bad_job_id', envelopeBytes({ job_id: '018F3A2E-7C4B-7A11-9D2E-3F4A5B6C7D8E' })],
    ['bad_job_type', envelopeBytes({ job_type: 'Terraform.Plan' })],
    ['bad_job_type', envelopeBytes({ job_type: 'a.b.c.d.e' })],
    ['bad_idempotency_key', envelopeBytes({ idempotency_key: 'c'.repeat(63) })],
    ['bad_inputs', envelopeBytes({ inputs: [] })],
    ['bad_inputs', protoBytes],
    ['bad_inputs', envelopeBytes({ inputs: { constructor: 1 } })],
    ['bad_inputs', envelopeBytes({ inputs: { s: 'x'.repeat(4_097) } })],
    ['bad_inputs', envelopeBytes({ inputs: { deep: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } } })],
    ['bad_inputs', envelopeBytes({ inputs: { list: new Array(257).fill(0) } })],
    ['bad_inputs', envelopeBytes({ inputs: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) })],
    ['bad_inputs', envelopeBytes({ inputs: { ['k'.repeat(65)]: 1 } })],
    ['bad_requested_by', envelopeBytes({ requested_by: 'cron' })],
    ['bad_requested_by', envelopeBytes({ requested_by: { sub: 'cron', extra: 1 } })],
    ['bad_requested_by', envelopeBytes({ requested_by: { sub: 'bad sub' } })],
    ['bad_requested_by', envelopeBytes({ requested_by: { sub: 'cron', run_id: 7 } })],
    ['bad_requested_by', envelopeBytes({ requested_by: { sub: 'cron', run_id: '0' } })],
    ['bad_created_at', envelopeBytes({ created_at: '2026-10-15 12:00:00' })],
    ['bad_created_at', envelopeBytes({ created_at: '2026-10-15T12:00:00+02:00' })],
    ['bad_created_at', envelopeBytes({ created_at: '2026-02-31T12:00:00Z' })],
  ];
  for (const [expected, bytes] of cases) assert.equal(code(bytes), expected, `case ${expected}`);
});

test('a __proto__ key never reaches the parsed object', () => {
  assert.ok(new TextDecoder().decode(protoBytes).includes('"__proto__"'));
  assert.throws(() => parseEnvelope(protoBytes), (error: unknown) => error instanceof EnvelopeError && error.code === 'bad_inputs');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('serialization is canonical and the digest is stable under key order', async () => {
  const a = parseEnvelope(envelopeBytes());
  const reordered = encoder.encode(JSON.stringify(Object.fromEntries(Object.entries(envelopeJson()).reverse())));
  const b = parseEnvelope(reordered);
  assert.equal(new TextDecoder().decode(serializeEnvelope(a)), new TextDecoder().decode(serializeEnvelope(b)));
  assert.equal(await envelopeDigest(a), await envelopeDigest(b));
  assert.notEqual(await envelopeDigest(a), await envelopeDigest(parseEnvelope(envelopeBytes({ inputs: { repo: 'other' } }))));
  assert.equal(canonicalJson({ b: [1, { z: null, a: 'x' }], a: true }), '{"a":true,"b":[1,{"a":"x","z":null}]}');
  assert.match(new TextDecoder().decode(serializeEnvelope(a)), /^\{"created_at":"2026-10-15T12:00:00Z","idempotency_key":/);
});
