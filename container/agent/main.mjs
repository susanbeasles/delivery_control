import { closeSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkFiles, validateEnvelope } from './envelope.mjs';
import { JobFailure } from './errors.mjs';
import { readFrames } from './framing.mjs';
import { PATHS } from './paths.mjs';
import { runReleaseVerify } from './release.mjs';
import { failureDocument, successDocument } from './result.mjs';
import { runApply, runPlan } from './terraform.mjs';

/**
 * The runner agent. Started once per container by the Durable Object through `exec`, it reads the
 * job from stdin into a private workdir, runs it, and writes exactly one `runner-result/v1`
 * document to stdout. It exits 0 only after writing that document.
 */

const HANDLERS = {
  'release.verify': runReleaseVerify,
  'terraform.plan': runPlan,
  'root.plan': runPlan,
  'terraform.apply': runApply,
  'root.apply': runApply,
};

/** Leave time to report before the Durable Object's watchdog destroys the container. */
const DEADLINE_MARGIN_MS = 20_000;

/** Reads the framed job into `<workdir>/in/<name>`; returns the envelope and file paths. */
export async function receive(source, workdir) {
  const inbox = join(workdir, 'in');
  mkdirSync(inbox, { mode: 0o700 });
  let envelope = null;
  const files = new Map();
  let fd = null;
  for await (const event of readFrames(source)) {
    if (event.kind === 'envelope') {
      envelope = validateEnvelope(event.value);
    } else if (event.kind === 'files') {
      checkFiles(envelope.type, event.value);
    } else if (event.kind === 'chunk') {
      if (fd === null) {
        const path = join(inbox, event.file.name);
        fd = openSync(path, 'wx', 0o600);
        files.set(event.file.name, path);
      }
      writeSync(fd, event.bytes);
    } else if (event.kind === 'file-end') {
      if (fd !== null) closeSync(fd);
      fd = null;
    }
  }
  return { envelope, files };
}

export async function main({ stdin = process.stdin, paths = PATHS, env = process.env } = {}) {
  // The one secret this process may hold. Removed from our environment before anything runs;
  // tools get explicit environments, and only tofu receives it (as TF_ENCRYPTION).
  const passphrase = env.RUNNER_TF_PASSPHRASE ?? null;
  delete env.RUNNER_TF_PASSPHRASE;
  const workdir = paths.workdir;
  let jobId = null;
  const ctx = { mutationStarted: false };
  let doc;
  try {
    mkdirSync(workdir, { recursive: true, mode: 0o700 });
    if (readdirSync(workdir).length > 0) throw new JobFailure('workdir_not_empty', 'a container runs exactly one job');
    const home = join(workdir, 'home');
    mkdirSync(home, { mode: 0o700 });
    const { envelope, files } = await receive(stdin, workdir);
    jobId = envelope.jobId;
    Object.assign(ctx, { envelope, files, paths, workdir, home, passphrase, deadlineMs: envelope.deadlineAt * 1000 - DEADLINE_MARGIN_MS });
    if (Date.now() >= ctx.deadlineMs) throw new JobFailure('deadline_exceeded', 'the job deadline passed before it started');
    doc = successDocument(jobId, await HANDLERS[envelope.type](ctx));
  } catch (error) {
    if (jobId === null) {
      process.stderr.write(`[agent] job rejected before it was identified: ${error instanceof JobFailure ? error.code : 'error'}\n`);
      return 2;
    }
    const failure = error instanceof JobFailure ? error : new JobFailure('agent_error', `unexpected ${error instanceof Error ? error.name : typeof error}`);
    // Once `tofu apply` has started, no failure can say what the infrastructure looks like.
    if (ctx.mutationStarted) failure.uncertain = true;
    process.stderr.write(`[agent] job failed: ${failure.code}\n`);
    doc = failureDocument(jobId, failure);
  }
  process.stdout.write(`${JSON.stringify(doc)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
