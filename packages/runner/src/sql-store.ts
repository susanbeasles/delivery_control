// Job record persistence on the Durable Object's SQLite storage. One row: the job this object owns.
import type { JobStore } from './ports.ts';
import type { JobRecord, Outcome } from './records.ts';

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlCursorLike<T> {
  toArray(): T[];
}

/** Structural subset of the Durable Object `SqlStorage` interface; a `node:sqlite` adapter satisfies it in tests. */
export interface SqlLike {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursorLike<T>;
}

interface JobRow extends Record<string, SqlValue> {
  job_id: string;
  job_type: string;
  idempotency_key: string;
  envelope_digest: string;
  state: string;
  attempt: number;
  started_at: number;
  deadline_at: number;
  outcome: string | null;
}

export const JOB_SCHEMA = `CREATE TABLE IF NOT EXISTS job (
  job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  outcome TEXT
)`;

function toRecord(row: JobRow): JobRecord {
  if (row.state !== 'running' && row.state !== 'done') throw new Error(`corrupt job row: state ${row.state}`);
  return {
    job_id: row.job_id,
    job_type: row.job_type,
    idempotency_key: row.idempotency_key,
    envelope_digest: row.envelope_digest,
    state: row.state,
    attempt: row.attempt,
    started_at: row.started_at,
    deadline_at: row.deadline_at,
    outcome: row.outcome === null ? null : (JSON.parse(row.outcome) as Outcome),
  };
}

export class SqlJobStore implements JobStore {
  readonly #sql: SqlLike;
  constructor(sql: SqlLike) {
    this.#sql = sql;
    this.#sql.exec(JOB_SCHEMA);
  }
  get(): JobRecord | undefined {
    const rows = this.#sql.exec<JobRow>('SELECT * FROM job ORDER BY started_at DESC LIMIT 2').toArray();
    if (rows.length > 1) throw new Error('corrupt job store: more than one job');
    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }
  put(record: JobRecord): void {
    const existing = this.get();
    if (existing !== undefined && existing.job_id !== record.job_id) throw new Error('job store already owns a different job');
    this.#sql.exec(
      `INSERT INTO job (job_id, job_type, idempotency_key, envelope_digest, state, attempt, started_at, deadline_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET state = excluded.state, attempt = excluded.attempt, deadline_at = excluded.deadline_at, outcome = excluded.outcome`,
      record.job_id,
      record.job_type,
      record.idempotency_key,
      record.envelope_digest,
      record.state,
      record.attempt,
      record.started_at,
      record.deadline_at,
      record.outcome === null ? null : JSON.stringify(record.outcome),
    );
  }
}
