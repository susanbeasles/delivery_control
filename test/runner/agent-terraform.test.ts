import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSITIVE,
  backendConfigFile,
  checkApplyBinding,
  checkConfigurationText,
  checkEncryption,
  PINNED_ENCRYPTION,
  checkInitializedBackend,
  countChanges,
  encryptionConfig,
  parseStatePull,
  redactPlan,
  sameState,
  validateApplyInput,
  validatePlanInput,
} from '../../container/agent/plan.mjs';
import { parseConftestOutput } from '../../container/agent/policy.mjs';
import { backendConfig } from '../../worker/runner/prepare.ts';
import { ACCOUNT, COMMIT, JOB_ID, PASSPHRASE, POLICY_COMMIT, TREE } from './builders.ts';

const backend = backendConfig('infra', ACCOUNT);
const LINEAGE = '3f2a1c6e-1111-2222-3333-444455556666';

function applyInput(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'apply',
    stack: 'infra',
    repository: 'susanbeasles/infra',
    commit: COMMIT,
    treeSha: TREE,
    backend,
    artifactsOrigin: 'https://artifacts.runner.internal',
    plan: { sha256: 'a'.repeat(64), stateSerial: 7, stateLineage: LINEAGE, planJobId: JOB_ID },
    archive: { bucket: 'tf-state-archive', before: `infra/${TREE}/${JOB_ID}/before.tfstate`, after: `infra/${TREE}/${JOB_ID}/after.tfstate` },
    ...overrides,
  };
}

test('change counts follow the Terraform convention (replace = add + destroy)', () => {
  const plan = {
    resource_changes: [
      { change: { actions: ['create'] } },
      { change: { actions: ['update'] } },
      { change: { actions: ['delete'] } },
      { change: { actions: ['delete', 'create'] } },
      { change: { actions: ['create', 'delete'] } },
      { change: { actions: ['no-op'] } },
      { change: { actions: ['read'] } },
    ],
  };
  assert.deepEqual(countChanges(plan), { addCount: 3, changeCount: 1, destroyCount: 3 });
  assert.deepEqual(countChanges({}), { addCount: 0, changeCount: 0, destroyCount: 0 });
});

test('plan JSON redaction removes every value marked sensitive', () => {
  const plan = {
    format_version: '1.2',
    variables: { token: { value: 'secret-var' }, region: { value: 'auto' } },
    configuration: { root_module: { variables: { token: { sensitive: true }, region: {} } } },
    resource_changes: [
      {
        address: 'cloudflare_zero_trust_access_service_token.ci',
        change: {
          actions: ['create'],
          before: null,
          after: { name: 'ci', client_secret: 'very-secret', nested: [{ k: 'v', s: 'nested-secret' }] },
          after_sensitive: { client_secret: true, nested: [{ s: true }] },
          before_sensitive: false,
        },
      },
    ],
    planned_values: {
      outputs: { secret: { sensitive: true, value: 'out-secret' }, plain: { sensitive: false, value: 'ok' } },
      root_module: {
        resources: [{ address: 'x', values: { password: 'pv-secret', name: 'n' }, sensitive_values: { password: true } }],
        child_modules: [{ resources: [{ values: { key: 'child-secret' }, sensitive_values: { key: true } }] }],
      },
    },
    prior_state: { values: { root_module: { resources: [{ values: { password: 'prior-secret' }, sensitive_values: { password: true } }] } } },
    output_changes: { secret: { before: 'old-out', after: 'new-out', before_sensitive: true, after_sensitive: true } },
  };
  const redacted = JSON.stringify(redactPlan(plan));
  for (const leaked of ['secret-var', 'very-secret', 'nested-secret', 'out-secret', 'pv-secret', 'child-secret', 'prior-secret', 'old-out', 'new-out']) {
    assert.equal(redacted.includes(leaked), false, leaked);
  }
  for (const kept of ['"auto"', '"name":"ci"', '"k":"v"', '"value":"ok"', SENSITIVE]) assert.ok(redacted.includes(kept), kept);
  assert.deepEqual(countChanges(JSON.parse(redacted)), countChanges(plan));
});

test('state pull parsing: empty means no state; serial and lineage required otherwise', () => {
  assert.equal(parseStatePull(''), null);
  assert.equal(parseStatePull('  \n'), null);
  assert.deepEqual(parseStatePull(JSON.stringify({ version: 4, serial: 7, lineage: LINEAGE, resources: [] })), { serial: 7, lineage: LINEAGE });
  assert.throws(() => parseStatePull('{"serial":"7"}'), { code: 'state_unreadable' });
  assert.throws(() => parseStatePull('not json'), { code: 'state_unreadable' });
  assert.equal(sameState(null, null), true);
  assert.equal(sameState({ serial: 1, lineage: 'a' }, { serial: 2, lineage: 'a' }), false);
});

test('apply binding refuses a different plan, a changed serial or lineage, and state appearing or vanishing', () => {
  const expected = { sha256: 'a'.repeat(64), stateSerial: 7, stateLineage: LINEAGE };
  const ok = { expected, planSha256: 'a'.repeat(64), current: { serial: 7, lineage: LINEAGE } };
  assert.doesNotThrow(() => checkApplyBinding(ok));
  assert.throws(() => checkApplyBinding({ ...ok, planSha256: 'b'.repeat(64) }), { code: 'plan_digest_mismatch' });
  assert.throws(() => checkApplyBinding({ ...ok, current: { serial: 8, lineage: LINEAGE } }), { code: 'state_serial_changed' });
  assert.throws(() => checkApplyBinding({ ...ok, current: { serial: 7, lineage: 'other-lineage' } }), { code: 'state_lineage_changed' });
  assert.throws(() => checkApplyBinding({ ...ok, current: null }), { code: 'state_changed' });
  const first = { sha256: 'a'.repeat(64), stateSerial: null, stateLineage: null };
  assert.doesNotThrow(() => checkApplyBinding({ expected: first, planSha256: 'a'.repeat(64), current: null }));
  assert.throws(() => checkApplyBinding({ expected: first, planSha256: 'a'.repeat(64), current: { serial: 1, lineage: LINEAGE } }), { code: 'state_changed' });
});

test('inputs are bound to the stack backend, the tree and this job id', () => {
  assert.doesNotThrow(() => validateApplyInput(applyInput(), JOB_ID));
  assert.throws(() => validateApplyInput(applyInput({ backend: { ...backend, key: 'infra-root/terraform.tfstate' } }), JOB_ID), { code: 'input_invalid' });
  assert.throws(() => validateApplyInput(applyInput({ backend: { ...backend, endpoint: 'https://evil.example' } }), JOB_ID), { code: 'input_invalid' });
  assert.throws(() => validateApplyInput(applyInput(), '0199e7a0-0000-7000-8000-000000000099'), { code: 'input_invalid' });
  assert.throws(() => validateApplyInput({ ...applyInput(), extra: 1 }, JOB_ID), { code: 'input_invalid' });
  const planInput = { ...applyInput(), operation: 'plan', policyCommit: POLICY_COMMIT, policyDirectory: 'policy' } as Record<string, unknown>;
  delete planInput['plan'];
  delete planInput['archive'];
  assert.doesNotThrow(() => validatePlanInput(planInput));
  assert.throws(() => validatePlanInput({ ...planInput, policyDirectory: '../x' }), { code: 'input_invalid' });
});

test('backend and encryption configuration', () => {
  const file = backendConfigFile(backend);
  assert.match(file, /^bucket = "tf-state"$/m);
  assert.match(file, /^key = "infra\/terraform.tfstate"$/m);
  assert.match(file, /^use_path_style = true$/m);
  assert.match(file, /^skip_s3_checksum = true$/m);
  assert.match(file, /^access_key = "signed-by-egress-gate"$/m);
  // Only the key provider is injected, under the name the pinned encryption.tf and day-zero use.
  const enc = encryptionConfig(PASSPHRASE);
  assert.match(enc, /^key_provider "pbkdf2" "state" \{$/m);
  assert.doesNotMatch(enc, /method|enforced|^state|^plan/m);
  assert.ok(PINNED_ENCRYPTION.includes('keys=key_provider.pbkdf2.state'));
  assert.throws(() => encryptionConfig('short'), { code: 'passphrase_invalid' });
  assert.throws(() => encryptionConfig('a"; } evil { x = "' + 'a'.repeat(40)), { code: 'passphrase_invalid' });
  assert.throws(() => encryptionConfig(null), { code: 'passphrase_invalid' });
});

test('the initialized backend must be our s3 bucket and key', () => {
  const s3 = JSON.stringify({ version: 3, backend: { type: 's3', config: { bucket: 'tf-state', key: 'infra/terraform.tfstate' } } });
  assert.doesNotThrow(() => checkInitializedBackend(s3, backend));
  assert.throws(() => checkInitializedBackend(JSON.stringify({ backend: { type: 'local', config: {} } }), backend), { code: 'backend_mismatch' });
  assert.throws(() => checkInitializedBackend(s3.replace('infra/terraform', 'other/terraform'), backend), { code: 'backend_mismatch' });
});

test('conftest results: per-rule entries, worst result wins, passes aggregated', () => {
  const output = JSON.stringify([
    {
      filename: 'policy-input.json',
      namespace: 'p1',
      successes: 10,
      failures: [{ msg: 'P1: plan deletes protected bucket releases' }, { msg: 'P1: plan replaces tf-state' }, { msg: 'unnamed failure' }],
      warnings: [{ msg: 'P2: three deletes', metadata: { details: { rule: 'P2' } } }],
      exceptions: [{ msg: 'P10: excused' }],
    },
  ]);
  const parsed = parseConftestOutput(output);
  assert.equal(parsed.passed, false);
  assert.deepEqual(parsed.results.map((r: { rule: string; result: string }) => [r.rule, r.result]), [
    ['P1', 'fail'],
    ['unnamed', 'fail'],
    ['P10', 'exception'],
    ['P2', 'warn'],
    ['*', 'pass'],
  ]);
  assert.equal(parsed.results[0].messages.length, 2);
  const clean = parseConftestOutput(JSON.stringify([{ filename: 'x', successes: 4, failures: [], warnings: [] }]));
  assert.equal(clean.passed, true);
  assert.deepEqual(clean.results, [{ rule: '*', result: 'pass', messages: ['4 policy checks passed'] }]);
  assert.throws(() => parseConftestOutput('{'), { code: 'policy_error' });
  // `--namespace main` against packages p1..p13 evaluates nothing; that must never read as a pass.
  assert.throws(() => parseConftestOutput(JSON.stringify([{ filename: 'x', namespace: 'main', successes: 0, failures: [] }])), { code: 'policy_error' });
  assert.throws(() => parseConftestOutput('[]'), { code: 'policy_error' });
});

test('configuration that can read the filesystem is refused before tofu runs', () => {
  const refused = [
    'output "x" { value = file("/proc/self/environ") }',
    'locals { e = filebase64 ( "/proc/1/environ" ) }',
    '{"output":{"x":{"value":"${templatefile(\\"/etc/passwd\\", {})}"}}}',
    'output "x" { value = fileset("/", "**") }',
    'output "x" { value = provider::cloudflare::anything("a") }',
    'output "x" { value = abspath(".") }',
    'data "terraform_remote_state" "x" { backend = "local" config = { path = "/proc/self/environ" } }',
  ];
  for (const text of refused) {
    assert.throws(() => checkConfigurationText('main.tf', text), (e: any) => e.code === 'config_refused', text);
  }
  // Comments between the name and its arguments, comment markers inside strings, interpolations in
  // strings and heredocs: the lexer sees through all of them.
  for (const text of [
    'output "x" { value = file/* gap */("/proc/self/environ") }',
    'output "x" { value = file # gap\n("/proc/self/environ") }',
    'locals { a = "/*" \n b = file("/proc/self/environ") \n c = "*/" }',
    'output "x" { value = "${filebase64("/proc/self/environ")}" }',
    'locals { s = <<EOT\n${file("/proc/self/environ")}\nEOT\n}',
    'output "x" { value = provider /* x */ :: cloudflare :: f("a") }',
    // A false, indented terminator does not end a plain `<<EOT` heredoc; HCL keeps reading.
    'locals { s = <<EOT\n  EOT\n# ${file("/proc/self/environ")}\nEOT\n}',
  ]) {
    assert.throws(() => checkConfigurationText('main.tf', text), (e: any) => e.code === 'config_refused', text);
  }
  assert.throws(() => checkConfigurationText('main.tf', 'locals { a = "unterminated }'), (e: any) => e.code === 'config_refused');
  assert.throws(() => checkConfigurationText('main.tf', 'locals { a = 1 } /* open'), (e: any) => e.code === 'config_refused');
  // JSON escapes hide the name from a raw-text scan; the decoded strings and keys are checked.
  const escaped = '{"output":{"x":{"value":"${fil\\u0065(\\"/proc/self/environ\\")}"}}}';
  assert.doesNotThrow(() => JSON.parse(escaped));
  assert.throws(() => checkConfigurationText('main.tf.json', escaped), (e: any) => e.code === 'config_refused');
  assert.throws(() => checkConfigurationText('x.tf.json', '{"locals":{"\\u0066ile(\\"/x\\")":1}}'), (e: any) => e.code === 'config_refused');
  assert.throws(() => checkConfigurationText('x.tf.json', '{'), (e: any) => e.code === 'config_refused');
  const allowed = [
    'resource "cloudflare_workers_kv" "registry" { key_name = "registry" value = jsonencode(local.doc) }',
    'locals { profile = "x" }  # mentions file( in a comment, profile and filesystem',
    '/* file("/x") */ locals { note = "reads a file(/x) and fe80::1" }',
    'resource "cloudflare_dns_record" "a" { content = "100::" }',
    'locals { s = <<-EOT\n  the file() function is not called here: $${file("x")}\n  EOT\n}',
    'locals { s = <<EOT\nplain text\nEOT\n}',
    'variable "file_name" { type = string }',
  ];
  for (const text of allowed) checkConfigurationText('main.tf', text);
});

test('encryption.tf is pinned: no weaker method, no fallback, no second declaration', () => {
  const pinned = `# comments may change
terraform {
  encryption {
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}
`;
  const main: [string, string] = ['main.tf', 'resource "terraform_data" "x" {}'];
  assert.doesNotThrow(() => checkEncryption([main, ['encryption.tf', pinned]]));
  // Mentioning the word in a JSON string value is not a declaration.
  assert.doesNotThrow(() => checkEncryption([main, ['encryption.tf', pinned], ['vars.tf.json', '{"variable":{"x":{"description":"state encryption is pinned"}}}']]));
  for (const doc of [
    { output: { settings: { value: { encryption: 'enabled' } } } },
    { variable: { settings: { default: { terraform: { encryption: 'enabled' } } } } },
    { locals: { encryption: { encryption: true } } },
    { output: { encryption: { value: 'enabled' } } },
  ]) {
    assert.doesNotThrow(() => checkEncryption([main, ['encryption.tf', pinned], ['settings.tf.json', JSON.stringify(doc)]]));
  }
  const refused: Array<Array<[string, string]>> = [
    [main],
    [main, ['encryption.tf', pinned.replace('enforced = true', 'enforced = false')]],
    [main, ['encryption.tf', pinned.replace('state {\n      method   = method.aes_gcm.state', 'method "unencrypted" "off" {}\n    state {\n      method   = method.unencrypted.off')]],
    [main, ['encryption.tf', pinned], ['override.tf', 'terraform {\n  encryption {\n    state {\n      fallback {\n        method = method.unencrypted.off\n      }\n    }\n  }\n}']],
    [main, ['encryption.tf', pinned], ['x.tf.json', '{"terraform":{"encryption":{}}}']],
    [main, ['encryption.tf', pinned], ['x.tofu.json', '{"terraform":[{"encryption":{}}]}']],
    [main, ['encryption.tf', pinned], ['override.tf.json', '{"terraform":{"encrypt\\u0069on":{"method":{"unencrypted":{"off":{}}}}}}']],
  ];
  for (const files of refused) {
    assert.throws(() => checkEncryption(files), (e: any) => e.code === 'encryption_config', files.map((f) => f[0]).join(','));
  }
});
