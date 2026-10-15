import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqlJobStore, type SqlLike, type SqlValue } from '../src/sql-store.ts';
import type { JobRecord, Outcome } from '../src/records.ts';
import { JOB_ID, KEY } from './helpers.ts';

/** `node:sqlite` with the shape of the Durable Object SqlStorage.exec(). */
function sqlite(): SqlLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
      if (bindings.length === 0 && !/^\s*SELECT/i.test(query)) {
        db.exec(query);
        return { toArray: () => [] as T[] };
      }
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) return { toArray: () => statement.all(...(bindings as (string | number | null)[])) as unknown as T[] };
      statement.run(...(bindings as (string | number | null)[]));
      return { toArray: () => [] as T[] };
    },
  };
}

const running: JobRecord = { job_id: JOB_ID, job_type: 'terraform.plan', idempotency_key: KEY, envelope_digest: 'd'.repeat(64), state: 'running', attempt: 1, started_at: 1_000, deadline_at: 91_000, outcome: null };
const outcome: Outcome = { v: 1, job_id: JOB_ID, job_type: 'terraform.plan', idempotency_key: KEY, attempt: 1, status: 'succeeded', reason: 'exit_zero', exit_code: 0, started_at: '2026-10-15T12:00:00.000Z', finished_at: '2026-10-15T12:00:05.000Z', duration_ms: 5_000, logs: { stdout: { key: 'k', bytes: 3, truncated: false }, stderr: null }, artifacts: [{ path: 'plan.json', key: 'a', bytes: 7, sha256: 'f'.repeat(64) }], notes: [] };

test('records round-trip through SQLite, including the outcome', () => {
  const store = new SqlJobStore(sqlite());
  assert.equal(store.get(), undefined);
  store.put(running);
  assert.deepEqual(store.get(), running);
  store.put({ ...running, state: 'done', outcome });
  const read = store.get();
  assert.equal(read?.state, 'done');
  assert.deepEqual(read?.outcome, outcome);
});

test('the schema is idempotent and a store owns exactly one job', () => {
  const sql = sqlite();
  const first = new SqlJobStore(sql);
  first.put(running);
  const second = new SqlJobStore(sql);
  assert.deepEqual(second.get(), running);
  assert.throws(() => second.put({ ...running, job_id: '00000000-0000-4000-8000-000000000000' }), /different job/);
  assert.throws(() => sql.exec("INSERT INTO job VALUES ('x','t','k','d','weird',1,1,1,NULL)"), /CHECK/);
});
