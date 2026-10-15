import type { RunnerJobType } from '../api.ts';
import { ARTIFACT_HOST } from '../limits.ts';
import { JOB_PROFILES, type StackName } from '../profiles.ts';

/**
 * The egress allowlist, as data. Every request leaving a runner container is matched against the
 * rules for its job type; the first rule whose host, method, path and query all match decides how
 * the gate forwards it and which credential it injects. No match means 403.
 *
 * Rules are computed per job from its validated context (stack, tree, job id, account), so paths
 * are exact strings, never prefixes chosen by the container.
 */

export interface EgressContext {
  jobId: string;
  type: RunnerJobType;
  stack: StackName | null;
  treeSha: string | null;
  accountId: string;
}

export type RuleKind =
  /** Forward to api.cloudflare.com with the job type's Cloudflare bearer token. */
  | 'cloudflare-api'
  /** Forward to the account's R2 S3 endpoint, re-signed with the job type's state credential. */
  | 'r2-state'
  /** Same, and the gate forces `if-none-match: *` so archives are create-only. */
  | 'r2-archive'
  /** Served by the gate from the `tf-plans` bucket; never forwarded. */
  | 'artifact-put'
  | 'artifact-get';

export interface EgressRule {
  /** Stable name for logs and tests. */
  name: string;
  kind: RuleKind;
  host: string;
  methods: readonly string[];
  /** Exact pathname, as sent (percent-encoded paths never match). */
  paths: readonly string[];
  query: QueryRule;
  /** For artifacts: the object key in `tf-plans` and the size limit. */
  artifact?: { key: string; maxBytes: number };
}

/** `none`: no query string at all. `object`: only `x-id`. `list`: the s3 backend's workspace listing. */
export type QueryRule = 'none' | 'any' | 'object' | 'list';

export const CLOUDFLARE_API_HOST = 'api.cloudflare.com';
export const STATE_BUCKET = 'tf-state';
export const ARCHIVE_BUCKET = 'tf-state-archive';

/** Artifact names a plan job may write, with their size limits. */
export const PLAN_ARTIFACTS: Readonly<Record<string, number>> = {
  'plan.tfplan': 64 * 1024 * 1024,
  'plan.json': 64 * 1024 * 1024,
  'summary.json': 256 * 1024,
};

export function r2Host(accountId: string): string {
  return `${accountId}.r2.cloudflarestorage.com`;
}

export function stateKey(stack: StackName): string {
  return `${stack}/terraform.tfstate`;
}

export function planObjectKey(stack: StackName, treeSha: string, name: string): string {
  return `${stack}/${treeSha}/${name}`;
}

export function archiveKey(stack: StackName, treeSha: string, jobId: string, phase: 'before' | 'after'): string {
  return `${stack}/${treeSha}/${jobId}/${phase}.tfstate`;
}

export function rulesFor(ctx: EgressContext): EgressRule[] {
  const profile = JOB_PROFILES[ctx.type];
  // release.verify has no rules at all: attestation verification is offline.
  if (profile.cloudflare === null || profile.state === null || ctx.stack === null || ctx.treeSha === null) return [];
  const rules: EgressRule[] = [];
  const r2 = r2Host(ctx.accountId);
  const state = `/${STATE_BUCKET}/${stateKey(ctx.stack)}`;

  rules.push({ name: 'cloudflare-api', kind: 'cloudflare-api', host: CLOUDFLARE_API_HOST, methods: profile.cloudflare.methods, paths: [], query: 'any' });
  // `tofu init` lists workspaces under the default `env:` prefix; nothing is stored there.
  rules.push({ name: 'state-workspaces', kind: 'r2-state', host: r2, methods: ['GET'], paths: [`/${STATE_BUCKET}`, `/${STATE_BUCKET}/`], query: 'list' });
  if (profile.state.access === 'read') {
    rules.push({ name: 'state-read', kind: 'r2-state', host: r2, methods: ['GET', 'HEAD'], paths: [state], query: 'object' });
  } else {
    rules.push({ name: 'state-write', kind: 'r2-state', host: r2, methods: ['GET', 'HEAD', 'PUT'], paths: [state], query: 'object' });
    rules.push({ name: 'state-lock', kind: 'r2-state', host: r2, methods: ['GET', 'HEAD', 'PUT', 'DELETE'], paths: [`${state}.tflock`], query: 'object' });
    rules.push({
      name: 'state-archive',
      kind: 'r2-archive',
      host: r2,
      methods: ['PUT'],
      paths: (['before', 'after'] as const).map((phase) => `/${ARCHIVE_BUCKET}/${archiveKey(ctx.stack as StackName, ctx.treeSha as string, ctx.jobId, phase)}`),
      query: 'object',
    });
  }

  if (profile.operation === 'plan') {
    for (const [name, maxBytes] of Object.entries(PLAN_ARTIFACTS)) {
      rules.push({
        name: `artifact-put:${name}`,
        kind: 'artifact-put',
        host: ARTIFACT_HOST,
        methods: ['PUT'],
        paths: [`/${name}`],
        query: 'none',
        artifact: { key: planObjectKey(ctx.stack, ctx.treeSha, name), maxBytes },
      });
    }
  } else {
    rules.push({
      name: 'artifact-get:plan.tfplan',
      kind: 'artifact-get',
      host: ARTIFACT_HOST,
      methods: ['GET'],
      paths: ['/plan.tfplan'],
      query: 'none',
      artifact: { key: planObjectKey(ctx.stack, ctx.treeSha, 'plan.tfplan'), maxBytes: PLAN_ARTIFACTS['plan.tfplan'] ?? 0 },
    });
  }
  return rules;
}

export type Decision = { allow: true; rule: EgressRule } | { allow: false; reason: string };

/** Pure decision for one request. `url` must already be parsed; the gate checks scheme and port. */
export function decide(ctx: EgressContext, method: string, url: URL): Decision {
  if (url.protocol !== 'https:') return { allow: false, reason: 'scheme_not_allowed' };
  if (url.username !== '' || url.password !== '' || url.port !== '') return { allow: false, reason: 'authority_not_allowed' };
  const verb = method.toUpperCase();
  const candidates = rulesFor(ctx).filter((r) => r.host === url.hostname);
  if (candidates.length === 0) return { allow: false, reason: 'host_not_allowed' };
  for (const rule of candidates) {
    if (!rule.methods.includes(verb)) continue;
    if (!pathMatches(rule, url.pathname)) continue;
    if (!queryMatches(rule.query, url.search)) continue;
    return { allow: true, rule };
  }
  return { allow: false, reason: 'request_not_allowed' };
}

function pathMatches(rule: EgressRule, pathname: string): boolean {
  if (rule.kind === 'cloudflare-api') return pathname.startsWith('/client/v4/') && !/(?:^|\/)\.{1,2}(?:\/|$)|%2e|%2f|%5c/i.test(pathname);
  // Object paths are compared byte for byte; an encoded path can never equal an allowed key.
  return rule.paths.includes(pathname);
}

const OBJECT_OPERATIONS = new Set(['GetObject', 'HeadObject', 'PutObject', 'DeleteObject']);
const LIST_PARAMETERS = new Set(['list-type', 'prefix', 'max-keys', 'continuation-token', 'encoding-type', 'start-after', 'delimiter', 'fetch-owner', 'x-id']);

export function queryMatches(rule: QueryRule, search: string): boolean {
  if (rule === 'any') return true;
  const params = parseQuery(search);
  if (params === null) return false;
  if (rule === 'none') return params.length === 0;
  if (rule === 'object') return params.every(([name, value]) => name === 'x-id' && OBJECT_OPERATIONS.has(value));
  // list: ListObjectsV2 restricted to the workspace prefix, which never holds this stack's state.
  const names = params.map(([name]) => name);
  if (new Set(names).size !== names.length) return false;
  if (!params.every(([name]) => LIST_PARAMETERS.has(name))) return false;
  const get = (name: string): string | undefined => params.find(([n]) => n === name)?.[1];
  return get('list-type') === '2' && get('prefix') === 'env:/' && (get('x-id') ?? 'ListObjectsV2') === 'ListObjectsV2';
}

function parseQuery(search: string): Array<[string, string]> | null {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw === '') return [];
  const out: Array<[string, string]> = [];
  for (const part of raw.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    try {
      out.push([decodeURIComponent(eq === -1 ? part : part.slice(0, eq)), decodeURIComponent(eq === -1 ? '' : part.slice(eq + 1))]);
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * A 3xx is passed back to the container only when its target would itself be allowed for the same
 * job (307/308 keep the method, other redirects become GET). Anything else is refused by the gate.
 */
export function redirectAllowed(ctx: EgressContext, method: string, status: number, location: string | null, base: URL): boolean {
  if (location === null) return false;
  let target: URL;
  try {
    target = new URL(location, base);
  } catch {
    return false;
  }
  const nextMethod = status === 307 || status === 308 ? method : 'GET';
  const decision = decide(ctx, nextMethod, target);
  return decision.allow && decision.rule.kind !== 'artifact-put' && decision.rule.kind !== 'artifact-get';
}
