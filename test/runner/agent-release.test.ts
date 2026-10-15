import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { combineFacts, parseVerifyOutput, runReleaseVerify, verifyArgs } from '../../container/agent/release.mjs';
import { main } from '../../container/agent/main.mjs';
import { frameHeader } from '../../worker/runner/framing.ts';
import { COMMIT, JOB_ID, RELEASE_BYTES, releaseInput } from './builders.ts';

const input = releaseInput();
const zipSha = (input['files'] as Array<{ name: string; sha256: string }>)[0]?.sha256 ?? '';

function ghOutput(overrides: Record<string, unknown> = {}, subjectSha = zipSha) {
  return JSON.stringify([
    {
      verificationResult: {
        statement: { subject: [{ name: 'release.zip', digest: { sha256: subjectSha } }] },
        signature: {
          certificate: {
            sourceRepositoryURI: 'https://github.com/susanbeasles/ProsRUs',
            sourceRepositoryDigest: COMMIT,
            sourceRepositoryRef: 'refs/heads/main',
            buildSignerURI: 'https://github.com/susanbeasles/workflow_depot/.github/workflows/release.yml@refs/heads/main',
            runnerEnvironment: 'github-hosted',
            ...overrides,
          },
        },
      },
    },
  ]);
}

test('gh is invoked offline with the pinned root, repository, signer workflow and source digest', () => {
  assert.deepEqual(verifyArgs('/tmp/job/in/release.zip', '/tmp/job/in/attestation.sigstore.json', '/opt/runner/trust/trusted_root.jsonl', input), [
    'attestation', 'verify', '/tmp/job/in/release.zip',
    '--bundle', '/tmp/job/in/attestation.sigstore.json',
    '--custom-trusted-root', '/opt/runner/trust/trusted_root.jsonl',
    '--repo', 'susanbeasles/ProsRUs',
    '--signer-workflow', 'susanbeasles/workflow_depot/.github/workflows/release.yml',
    '--source-digest', COMMIT,
    '--deny-self-hosted-runners',
    '--format', 'json',
  ]);
});

test('verified facts come from the certificate of a statement that lists the artifact', () => {
  const facts = parseVerifyOutput(ghOutput(), zipSha);
  assert.deepEqual(facts, {
    sourceRepository: 'susanbeasles/ProsRUs',
    sourceDigest: COMMIT,
    sourceRef: 'refs/heads/main',
    signerWorkflow: 'susanbeasles/workflow_depot/.github/workflows/release.yml',
    runnerEnvironment: 'github-hosted',
  });
  assert.throws(() => parseVerifyOutput(ghOutput({}, 'f'.repeat(64)), zipSha), { code: 'attestation_subject_missing' });
  assert.throws(() => parseVerifyOutput(ghOutput({ runnerEnvironment: 'self-hosted' }), zipSha), { code: 'attestation_runner_not_hosted' });
  assert.throws(() => parseVerifyOutput('[]', zipSha), { code: 'attestation_output_invalid' });
});

test('both artifacts must agree, and match the request (repository, commit, signer, ref)', () => {
  const facts = parseVerifyOutput(ghOutput(), zipSha);
  const both = (other: Record<string, unknown>) => new Map([['release.zip', facts], ['release.manifest.json', { ...facts, ...other }]]);
  assert.equal(combineFacts(input, both({})).sourceRef, 'refs/heads/main');
  assert.throws(() => combineFacts(input, both({ sourceDigest: 'b'.repeat(40) })), { code: 'attestation_inconsistent' });
  const tagged = { ...facts, sourceRef: 'refs/tags/v1.4.2' };
  assert.doesNotThrow(() => combineFacts(input, new Map([['release.zip', tagged], ['release.manifest.json', tagged]])));
  const otherTag = { ...facts, sourceRef: 'refs/tags/v9.9.9' };
  assert.throws(() => combineFacts(input, new Map([['release.zip', otherTag], ['release.manifest.json', otherTag]])), { code: 'attestation_ref_mismatch' });
  const otherRepo = { ...facts, sourceRepository: 'someone/else' };
  assert.throws(() => combineFacts(input, new Map([['release.zip', otherRepo], ['release.manifest.json', otherRepo]])), { code: 'attestation_repository_mismatch' });
  const otherSigner = { ...facts, signerWorkflow: 'susanbeasles/ProsRUs/.github/workflows/release.yml' };
  assert.throws(() => combineFacts(input, new Map([['release.zip', otherSigner], ['release.manifest.json', otherSigner]])), { code: 'attestation_signer_mismatch' });
});

test('without a commissioned trusted root, verification fails closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-release-'));
  const ctx = { envelope: { input }, paths: { trustedRoot: join(dir, 'absent.jsonl'), gh: '/nonexistent/gh', cloudflareCa: '/nonexistent' }, workdir: dir, home: dir, files: new Map(), deadlineMs: Date.now() + 60_000 };
  await assert.rejects(runReleaseVerify(ctx), { code: 'trusted_root_missing' });
});

test('the agent entrypoint writes exactly one failure document for trusted_root_missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-main-'));
  const files = (input['files'] as Array<{ name: keyof typeof RELEASE_BYTES; sha256: string; size: number }>).map(({ name, sha256, size }) => ({ name, sha256, size }));
  const envelope = { schema: 'runner-job/v1' as const, jobId: JOB_ID, type: 'release.verify' as const, deadlineAt: Math.floor(Date.now() / 1000) + 3600, input: { ...input, files } };
  const bytes = Buffer.concat([Buffer.from(frameHeader(envelope, files)), ...files.map((f) => Buffer.from(RELEASE_BYTES[f.name]))]);
  async function* stdin() {
    yield bytes;
  }
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const env: Record<string, string> = { RUNNER_TF_PASSPHRASE: 'should-be-removed' };
  let code: number;
  try {
    code = await main({ stdin: stdin(), env, paths: { workdir: join(dir, 'job'), trustedRoot: join(dir, 'none.jsonl'), gh: '/nonexistent/gh', cloudflareCa: '/nonexistent' } });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(code, 0);
  assert.equal(env['RUNNER_TF_PASSPHRASE'], undefined);
  assert.equal(written.length, 1);
  const doc = JSON.parse(written[0] ?? '');
  assert.deepEqual(doc, { schema: 'runner-result/v1', jobId: JOB_ID, outcome: 'failed', result: null, error: { code: 'trusted_root_missing', message: 'the image has no pinned Sigstore trusted root' } });

  // A second job in the same container is refused: one job per container.
  async function* again() {
    yield bytes;
  }
  const second: string[] = [];
  process.stdout.write = ((chunk: string) => {
    second.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await main({ stdin: again(), env: {}, paths: { workdir: join(dir, 'job'), trustedRoot: join(dir, 'none.jsonl'), gh: '/x', cloudflareCa: '/x' } }), 2);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(second.length, 0);
});
