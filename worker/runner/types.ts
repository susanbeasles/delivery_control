import type { Json } from '../lib/json.ts';
import type { RunnerJobRequest } from './api.ts';

/**
 * The Durable Object's record of one job. `phase` is internal progress; the public state derives
 * from it. `outcome` is decided once (first writer wins) and never changes; the job only becomes
 * terminal after the container is confirmed destroyed.
 *
 *   queued ─▶ preparing ─▶ starting ─▶ running ─▶ cleanup ─▶ done
 *                 │            │           │          ▲
 *                 └────────────┴───────────┴──────────┘  (outcome decided: refusal, watchdog, exit)
 */
export type Phase = 'queued' | 'preparing' | 'starting' | 'running' | 'cleanup' | 'done';

export type OutcomeState = 'succeeded' | 'failed' | 'uncertain';

export interface JobError {
  code: string;
  message: string;
}

export interface Outcome {
  state: OutcomeState;
  result: Json | null;
  error: JobError | null;
}

export interface JobRecord {
  schema: 'runner-job-record/v1';
  request: RunnerJobRequest;
  /** SHA-256 of the canonical request; a resubmit must match it exactly. */
  requestDigest: string;
  phase: Phase;
  outcome: Outcome | null;
  submittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  logKey: string | null;
  prepareAttempts: number;
  cleanupAttempts: number;
  /** Uncertain apply: the create-only stack lock has been written (or already existed). */
  stackLocked: boolean;
  /** Post-terminal side effects run at most once; the flags are set before each attempt. */
  reported: boolean;
  notified: boolean;
}

export function succeeded(result: Json): Outcome {
  return { state: 'succeeded', result, error: null };
}

export function failed(code: string, message: string): Outcome {
  return { state: 'failed', result: null, error: { code, message } };
}

/** For mutating jobs an unknown ending is `uncertain`; for read-only jobs it is simply `failed`. */
export function unknownEnding(mutating: boolean, code: string, message: string): Outcome {
  return { state: mutating ? 'uncertain' : 'failed', result: null, error: { code, message } };
}
