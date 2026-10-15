// Persisted shapes: the job record the controller keeps in SQLite, the outcome it publishes, and the result of a run call.
import type { EnvelopeErrorCode } from './envelope.ts';

export type OutcomeStatus = 'succeeded' | 'failed' | 'uncertain';

/**
 * Why a job ended. `succeeded` and `failed` are certain: the job reported. `uncertain` means the controller cannot
 * say whether the job's side effects happened; such outcomes are kept for a human and never retried by the runner.
 */
export type OutcomeReason =
  | 'exit_zero' // succeeded
  | 'exit_nonzero' // failed
  | 'timeout' // failed: killed at the job type's hard timeout
  | 'start_failed' // failed: nothing ran (secret resolution, image lookup, container start or exec refused)
  | 'container_exited' // uncertain: the container went away before the job reported
  | 'controller_error' // uncertain: the controller hit an error after the job had started
  | 'watchdog'; // uncertain: the controller that started the job never finished it; the watchdog settled it

export interface LogRef {
  readonly key: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface Outcome {
  readonly v: 1;
  readonly job_id: string;
  readonly job_type: string;
  readonly idempotency_key: string;
  readonly attempt: number;
  readonly status: OutcomeStatus;
  readonly reason: OutcomeReason;
  readonly exit_code: number | null;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly logs: { readonly stdout: LogRef | null; readonly stderr: LogRef | null };
  readonly notes: readonly string[];
}

export interface JobRecord {
  readonly job_id: string;
  readonly job_type: string;
  readonly idempotency_key: string;
  readonly envelope_digest: string;
  readonly state: 'running' | 'done';
  readonly attempt: number;
  /** ms since epoch */
  readonly started_at: number;
  /** ms since epoch: timeout plus grace. A running record past this point is lost and is settled as uncertain. */
  readonly deadline_at: number;
  readonly outcome: Outcome | null;
}

export type RunResult =
  | { readonly kind: 'done'; readonly outcome: Outcome }
  | { readonly kind: 'running'; readonly job_id: string; readonly deadline_at: number }
  | { readonly kind: 'rejected'; readonly code: EnvelopeErrorCode | 'envelope_mismatch' };
