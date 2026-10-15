/**
 * Acceptance: "a commit lands on main and the new code is serving".
 *
 * Runs the real authorizer and deployer bundles in workerd (Miniflare from the installed wrangler),
 * with Durable Objects, R2, KV, the queue, alarms, Secrets Store and service-binding RPC all real.
 * Only the world outside Cloudflare is faked at the network edge: GitHub (OIDC keys, API, release
 * storage), the Cloudflare API and the application's health endpoint. The attestation verifier is
 * a stand-in that checks staged digests (test/e2e/fake-runner.js); the real one needs the runner
 * image.
 *
 * Run: npm run test:e2e   (expects the authorizer checkout at ../authorizer or AUTHORIZER_DIR)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalBytes } from '../../worker/lib/json.ts';
import { ACCOUNT, COMMIT, registryDoc } from '../worker/helpers/fixtures.ts';
import { FakeCloudflare, buildRelease, type BuiltRelease } from '../worker/helpers/fakes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const deployerDir = resolve(here, '../..');
const authorizerDir = resolve(process.env.AUTHORIZER_DIR ?? join(deployerDir, '../authorizer'));
const STORE = 'b6504fe2d5f64352954629bc7185fb79';
const REPO = 'susanbeasles/ProsRUs';
const REPO_ID = 1412827677;
const MAIN = COMMIT; // the release commit is the head of main
const ORIGIN = 'https://jobs.susanb.dev';

function wranglerRoot(): string {
  let dir = dirname(realpathSync(execFileSync('which', ['wrangler']).toString().trim()));
  while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== 'wrangler') {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('wrangler installation not found');
    dir = parent;
  }
  return dir;
}

const enrolledPolicy = () => {
  const policy = JSON.parse(readFileSync(join(authorizerDir, 'policy/authorizer-policy.json'), 'utf8'));
  const triggers = { workflows: ['deploy.yml'], refs: ['refs/heads/main', 'refs/tags/v*'], events: ['push', 'workflow_dispatch'], environments: ['production'] };
  policy.repositories.push({
    repository: REPO,
    repositoryId: REPO_ID,
    actions: { deploy: { ...triggers, applications: [{ application: 'prosrus', environments: ['production'] }] }, 'deploy.status': triggers },
  });
  return policy;
};

async function bundle(esbuild: any, entry: string, policy?: unknown): Promise<string> {
  if (policy) {
    // Use the production bundler, aliases and compatibility layer of the unified authorizer.
    const root = mkdtempSync(join(tmpdir(), 'deployer-authorizer-'));
    try {
      const tree = join(root, 'authorizer');
      for (const name of ['src', 'worker', 'policy', 'wrangler.jsonc', 'package.json', 'tsconfig.json']) {
        if (existsSync(join(authorizerDir, name))) cpSync(join(authorizerDir, name), join(tree, name), {recursive:true});
      }
      symlinkSync(join(authorizerDir, 'node_modules'), join(tree, 'node_modules'), 'dir');
      writeFileSync(join(tree, 'policy/authorizer-policy.json'), JSON.stringify(policy));
      execFileSync(join(authorizerDir, 'node_modules/.bin/wrangler'), ['deploy','--dry-run','--outdir',join(root,'bundle'),'--config',join(tree,'wrangler.jsonc')], {cwd:tree,env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'},stdio:['ignore','pipe','pipe'],timeout:120000});
      return readFileSync(join(root,'bundle/index.js'),'utf8');
    } finally { rmSync(root,{recursive:true,force:true}); }
  }
  const plugins: unknown[] = [];
  const result = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, external: ['cloudflare:*'], plugins, logLevel: 'silent' });
  return result.outputFiles[0].text;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

class GitHubEdge {
  readonly statuses: Array<{ deployment: number; state: string; description: string }> = [];
  readonly deployments: Array<{ id: number; environment: string; ref: string }> = [];
  private readonly releases = new Map<string, BuiltRelease>();
  private readonly assets = new Map<number, Uint8Array>();

  publish(release: BuiltRelease) {
    this.releases.set(release.tag, release);
    for (const [name, ref] of [['release.manifest.json', release.assets.manifest], ['release.zip', release.assets.archive], ['attestation.sigstore.json', release.assets.attestation]] as const) {
      this.assets.set(ref.id, release.bytes[name]);
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'objects.githubusercontent.com') {
      const bytes = this.assets.get(Number(url.pathname.split('/').pop()));
      return bytes ? new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }) : new Response('missing', { status: 404 });
    }
    const path = url.pathname;
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (path === `/repos/${REPO}/installation`) return json({ id: 1 });
    if (path === '/app/installations/1/access_tokens' && request.method === 'POST') return json({ token: 'ghs_e2e', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    const prefix = `/repos/${REPO}/`;
    if (!path.startsWith(prefix)) return json({ message: 'Not Found' }, 404);
    const rest = path.slice(prefix.length);
    let m: RegExpExecArray | null;
    if ((m = /^releases\/tags\/(v[0-9.]+)$/.exec(rest))) {
      const r = this.releases.get(decodeURIComponent(m[1]!));
      if (!r) return json({ message: 'Not Found' }, 404);
      const asset = (name: string, ref: { id: number; sha256: string; size: number }) => ({ id: ref.id, name, state: 'uploaded', size: ref.size, digest: `sha256:${ref.sha256}` });
      return json({
        id: 9000 + this.releases.size,
        tag_name: r.tag,
        draft: false,
        prerelease: false,
        immutable: true,
        assets: [asset('release.manifest.json', r.assets.manifest), asset('release.zip', r.assets.archive), asset('attestation.sigstore.json', r.assets.attestation)],
      });
    }
    if ((m = /^git\/ref\/tags\/(v[0-9.]+)$/.exec(rest))) return json({ ref: `refs/tags/${decodeURIComponent(m[1]!)}`, object: { type: 'commit', sha: COMMIT } });
    if (rest === 'git/ref/heads/main') return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: MAIN } });
    if (rest.startsWith(`compare/${MAIN}...`)) return json({ status: 'identical', ahead_by: 0, behind_by: 0 });
    if ((m = /^releases\/assets\/([0-9]+)$/.exec(rest))) {
      if (request.headers.get('authorization') !== 'Bearer ghs_e2e') return json({ message: 'Bad credentials' }, 401);
      return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/github-production-release-asset/${m[1]}` } });
    }
    if (rest === 'deployments' && request.method === 'POST') {
      const body = (await request.json()) as any;
      const id = 7000 + this.deployments.length;
      this.deployments.push({ id, environment: body.environment, ref: body.ref });
      return json({ id }, 201);
    }
    if ((m = /^deployments\/([0-9]+)\/statuses$/.exec(rest)) && request.method === 'POST') {
      const body = (await request.json()) as any;
      this.statuses.push({ deployment: Number(m[1]), state: body.state, description: body.description });
      return json({ id: this.statuses.length }, 201);
    }
    return json({ message: `unexpected ${request.method} ${rest}` }, 404);
  }
}

test('push to main → authorized → ingested → deployed → healthy → committed', { timeout: 120_000, skip: !existsSync(join(authorizerDir, 'worker/index.ts')) && 'authorizer checkout not found' }, async (t) => {
  const root = wranglerRoot();
  const resolveTool = createRequire(join(root, 'package.json'));
  const { Miniflare, convertV4MiniflareOptions, Response: EdgeResponse } = await import(resolveTool.resolve('miniflare'));
  const esbuild = await import(resolveTool.resolve('esbuild'));

  // GitHub's OIDC signing key and the two Apps' keys, generated per run.
  const oidc = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', oidc.publicKey)), kid: 'e2e-key', alg: 'RS256', use: 'sig' } as Record<string, unknown>;
  delete jwk['key_ops'];
  delete jwk['ext'];
  const appKey = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;

  let tokens = 0;
  const oidcToken = async (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'services.susanb.dev',
      exp: now + 300,
      iat: now - 5,
      nbf: now - 5,
      jti: `e2e-jti-${++tokens}-${now}`,
      sub: `repo:${REPO}:ref:refs/heads/main`,
      repository: REPO,
      repository_id: String(REPO_ID),
      repository_owner: 'susanbeasles',
      repository_owner_id: '215839550',
      ref: 'refs/heads/main',
      sha: COMMIT,
      event_name: 'push',
      environment: 'production',
      workflow_ref: `${REPO}/.github/workflows/deploy.yml@refs/heads/main`,
      job_workflow_ref: 'susanbeasles/workflow_depot/.github/workflows/deploy.yml@refs/heads/main',
      job_workflow_sha: 'b'.repeat(40),
      run_id: '123456',
      run_attempt: '1',
      actor_id: '215839550',
      runner_environment: 'github-hosted',
      ...overrides,
    };
    const enc = new TextEncoder();
    const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'e2e-key' })));
    const body = b64url(enc.encode(JSON.stringify(claims)));
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', oidc.privateKey, enc.encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  };

  const github = new GitHubEdge();
  const cf = new FakeCloudflare(ACCOUNT, ORIGIN, 'prosrus-api');
  cf.tokens.set('prosrus-api', 'cf-token-prosrus-api');
  const blocked: string[] = [];
  const edgeErrors: string[] = [];
  const route = async (request: Request): Promise<Response> => {
    const host = new URL(request.url).hostname;
    if (host === 'token.actions.githubusercontent.com') return Response.json({ keys: [jwk] });
    if (host === 'api.github.com' || host === 'objects.githubusercontent.com') return github.handle(request);
    if (host === 'api.cloudflare.com' || host === 'jobs.susanb.dev') return cf.fetch(request);
    blocked.push(request.url);
    return new Response('egress blocked in test', { status: 599 });
  };
  // Miniflare hands us its own Request and expects its own Response class back.
  const internet = async (incoming: any) => {
    try {
      const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : new Uint8Array(await incoming.arrayBuffer());
      const response = await route(new Request(incoming.url, { method: incoming.method, headers: Object.fromEntries(incoming.headers), body }));
      const bytes = response.body === null ? null : new Uint8Array(await response.arrayBuffer());
      return new EdgeResponse(bytes, { status: response.status, headers: Object.fromEntries(response.headers) });
    } catch (error) {
      edgeErrors.push(`${incoming.method} ${incoming.url}: ${(error as Error).stack}`);
      return new EdgeResponse('edge fake failed', { status: 599 });
    }
  };

  const [authorizerCode, deployerCode] = await Promise.all([
    bundle(esbuild, join(authorizerDir, 'worker/index.ts'), enrolledPolicy()),
    bundle(esbuild, join(deployerDir, 'worker/index.ts')),
  ]);
  const compat = { compatibilityDate: '2026-10-01' };
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: 'authorizer',
        ...compat,
        modules: [{ type: 'ESModule', path: 'authorizer.js', contents: authorizerCode }],
        bindings: { GITHUB_APP_ID: '101', GITHUB_OWNER_ID: '215839550', OIDC_AUDIENCE: 'services.susanb.dev' },
        durableObjects: { TOKEN_LEDGER: { className: 'TokenLedger', useSQLite: true }, TOKENS: { className: 'PromotionLedger', useSQLite: true } },
        compatibilityFlags: ['global_fetch_strictly_public','nodejs_compat'],
        serviceBindings: { DEPLOYER: { name: 'deployer', entrypoint: 'Deployer' }, ROOT_RUNNER: { name: 'deployer', entrypoint: 'Deployer' } },
        secretsStoreSecrets: { GITHUB_APP_KEY: { store_id: STORE, secret_name: 'AUTHORIZER_GITHUB_APP_KEY' } },
        outboundService: internet,
      },
      {
        name: 'deployer',
        ...compat,
        modules: [{ type: 'ESModule', path: 'deployer.js', contents: deployerCode }],
        bindings: { ACCOUNT_ID: ACCOUNT, GITHUB_OWNER_ID: '215839550', GITHUB_APP_ID: '202', R2_STATE_RO_TOKEN_ID: '', R2_STATE_RW_TOKEN_ID: '' },
        durableObjects: { COORDINATOR: { className: 'Coordinator', useSQLite: true }, RUNNER: { className: 'FakeRunnerJob', scriptName: 'fake-runner', useSQLite: true } },
        r2Buckets: { RELEASES: 'releases', STAGING: 'release-staging', STATE: 'deploy-state', RUNNER_LOGS: 'runner-logs', TF_PLANS: 'tf-plans' },
        kvNamespaces: { REGISTRY: 'deploy-registry' },
        queueProducers: { DEPLOY_QUEUE: 'deploy-requests' },
        queueConsumers: { 'deploy-requests': { maxBatchSize: 1, maxBatchTimeout: 1, maxRetries: 5, deadLetterQueue: 'deploy-requests-dlq' } },
        serviceBindings: { AUTHORIZER: { name: 'authorizer', entrypoint: 'Authorizer' } },
        secretsStoreSecrets: {
          GITHUB_APP_KEY: { store_id: STORE, secret_name: 'DEPLOYER_GITHUB_APP_KEY' },
          WORKER_PROSRUS_API: { store_id: STORE, secret_name: 'WORKER_PROSRUS_API' },
        },
        outboundService: internet,
      },
      {
        name: 'fake-runner',
        ...compat,
        modules: [{ type: 'ESModule', path: 'fake-runner.js', contents: readFileSync(join(here, 'fake-runner.js'), 'utf8') }],
        durableObjects: { JOBS: { className: 'FakeRunnerJob', useSQLite: true } },
        r2Buckets: { STAGING: 'release-staging' },
      },
    ],
  }));
  t.after(() => mf.dispose());

  const secret = async (binding: string, worker: string, value: string) => (await mf.getSecretsStoreSecretAPI(binding, worker))().create(value);
  await secret('GITHUB_APP_KEY', 'authorizer', appKey());
  await secret('GITHUB_APP_KEY', 'deployer', appKey());
  await secret('WORKER_PROSRUS_API', 'deployer', 'cf-token-prosrus-api');
  const registry = registryDoc() as any;
  registry.applications[0].environments[0].targets[0].health = { origin: ORIGIN, timeoutMs: 2000, attempts: 3, intervalMs: 1000 };
  await (await mf.getKVNamespace('REGISTRY', 'deployer')).put('registry', canonicalBytes(registry));

  const call = async (token: string, action: string, subject: unknown) => {
    const response = await mf.dispatchFetch('https://services.susanb.dev/v1/token', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, subject }),
      redirect: 'manual',
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const deploy = async (tag: string, overrides: Record<string, unknown> = {}) =>
    call(await oidcToken(overrides), 'deploy', { application: 'prosrus', environment: 'production', releaseTag: tag });
  const waitFor = async (deploymentId: string) => {
    for (let i = 0; i < 240; i++) {
      const reply = await call(await oidcToken(), 'deploy.status', { application: 'prosrus', environment: 'production', deploymentId });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      if (['SUCCEEDED', 'ROLLED_BACK', 'RECOVERY_FAILED', 'REJECTED'].includes(reply.body.phase)) return reply.body;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('deployment did not finish in time');
  };

  // 1. The release workflow published v1.0.0 for the commit at the head of main.
  const v1 = await buildRelease('v1.0.0');
  github.publish(v1);

  // 2. The deploy workflow trades its OIDC token.
  const admitted = await deploy('v1.0.0');
  assert.equal(admitted.status, 202, `${JSON.stringify(admitted.body)} ${edgeErrors.join('\n')}`);
  assert.equal(admitted.body.status, 'QUEUED');

  // 3. The queue, the coordinator, the runner and the adapter take it from there.
  const done = await waitFor(admitted.body.deploymentId);
  assert.equal(done.phase, 'SUCCEEDED', JSON.stringify(done.lastError));
  assert.equal(done.generation, 1);
  assert.equal(cf.activeRelease('prosrus-api'), 'v1.0.0', 'the new code is serving');
  const pointer = await (await mf.getR2Bucket('STATE', 'deployer')).get('pointers/prosrus/production/current.json');
  assert.equal(JSON.parse(await pointer.text()).release.tag, 'v1.0.0');
  assert.ok(await (await mf.getR2Bucket('RELEASES', 'deployer')).head('releases/prosrus/v1.0.0/release.zip'), 'release kept in the immutable bucket');
  assert.equal(github.statuses.at(-1)?.state, 'success');
  assert.equal(github.deployments[0]?.ref, COMMIT);

  // Replays and stale or wrong requests never reach the deployer.
  const token = await oidcToken();
  await call(token, 'deploy', { application: 'prosrus', environment: 'production', releaseTag: 'v1.0.0' });
  assert.deepEqual(await call(token, 'deploy', { application: 'prosrus', environment: 'production', releaseTag: 'v1.0.0' }), { status: 403, body: { error: 'replay' } });
  assert.equal((await deploy('v1.0.0', { aud: 'someone-else' })).body.error, 'bad_aud');
  assert.equal((await deploy('v1.0.0', { job_workflow_ref: `${REPO}/.github/workflows/deploy.yml@refs/heads/main` })).body.error, 'bad_workflow');
  assert.equal((await deploy('v1.0.0')).body.status, 'ALREADY_CURRENT');

  // 4. The next release is unhealthy: it is rolled back automatically and GitHub says so.
  const v2 = await buildRelease('v1.1.0');
  github.publish(v2);
  cf.unhealthy.add('v1.1.0');
  const second = await deploy('v1.1.0');
  assert.equal(second.status, 202, JSON.stringify(second.body));
  const rolled = await waitFor(second.body.deploymentId);
  assert.equal(rolled.phase, 'ROLLED_BACK');
  assert.equal(rolled.lastError?.code, 'health_failed');
  assert.equal(cf.activeRelease('prosrus-api'), 'v1.0.0', 'the previous code is serving again');
  assert.equal(github.statuses.at(-1)?.state, 'failure');

  // 5. An older release than the committed one is refused.
  const v0 = await buildRelease('v0.9.0');
  github.publish(v0);
  const stale = await deploy('v0.9.0');
  assert.deepEqual(stale, { status: 409, body: { error: 'rejected', reason: 'stale_release' } });

  assert.deepEqual(blocked, [], 'no request left the faked edge');
  assert.deepEqual(edgeErrors, []);
});
