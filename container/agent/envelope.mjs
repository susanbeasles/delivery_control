import { JobFailure } from './errors.mjs';

/** Validation of the `runner-job/v1` envelope and of which stdin files each job type expects. */

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const EXPECTED_FILES = Object.freeze({
  'release.verify': ['release.zip', 'release.manifest.json', 'attestation.sigstore.json'],
  'terraform.plan': ['source.tar.gz', 'policy.tar.gz'],
  'root.plan': ['source.tar.gz', 'policy.tar.gz'],
  'terraform.apply': ['source.tar.gz'],
  'root.apply': ['source.tar.gz'],
});

export function validateEnvelope(value) {
  const keys = ['schema', 'jobId', 'type', 'deadlineAt', 'input'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new JobFailure('envelope_invalid', 'envelope has an unexpected shape');
  }
  if (value.schema !== 'runner-job/v1') throw new JobFailure('envelope_invalid', 'envelope schema');
  if (typeof value.jobId !== 'string' || !UUIDV7.test(value.jobId)) throw new JobFailure('envelope_invalid', 'envelope jobId');
  if (!Object.hasOwn(EXPECTED_FILES, value.type)) throw new JobFailure('envelope_invalid', 'envelope type');
  if (!Number.isSafeInteger(value.deadlineAt) || value.deadlineAt <= 0) throw new JobFailure('envelope_invalid', 'envelope deadlineAt');
  if (value.input === null || typeof value.input !== 'object' || Array.isArray(value.input)) throw new JobFailure('envelope_invalid', 'envelope input');
  return value;
}

export function checkFiles(type, files) {
  const expected = EXPECTED_FILES[type];
  const names = files.map((f) => f.name);
  if (names.length !== expected.length || expected.some((name, i) => names[i] !== name)) {
    throw new JobFailure('stdin_invalid', `expected files ${expected.join(', ')}`);
  }
}
