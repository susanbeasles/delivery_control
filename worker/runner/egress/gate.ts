import { DeployError, summarize } from '../../lib/errors.ts';
import { readBounded, type Fetcher } from '../../lib/fetch.ts';
import { isPlainObject } from '../../lib/json.ts';
import { log, type Clock } from '../../lib/runtime.ts';
import { PATTERNS } from '../../lib/validate.ts';
import type { RunnerJobType } from '../api.ts';
import type { PlanBucket } from '../plan-store.ts';
import { JOB_TYPES } from '../profiles.ts';
import { decide, redirectAllowed, type EgressContext, type EgressRule } from './rules.ts';
import { signV4, UNSIGNED_PAYLOAD, type SigV4Credentials } from './sigv4.ts';

/**
 * The egress gate: every HTTP(S) request a runner container makes arrives here (the container
 * starts with the internet disabled and all hosts intercepted). Deny by default. For an allowed
 * request the gate drops every header the container sent except a small per-destination
 * allowlist, injects the credential for that destination, forwards without following redirects,
 * and refuses any redirect whose target is not itself allowed.
 */

export interface GateDeps {
  /** The job's context from its Durable Object, or `null` when the job is not running. */
  context(jobId: string): Promise<EgressContext | null>;
  cloudflareToken(type: RunnerJobType): Promise<string>;
  stateCredentials(type: RunnerJobType): Promise<SigV4Credentials>;
  fetcher: Fetcher;
  plans: PlanBucket;
  clock: Clock;
}

export interface GateProps {
  jobId: string;
  type: RunnerJobType;
}

const API_HEADERS = ['accept', 'content-type', 'user-agent'];
const S3_HEADERS = ['content-type', 'content-md5', 'if-none-match', 'if-match', 'if-modified-since', 'if-unmodified-since', 'range'];
const API_BODY_BYTES = 8 * 1024 * 1024;
const STATE_BODY_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;

export async function handleEgress(request: Request, rawProps: unknown, deps: GateDeps): Promise<Response> {
  const props = parseProps(rawProps);
  if (props === null) return deny(403, 'gate_props_invalid');
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return deny(403, 'url_invalid');
  }
  const ctx = await deps.context(props.jobId).catch(() => null);
  if (ctx === null || ctx.type !== props.type || ctx.jobId !== props.jobId) return denied(props, request.method, url, 'job_not_running');
  const decision = decide(ctx, request.method, url);
  if (!decision.allow) return denied(props, request.method, url, decision.reason);
  try {
    const response = await forward(request, url, ctx, decision.rule, deps);
    log('info', 'egress.allowed', { jobId: props.jobId, rule: decision.rule.name, method: request.method, status: response.status });
    return response;
  } catch (error) {
    const s = summarize(error);
    log('warn', 'egress.failed', { jobId: props.jobId, rule: decision.rule.name, method: request.method, code: s.code });
    return deny(s.code === 'egress_body_too_large' ? 413 : 502, s.code);
  }
}

async function forward(request: Request, url: URL, ctx: EgressContext, rule: EgressRule, deps: GateDeps): Promise<Response> {
  switch (rule.kind) {
    case 'artifact-put':
      return putArtifact(request, rule, deps.plans);
    case 'artifact-get':
      return getArtifact(rule, deps.plans);
    case 'cloudflare-api': {
      const headers = pick(request.headers, API_HEADERS);
      headers['authorization'] = `Bearer ${await deps.cloudflareToken(ctx.type)}`;
      const body = await bodyOf(request, API_BODY_BYTES);
      return upstream(deps.fetcher, ctx, request.method, url, headers, body);
    }
    case 'r2-state':
    case 'r2-archive': {
      // Chunked SigV4 payloads cannot be re-signed with UNSIGNED-PAYLOAD; the backend runs with
      // `skip_s3_checksum`, so a client sending them is misconfigured or not ours.
      const encoding = request.headers.get('content-encoding') ?? '';
      const declared = request.headers.get('x-amz-content-sha256') ?? '';
      if (/aws-chunked/i.test(encoding) || declared.startsWith('STREAMING-') || request.headers.has('x-amz-decoded-content-length')) {
        throw new DeployError('egress_chunked_refused', 'aws-chunked uploads are not accepted');
      }
      const headers = pick(request.headers, S3_HEADERS);
      // Archives are create-only regardless of what the client asked for (the bucket is also locked).
      if (rule.kind === 'r2-archive') headers['if-none-match'] = '*';
      headers['x-amz-content-sha256'] = UNSIGNED_PAYLOAD;
      const body = await bodyOf(request, STATE_BODY_BYTES);
      const signed = await signV4(
        { method: request.method, url, headers, payloadHash: UNSIGNED_PAYLOAD, region: 'auto', service: 's3', now: new Date(deps.clock.now()) },
        await deps.stateCredentials(ctx.type),
      );
      delete signed.headers['host'];
      return upstream(deps.fetcher, ctx, request.method, url, signed.headers, body);
    }
  }
}

async function upstream(fetcher: Fetcher, ctx: EgressContext, method: string, url: URL, headers: Record<string, string>, body: Uint8Array | null): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url.toString(), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (cause) {
    throw new DeployError('egress_upstream_failed', `request to ${url.hostname} failed`, { cause });
  }
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    if (!redirectAllowed(ctx, method, response.status, response.headers.get('location'), url)) {
      await response.body?.cancel();
      log('warn', 'egress.redirect_refused', { jobId: ctx.jobId, host: url.hostname, status: response.status });
      return deny(502, 'redirect_refused');
    }
  }
  const out = new Headers(response.headers);
  out.delete('set-cookie');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

async function putArtifact(request: Request, rule: EgressRule, plans: PlanBucket): Promise<Response> {
  const artifact = rule.artifact;
  if (!artifact) throw new DeployError('internal', 'artifact rule without a key');
  const bytes = await bodyOf(request, artifact.maxBytes);
  if (bytes === null || bytes.byteLength === 0) return deny(400, 'artifact_empty');
  const created = await plans.put(artifact.key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/octet-stream' } });
  if (created === null) return deny(409, 'artifact_exists');
  return new Response(null, { status: 201 });
}

async function getArtifact(rule: EgressRule, plans: PlanBucket): Promise<Response> {
  const artifact = rule.artifact;
  if (!artifact) throw new DeployError('internal', 'artifact rule without a key');
  const object = await plans.get(artifact.key);
  if (!object) return deny(404, 'artifact_missing');
  if (object.size > artifact.maxBytes) {
    await object.body.cancel();
    return deny(413, 'artifact_too_large');
  }
  return new Response(object.body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(object.size) } });
}

/** Only the named headers survive; everything else the container sent (Authorization included) is dropped. */
function pick(headers: Headers, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of allowed) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

async function bodyOf(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new DeployError('egress_body_too_large', `request body exceeds ${maxBytes} bytes`);
  return readBounded(request.body, maxBytes, 'egress_body_too_large');
}

function parseProps(value: unknown): GateProps | null {
  if (!isPlainObject(value)) return null;
  const { jobId, type } = value;
  if (typeof jobId !== 'string' || !PATTERNS.uuidv7.test(jobId)) return null;
  if (typeof type !== 'string' || !(JOB_TYPES as string[]).includes(type)) return null;
  return { jobId, type: type as RunnerJobType };
}

function denied(props: GateProps, method: string, url: URL, reason: string): Response {
  log('warn', 'egress.denied', { jobId: props.jobId, type: props.type, method, host: url.hostname, path: url.pathname.slice(0, 200), reason });
  return deny(403, reason);
}

function deny(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}
