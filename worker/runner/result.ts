import { DeployError } from '../lib/errors.ts';
import { parseStrictJsonBytes, type Json } from '../lib/json.ts';
import { PATTERNS, Shape } from '../lib/validate.ts';
import type { ReleaseVerifyInput, ReleaseVerifyResult, RunnerJobRequest } from './api.ts';
import type { AgentExit } from './exec.ts';
import { LIMITS } from './limits.ts';
import { parsePlanSummary } from './plan-summary.ts';
import { JOB_PROFILES } from './profiles.ts';
import { parseReleaseVerifyInput } from './request.ts';
import { parseTerraformSubject } from './subject.ts';
import { failed, succeeded, unknownEnding, type Outcome } from './types.ts';

/**
 * Turns the agent's exit into the job's outcome. Exit code 0 with a valid `runner-result/v1`
 * document is authoritative; anything else is `uncertain` for mutating jobs and `failed` for
 * read-only ones. A success result is validated against its type's contract and cross-checked with
 * the job's own input, so a confused or compromised agent cannot report someone else's facts.
 */

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function interpretExit(request: RunnerJobRequest, exit: AgentExit): Outcome {
  const mutating = JOB_PROFILES[request.type].mutating;
  if (exit.failure) {
    // The runner refused its own input (for example a staging digest mismatch): never trusted.
    return exit.failure.code === 'staging_digest_mismatch' ? failed(exit.failure.code, exit.failure.message) : unknownEnding(mutating, exit.failure.code, exit.failure.message);
  }
  if (exit.exitCode !== 0 || exit.stdout === null) {
    return unknownEnding(mutating, 'agent_failed', `agent exited with ${exit.exitCode ?? 'no status'} and no authoritative result`);
  }
  let doc: ResultDocument;
  try {
    doc = parseResultDocument(parseStrictJsonBytes(exit.stdout, LIMITS.resultBytes, 'result_invalid'), request.jobId);
  } catch (error) {
    return unknownEnding(mutating, 'result_invalid', error instanceof DeployError ? error.message : 'result document is invalid');
  }
  if (doc.outcome !== 'succeeded') {
    return doc.outcome === 'failed' ? failed(doc.error.code, doc.error.message) : unknownEnding(mutating, doc.error.code, doc.error.message);
  }
  try {
    return succeeded(validateSuccess(request, doc.result));
  } catch (error) {
    return unknownEnding(mutating, 'result_invalid', error instanceof DeployError ? error.message : 'result is invalid');
  }
}

type ResultDocument =
  | { outcome: 'succeeded'; result: Json }
  | { outcome: 'failed' | 'uncertain'; error: { code: string; message: string } };

function parseResultDocument(value: unknown, jobId: string): ResultDocument {
  const s = new Shape(value, 'result_invalid', 'result', ['schema', 'jobId', 'outcome', 'result', 'error']);
  s.literal('schema', 'runner-result/v1');
  if (s.string('jobId', PATTERNS.uuidv7, 36) !== jobId) throw new DeployError('result_invalid', 'result is for another job');
  const outcome = s.oneOf('outcome', ['succeeded', 'failed', 'uncertain'] as const);
  if (outcome === 'succeeded') {
    if (s.raw('error') !== null || s.raw('result') === null) throw new DeployError('result_invalid', 'success must carry a result and no error');
    return { outcome, result: s.raw('result') as Json };
  }
  if (s.raw('result') !== null) throw new DeployError('result_invalid', 'a failure carries no result');
  const e = s.object('error', ['code', 'message']);
  const code = e.string('code', PATTERNS.any, 64);
  return { outcome, error: { code: ERROR_CODE.test(code) ? code : 'agent_error', message: e.string('message', PATTERNS.any, 2000).slice(0, 500) } };
}

function validateSuccess(request: RunnerJobRequest, result: Json): Json {
  const profile = JOB_PROFILES[request.type];
  if (profile.operation === 'verify') return validateReleaseVerifyResult(parseReleaseVerifyInput(request.input), result) as unknown as Json;
  if (profile.stack === null) throw new DeployError('result_invalid', 'job has no stack');
  const subject = parseTerraformSubject(request.input, { stack: profile.stack, operation: profile.operation });
  if (profile.operation === 'plan') {
    const summary = parsePlanSummary(result, 'result_invalid');
    if (summary.jobId !== request.jobId || summary.stack !== subject.stack || summary.treeSha !== subject.treeSha || summary.commit !== subject.commit || summary.repository !== subject.repository) {
      throw new DeployError('result_invalid', 'plan summary does not describe this job');
    }
    return result;
  }
  const s = new Shape(result, 'result_invalid', 'result', ['schema', 'jobId', 'stack', 'commit', 'treeSha', 'applied', 'stateSerialBefore', 'stateSerialAfter', 'stateLineage', 'archive']);
  s.literal('schema', 'terraform-apply-result/v1');
  if (s.raw('applied') !== true) throw new DeployError('result_invalid', 'apply result must say applied');
  s.nullable('stateSerialBefore', (shape, key) => shape.int(key, 0, Number.MAX_SAFE_INTEGER));
  s.int('stateSerialAfter', 0, Number.MAX_SAFE_INTEGER);
  s.string('stateLineage', /^[A-Za-z0-9-]{1,64}$/, 64);
  const archive = s.object('archive', ['before', 'after']);
  archive.nullable('before', (shape, key) => shape.string(key, /^[A-Za-z0-9._/-]{1,300}$/, 300));
  archive.nullable('after', (shape, key) => shape.string(key, /^[A-Za-z0-9._/-]{1,300}$/, 300));
  if (s.raw('jobId') !== request.jobId || s.raw('stack') !== subject.stack || s.raw('commit') !== subject.commit || s.raw('treeSha') !== subject.treeSha) {
    throw new DeployError('result_invalid', 'apply result does not describe this job');
  }
  return result;
}

/** The verified facts must be exactly the ones the job asked about. */
export function validateReleaseVerifyResult(input: ReleaseVerifyInput, value: unknown): ReleaseVerifyResult {
  const code = 'result_invalid';
  const s = new Shape(value, code, 'result', ['verified', 'subjects', 'signerWorkflow', 'sourceRepository', 'sourceDigest', 'sourceRef', 'verifier']);
  if (s.raw('verified') !== true) throw new DeployError(code, 'verified must be true');
  const subjects = s.array('subjects', 2, 2).map((item, index) => {
    const sub = new Shape(item, code, `result.subjects[${index}]`, ['name', 'sha256']);
    return { name: sub.oneOf('name', ['release.zip', 'release.manifest.json'] as const), sha256: sub.string('sha256', PATTERNS.sha256, 64) };
  });
  for (const name of ['release.zip', 'release.manifest.json'] as const) {
    const declared = input.files.find((f) => f.name === name);
    const verified = subjects.find((sub) => sub.name === name);
    if (!declared || !verified || declared.sha256 !== verified.sha256) throw new DeployError(code, `attestation subject ${name} does not match the staged file`);
  }
  const result: ReleaseVerifyResult = {
    verified: true,
    subjects,
    signerWorkflow: s.string('signerWorkflow', PATTERNS.githubWorkflow, 320),
    sourceRepository: s.string('sourceRepository', PATTERNS.repository, 201),
    sourceDigest: s.string('sourceDigest', PATTERNS.commit, 40),
    sourceRef: s.string('sourceRef', /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]{1,200}$/, 220),
    verifier: s.string('verifier', /^[\x20-\x7e]{1,200}$/, 200),
  };
  if (result.signerWorkflow !== input.signerWorkflow) throw new DeployError(code, 'signer workflow differs');
  if (result.sourceRepository !== input.repository) throw new DeployError(code, 'source repository differs');
  if (result.sourceDigest !== input.sourceCommit) throw new DeployError(code, 'source digest differs');
  if (result.sourceRef !== 'refs/heads/main' && result.sourceRef !== `refs/tags/${input.releaseTag}`) throw new DeployError(code, 'source ref is neither main nor the release tag');
  return result;
}
