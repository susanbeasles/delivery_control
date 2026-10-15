import { sha256Hex, canonicalBytes } from '../../../worker/lib/json.ts';
import { buildZip } from './zip-builder.ts';
import { COMMIT, manifestDoc, workerArtifactDoc } from './fixtures.ts';
import type { AssetRef } from '../../../worker/contracts/subject.ts';
import type { RunnerJobRequest, RunnerJobStatus } from '../../../worker/runner/api.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ManualClock {
  t: number;
  constructor(start = Date.parse('2026-10-15T12:00:00.000Z')) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return enc.encode(value);
  if (value && typeof (value as ReadableStream).getReader === 'function') return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  throw new Error('unsupported body');
}

function hexToBuffer(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  sha256: string | null;
}

/** In-memory R2 with the semantics the code relies on: checksums, conditional writes, ranges, locks. */
export class FakeBucket {
  readonly objects = new Map<string, StoredObject>();
  readonly lockedPrefixes: string[];
  puts = 0;
  private seq = 0;

  constructor(lockedPrefixes: string[] = []) {
    this.lockedPrefixes = lockedPrefixes;
  }

  private meta(key: string, o: StoredObject) {
    return { key, size: o.bytes.byteLength, etag: o.etag, httpEtag: `"${o.etag}"`, checksums: o.sha256 ? { sha256: hexToBuffer(o.sha256) } : {} };
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? this.meta(key, o) : null;
  }

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const o = this.objects.get(key);
    if (!o) return null;
    let bytes = o.bytes;
    if (options?.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
    const copy = bytes.slice();
    return {
      ...this.meta(key, o),
      body: new Blob([copy]).stream(),
      arrayBuffer: async () => copy.slice().buffer,
      text: async () => dec.decode(copy),
    };
  }

  async put(key: string, value: unknown, options: { sha256?: string; onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string } } = {}) {
    const bytes = await toBytes(value);
    const actual = await sha256Hex(bytes);
    if (options.sha256 && options.sha256 !== actual) throw new Error('The SHA-256 checksum you specified did not match what we received');
    const existing = this.objects.get(key);
    if (options.onlyIf?.etagDoesNotMatch === '*' && existing) return null;
    if (options.onlyIf?.etagMatches !== undefined && existing?.etag !== options.onlyIf.etagMatches) return null;
    if (existing && this.lockedPrefixes.some((p) => key.startsWith(p))) throw new Error('object is locked');
    const stored = { bytes, etag: `etag-${++this.seq}`, sha256: options.sha256 ?? null };
    this.objects.set(key, stored);
    this.puts++;
    return this.meta(key, stored);
  }

  json(key: string): any {
    const o = this.objects.get(key);
    return o ? JSON.parse(dec.decode(o.bytes)) : undefined;
  }

  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

interface FakeVersion {
  id: string;
  message: string;
  tag: string;
  releaseTag: string | null;
  bindings: Array<Record<string, string>>;
  modules: string[];
}

interface FakeScript {
  versions: FakeVersion[]; // newest first
  active: string | null;
  deployments: number;
  subdomainEnabled: boolean;
}

/** A fake Cloudflare Workers API plus the health endpoint of whatever version is active. */
export class FakeCloudflare {
  readonly scripts = new Map<string, FakeScript>();
  readonly calls: string[] = [];
  /** script → the token it accepts. */
  readonly tokens = new Map<string, string>();
  /** Releases whose health endpoint fails. */
  readonly unhealthy = new Set<string>();
  /** One-shot fault injected after a matching call succeeds on the server. */
  failAfter: { method: string; suffix: string } | null = null;
  private seq = 0;
  readonly account: string;
  readonly healthOrigin: string;
  readonly healthScript: string;

  constructor(account: string, healthOrigin: string, healthScript: string) {
    this.account = account;
    this.healthOrigin = healthOrigin;
    this.healthScript = healthScript;
  }

  private json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private ok(result: unknown) {
    return this.json(200, { success: true, errors: [], messages: [], result });
  }

  fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as string, init);
    const url = new URL(request.url);
    if (url.origin === this.healthOrigin) return this.health(url);
    const prefix = `/client/v4/accounts/${this.account}/workers/scripts/`;
    if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith(prefix)) return new Response('no route', { status: 599 });
    const [name, ...rest] = url.pathname.slice(prefix.length).split('/');
    const sub = rest.join('/');
    const call = `${request.method} ${name}${sub ? '/' + sub : ''}`;
    this.calls.push(call);
    if (request.headers.get('authorization') !== `Bearer ${this.tokens.get(name!)}`) return this.json(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    const response = await this.route(request, name!, sub);
    if (this.failAfter && request.method === this.failAfter.method && call.endsWith(this.failAfter.suffix)) {
      this.failAfter = null;
      throw new TypeError('network connection lost'); // the server applied the change, the client never heard
    }
    return response;
  };

  private async route(request: Request, name: string, sub: string): Promise<Response> {
    const script = this.scripts.get(name);
    const notFound = () => this.json(404, { success: false, errors: [{ code: 10007, message: 'This Worker does not exist' }] });
    if (request.method === 'PUT' && sub === '') {
      const v = await this.version(request);
      this.scripts.set(name, { versions: [v], active: v.id, deployments: 1, subdomainEnabled: true });
      return this.ok({ id: name });
    }
    if (!script) return notFound();
    if (request.method === 'GET' && sub === 'deployments') {
      return this.ok({ deployments: script.active ? [{ id: `dep-${script.deployments}`, versions: [{ version_id: script.active, percentage: 100 }] }] : [] });
    }
    if (request.method === 'GET' && sub === 'versions') {
      return this.ok({ items: script.versions.map((v) => ({ id: v.id, annotations: { 'workers/message': v.message, 'workers/tag': v.tag } })) });
    }
    if (request.method === 'POST' && sub === 'versions') {
      const v = await this.version(request);
      script.versions.unshift(v);
      return this.ok({ id: v.id, number: script.versions.length });
    }
    if (request.method === 'POST' && sub === 'deployments') {
      const body = (await request.json()) as any;
      const versionId = body.versions[0].version_id;
      if (!script.versions.some((v) => v.id === versionId) || body.versions[0].percentage !== 100 || body.strategy !== 'percentage') return this.json(400, { success: false, errors: [{ code: 1, message: 'bad deployment' }] });
      script.active = versionId;
      script.deployments++;
      return this.ok({ id: `dep-${script.deployments}` });
    }
    if (request.method === 'POST' && sub === 'subdomain') {
      const body = (await request.json()) as any;
      script.subdomainEnabled = body.enabled;
      return this.ok({ enabled: body.enabled });
    }
    return this.json(400, { success: false, errors: [{ code: 2, message: `unexpected ${request.method} ${sub}` }] });
  }

  private async version(request: Request): Promise<FakeVersion> {
    const form = await request.formData();
    const metadata = JSON.parse(await (form.get('metadata') as Blob).text());
    const modules = [...form.keys()].filter((k) => k !== 'metadata');
    if (!modules.includes(metadata.main_module)) throw new Error('main module missing from upload');
    const tagBinding = metadata.bindings.find((b: any) => b.name === 'DEPLOY_RELEASE_TAG');
    const n = ++this.seq;
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      message: metadata.annotations['workers/message'],
      tag: metadata.annotations['workers/tag'],
      releaseTag: tagBinding?.text ?? null,
      bindings: metadata.bindings,
      modules,
    };
  }

  private health(url: URL): Response {
    const script = this.scripts.get(this.healthScript);
    const active = script?.versions.find((v) => v.id === script.active);
    if (!active || url.pathname !== '/healthz') return new Response('not found', { status: 404 });
    if (active.releaseTag && this.unhealthy.has(active.releaseTag)) return this.json(500, { release: active.releaseTag, ok: false });
    return this.json(200, { release: active.releaseTag });
  }

  activeRelease(script: string): string | null {
    const s = this.scripts.get(script);
    return s?.versions.find((v) => v.id === s.active)?.releaseTag ?? null;
  }
}

export interface BuiltRelease {
  tag: string;
  bytes: Record<'release.manifest.json' | 'release.zip' | 'attestation.sigstore.json', Uint8Array>;
  assets: { manifest: AssetRef; archive: AssetRef; attestation: AssetRef };
}

let assetIds = 100;

export async function buildRelease(tag: string, options: { targets?: Array<{ id: string; bindings?: string[] }>; tamperModule?: boolean } = {}): Promise<BuiltRelease> {
  const targets = options.targets ?? [{ id: 'api', bindings: ['DB'] }];
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const manifestTargets = [];
  for (const t of targets) {
    const code = enc.encode(`export default { fetch(_r, env) { return Response.json({ release: env.DEPLOY_RELEASE_TAG }) } } // ${tag}`);
    const artifact = canonicalBytes(workerArtifactDoc([{ name: 'index.js', path: `targets/${t.id}/index.js`, type: 'esm', sha256: await sha256Hex(code) }], t.bindings ?? ['DB']));
    entries.push({ name: `targets/${t.id}/worker-artifact.json`, data: artifact });
    entries.push({ name: `targets/${t.id}/index.js`, data: options.tamperModule ? enc.encode('tampered') : code });
    manifestTargets.push({ id: t.id, adapter: 'cloudflare-worker/v1', artifactPath: `targets/${t.id}/worker-artifact.json`, sha256: await sha256Hex(artifact), dependsOn: [], healthContract: { path: '/healthz', expectStatus: 200, expectReleaseTag: true } });
  }
  const zip = await buildZip(entries);
  const manifest = canonicalBytes(manifestDoc(await sha256Hex(zip), zip.byteLength, manifestTargets, { releaseTag: tag, sourceCommit: COMMIT }));
  const attestation = enc.encode(JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', tag }));
  const ref = async (b: Uint8Array): Promise<AssetRef> => ({ id: assetIds++, sha256: await sha256Hex(b), size: b.byteLength });
  return {
    tag,
    bytes: { 'release.manifest.json': manifest, 'release.zip': zip, 'attestation.sigstore.json': attestation },
    assets: { manifest: await ref(manifest), archive: await ref(zip), attestation: await ref(attestation) },
  };
}

/** A runner whose `release.verify` behaves as configured. */
export class FakeRunner {
  readonly jobs = new Map<string, { request: RunnerJobRequest; polls: number }>();
  mode: 'pass' | 'fail' | { runningPolls: number } = 'pass';
  signerWorkflow = 'susanbeasles/workflow_depot/.github/workflows/release.yml';

  submit = async (request: RunnerJobRequest): Promise<RunnerJobStatus> => {
    const existing = this.jobs.get(request.jobId);
    if (existing && JSON.stringify(existing.request) !== JSON.stringify(request)) throw new Error('job_conflict');
    if (!existing) this.jobs.set(request.jobId, { request, polls: 0 });
    return this.view(request.jobId);
  };

  status = async (jobId: string): Promise<RunnerJobStatus | null> => (this.jobs.has(jobId) ? this.view(jobId) : null);

  private view(jobId: string): RunnerJobStatus {
    const job = this.jobs.get(jobId)!;
    job.polls++;
    const base = { jobId, type: job.request.type, logKey: null, submittedAt: '2026-10-15T12:00:00.000Z', finishedAt: null };
    if (typeof this.mode === 'object' && job.polls <= this.mode.runningPolls) return { ...base, state: 'running', result: null, error: null };
    if (this.mode === 'fail') return { ...base, state: 'failed', result: null, error: { code: 'attestation_rejected', message: 'signer mismatch' }, finishedAt: base.submittedAt };
    const input = job.request.input as any;
    return {
      ...base,
      state: 'succeeded',
      error: null,
      finishedAt: base.submittedAt,
      result: {
        verified: true,
        subjects: input.files.filter((f: any) => f.name !== 'attestation.sigstore.json').map((f: any) => ({ name: f.name, sha256: f.sha256 })),
        signerWorkflow: `https://github.com/${this.signerWorkflow}@refs/heads/main`,
        sourceRepository: `https://github.com/${input.repository}`,
        sourceDigest: input.sourceCommit,
        sourceRef: 'refs/heads/main',
        verifier: 'fake',
      },
    };
  }
}

export class FakeQueue {
  readonly sent: Array<{ body: any; delaySeconds: number }> = [];
  failNext = 0;
  send = async (body: any, delaySeconds: number) => {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('queue unavailable');
    }
    this.sent.push({ body, delaySeconds });
  };
}

export class FakeGitHub {
  readonly deployments: Array<{ id: number; environment: string; ref: string }> = [];
  readonly statuses: Array<{ id: number; state: string; description: string }> = [];
  createDeployment = async (input: { environment: string; ref: string }) => {
    const id = 5000 + this.deployments.length;
    this.deployments.push({ id, environment: input.environment, ref: input.ref });
    return id;
  };
  createStatus = async (input: { githubDeploymentId: number; state: string; description: string }) => {
    this.statuses.push({ id: input.githubDeploymentId, state: input.state, description: input.description });
  };
}
