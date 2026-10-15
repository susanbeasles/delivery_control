import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { JobFailure, fail } from './errors.mjs';
import { request } from './http.mjs';
import { baseToolEnv } from './paths.mjs';
import {
  backendConfigFile,
  CONFIG_FILE,
  checkApplyBinding,
  checkConfigurationText,
  checkInitializedBackend,
  countChanges,
  encryptionConfig,
  parseStatePull,
  redactPlan,
  sameState,
  validateApplyInput,
  validatePlanInput,
} from './plan.mjs';
import { parseConftestOutput } from './policy.mjs';
import { runTool } from './process.mjs';
import { extractTarball } from './tar.mjs';

/**
 * `terraform.plan` / `root.plan` and `terraform.apply` / `root.apply`. The stack's code comes from
 * the source tarball, the policy from infra-root `main`, providers only from the image's
 * filesystem mirror. State, artifacts and the Cloudflare API are reached through the egress gate,
 * which holds every credential; the only secret here is the state passphrase, passed to tofu
 * processes through `TF_ENCRYPTION` and to nothing else.
 */

const MiB = 1024 * 1024;
const EXPANDED_MAX = 512 * MiB;
const PLAN_JSON_MAX = 128 * MiB;
const STATE_MAX = 128 * MiB;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function tofuEnv(ctx) {
  return {
    ...baseToolEnv(ctx),
    TF_CLI_CONFIG_FILE: ctx.paths.tofurc,
    // Outside the source tree, so a committed `.terraform/` directory is never used.
    TF_DATA_DIR: join(ctx.workdir, 'tfdata'),
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    CHECKPOINT_DISABLE: '1',
    TF_ENCRYPTION: encryptionConfig(ctx.passphrase),
  };
}

function tofu(ctx, cwd, args, captureBytes = 0) {
  return runTool(ctx.paths.tofu, args, { cwd, env: tofuEnv(ctx), deadlineMs: ctx.deadlineMs, captureBytes, label: `tofu ${args[0]}` });
}

function extract(ctx, name, dest) {
  extractTarball(readFileSync(ctx.files.get(name)), dest, EXPANDED_MAX);
  return dest;
}

/** Refuse a stack whose configuration could read the environment (see checkConfigurationText). */
function checkConfiguration(src) {
  const pending = [src];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (CONFIG_FILE.test(entry.name)) checkConfigurationText(relative(src, path), readFileSync(path, 'utf8'));
    }
  }
}

function extractStack(ctx, dest) {
  const src = extract(ctx, 'source.tar.gz', dest);
  checkConfiguration(src);
  return src;
}

async function init(ctx, src, input) {
  const file = join(ctx.workdir, 'backend.tfbackend');
  writeFileSync(file, backendConfigFile(input.backend), { mode: 0o600 });
  const r = await tofu(ctx, src, ['init', '-input=false', '-no-color', '-lockfile=readonly', `-backend-config=${file}`]);
  if (r.code !== 0) fail('tofu_init_failed', `tofu init exited with ${r.code ?? r.signal}`);
  const recorded = join(ctx.workdir, 'tfdata', 'terraform.tfstate');
  if (!existsSync(recorded)) fail('backend_mismatch', 'the configuration declares no backend');
  checkInitializedBackend(readFileSync(recorded, 'utf8'), input.backend);
}

async function pullState(ctx, src) {
  const r = await tofu(ctx, src, ['state', 'pull'], STATE_MAX);
  if (r.code !== 0 || r.stdout === null) fail('state_unreadable', 'tofu state pull failed');
  // Decrypted state lives only in this buffer; only serial and lineage are kept.
  return parseStatePull(r.stdout.toString('utf8'));
}

async function upload(input, name, body) {
  const r = await request(`${input.artifactsOrigin}/${name}`, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' }, maxBytes: 64 * 1024 });
  if (r.status === 409) fail('plan_exists', `${name} already exists for this tree`);
  if (r.status !== 201) fail('artifact_upload_failed', `${name} upload returned HTTP ${r.status}`);
}

export async function runPlan(ctx) {
  const input = validatePlanInput(ctx.envelope.input);
  const out = join(ctx.workdir, 'out');
  mkdirSync(out, { mode: 0o700 });
  const src = extractStack(ctx, join(ctx.workdir, 'src'));
  const policyRepo = extract(ctx, 'policy.tar.gz', join(ctx.workdir, 'policy-repo'));
  const policyDir = join(policyRepo, input.policyDirectory);
  if (!existsSync(policyDir) || !lstatSync(policyDir).isDirectory()) fail('policy_missing', `infra-root main has no ${input.policyDirectory}/ directory`);

  await init(ctx, src, input);
  const before = await pullState(ctx, src);
  const planPath = join(out, 'plan.tfplan');
  // -lock=false: a plan never writes state, so it needs no write credential at all, and a plan
  // killed by the watchdog can never leave a stale lock that blocks applies. A concurrent apply is
  // detected by the serial/lineage check below and again, authoritatively, at apply time.
  const planned = await tofu(ctx, src, ['plan', '-input=false', '-no-color', '-lock=false', `-out=${planPath}`]);
  if (planned.code !== 0) fail('tofu_plan_failed', `tofu plan exited with ${planned.code ?? planned.signal}`);
  const after = await pullState(ctx, src);
  if (!sameState(before, after)) fail('state_changed_during_plan', 'state changed while planning; plan again');

  const shown = await tofu(ctx, src, ['show', '-json', '-no-color', planPath], PLAN_JSON_MAX);
  if (shown.code !== 0 || shown.stdout === null) fail('tofu_show_failed', 'tofu show -json failed');
  const plan = JSON.parse(shown.stdout.toString('utf8'));
  const counts = countChanges(plan);
  const redacted = redactPlan(plan);
  const planJson = Buffer.from(JSON.stringify(redacted));
  const policyInput = join(out, 'policy-input.json');
  writeFileSync(policyInput, JSON.stringify({ ...redacted, stack: input.stack }), { mode: 0o600 });

  const conftest = await runTool(ctx.paths.conftest, ['test', '--no-color', '--output', 'json', '--policy', policyDir, '--all-namespaces', policyInput], {
    cwd: out,
    env: baseToolEnv(ctx),
    deadlineMs: ctx.deadlineMs,
    captureBytes: 4 * MiB,
  });
  if ((conftest.code !== 0 && conftest.code !== 1) || conftest.stdout === null) fail('policy_error', `conftest exited with ${conftest.code ?? conftest.signal}`);
  const policy = parseConftestOutput(conftest.stdout.toString('utf8'));
  if (policy.passed !== (conftest.code === 0)) fail('policy_error', 'conftest exit status contradicts its results');

  const planBytes = readFileSync(planPath);
  const summary = {
    schema: 'terraform-plan-summary/v1',
    jobId: ctx.envelope.jobId,
    stack: input.stack,
    repository: input.repository,
    commit: input.commit,
    treeSha: input.treeSha,
    policyCommit: input.policyCommit,
    ...counts,
    policy: policy.results,
    policyPassed: policy.passed,
    stateSerial: before?.serial ?? null,
    stateLineage: before?.lineage ?? null,
    planSha256: sha256(planBytes),
    planJsonSha256: sha256(planJson),
  };
  // summary.json last: its presence marks a complete plan for the apply binding.
  await upload(input, 'plan.tfplan', planBytes);
  await upload(input, 'plan.json', planJson);
  await upload(input, 'summary.json', Buffer.from(JSON.stringify(summary)));
  return summary;
}

async function archiveState(input, phase) {
  const { endpoint, bucket, key } = input.backend;
  const state = await request(`${endpoint}/${bucket}/${key}`, { maxBytes: STATE_MAX });
  if (state.status === 404) return null;
  if (state.status !== 200) fail('archive_failed', `state read returned HTTP ${state.status}`);
  const target = input.archive[phase];
  // The object is archived exactly as stored (encrypted). The gate makes the write create-only.
  const put = await request(`${endpoint}/${input.archive.bucket}/${target}`, { method: 'PUT', body: state.bytes, headers: { 'content-type': 'application/octet-stream' }, maxBytes: 64 * 1024 });
  if (put.status === 412) fail('archive_exists', `${phase} archive already exists`);
  if (put.status !== 200) fail('archive_failed', `${phase} archive write returned HTTP ${put.status}`);
  return `${input.archive.bucket}/${target}`;
}

export async function runApply(ctx) {
  const input = validateApplyInput(ctx.envelope.input, ctx.envelope.jobId);
  const out = join(ctx.workdir, 'out');
  mkdirSync(out, { mode: 0o700 });
  const src = extractStack(ctx, join(ctx.workdir, 'src'));
  await init(ctx, src, input);

  const plan = await request(`${input.artifactsOrigin}/plan.tfplan`, { maxBytes: 64 * MiB });
  if (plan.status !== 200) fail('plan_missing', `plan download returned HTTP ${plan.status}`);
  const planPath = join(out, 'plan.tfplan');
  writeFileSync(planPath, plan.bytes, { mode: 0o600 });
  const current = await pullState(ctx, src);
  checkApplyBinding({ expected: input.plan, planSha256: sha256(plan.bytes), current });
  const archivedBefore = await archiveState(input, 'before');
  if ((archivedBefore === null) !== (current === null)) fail('archive_failed', 'state presence changed while archiving');

  // From here on infrastructure may change: any failure is uncertain and locks the stack.
  ctx.mutationStarted = true;
  const applied = await tofu(ctx, src, ['apply', '-input=false', '-no-color', '-lock-timeout=60s', planPath]);
  const archivedAfter = await archiveState(input, 'after').catch((error) => {
    process.stderr.write(`[agent] after-apply archive failed: ${error instanceof JobFailure ? error.code : 'error'}\n`);
    return null;
  });
  if (applied.code !== 0) throw new JobFailure('apply_failed', `tofu apply exited with ${applied.code ?? applied.signal}; infrastructure may be partially changed`, { uncertain: true });
  const after = await pullState(ctx, src).catch(() => null);
  if (after === null) throw new JobFailure('state_unreadable', 'state could not be read after apply', { uncertain: true });
  return {
    schema: 'terraform-apply-result/v1',
    jobId: ctx.envelope.jobId,
    stack: input.stack,
    commit: input.commit,
    treeSha: input.treeSha,
    applied: true,
    stateSerialBefore: current?.serial ?? null,
    stateSerialAfter: after.serial,
    stateLineage: after.lineage,
    archive: { before: archivedBefore, after: archivedAfter },
  };
}
