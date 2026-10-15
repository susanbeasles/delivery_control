import { JobFailure } from './errors.mjs';

/**
 * Pure helpers for the terraform jobs: input validation, the backend and encryption configuration
 * handed to OpenTofu, change counts, redaction of sensitive values in plan JSON, and the apply
 * binding checks. No I/O here; terraform.mjs does the running.
 */

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STACKS = new Set(['infra', 'infra-root']);
/** Mirrors worker/runner/egress/rules.ts STATE_BUCKETS: one state bucket per stack. */
const STATE_BUCKETS = { infra: 'tf-state', 'infra-root': 'tf-state-root' };
const ENDPOINT = /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/;
const PASSPHRASE = /^[A-Za-z0-9_-]{32,128}$/;
const LINEAGE = /^[A-Za-z0-9-]{1,64}$/;

const invalid = (message) => new JobFailure('input_invalid', message);

function exact(value, keys, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw invalid(`${what} has an unexpected shape`);
  }
  return value;
}

function backend(value, stack) {
  const b = exact(value, ['bucket', 'key', 'endpoint'], 'input.backend');
  if (b.bucket !== STATE_BUCKETS[stack] || b.key !== `${stack}/terraform.tfstate` || !ENDPOINT.test(b.endpoint)) throw invalid('input.backend is not this stack\'s state');
  return b;
}

function common(input) {
  if (!STACKS.has(input.stack)) throw invalid('input.stack');
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository)) throw invalid('input.repository');
  if (!COMMIT.test(input.commit) || !COMMIT.test(input.treeSha)) throw invalid('input.commit or input.treeSha');
  if (input.artifactsOrigin !== 'https://artifacts.runner.internal') throw invalid('input.artifactsOrigin');
  backend(input.backend, input.stack);
}

export function validatePlanInput(input) {
  exact(input, ['operation', 'stack', 'repository', 'commit', 'treeSha', 'backend', 'artifactsOrigin', 'policyCommit', 'policyDirectory'], 'input');
  if (input.operation !== 'plan') throw invalid('input.operation');
  common(input);
  if (!COMMIT.test(input.policyCommit)) throw invalid('input.policyCommit');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.policyDirectory)) throw invalid('input.policyDirectory');
  return input;
}

export function validateApplyInput(input, jobId) {
  exact(input, ['operation', 'stack', 'repository', 'commit', 'treeSha', 'backend', 'artifactsOrigin', 'plan', 'archive'], 'input');
  if (input.operation !== 'apply') throw invalid('input.operation');
  common(input);
  const plan = exact(input.plan, ['sha256', 'stateSerial', 'stateLineage', 'planJobId'], 'input.plan');
  if (!SHA256.test(plan.sha256) || !UUIDV7.test(plan.planJobId)) throw invalid('input.plan');
  if ((plan.stateSerial === null) !== (plan.stateLineage === null)) throw invalid('input.plan state binding');
  if (plan.stateSerial !== null && (!Number.isSafeInteger(plan.stateSerial) || plan.stateSerial < 0 || !LINEAGE.test(plan.stateLineage))) throw invalid('input.plan state binding');
  const archive = exact(input.archive, ['bucket', 'before', 'after'], 'input.archive');
  const prefix = `${input.stack}/${input.treeSha}/${jobId}/`;
  if (archive.bucket !== 'tf-state-archive' || archive.before !== `${prefix}before.tfstate` || archive.after !== `${prefix}after.tfstate`) throw invalid('input.archive');
  return input;
}

/** `-backend-config` file. Credentials are placeholders: the egress gate re-signs every request. */
export function backendConfigFile(b) {
  return [
    `bucket = ${JSON.stringify(b.bucket)}`,
    `key = ${JSON.stringify(b.key)}`,
    'region = "auto"',
    `endpoints = { s3 = ${JSON.stringify(b.endpoint)} }`,
    'use_path_style = true',
    'use_lockfile = true',
    'skip_credentials_validation = true',
    'skip_region_validation = true',
    'skip_requesting_account_id = true',
    'skip_metadata_api_check = true',
    'skip_s3_checksum = true',
    'access_key = "signed-by-egress-gate"',
    'secret_key = "signed-by-egress-gate"',
    '',
  ].join('\n');
}

/**
 * `TF_ENCRYPTION` for tofu child processes only: state and plan encryption enforced with a
 * PBKDF2-derived AES-GCM key. The passphrase is base64url (validated), so it is HCL-safe.
 */
export function encryptionConfig(passphrase) {
  if (typeof passphrase !== 'string' || !PASSPHRASE.test(passphrase)) throw new JobFailure('passphrase_invalid', 'state passphrase is missing or malformed');
  return [
    'key_provider "pbkdf2" "runner" {',
    `  passphrase = "${passphrase}"`,
    '}',
    'method "aes_gcm" "runner" {',
    '  keys = key_provider.pbkdf2.runner',
    '}',
    'state {',
    '  method   = method.aes_gcm.runner',
    '  enforced = true',
    '}',
    'plan {',
    '  method   = method.aes_gcm.runner',
    '  enforced = true',
    '}',
    '',
  ].join('\n');
}

/** Terraform's convention: a replacement counts as one add and one destroy. */
export function countChanges(plan) {
  let addCount = 0;
  let changeCount = 0;
  let destroyCount = 0;
  for (const rc of Array.isArray(plan?.resource_changes) ? plan.resource_changes : []) {
    const actions = Array.isArray(rc?.change?.actions) ? rc.change.actions : [];
    const has = (a) => actions.includes(a);
    if (has('create')) addCount += 1;
    if (has('delete')) destroyCount += 1;
    if (has('update')) changeCount += 1;
  }
  return { addCount, changeCount, destroyCount };
}

export const SENSITIVE = '(sensitive)';

/** Replace every value the plan marks sensitive. `marks` mirrors `value` (true, object or array). */
export function maskSensitive(value, marks) {
  if (marks === true) return SENSITIVE;
  if (marks === null || typeof marks !== 'object' || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item, index) => maskSensitive(item, Array.isArray(marks) ? marks[index] : undefined));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = maskSensitive(item, marks[key]);
  return out;
}

function redactModule(module) {
  if (!module || typeof module !== 'object') return module;
  return {
    ...module,
    resources: Array.isArray(module.resources) ? module.resources.map((r) => ({ ...r, values: maskSensitive(r.values, r.sensitive_values) })) : module.resources,
    child_modules: Array.isArray(module.child_modules) ? module.child_modules.map(redactModule) : module.child_modules,
  };
}

function redactChange(rc) {
  if (!rc?.change) return rc;
  const change = rc.change;
  return { ...rc, change: { ...change, before: maskSensitive(change.before, change.before_sensitive), after: maskSensitive(change.after, change.after_sensitive) } };
}

function redactOutputs(outputs) {
  if (!outputs || typeof outputs !== 'object') return outputs;
  const out = {};
  for (const [name, output] of Object.entries(outputs)) out[name] = output?.sensitive ? { ...output, value: SENSITIVE } : output;
  return out;
}

function redactValues(values) {
  if (!values || typeof values !== 'object') return values;
  return { ...values, outputs: redactOutputs(values.outputs), root_module: redactModule(values.root_module) };
}

/**
 * `tofu show -json` includes sensitive values in clear text (only marked as sensitive). The stored
 * `plan.json` and the policy input get them replaced, so neither R2 nor the policy engine sees them.
 */
export function redactPlan(plan) {
  const variablesConfig = plan?.configuration?.root_module?.variables ?? {};
  const variables = {};
  for (const [name, variable] of Object.entries(plan?.variables ?? {})) {
    variables[name] = variablesConfig[name]?.sensitive ? { ...variable, value: SENSITIVE } : variable;
  }
  const outputChanges = {};
  for (const [name, change] of Object.entries(plan?.output_changes ?? {})) {
    outputChanges[name] = { ...change, before: maskSensitive(change?.before, change?.before_sensitive), after: maskSensitive(change?.after, change?.after_sensitive) };
  }
  return {
    ...plan,
    ...(plan?.variables ? { variables } : {}),
    ...(plan?.output_changes ? { output_changes: outputChanges } : {}),
    ...(plan?.planned_values ? { planned_values: redactValues(plan.planned_values) } : {}),
    ...(plan?.prior_state ? { prior_state: { ...plan.prior_state, values: redactValues(plan.prior_state.values) } } : {}),
    ...(Array.isArray(plan?.resource_changes) ? { resource_changes: plan.resource_changes.map(redactChange) } : {}),
    ...(Array.isArray(plan?.resource_drift) ? { resource_drift: plan.resource_drift.map(redactChange) } : {}),
  };
}

/** Output of `tofu state pull`: empty when no state exists yet, else JSON with serial and lineage. */
export function parseStatePull(text) {
  if (text.trim() === '') return null;
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new JobFailure('state_unreadable', 'tofu state pull did not return JSON');
  }
  if (state === null || (typeof state === 'object' && Object.keys(state).length === 0)) return null;
  if (!Number.isSafeInteger(state.serial) || state.serial < 0 || typeof state.lineage !== 'string' || !LINEAGE.test(state.lineage)) {
    throw new JobFailure('state_unreadable', 'state has no valid serial and lineage');
  }
  return { serial: state.serial, lineage: state.lineage };
}

export function sameState(a, b) {
  return (a === null && b === null) || (a !== null && b !== null && a.serial === b.serial && a.lineage === b.lineage);
}

/**
 * The apply binding, checked after `tofu init` and before `tofu apply`: the downloaded plan is
 * the one the summary describes, and the state is exactly the one the plan was computed against.
 */
export function checkApplyBinding({ expected, planSha256, current }) {
  if (planSha256 !== expected.sha256) throw new JobFailure('plan_digest_mismatch', 'downloaded plan does not match the stored plan digest');
  const planned = expected.stateSerial === null ? null : { serial: expected.stateSerial, lineage: expected.stateLineage };
  if (planned === null && current !== null) throw new JobFailure('state_changed', 'state was created after the plan');
  if (planned !== null && current === null) throw new JobFailure('state_changed', 'state disappeared after the plan');
  if (planned !== null && current !== null) {
    if (current.lineage !== planned.lineage) throw new JobFailure('state_lineage_changed', 'state lineage differs from the plan');
    if (current.serial !== planned.serial) throw new JobFailure('state_serial_changed', `state serial is ${current.serial}, the plan was made at ${planned.serial}`);
  }
}

/** The backend recorded by `tofu init` must be our S3 bucket and key, never local or another backend. */
export function checkInitializedBackend(dataDirState, b) {
  let parsed;
  try {
    parsed = JSON.parse(dataDirState);
  } catch {
    throw new JobFailure('backend_mismatch', 'initialized backend is unreadable');
  }
  const config = parsed?.backend?.config ?? {};
  if (parsed?.backend?.type !== 's3' || config.bucket !== b.bucket || config.key !== b.key) {
    throw new JobFailure('backend_mismatch', 'the configuration does not use the runner\'s s3 state backend');
  }
}

/**
 * The state passphrase is in every tofu process's environment, and a plan runs code from a pull
 * request. OpenTofu reaches the filesystem only through these functions (there is no `env()`), and
 * `terraform_remote_state` with a `local` backend reads any path, so a configuration that calls one
 * could read `/proc/self/environ` and smuggle the passphrase into a plan output. Neither stack needs
 * them. The check runs on the configuration's code only: comments and literal string text are
 * dropped by a small HCL lexer, interpolations (`${...}`, `%{...}`) are kept. An identifier cannot be
 * split by a comment, so `file`, a comment, then `(` still shows `file`, and the bare name is refused whether
 * or not a call follows. `::` in code means a provider-defined function, which is refused as well.
 */
export const CONFIG_FILE = /\.(?:tf|tofu)(?:\.json)?$/;
const FORBIDDEN_NAME = /(?<![\w])(?:file(?:base64(?:sha256|sha512)?|md5|sha1|sha256|sha512|exists|set)?|templatefile|templatestring|abspath|pathexpand|terraform_remote_state)(?![\w])|::/;

const unterminated = (name, what) => new JobFailure('config_refused', `${name} has an unterminated ${what}`);

/** Code text of HCL source (or of one template string when `template` is set), comments and literals blanked. */
export function hclCode(src, name, template = false, keepStrings = false) {
  let out = '';
  let i = 0;
  const stack = [template ? { kind: 'template' } : { kind: 'code', depth: 0 }];
  const openInterpolation = () => {
    stack.push({ kind: 'code', depth: 0 });
    out += ' ';
    i += 2;
  };
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const next = src[i + 1];
    if (top.kind === 'code') {
      if (c === '#' || (c === '/' && next === '/')) {
        const end = src.indexOf('\n', i);
        i = end === -1 ? src.length : end;
        out += ' ';
      } else if (c === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) throw unterminated(name, 'comment');
        i = end + 2;
        out += ' ';
      } else if (c === '"') {
        stack.push({ kind: 'string' });
        out += keepStrings ? '"' : ' ';
        i += 1;
      } else if (c === '<' && next === '<' && /^<<-?[A-Za-z_][\w-]*\r?\n/.test(src.slice(i, i + 260))) {
        const m = /^<<-?([A-Za-z_][\w-]*)\r?\n/.exec(src.slice(i, i + 260));
        stack.push({ kind: 'heredoc', marker: m[1] });
        out += ' ';
        i += m[0].length;
      } else if (c === '}' && top.depth === 0 && stack.length > 1) {
        stack.pop();
        out += ' ';
        i += 1;
      } else {
        if (c === '{') top.depth += 1;
        else if (c === '}') top.depth -= 1;
        out += c;
        i += 1;
      }
      continue;
    }
    // Literal text: a quoted string, a heredoc body or a JSON-syntax template.
    if (top.kind === 'heredoc' && (i === 0 || src[i - 1] === '\n')) {
      const end = src.indexOf('\n', i);
      const line = src.slice(i, end === -1 ? src.length : end);
      if (line.trim() === top.marker) {
        stack.pop();
        i += line.length;
        continue;
      }
    }
    if ((c === '$' || c === '%') && next === c && src[i + 2] === '{') {
      i += 3; // `$${` and `%%{` are literal
    } else if ((c === '$' || c === '%') && next === '{') {
      openInterpolation();
    } else if (top.kind === 'string' && c === '\\') {
      i += 2;
    } else if (top.kind === 'string' && c === '"') {
      stack.pop();
      out += keepStrings ? '"' : ' ';
      i += 1;
    } else if (top.kind === 'string' && c === '\n') {
      throw unterminated(name, 'string');
    } else {
      if (keepStrings) out += c;
      i += 1;
    }
  }
  if (stack.length !== 1) throw unterminated(name, stack[stack.length - 1].kind === 'code' ? 'interpolation' : stack[stack.length - 1].kind);
  return out;
}

export function checkConfigurationText(name, text) {
  const codes = [];
  if (name.endsWith('.json')) {
    // JSON syntax: every string is a template and keys can name things, so each decoded key is
    // checked as code and each decoded string value as a template; escapes like e are gone.
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new JobFailure('config_refused', `${name} is not valid JSON`);
    }
    const walk = (v) => {
      if (typeof v === 'string') codes.push(hclCode(v, name, true));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) (codes.push(k), walk(x));
    };
    walk(doc);
  } else {
    codes.push(hclCode(text, name));
  }
  // Block labels are quoted, so the data source type is looked for in the raw text as well.
  if (/terraform_remote_state/.test(text)) throw new JobFailure('config_refused', `${name} uses terraform_remote_state, which can read the runner's environment`);
  for (const code of codes) {
    const match = FORBIDDEN_NAME.exec(code);
    if (match) throw new JobFailure('config_refused', `${name} uses ${match[0] === '::' ? 'a provider-defined function' : match[0]}, which can read the runner's environment`);
  }
}

/**
 * State and plan encryption is configured by the stack's `encryption.tf`, which a pull request could
 * weaken (an `unencrypted` method, a fallback, `enforced = false`) before any policy sees the plan;
 * `tofu show -json` does not record it. So the block is pinned here: `encryption.tf` at the stack
 * root must have exactly this code (comments and whitespace aside) and no other file may declare
 * encryption. Changing it is a reviewed change to the runner.
 */
export const PINNED_ENCRYPTION = 'terraform{encryption{method"aes_gcm""state"{keys=key_provider.pbkdf2.state}state{method=method.aes_gcm.stateenforced=true}plan{method=method.aes_gcm.stateenforced=true}}}';
const ENCRYPTION_WORD = /(?<![\w])encryption(?![\w])/;

export function checkEncryption(files) {
  let pinned = false;
  for (const [name, text] of files) {
    const code = name.endsWith('.json') ? text : hclCode(text, name);
    if (!ENCRYPTION_WORD.test(code)) continue;
    if (name !== 'encryption.tf') throw new JobFailure('encryption_config', `${name} declares encryption; only encryption.tf may, and it is pinned`);
    if (hclCode(text, name, false, true).replace(/\s+/g, '') !== PINNED_ENCRYPTION) {
      throw new JobFailure('encryption_config', 'encryption.tf differs from the pinned state and plan encryption');
    }
    pinned = true;
  }
  if (!pinned) throw new JobFailure('encryption_config', 'the stack has no encryption.tf; state and plans must be encrypted');
}
