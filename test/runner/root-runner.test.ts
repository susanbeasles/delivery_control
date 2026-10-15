import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootJobStatus, rootRunJob, type ConsumeResult, type RootDeps } from '../../worker/runner/root.ts';
import { ensureGeneratedSecrets, ensureSecret, type SecretsStoreDeps } from '../../worker/runner/secrets-generate.ts';
import { getRunnerJobStatus, submitTerraformJob } from '../../worker/runner/index.ts';
import type { RunnerJobRequest } from '../../worker/runner/api.ts';
import { ACCOUNT, JOB_ID, NOW_MS, subject } from './builders.ts';
import { FakeClock, fixedRandom, sha256 } from './fakes.ts';

const TOKEN = 'A'.repeat(43);
const STORE = 'b6504fe2d5f64352954629bc7185fb79';

function namespace() {
  const submitted: RunnerJobRequest[] = [];
  const names: string[] = [];
  return {
    submitted,
    names,
    RUNNER: {
      getByName(name: string) {
        names.push(name);
        return {
          submit: async (request: RunnerJobRequest) => {
            submitted.push(request);
            return { jobId: request.jobId, type: request.type, state: 'queued', result: null, error: null, logKey: null, submittedAt: '', finishedAt: null };
          },
          status: async () => null,
        };
      },
    },
  };
}

function secretsStore(existing: string[] = []) {
  const calls: Array<{ method: string; url: string; body: string | null; authorization: string | null }> = [];
  const names = new Set(existing);
  const deps: SecretsStoreDeps = {
    accountId: ACCOUNT,
    storeId: STORE,
    token: async () => 'cfSecretsWriteTokenValue0123456789abcdef',
    random: fixedRandom,
    fetcher: async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : null;
      calls.push({ method: init?.method ?? 'GET', url, body, authorization: new Headers(init?.headers).get('authorization') });
      if ((init?.method ?? 'GET') === 'GET') {
        const search = new URL(url).searchParams.get('search') ?? '';
        // Substring search, as the API does: exact-name matching is the client's job.
        const result = [...names].filter((n) => n.includes(search)).map((name) => ({ id: sha256(name).slice(0, 32), name }));
        return Response.json({ success: true, result });
      }
      for (const item of JSON.parse(body ?? '[]')) names.add(item.name);
      return Response.json({ success: true, result: [] });
    },
  };
  return { deps, calls, names };
}

function root(consume: (input: { tokenHash: string; action: string; subject: unknown }) => Promise<ConsumeResult>, secrets: SecretsStoreDeps | null = null) {
  const ns = namespace();
  const consumed: Array<{ tokenHash: string; action: string; subject: unknown }> = [];
  const deps: RootDeps = {
    authorizer: {
      consume: async (input) => {
        consumed.push(input);
        return consume(input);
      },
    },
    runner: ns,
    secrets,
    clock: new FakeClock(NOW_MS),
  };
  return { deps, ns, consumed };
}

const granted = (action: string) => async (): Promise<ConsumeResult> => ({ ok: true, grant: { action, subjectDigest: 'x', sub: 's', jti: 'j', expiresAt: 0 } });

test('root runner consumes a root grant, then submits a root job for infra-root', async () => {
  const r = root(granted('root.apply'));
  const s = subject('apply', 'infra-root');
  const status = await rootRunJob(r.deps, { token: TOKEN, job: { type: 'terraform.apply', subject: s } });
  assert.equal('state' in status && status.state, 'queued');
  assert.deepEqual(r.consumed, [{ tokenHash: sha256(TOKEN), action: 'root.apply', subject: s }]);
  assert.equal(r.ns.submitted[0]?.type, 'root.apply');
  assert.deepEqual(r.ns.submitted[0]?.input, s);
  assert.equal(r.ns.names[0], r.ns.submitted[0]?.jobId, 'one object per job, addressed by jobId');
  assert.equal(r.ns.submitted[0]?.notify, null);
});

test('root runner refuses before consuming when the request is malformed or for another stack', async () => {
  const r = root(granted('root.plan'));
  assert.deepEqual(await rootRunJob(r.deps, { token: TOKEN, job: { type: 'terraform.plan', subject: subject('plan', 'infra') } }), { state: 'rejected', error: 'invalid_terraform_subject' });
  assert.deepEqual(await rootRunJob(r.deps, { token: TOKEN, job: { type: 'terraform.plan', subject: subject('apply', 'infra-root') } }), { state: 'rejected', error: 'invalid_terraform_subject' });
  assert.deepEqual(await rootRunJob(r.deps, { token: 'short', job: { type: 'terraform.plan', subject: subject('plan', 'infra-root') } }), { state: 'rejected', error: 'grant_malformed' });
  assert.deepEqual(await rootRunJob(r.deps, { token: TOKEN, job: { type: 'root.plan', subject: subject('plan', 'infra-root') } }), { state: 'rejected', error: 'bad_job_type' });
  assert.equal(r.consumed.length, 0);
  assert.equal(r.ns.submitted.length, 0);
});

test('root runner submits nothing unless the grant is ok and for the same action', async () => {
  for (const [consume, error] of [
    [async (): Promise<ConsumeResult> => ({ ok: false, error: 'replay' }), 'grant_replay'],
    [async (): Promise<ConsumeResult> => ({ ok: false, error: 'mismatch' }), 'grant_mismatch'],
    [granted('root.plan'), 'grant_mismatch'],
  ] as const) {
    const r = root(consume);
    assert.deepEqual(await rootRunJob(r.deps, { token: TOKEN, job: { type: 'terraform.apply', subject: subject('apply', 'infra-root') } }), { state: 'rejected', error });
    assert.equal(r.ns.submitted.length, 0);
  }
  assert.equal(await rootJobStatus({ runner: namespace() }, { jobId: 'nope' }), null);
});

test('secrets.generate runs before a granted root job: create-only, values never returned', async () => {
  const store = secretsStore(['TF_ENCRYPTION_INFRA']);
  const r = root(granted('root.plan'), store.deps);
  const status = await rootRunJob(r.deps, { token: TOKEN, job: { type: 'terraform.plan', subject: subject('plan', 'infra-root') } });
  assert.equal('state' in status && status.state, 'queued');
  const posts = store.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  const created = JSON.parse(posts[0]?.body ?? '[]');
  assert.equal(created[0].name, 'TF_ENCRYPTION_ROOT');
  assert.match(created[0].value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(posts[0]?.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/secrets_store/stores/${STORE}/secrets`);
  assert.equal(JSON.stringify(status).includes(created[0].value), false);

  // Second run: both exist, nothing is written (never overwritten).
  const again = await ensureGeneratedSecrets(store.deps);
  assert.deepEqual(again, [{ name: 'TF_ENCRYPTION_ROOT', outcome: 'exists' }, { name: 'TF_ENCRYPTION_INFRA', outcome: 'exists' }]);
  assert.equal(store.calls.filter((c) => c.method === 'POST').length, 1);
  await assert.rejects(ensureSecret(store.deps, 'CF_APPLY' as never), { code: 'secret_not_generatable' });

  // A similarly named secret does not count as the real one (search is a substring filter).
  const similar = secretsStore(['TF_ENCRYPTION_ROOT_OLD']);
  assert.deepEqual(await ensureSecret(similar.deps, 'TF_ENCRYPTION_ROOT'), { name: 'TF_ENCRYPTION_ROOT', outcome: 'created' });
});

test('deployer helpers: subject must be infra and match the consumed action', async () => {
  const ns = namespace();
  const clock = new FakeClock(NOW_MS);
  const status = await submitTerraformJob(ns, subject('plan'), 'infra.plan', { clock });
  assert.equal(status.state, 'queued');
  assert.equal(ns.submitted[0]?.type, 'terraform.plan');
  assert.equal(ns.submitted[0]?.deadlineAt, NOW_MS / 1000 + 30 * 60);
  await assert.rejects(submitTerraformJob(ns, subject('plan'), 'infra.apply', { clock }), { code: 'invalid_terraform_subject' });
  await assert.rejects(submitTerraformJob(ns, subject('apply', 'infra-root'), 'infra.apply', { clock }), { code: 'invalid_terraform_subject' });
  assert.equal(ns.submitted.length, 1);
  assert.equal(await getRunnerJobStatus(ns, JOB_ID), null);
  await assert.rejects(getRunnerJobStatus(ns, 'not-a-uuid'), { code: 'invalid_job_id' });
});
