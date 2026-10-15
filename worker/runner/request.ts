import type { Json } from '../lib/json.ts';
import { fail } from '../lib/errors.ts';
import { PATTERNS, Shape } from '../lib/validate.ts';
import type { ReleaseVerifyInput, RunnerJobRequest, RunnerJobType, RunnerNotify } from './api.ts';
import { LIMITS } from './limits.ts';
import { JOB_PROFILES, JOB_TYPES, type RunnerRole } from './profiles.ts';
import { parseTerraformSubject } from './subject.ts';

/**
 * Fatal validation of a `RunnerJobRequest`. Shape checks are pure and repeatable (they run again
 * on every resubmit so the canonical digest is computed over a validated value); time checks run
 * only when a job is first recorded, so an idempotent resubmit after the deadline still answers.
 */

const CODE = 'invalid_job_request';
const MAX_EPOCH_SECONDS = 2 ** 40;

export function parseJobRequest(value: unknown, role: RunnerRole): RunnerJobRequest {
  const s = new Shape(value, CODE, 'request', ['jobId', 'type', 'deadlineAt', 'input', 'notify']);
  const jobId = s.string('jobId', PATTERNS.uuidv7, 36);
  const type = s.oneOf('type', JOB_TYPES);
  if (JOB_PROFILES[type].role !== role) fail('job_type_not_allowed', `${type} jobs do not run on the ${role} runner`);
  const deadlineAt = s.int('deadlineAt', 1, MAX_EPOCH_SECONDS);
  const notify = s.nullable('notify', (shape, key) => parseNotify(shape.raw(key)));
  if (role === 'root' && notify !== null) fail(CODE, 'request.notify: the root runner has no coordinator to notify');
  // Input validators throw on anything unexpected; the original value is kept so the canonical
  // digest (and the authorizer's subject digest) is computed over exactly what was granted.
  validateInput(type, s.raw('input'));
  return { jobId, type, deadlineAt, input: s.raw('input') as Json, notify };
}

export function checkDeadline(request: RunnerJobRequest, nowMs: number): void {
  const now = Math.floor(nowMs / 1000);
  if (request.deadlineAt < now + LIMITS.minDeadlineSeconds) fail(CODE, 'request.deadlineAt is too close or in the past');
  if (request.deadlineAt > now + LIMITS.maxDeadlineSeconds) fail(CODE, 'request.deadlineAt exceeds the container lifetime');
}

function parseNotify(value: unknown): RunnerNotify {
  const s = new Shape(value, CODE, 'request.notify', ['application', 'environment', 'deploymentId']);
  return {
    application: s.string('application', PATTERNS.application, 40),
    environment: s.string('environment', PATTERNS.environment, 32),
    deploymentId: s.string('deploymentId', PATTERNS.uuidv7, 36),
  };
}

function validateInput(type: RunnerJobType, input: unknown): void {
  const profile = JOB_PROFILES[type];
  if (profile.operation === 'verify') {
    parseReleaseVerifyInput(input);
    return;
  }
  if (profile.stack === null) return fail(CODE, `${type} has no stack`);
  parseTerraformSubject(input, { stack: profile.stack, operation: profile.operation });
}

const RELEASE_FILES = ['release.zip', 'release.manifest.json', 'attestation.sigstore.json'] as const;
type ReleaseFileName = (typeof RELEASE_FILES)[number];

const RELEASE_FILE_LIMITS: Readonly<Record<ReleaseFileName, number>> = {
  'release.zip': LIMITS.releaseZipBytes,
  'release.manifest.json': LIMITS.releaseManifestBytes,
  'attestation.sigstore.json': LIMITS.attestationBytes,
};

/** Staging keys follow CONTRACTS.md section 8: `staging/{deploymentId}/{asset}`. */
const STAGING_KEY = /^staging\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/([a-z.]+)$/;

export function parseReleaseVerifyInput(value: unknown): ReleaseVerifyInput {
  const code = 'invalid_release_verify_input';
  const s = new Shape(value, code, 'input', ['repository', 'sourceCommit', 'releaseTag', 'signerWorkflow', 'files']);
  const items = s.array('files', RELEASE_FILES.length, RELEASE_FILES.length);
  const files = items.map((item, index) => {
    const f = new Shape(item, code, `input.files[${index}]`, ['name', 'key', 'sha256', 'size']);
    const name = f.oneOf('name', RELEASE_FILES);
    const key = f.string('key', STAGING_KEY, 120);
    if (STAGING_KEY.exec(key)?.[1] !== name) fail(code, `input.files[${index}].key does not name ${name}`);
    return { name, key, sha256: f.string('sha256', PATTERNS.sha256, 64), size: f.int('size', 1, RELEASE_FILE_LIMITS[name]) };
  });
  if (new Set(files.map((f) => f.name)).size !== files.length) fail(code, 'input.files: each release file exactly once');
  // A fixed order makes the stdin framing and the agent's expectations independent of caller order.
  files.sort((a, b) => RELEASE_FILES.indexOf(a.name) - RELEASE_FILES.indexOf(b.name));
  return {
    repository: s.string('repository', PATTERNS.repository, 201),
    sourceCommit: s.string('sourceCommit', PATTERNS.commit, 40),
    releaseTag: s.string('releaseTag', PATTERNS.releaseTag, 40),
    signerWorkflow: s.string('signerWorkflow', PATTERNS.githubWorkflow, 320),
    files,
  };
}
