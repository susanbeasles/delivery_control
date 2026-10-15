import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobTypeError, JobTypeRegistry, defineJobType, isHostname, type JobTypeErrorCode, type JobTypeSpec } from '../src/job-type.ts';
import { planSpec } from './helpers.ts';

function code(spec: JobTypeSpec): JobTypeErrorCode {
  try {
    defineJobType(spec);
  } catch (error) {
    if (error instanceof JobTypeError) return error.code;
    throw error;
  }
  throw new Error('expected JobTypeError');
}

test('a valid job type is frozen and copied', () => {
  const spec = defineJobType(planSpec);
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.command) && Object.isFrozen(spec.allowedHosts));
  assert.notEqual(spec.command, planSpec.command);
  assert.deepEqual(spec.allowedHosts, ['api.cloudflare.com', 'github.com']);
});

test('every invalid job type field is refused with its code', () => {
  const cases: [JobTypeErrorCode, Partial<JobTypeSpec>][] = [
    ['bad_name', { name: 'Terraform' }],
    ['bad_image', { image: 'registry.cloudflare.com/x@sha256:abc' }],
    ['bad_instance', { instance: 'huge' as JobTypeSpec['instance'] }],
    ['bad_command', { command: [] }],
    ['bad_command', { command: ['runner-job'] }],
    ['bad_command', { command: ['/bin/sh', '-c', 'x\0y'] }],
    ['bad_secret', { secrets: ['cf_plan'] }],
    ['bad_secret', { secrets: ['RUNNER_JOB_ID'] }],
    ['bad_secret', { secrets: ['SSL_CERT_FILE'] }],
    ['bad_secret', { secrets: ['A', 'A'] }],
    ['bad_host', { allowedHosts: ['*.cloudflare.com'] }],
    ['bad_host', { allowedHosts: ['api.cloudflare.com:443'] }],
    ['bad_host', { allowedHosts: ['https://api.cloudflare.com'] }],
    ['bad_host', { allowedHosts: ['API.cloudflare.com'] }],
    ['bad_host', { allowedHosts: ['localhost'] }],
    ['bad_host', { allowedHosts: ['10.0.0.1'] }],
    ['bad_host', { allowedHosts: ['github.com', 'github.com'] }],
    ['bad_timeout', { timeoutMs: 999 }],
    ['bad_timeout', { timeoutMs: 7 * 3_600_000 }],
    ['bad_timeout', { timeoutMs: 1.5 }],
    ['bad_log_limit', { maxLogBytes: 100 }],
    ['bad_log_limit', { maxLogBytes: 64 * 1024 * 1024 }],
  ];
  for (const [expected, patch] of cases) assert.equal(code({ ...planSpec, ...patch }), expected, JSON.stringify(patch));
});

test('hostnames are exact, lowercase DNS names', () => {
  for (const ok of ['api.cloudflare.com', 'r2.cloudflarestorage.com', 'a.b.c.example']) assert.ok(isHostname(ok), ok);
  for (const bad of ['', 'example', 'example.', '.example.com', 'ex ample.com', 'a-.example.com', 'example.123', `${'a'.repeat(64)}.com`]) assert.ok(!isHostname(bad), bad);
});

test('registry refuses duplicates and resolves by name', () => {
  const registry = new JobTypeRegistry([planSpec, { ...planSpec, name: 'terraform.apply' }]);
  assert.deepEqual(registry.names(), ['terraform.plan', 'terraform.apply']);
  assert.equal(registry.get('terraform.apply')?.name, 'terraform.apply');
  assert.equal(registry.get('nope'), undefined);
  assert.throws(() => new JobTypeRegistry([planSpec, planSpec]), (e: unknown) => e instanceof JobTypeError && e.code === 'duplicate_name');
});
