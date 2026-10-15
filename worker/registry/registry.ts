import { fail } from '../lib/errors.ts';
import { parseStrictJsonBytes, type Json } from '../lib/json.ts';
import { PATTERNS, Shape } from '../lib/validate.ts';

/**
 * `deploy-registry/v1` (CONTRACTS.md section 5). Terraform writes it; the deployer only reads it.
 * Validation is fatal and total: one bad target invalidates the whole registry, and a deployment
 * against an invalid registry does not start.
 */

export type BindingType =
  | 'plain_text'
  | 'd1'
  | 'kv_namespace'
  | 'r2_bucket'
  | 'service'
  | 'queue'
  | 'secrets_store_secret'
  | 'durable_object_namespace'
  | 'version_metadata';

/** Cloudflare Workers API binding object, exactly as sent in version metadata. */
export type ApiBinding = { name: string; type: BindingType } & Record<string, string>;

export interface HealthSettings {
  origin: string;
  timeoutMs: number;
  attempts: number;
  intervalMs: number;
}

export interface RegistryTarget {
  id: string;
  adapter: 'cloudflare-worker/v1';
  scriptName: string;
  credential: string;
  health: HealthSettings;
  bindings: ApiBinding[];
  keepBindings: Array<'secret_text' | 'secret_key'>;
}

export interface RegistryEnvironment {
  environment: string;
  githubEnvironment: string;
  targets: RegistryTarget[];
}

export interface RegistryApplication {
  application: string;
  repository: string;
  repositoryId: number;
  releaseWorkflow: string;
  maxArtifactBytes: number;
  environments: RegistryEnvironment[];
}

export interface Registry {
  schema: 'deploy-registry/v1';
  revision: number;
  accountId: string;
  applications: RegistryApplication[];
}

const CODE = 'registry_invalid';
export const MAX_REGISTRY_BYTES = 512 * 1024;
export const FORBIDDEN_SCRIPTS = new Set(['deployer', 'authorizer', 'root-runner']);
const RESERVED_ADAPTERS = new Set(['cloudflare-d1-migrate/v1', 'static-assets/v1', 'host-agent/v1']);

/** Fields each binding type requires beyond `name` and `type`, and those it may carry. */
const BINDING_FIELDS: Record<BindingType, { required: string[]; optional: string[]; patterns: Record<string, RegExp> }> = {
  plain_text: { required: ['text'], optional: [], patterns: { text: /^[\x20-\x7e]{0,1024}$/ } },
  d1: { required: ['id'], optional: [], patterns: { id: PATTERNS.uuid } },
  kv_namespace: { required: ['namespace_id'], optional: [], patterns: { namespace_id: PATTERNS.hex32 } },
  r2_bucket: { required: ['bucket_name'], optional: [], patterns: { bucket_name: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/ } },
  service: { required: ['service'], optional: ['entrypoint'], patterns: { service: PATTERNS.scriptName, entrypoint: /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/ } },
  queue: { required: ['queue_name'], optional: [], patterns: { queue_name: /^[a-z0-9][a-z0-9-]{0,62}$/ } },
  secrets_store_secret: {
    required: ['store_id', 'secret_name'],
    optional: [],
    patterns: { store_id: PATTERNS.hex32, secret_name: /^[A-Za-z0-9_-]{1,255}$/ },
  },
  durable_object_namespace: {
    required: ['class_name'],
    optional: ['script_name'],
    patterns: { class_name: /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/, script_name: PATTERNS.scriptName },
  },
  version_metadata: { required: [], optional: [], patterns: {} },
};

export function parseRegistryBytes(bytes: Uint8Array): Registry {
  return parseRegistry(parseStrictJsonBytes(bytes, MAX_REGISTRY_BYTES, CODE));
}

export function parseRegistry(value: Json): Registry {
  const s = new Shape(value, CODE, 'registry', ['schema', 'revision', 'accountId', 'applications']);
  s.literal('schema', 'deploy-registry/v1');
  const applications = s.array('applications', 0, 200).map((raw, index) => parseApplication(raw, index));
  unique(applications.map((a) => a.application), 'application names');
  unique(applications.map((a) => String(a.repositoryId)), 'repository ids');
  const scripts = applications.flatMap((a) => a.environments.flatMap((e) => e.targets.map((t) => t.scriptName)));
  unique(scripts, 'script names (one script belongs to exactly one application environment target)');
  const credentials = applications.flatMap((a) => a.environments.flatMap((e) => e.targets.map((t) => t.credential)));
  unique(credentials, 'credential bindings (one credential per script)');
  return {
    schema: 'deploy-registry/v1',
    revision: s.int('revision', 1, Number.MAX_SAFE_INTEGER),
    accountId: s.string('accountId', PATTERNS.hex32),
    applications,
  };
}

function parseApplication(raw: unknown, index: number): RegistryApplication {
  const a = new Shape(raw, CODE, `registry.applications[${index}]`, [
    'application',
    'repository',
    'repositoryId',
    'releaseWorkflow',
    'maxArtifactBytes',
    'environments',
  ]);
  const environments = a.array('environments', 1, 16).map((e, k) => parseEnvironment(e, `${a.path}.environments[${k}]`));
  unique(environments.map((e) => e.environment), `${a.path} environments`);
  return {
    application: a.string('application', PATTERNS.application),
    repository: a.string('repository', PATTERNS.repository),
    repositoryId: a.int('repositoryId', 1, Number.MAX_SAFE_INTEGER),
    releaseWorkflow: a.string('releaseWorkflow', PATTERNS.githubWorkflow, 400),
    maxArtifactBytes: a.int('maxArtifactBytes', 1024, 64 * 1024 * 1024),
    environments,
  };
}

function parseEnvironment(raw: unknown, path: string): RegistryEnvironment {
  const e = new Shape(raw, CODE, path, ['environment', 'githubEnvironment', 'targets']);
  const targets = e.array('targets', 1, 32).map((t, k) => parseTarget(t, `${path}.targets[${k}]`));
  unique(targets.map((t) => t.id), `${path} target ids`);
  return {
    environment: e.string('environment', PATTERNS.environment),
    githubEnvironment: e.string('githubEnvironment', /^[A-Za-z0-9_.-]{1,255}$/),
    targets,
  };
}

function parseTarget(raw: unknown, path: string): RegistryTarget {
  const t = new Shape(raw, CODE, path, ['id', 'adapter', 'scriptName', 'credential', 'health', 'bindings', 'keepBindings']);
  const adapter = t.raw('adapter');
  if (typeof adapter === 'string' && RESERVED_ADAPTERS.has(adapter)) {
    fail('adapter_not_implemented', `${path}.adapter: ${adapter} is reserved and not implemented yet`);
  }
  const scriptName = t.string('scriptName', PATTERNS.scriptName);
  if (FORBIDDEN_SCRIPTS.has(scriptName)) fail(CODE, `${path}.scriptName: control-plane Workers are never deployed through the registry`);
  const credential = t.string('credential', /^WORKER_[A-Z0-9_]{1,58}$/);

  const h = t.object('health', ['origin', 'timeoutMs', 'attempts', 'intervalMs']);
  const origin = h.string('origin', PATTERNS.ownerOrigin, 260);

  const bindings = t.array('bindings', 0, 64).map((b, k) => parseBinding(b, `${path}.bindings[${k}]`));
  unique(bindings.map((b) => b.name), `${path} binding names`);
  const keep = t.stringArray('keepBindings', /^(secret_text|secret_key)$/, 0, 2) as Array<'secret_text' | 'secret_key'>;

  return {
    id: t.string('id', PATTERNS.targetId),
    adapter: t.oneOf('adapter', ['cloudflare-worker/v1'] as const),
    scriptName,
    credential,
    health: {
      origin,
      timeoutMs: h.int('timeoutMs', 1_000, 10_000),
      attempts: h.int('attempts', 1, 20),
      intervalMs: h.int('intervalMs', 1_000, 30_000),
    },
    bindings,
    keepBindings: keep,
  };
}

function parseBinding(raw: unknown, path: string): ApiBinding {
  const probe = new Shape(raw, CODE, path, ['name', 'type'], ['text', 'id', 'namespace_id', 'bucket_name', 'service', 'entrypoint', 'queue_name', 'store_id', 'secret_name', 'class_name', 'script_name']);
  const type = probe.oneOf('type', Object.keys(BINDING_FIELDS) as BindingType[]);
  const spec = BINDING_FIELDS[type];
  const b = new Shape(raw, CODE, path, ['name', 'type', ...spec.required], spec.optional);
  const name = b.string('name', PATTERNS.bindingName);
  if (name.startsWith('DEPLOY_')) fail(CODE, `${path}.name: DEPLOY_* bindings are reserved for the deployer`);
  const out: ApiBinding = { name, type } as ApiBinding;
  for (const field of [...spec.required, ...spec.optional]) {
    if (!b.has(field)) continue;
    const pattern = spec.patterns[field];
    if (!pattern) fail(CODE, `${path}.${field}: no validation rule`);
    out[field] = b.string(field, pattern, 1024);
  }
  // Application code must never reach into the control plane: a service binding to the authorizer's
  // `Authorizer` entrypoint could burn grants, and a Durable Object binding with
  // `script_name: authorizer` could mint them. The authorizer's public HTTPS endpoint remains usable.
  const reached = type === 'service' ? out['service'] : type === 'durable_object_namespace' ? out['script_name'] : undefined;
  if (reached !== undefined && FORBIDDEN_SCRIPTS.has(reached)) {
    fail(CODE, `${path}: bindings to control-plane Workers (${reached}) are not allowed`);
  }
  return out;
}

function unique(values: string[], what: string): void {
  if (new Set(values).size !== values.length) fail(CODE, `registry: duplicate ${what}`);
}

export interface ResolvedEnvironment {
  application: RegistryApplication;
  environment: RegistryEnvironment;
}

export function resolveEnvironment(registry: Registry, application: string, environment: string): ResolvedEnvironment {
  const app = registry.applications.find((a) => a.application === application);
  if (!app) fail('not_registered', `application ${application} is not in the registry`);
  const env = app.environments.find((e) => e.environment === environment);
  if (!env) fail('not_registered', `environment ${environment} of ${application} is not in the registry`);
  return { application: app, environment: env };
}
