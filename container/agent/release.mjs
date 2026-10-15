import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobFailure, fail } from './errors.mjs';
import { baseToolEnv } from './paths.mjs';
import { runTool } from './process.mjs';

/**
 * `release.verify`: GitHub's own verifier, offline, against a reviewed trusted root baked into the
 * image. No egress is allowed for this job type at all. Flags follow the `gh attestation verify`
 * manual for gh 2.74.0 (VERIFY against the pinned version before commissioning).
 */

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/;
const SUBJECT_FILES = ['release.zip', 'release.manifest.json'];

export function validateReleaseInput(input) {
  const keys = ['repository', 'sourceCommit', 'releaseTag', 'signerWorkflow', 'files'];
  if (input === null || typeof input !== 'object' || Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) fail('input_invalid', 'input has an unexpected shape');
  if (!REPOSITORY.test(input.repository) || !/^[a-f0-9]{40}$/.test(input.sourceCommit)) fail('input_invalid', 'input repository or sourceCommit');
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(input.releaseTag) || !WORKFLOW.test(input.signerWorkflow)) fail('input_invalid', 'input releaseTag or signerWorkflow');
  if (!Array.isArray(input.files) || input.files.length !== 3) fail('input_invalid', 'input files');
  return input;
}

/** Arguments for one subject; kept pure so the exact invocation is reviewed and tested. */
export function verifyArgs(file, bundle, trustedRoot, input) {
  return [
    'attestation', 'verify', file,
    '--bundle', bundle,
    '--custom-trusted-root', trustedRoot,
    '--repo', input.repository,
    '--signer-workflow', input.signerWorkflow,
    '--source-digest', input.sourceCommit,
    '--deny-self-hosted-runners',
    '--format', 'json',
  ];
}

const stripGithub = (uri) => (typeof uri === 'string' && uri.startsWith('https://github.com/') ? uri.slice('https://github.com/'.length) : null);

/**
 * Extracts the verified facts from gh's JSON output for one artifact, requiring a verification
 * result whose statement lists the artifact's digest. Field names follow gh's
 * `verificationResult.signature.certificate` (Fulcio certificate extensions). VERIFY.
 */
export function parseVerifyOutput(text, expectedSha256) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new JobFailure('attestation_output_invalid', 'gh output is not JSON');
  }
  if (!Array.isArray(doc) || doc.length === 0) throw new JobFailure('attestation_output_invalid', 'gh returned no verification results');
  const match = doc.find((entry) => (entry?.verificationResult?.statement?.subject ?? []).some((s) => s?.digest?.sha256 === expectedSha256));
  if (!match) throw new JobFailure('attestation_subject_missing', 'no verified statement lists this artifact digest');
  const cert = match.verificationResult?.signature?.certificate ?? {};
  const sourceRepository = stripGithub(cert.sourceRepositoryURI);
  const signer = stripGithub(cert.buildSignerURI);
  const signerWorkflow = signer?.split('@')[0] ?? null;
  const facts = {
    sourceRepository,
    sourceDigest: cert.sourceRepositoryDigest,
    sourceRef: cert.sourceRepositoryRef,
    signerWorkflow,
    runnerEnvironment: cert.runnerEnvironment,
  };
  if (!sourceRepository || !REPOSITORY.test(sourceRepository)) throw new JobFailure('attestation_output_invalid', 'certificate has no source repository');
  if (typeof facts.sourceDigest !== 'string' || !/^[a-f0-9]{40}$/.test(facts.sourceDigest)) throw new JobFailure('attestation_output_invalid', 'certificate has no source digest');
  if (typeof facts.sourceRef !== 'string' || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]{1,200}$/.test(facts.sourceRef)) throw new JobFailure('attestation_output_invalid', 'certificate has no source ref');
  if (!signerWorkflow || !WORKFLOW.test(signerWorkflow)) throw new JobFailure('attestation_output_invalid', 'certificate has no signer workflow');
  if (facts.runnerEnvironment !== 'github-hosted') throw new JobFailure('attestation_runner_not_hosted', 'attestation was not produced on a GitHub-hosted runner');
  return facts;
}

/** Both artifacts must be attested by the same signer for the same source; the ref must be main or the tag. */
export function combineFacts(input, factsByName) {
  const [first, ...rest] = SUBJECT_FILES.map((name) => factsByName.get(name));
  for (const other of rest) {
    for (const key of ['sourceRepository', 'sourceDigest', 'sourceRef', 'signerWorkflow']) {
      if (other[key] !== first[key]) throw new JobFailure('attestation_inconsistent', `artifacts disagree on ${key}`);
    }
  }
  if (first.sourceRepository !== input.repository) throw new JobFailure('attestation_repository_mismatch', 'attested repository differs');
  if (first.sourceDigest !== input.sourceCommit) throw new JobFailure('attestation_digest_mismatch', 'attested source commit differs');
  if (first.signerWorkflow !== input.signerWorkflow) throw new JobFailure('attestation_signer_mismatch', 'attested signer workflow differs');
  if (first.sourceRef !== 'refs/heads/main' && first.sourceRef !== `refs/tags/${input.releaseTag}`) throw new JobFailure('attestation_ref_mismatch', 'attested ref is neither main nor the release tag');
  return first;
}

export async function runReleaseVerify(ctx) {
  const input = validateReleaseInput(ctx.envelope.input);
  // Commissioning input: produced from GitHub's and Sigstore's TUF roots and reviewed (docs/RUNNER.md).
  if (!existsSync(ctx.paths.trustedRoot)) fail('trusted_root_missing', 'the image has no pinned Sigstore trusted root');
  const trustedRootSha256 = createHash('sha256').update(readFileSync(ctx.paths.trustedRoot)).digest('hex');
  const env = {
    ...baseToolEnv(ctx),
    GH_CONFIG_DIR: join(ctx.workdir, 'gh'),
    // gh insists on a token being present; verification with --bundle and a custom root is offline,
    // and the gate refuses every request of this job type anyway.
    GH_TOKEN: 'offline-verification',
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
  const version = await runTool(ctx.paths.gh, ['--version'], { cwd: ctx.workdir, env, deadlineMs: ctx.deadlineMs, captureBytes: 4096 });
  const ghVersion = /gh version (\d+\.\d+\.\d+)/.exec(version.stdout?.toString('utf8') ?? '')?.[1] ?? 'unknown';
  const facts = new Map();
  for (const name of SUBJECT_FILES) {
    const declared = input.files.find((f) => f.name === name);
    if (!declared) fail('input_invalid', `input does not declare ${name}`);
    const r = await runTool(ctx.paths.gh, verifyArgs(ctx.files.get(name), ctx.files.get('attestation.sigstore.json'), ctx.paths.trustedRoot, input), {
      cwd: ctx.workdir,
      env,
      deadlineMs: ctx.deadlineMs,
      captureBytes: 1024 * 1024,
    });
    if (r.code !== 0 || r.stdout === null) fail('attestation_invalid', `gh attestation verify rejected ${name}`);
    facts.set(name, parseVerifyOutput(r.stdout.toString('utf8'), declared.sha256));
  }
  const verified = combineFacts(input, facts);
  return {
    verified: true,
    subjects: SUBJECT_FILES.map((name) => ({ name, sha256: input.files.find((f) => f.name === name).sha256 })),
    signerWorkflow: verified.signerWorkflow,
    sourceRepository: verified.sourceRepository,
    sourceDigest: verified.sourceDigest,
    sourceRef: verified.sourceRef,
    verifier: `gh ${ghVersion} attestation verify; trusted root sha256:${trustedRootSha256}`,
  };
}
