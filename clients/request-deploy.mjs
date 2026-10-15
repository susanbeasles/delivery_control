#!/usr/bin/env node
// Reference client for the GitHub-side deploy workflow. Zero dependencies, Node 20+.
//
//   permissions: { id-token: write }
//   run: node request-deploy.mjs --application prosrus --environment production --release-tag v1.4.2
//
// It trades this job's OIDC token (audience services.susanb.dev) for a deployment, then, unless
// --no-wait is given, polls `deploy.status` with a fresh OIDC token each time until the deployment
// is terminal. Exit code 0 means SUCCEEDED (or the release was already current). It never prints a
// token, never follows a redirect, and never retries a rejected request.

const ENDPOINT = 'https://services.susanb.dev/v1/token';
const AUDIENCE = 'services.susanb.dev';
const TERMINAL = new Set(['SUCCEEDED', 'ROLLED_BACK', 'RECOVERY_FAILED', 'REJECTED']);

export function parseArgs(argv) {
  const out = { intent: 'deploy', wait: true, waitSeconds: 1800, pollSeconds: 10 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--application') out.application = value();
    else if (flag === '--environment') out.environment = value();
    else if (flag === '--release-tag') out.releaseTag = value();
    else if (flag === '--intent') out.intent = value();
    else if (flag === '--no-wait') out.wait = false;
    else if (flag === '--wait-seconds') out.waitSeconds = Number(value());
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(out.application ?? '')) throw new Error('--application is required');
  if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(out.environment ?? '')) throw new Error('--environment is required');
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(out.releaseTag ?? '')) throw new Error('--release-tag must be vX.Y.Z');
  if (!['deploy', 'rollback'].includes(out.intent)) throw new Error('--intent is deploy or rollback');
  if (!Number.isSafeInteger(out.waitSeconds) || out.waitSeconds < 0 || out.waitSeconds > 7200) throw new Error('--wait-seconds out of range');
  return out;
}

export async function oidcToken(env, fetcher) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('no OIDC token available: the job needs `permissions: id-token: write`');
  const response = await fetcher(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { authorization: `bearer ${bearer}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OIDC token request failed with HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body?.value !== 'string') throw new Error('OIDC token response is malformed');
  return body.value;
}

export async function call(fetcher, token, action, subject) {
  let response;
  try {
    response = await fetcher(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, subject }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    return { status: 0, body: { error: 'unreachable' }, cause };
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text.slice(0, 65536));
  } catch {
    body = { error: 'non_json_response' };
  }
  return { status: response.status, body };
}

export async function run({ args, env, fetcher = fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const subject = { application: args.application, environment: args.environment, releaseTag: args.releaseTag, intent: args.intent };
  const admitted = await call(fetcher, await oidcToken(env, fetcher), 'deploy', subject);
  if (admitted.status !== 202) {
    log(`::error::deploy request refused (HTTP ${admitted.status}): ${admitted.body.error ?? 'unknown'}${admitted.body.reason ? ` ${admitted.body.reason}` : ''}`);
    return 1;
  }
  const { status, deploymentId, githubDeploymentId } = admitted.body;
  log(`deploy ${args.application}/${args.environment} ${args.releaseTag}: ${status} (deployment ${deploymentId}, GitHub deployment ${githubDeploymentId ?? 'pending'})`);
  if (status === 'ALREADY_CURRENT' || !args.wait) return 0;

  const deadline = now() + args.waitSeconds * 1000;
  let last = '';
  while (now() < deadline) {
    await sleep(args.pollSeconds * 1000);
    const reply = await call(fetcher, await oidcToken(env, fetcher), 'deploy.status', { application: args.application, environment: args.environment, deploymentId });
    if (reply.status !== 200) {
      log(`::warning::status check returned HTTP ${reply.status}: ${reply.body.error ?? 'unknown'}`);
      continue;
    }
    const phase = reply.body?.phase;
    if (phase !== last) {
      log(`phase: ${phase}`);
      last = phase;
    }
    if (TERMINAL.has(phase)) {
      if (phase === 'SUCCEEDED') return 0;
      const error = reply.body.lastError;
      log(`::error::deployment ended ${phase}${error ? `: ${error.code} ${error.message}` : ''}`);
      return 1;
    }
  }
  log(`::error::deployment ${deploymentId} did not finish within ${args.waitSeconds} s; it continues server-side`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await run({ args: parseArgs(process.argv.slice(2)), env: process.env });
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
