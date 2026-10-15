import type { Json } from '../lib/json.ts';

/**
 * The seam between the coordinator (and the Deployer entrypoint) and the container runner.
 * Both sides import only these types; the runner owns everything behind `RunnerJob`.
 */

export type RunnerJobType = 'release.verify' | 'terraform.plan' | 'terraform.apply' | 'root.plan' | 'root.apply';

export type RunnerJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';

/** Who to tell when a job reaches a terminal state. The coordinator also polls; this is a nudge. */
export interface RunnerNotify {
  application: string;
  environment: string;
  deploymentId: string;
}

export interface RunnerJobRequest {
  /** UUIDv7 chosen by the caller and persisted before submission, so a resubmit is idempotent. */
  jobId: string;
  type: RunnerJobType;
  /** Epoch seconds. The watchdog destroys the container at this time. */
  deadlineAt: number;
  input: Json;
  notify: RunnerNotify | null;
}

export interface RunnerJobStatus {
  jobId: string;
  type: RunnerJobType;
  state: RunnerJobState;
  /** The container's single result document, present only when `state` is `succeeded`. */
  result: Json | null;
  error: { code: string; message: string } | null;
  /** Key in the `runner-logs` bucket holding stderr, once any was captured. */
  logKey: string | null;
  submittedAt: string;
  finishedAt: string | null;
}

/** Input for `release.verify`. Files are read from the `release-staging` bucket by key. */
export interface ReleaseVerifyInput {
  repository: string;
  sourceCommit: string;
  releaseTag: string;
  /** `owner/repo/.github/workflows/file.yml` of the workflow that must have signed the attestation. */
  signerWorkflow: string;
  files: Array<{ name: 'release.zip' | 'release.manifest.json' | 'attestation.sigstore.json'; key: string; sha256: string; size: number }>;
}

/** Result document of a successful `release.verify`. */
export interface ReleaseVerifyResult {
  verified: true;
  /** Every artifact that was checked against the attestation, by name and digest. */
  subjects: Array<{ name: string; sha256: string }>;
  signerWorkflow: string;
  sourceRepository: string;
  sourceDigest: string;
  sourceRef: string;
  verifier: string;
}

/** RPC surface of the `RunnerJob` Durable Object (one object per jobId, `idFromName(jobId)`). */
export interface RunnerJobRpc {
  submit(request: RunnerJobRequest): Promise<RunnerJobStatus>;
  status(): Promise<RunnerJobStatus | null>;
}

/** RPC the runner calls on the coordinator when a job with `notify` becomes terminal. */
export interface CoordinatorRunnerCallback {
  runnerJobFinished(input: { deploymentId: string; jobId: string }): Promise<void>;
}
