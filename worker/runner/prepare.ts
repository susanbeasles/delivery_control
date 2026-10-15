import { fail } from '../lib/errors.ts';
import type { Json } from '../lib/json.ts';
import type { ReleaseVerifyInput, RunnerJobRequest } from './api.ts';
import { ARCHIVE_BUCKET, STATE_BUCKET, archiveKey, planObjectKey, r2Host, stateKey } from './egress/rules.ts';
import type { InputFile } from './framing.ts';
import { branchHead, commitTree, downloadTarball, type SourceDeps } from './github-source.ts';
import { ARTIFACT_HOST, LIMITS } from './limits.ts';
import { digestStoredObject, isStackLocked, readPlanSummary, storedPlanState, type PlanBucket, type StoredBody, type StoredObject } from './plan-store.ts';
import { JOB_PROFILES, POLICY_SOURCE, STACKS, type StackName } from './profiles.ts';
import { parseReleaseVerifyInput } from './request.ts';
import { streamOfChunks, verifyingStream, type ChunkedBytes, type HashFactory } from './streams.ts';
import { parseTerraformSubject, type TerraformSubject } from './subject.ts';
import { succeeded, type Outcome } from './types.ts';

/**
 * Everything the Durable Object does before a container exists: refusals that need no container
 * (stack locked, plan missing or tampered, tree mismatch), reuse of an already stored plan, and
 * gathering the agent's input and stdin files. Throwing a DeployError here ends the job `failed`
 * (or retries, when retryable): nothing has run yet, so nothing can be uncertain.
 */

export interface ReadBucket {
  head(key: string): Promise<StoredObject | null>;
  get(key: string): Promise<StoredBody | null>;
}

export interface PrepareDeps {
  plans: PlanBucket;
  staging: ReadBucket | null;
  /** `null` when the GitHub App is not configured (GITHUB_APP_ID "0"): terraform jobs fail closed. */
  source: SourceDeps | null;
  passphrase(request: RunnerJobRequest): Promise<string | null>;
  accountId: string;
  hashes: HashFactory;
}

export type Preparation =
  | { kind: 'run'; agentInput: Json; files: InputFile[]; passphrase: string | null }
  | { kind: 'finished'; outcome: Outcome };

export async function prepareJob(request: RunnerJobRequest, deps: PrepareDeps): Promise<Preparation> {
  const profile = JOB_PROFILES[request.type];
  if (profile.operation === 'verify') return prepareReleaseVerify(parseReleaseVerifyInput(request.input), deps);
  if (profile.stack === null) return fail('invalid_job_request', `${request.type} has no stack`);
  const subject = parseTerraformSubject(request.input, { stack: profile.stack, operation: profile.operation });
  return profile.operation === 'plan' ? preparePlan(request, subject, deps) : prepareApply(request, subject, deps);
}

function prepareReleaseVerify(input: ReleaseVerifyInput, deps: PrepareDeps): Promise<Preparation> {
  const staging = deps.staging;
  if (staging === null) return fail('staging_unbound', 'release-staging is not bound to this runner');
  return (async () => {
    const files: InputFile[] = [];
    for (const file of input.files) {
      const object = await staging.head(file.key);
      if (!object) fail('staging_missing', `${file.name} is not staged`);
      if (object.size !== file.size) fail('staging_digest_mismatch', `${file.name} has ${object.size} bytes, expected ${file.size}`);
      files.push({
        name: file.name,
        size: file.size,
        sha256: file.sha256,
        // Streamed straight from R2 into stdin, verified on the way: a mismatch aborts the run.
        open: () => verifyingStream(lazyObjectStream(staging, file.key), file, deps.hashes, 'staging_digest_mismatch'),
      });
    }
    const agentInput = {
      repository: input.repository,
      sourceCommit: input.sourceCommit,
      releaseTag: input.releaseTag,
      signerWorkflow: input.signerWorkflow,
      files: input.files.map(({ name, sha256, size }) => ({ name, sha256, size })),
    };
    return { kind: 'run', agentInput, files, passphrase: null };
  })();
}

async function preparePlan(request: RunnerJobRequest, subject: TerraformSubject, deps: PrepareDeps): Promise<Preparation> {
  // Plans are create-only per tree. A complete stored plan for this tree is the reviewed one: report
  // it again instead of failing. Partial debris needs a human (see docs/RUNNER.md).
  const stored = await storedPlanState(deps.plans, subject.stack, subject.treeSha);
  if (stored.kind === 'complete') return { kind: 'finished', outcome: succeeded(stored.summary as unknown as Json) };
  if (stored.kind === 'incomplete') fail('plan_incomplete', `incomplete plan artifacts exist for ${subject.stack} at tree ${subject.treeSha}`);
  const source = requireSource(deps);
  await requireTree(source, subject);
  const policyCommit = await branchHead(source, POLICY_SOURCE, POLICY_SOURCE.branch);
  const code = await downloadTarball(source, subject, subject.commit, LIMITS.sourceTarballBytes);
  const policy = await downloadTarball(source, POLICY_SOURCE, policyCommit, LIMITS.policyTarballBytes);
  const passphrase = await deps.passphrase(request);
  return {
    kind: 'run',
    agentInput: {
      operation: 'plan',
      ...common(subject, deps.accountId),
      policyCommit,
      policyDirectory: POLICY_SOURCE.directory,
    },
    files: [tarFile('source.tar.gz', code), tarFile('policy.tar.gz', policy)],
    passphrase,
  };
}

async function prepareApply(request: RunnerJobRequest, subject: TerraformSubject, deps: PrepareDeps): Promise<Preparation> {
  if (await isStackLocked(deps.plans, subject.stack)) fail('stack_locked_uncertain', `stack ${subject.stack} is locked after an uncertain apply; a human must clear it`);
  const summary = await readPlanSummary(deps.plans, subject.stack, subject.treeSha);
  if (!summary) return fail('plan_missing', `no stored plan for ${subject.stack} at tree ${subject.treeSha}`);
  if (!summary.policyPassed) fail('plan_policy_failed', 'the stored plan did not pass policy');
  const plan = await digestStoredObject(deps.plans, planObjectKey(subject.stack, subject.treeSha, 'plan.tfplan'), LIMITS.planFileBytes, deps.hashes);
  if (!plan) return fail('plan_missing', 'plan.tfplan is missing');
  if (plan.sha256 !== summary.planSha256) fail('plan_digest_mismatch', 'stored plan.tfplan does not match the SHA-256 in summary.json');
  const source = requireSource(deps);
  await requireTree(source, subject);
  const code = await downloadTarball(source, subject, subject.commit, LIMITS.sourceTarballBytes);
  const passphrase = await deps.passphrase(request);
  return {
    kind: 'run',
    agentInput: {
      operation: 'apply',
      ...common(subject, deps.accountId),
      plan: { sha256: summary.planSha256, stateSerial: summary.stateSerial, stateLineage: summary.stateLineage, planJobId: summary.jobId },
      archive: {
        bucket: ARCHIVE_BUCKET,
        before: archiveKey(subject.stack, subject.treeSha, request.jobId, 'before'),
        after: archiveKey(subject.stack, subject.treeSha, request.jobId, 'after'),
      },
    },
    files: [tarFile('source.tar.gz', code)],
    passphrase,
  };
}

function common(subject: TerraformSubject, accountId: string): Record<string, Json> {
  return {
    stack: subject.stack,
    repository: subject.repository,
    commit: subject.commit,
    treeSha: subject.treeSha,
    backend: backendConfig(subject.stack, accountId),
    artifactsOrigin: `https://${ARTIFACT_HOST}`,
  };
}

/** What the agent writes into its backend config file; the gate enforces the same bucket and key. */
export function backendConfig(stack: StackName, accountId: string): { bucket: string; key: string; endpoint: string } {
  return { bucket: STATE_BUCKET, key: stateKey(stack), endpoint: `https://${r2Host(accountId)}` };
}

/** Plans bind to trees; the subject's tree must be the commit's real tree, observed independently. */
async function requireTree(source: SourceDeps, subject: TerraformSubject): Promise<void> {
  const pinned = STACKS[subject.stack];
  const tree = await commitTree(source, pinned, subject.commit);
  if (tree !== subject.treeSha) fail('tree_mismatch', `commit ${subject.commit} has tree ${tree}, not ${subject.treeSha}`);
}

function requireSource(deps: PrepareDeps): SourceDeps {
  if (deps.source === null) return fail('github_app_unconfigured', 'GITHUB_APP_ID is not configured');
  return deps.source;
}

function tarFile(name: string, bytes: ChunkedBytes): InputFile {
  return { name, size: bytes.size, sha256: bytes.sha256, open: () => streamOfChunks(bytes.chunks) };
}

/** A stream that opens the R2 object on first read, so nothing is fetched before the pump needs it. */
function lazyObjectStream(bucket: ReadBucket, key: string): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (reader === null) {
        const object = await bucket.get(key);
        if (!object) {
          controller.error(new Error('staged object disappeared'));
          return;
        }
        reader = object.body.getReader();
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}
