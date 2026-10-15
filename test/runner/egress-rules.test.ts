import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, redirectAllowed, rulesFor, type EgressContext } from '../../worker/runner/egress/rules.ts';
import { JOB_PROFILES } from '../../worker/runner/profiles.ts';
import type { RunnerJobType } from '../../worker/runner/api.ts';
import { ACCOUNT, JOB_ID, TREE } from './builders.ts';

const R2 = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const ART = 'https://artifacts.runner.internal';

function ctx(type: RunnerJobType): EgressContext {
  const stack = JOB_PROFILES[type].stack;
  return { jobId: JOB_ID, type, stack, treeSha: stack ? TREE : null, accountId: ACCOUNT };
}

type Row = [method: string, url: string, expected: string | null];

/** `expected` is the allowing rule's name, or null for a denial. */
function check(type: RunnerJobType, rows: Row[]): void {
  for (const [method, url, expected] of rows) {
    const d = decide(ctx(type), method, new URL(url));
    assert.equal(d.allow ? d.rule.name : null, expected, `${type} ${method} ${url}`);
  }
}

const archive = (stack: string, phase: string, jobId = JOB_ID, tree = TREE) => `${R2}/tf-state-archive/${stack}/${tree}/${jobId}/${phase}.tfstate`;

test('release.verify has no egress at all', () => {
  assert.deepEqual(rulesFor(ctx('release.verify')), []);
  check('release.verify', [
    ['GET', 'https://api.cloudflare.com/client/v4/user/tokens/verify', null],
    ['GET', 'https://api.github.com/repos/a/b', null],
    ['GET', 'https://tuf-repo-cdn.sigstore.dev/root.json', null],
    ['GET', `${R2}/tf-state/infra/terraform.tfstate`, null],
    ['PUT', `${ART}/plan.json`, null],
  ]);
});

test('terraform.plan: read-only API, read-only state, plan artifacts', () => {
  check('terraform.plan', [
    ['GET', 'https://api.cloudflare.com/client/v4/zones?name=susanb.dev', 'cloudflare-api'],
    ['HEAD', 'https://api.cloudflare.com/client/v4/accounts/x', 'cloudflare-api'],
    ['POST', 'https://api.cloudflare.com/client/v4/zones', null],
    ['DELETE', 'https://api.cloudflare.com/client/v4/zones/x', null],
    ['GET', 'https://api.cloudflare.com/other/path', null],
    ['GET', 'https://api.cloudflare.com/client/v4/%2e%2e/x', null],
    ['GET', `${R2}/tf-state/infra/terraform.tfstate`, 'state-read'],
    ['GET', `${R2}/tf-state/infra/terraform.tfstate?x-id=GetObject`, 'state-read'],
    ['HEAD', `${R2}/tf-state/infra/terraform.tfstate`, 'state-read'],
    ['PUT', `${R2}/tf-state/infra/terraform.tfstate`, null],
    ['PUT', `${R2}/tf-state/infra/terraform.tfstate.tflock`, null],
    ['DELETE', `${R2}/tf-state/infra/terraform.tfstate.tflock`, null],
    ['GET', `${R2}/tf-state?list-type=2&prefix=env%3A%2F&max-keys=1000`, 'state-workspaces'],
    ['GET', `${R2}/tf-state/?list-type=2&prefix=env:/`, 'state-workspaces'],
    ['GET', `${R2}/tf-state?list-type=2&prefix=infra%2F`, null],
    ['GET', `${R2}/tf-state?list-type=2`, null],
    ['GET', `${R2}/tf-state/infra-root/terraform.tfstate`, null],
    ['GET', `${R2}/tf-state/infra/other.tfstate`, null],
    ['GET', `${R2}/tf-plans/infra/${TREE}/plan.tfplan`, null],
    ['GET', `${R2}/tf-state/infra/terraform.tfstate?versionId=1`, null],
    ['GET', `${R2}/tf-state/infra%2Fterraform.tfstate`, null],
    ['GET', `https://tf-state.${ACCOUNT}.r2.cloudflarestorage.com/infra/terraform.tfstate`, null],
    ['GET', `https://${'0'.repeat(32)}.r2.cloudflarestorage.com/tf-state/infra/terraform.tfstate`, null],
    ['PUT', archive('infra', 'before'), null],
    ['PUT', `${ART}/plan.tfplan`, 'artifact-put:plan.tfplan'],
    ['PUT', `${ART}/plan.json`, 'artifact-put:plan.json'],
    ['PUT', `${ART}/summary.json`, 'artifact-put:summary.json'],
    ['PUT', `${ART}/state.tfstate`, null],
    ['PUT', `${ART}/plan.json?x=1`, null],
    ['GET', `${ART}/plan.tfplan`, null],
    ['GET', 'http://api.cloudflare.com/client/v4/zones', null],
    ['GET', 'https://api.cloudflare.com:8443/client/v4/zones', null],
    ['GET', 'https://user:pw@api.cloudflare.com/client/v4/zones', null],
    ['GET', 'https://registry.opentofu.org/v1/providers/cloudflare/cloudflare/versions', null],
    ['GET', 'https://github.com/opentofu/opentofu', null],
  ]);
});

test('terraform.apply: full API, read-write state and lock, create-only archive, plan download', () => {
  check('terraform.apply', [
    ['POST', 'https://api.cloudflare.com/client/v4/zones/z/dns_records', 'cloudflare-api'],
    ['PATCH', 'https://api.cloudflare.com/client/v4/zones/z/dns_records/r', 'cloudflare-api'],
    ['DELETE', 'https://api.cloudflare.com/client/v4/zones/z/dns_records/r', 'cloudflare-api'],
    ['GET', `${R2}/tf-state/infra/terraform.tfstate`, 'state-write'],
    ['PUT', `${R2}/tf-state/infra/terraform.tfstate?x-id=PutObject`, 'state-write'],
    ['DELETE', `${R2}/tf-state/infra/terraform.tfstate`, null],
    ['PUT', `${R2}/tf-state/infra/terraform.tfstate.tflock`, 'state-lock'],
    ['DELETE', `${R2}/tf-state/infra/terraform.tfstate.tflock?x-id=DeleteObject`, 'state-lock'],
    ['PUT', archive('infra', 'before'), 'state-archive'],
    ['PUT', archive('infra', 'after'), 'state-archive'],
    ['GET', archive('infra', 'before'), null],
    ['PUT', archive('infra', 'during'), null],
    ['PUT', archive('infra', 'before', '0199e7a0-0000-7000-8000-000000000099'), null],
    ['PUT', archive('infra', 'before', JOB_ID, 'f'.repeat(40)), null],
    ['PUT', `${R2}/tf-state-archive/infra/terraform.tfstate`, null],
    ['GET', `${ART}/plan.tfplan`, 'artifact-get:plan.tfplan'],
    ['GET', `${ART}/plan.json`, null],
    ['PUT', `${ART}/plan.tfplan`, null],
    ['PUT', `${R2}/tf-state/infra-root/terraform.tfstate`, null],
  ]);
});

test('root jobs are bound to the infra-root stack', () => {
  check('root.plan', [
    ['GET', `${R2}/tf-state/infra-root/terraform.tfstate`, 'state-read'],
    ['GET', `${R2}/tf-state/infra/terraform.tfstate`, null],
    ['POST', 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets', null],
    ['PUT', `${ART}/summary.json`, 'artifact-put:summary.json'],
  ]);
  check('root.apply', [
    ['PUT', `${R2}/tf-state/infra-root/terraform.tfstate`, 'state-write'],
    ['PUT', `${R2}/tf-state/infra/terraform.tfstate`, null],
    ['PUT', archive('infra-root', 'after'), 'state-archive'],
    ['PUT', archive('infra', 'after'), null],
    ['POST', 'https://api.cloudflare.com/client/v4/accounts/a/r2/buckets', 'cloudflare-api'],
  ]);
});

test('redirects are passed back only to targets the same job may reach', () => {
  const base = new URL('https://api.cloudflare.com/client/v4/zones');
  const plan = ctx('terraform.plan');
  assert.equal(redirectAllowed(plan, 'GET', 302, 'https://api.cloudflare.com/client/v4/zones?page=2', base), true);
  assert.equal(redirectAllowed(plan, 'GET', 302, '/client/v4/zones?page=2', base), true);
  assert.equal(redirectAllowed(plan, 'GET', 302, 'https://evil.example/collect', base), false);
  assert.equal(redirectAllowed(plan, 'GET', 302, 'https://dash.cloudflare.com/login', base), false);
  assert.equal(redirectAllowed(plan, 'GET', 302, null, base), false);
  assert.equal(redirectAllowed(plan, 'GET', 302, 'https://artifacts.runner.internal/plan.json', base), false);
  // 307 keeps the method: a POST redirect is judged as a POST, which plan jobs may not send.
  assert.equal(redirectAllowed(plan, 'POST', 307, 'https://api.cloudflare.com/client/v4/zones', base), false);
  assert.equal(redirectAllowed(ctx('terraform.apply'), 'POST', 307, 'https://api.cloudflare.com/client/v4/zones', base), true);
});

test('credential custody table: each job type gets exactly its own credentials', () => {
  const table = Object.fromEntries(
    Object.values(JOB_PROFILES).map((p) => [p.type, [p.role, p.mutating, p.stack, p.cloudflare?.secret ?? null, p.state?.secret ?? null, p.state?.access ?? null, p.passphrase]]),
  );
  assert.deepEqual(table, {
    'release.verify': ['deployer', false, null, null, null, null, null],
    'terraform.plan': ['deployer', false, 'infra', 'CF_PLAN', 'R2_STATE_RO', 'read', 'TF_ENCRYPTION_INFRA'],
    'terraform.apply': ['deployer', true, 'infra', 'CF_APPLY', 'R2_STATE_RW', 'write', 'TF_ENCRYPTION_INFRA'],
    'root.plan': ['root', false, 'infra-root', 'CF_ROOT_PLAN', 'R2_STATE_ROOT', 'read', 'TF_ENCRYPTION_ROOT'],
    'root.apply': ['root', true, 'infra-root', 'CF_ROOT_APPLY', 'R2_STATE_ROOT', 'write', 'TF_ENCRYPTION_ROOT'],
  });
  assert.deepEqual([...(JOB_PROFILES['terraform.plan'].cloudflare?.methods ?? [])], ['GET', 'HEAD']);
});
