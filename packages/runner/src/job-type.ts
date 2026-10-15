// A job type is static configuration owned by the controller Worker, never by the envelope: which image runs,
// which command, which secrets it may read, which hosts it may reach, how long it may run, how much log it may keep.
import { JOB_TYPE_NAME } from './envelope.ts';

export type InstanceType = 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4';

export interface ArtifactSpec {
  /** Absolute directory inside the container the job writes its outputs to; collected after the job ends. */
  readonly dir: string;
  /** Total bytes collected across all files; a file that would exceed the remainder is skipped and noted. */
  readonly maxBytes: number;
  readonly maxFiles: number;
}

export interface StageSpec {
  /** Absolute directory inside the container where staged input files are written before the job runs. */
  readonly dir: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
}

export interface JobTypeSpec {
  /** Job type name, matched against `envelope.job_type`. */
  readonly name: string;
  /** Key into the Worker's named container images (`ctx.container.images`); resolved to a digest-pinned reference at start. */
  readonly image: string;
  readonly instance: InstanceType;
  /** argv executed inside the container; argv[0] is an absolute path. The envelope arrives on its stdin. */
  readonly command: readonly string[];
  /** Environment variable names the job may read. The controller resolves each from Secrets Store; values never touch the envelope or logs. */
  readonly secrets: readonly string[];
  /** Exact hostnames the job may reach over HTTPS. Everything else is refused in the outbound handler. */
  readonly allowedHosts: readonly string[];
  readonly timeoutMs: number;
  /** Per-stream cap on captured log bytes. */
  readonly maxLogBytes: number;
  /** Outputs to collect from the container into the log sink after the job ends. */
  readonly artifacts?: ArtifactSpec;
  /** Inputs the consumer stages into the container before the job runs (for example a stored plan). */
  readonly stage?: StageSpec;
}

export type JobTypeErrorCode =
  | 'bad_name'
  | 'bad_image'
  | 'bad_instance'
  | 'bad_command'
  | 'bad_secret'
  | 'bad_host'
  | 'bad_timeout'
  | 'bad_log_limit'
  | 'bad_artifacts'
  | 'bad_stage'
  | 'duplicate_name';

export class JobTypeError extends Error {
  readonly code: JobTypeErrorCode;
  constructor(code: JobTypeErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'JobTypeError';
    this.code = code;
  }
}

export const JOB_TYPE_LIMITS = Object.freeze({
  minTimeoutMs: 1_000,
  maxTimeoutMs: 6 * 60 * 60 * 1_000,
  minLogBytes: 4_096,
  maxLogBytes: 32 * 1024 * 1024,
  maxSecrets: 32,
  maxHosts: 64,
  maxArgs: 64,
  maxArgLength: 4_096,
  maxArtifactBytes: 256 * 1024 * 1024,
  maxArtifactFiles: 1_000,
});

/** Environment names the controller sets itself; a job type may not claim them as secrets. */
export const RESERVED_ENV = Object.freeze([
  'RUNNER_JOB_ID',
  'RUNNER_JOB_TYPE',
  'RUNNER_ATTEMPT',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'HOME',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
]);

const INSTANCES: readonly InstanceType[] = ['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'];
const IMAGE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/** Exact lowercase DNS hostname: no wildcard, no port, no scheme, no IP literal, no trailing dot. */
export function isHostname(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => HOST_LABEL.test(label))) return false;
  const tld = labels[labels.length - 1];
  return tld !== undefined && TLD.test(tld);
}

function fail(code: JobTypeErrorCode, detail?: string): never {
  throw new JobTypeError(code, detail);
}

function unique(values: readonly string[], code: JobTypeErrorCode): void {
  if (new Set(values).size !== values.length) fail(code, 'duplicate');
}

/** Validate a job type and return a frozen copy. Throws `JobTypeError` on the first violation. */
export function defineJobType(spec: JobTypeSpec): JobTypeSpec {
  if (typeof spec.name !== 'string' || !JOB_TYPE_NAME.test(spec.name)) fail('bad_name');
  if (typeof spec.image !== 'string' || !IMAGE_KEY.test(spec.image)) fail('bad_image');
  if (!INSTANCES.includes(spec.instance)) fail('bad_instance');
  if (!Array.isArray(spec.command) || spec.command.length === 0 || spec.command.length > JOB_TYPE_LIMITS.maxArgs) fail('bad_command', 'argv');
  for (const arg of spec.command) {
    if (typeof arg !== 'string' || arg.length > JOB_TYPE_LIMITS.maxArgLength || arg.includes('\0')) fail('bad_command', 'arg');
  }
  if (!ABSOLUTE_PATH.test(spec.command[0] ?? '')) fail('bad_command', 'argv[0] must be an absolute path');
  if (!Array.isArray(spec.secrets) || spec.secrets.length > JOB_TYPE_LIMITS.maxSecrets) fail('bad_secret', 'count');
  for (const name of spec.secrets) {
    if (typeof name !== 'string' || !ENV_NAME.test(name) || RESERVED_ENV.includes(name) || name.startsWith('RUNNER_')) fail('bad_secret', String(name));
  }
  unique(spec.secrets, 'bad_secret');
  if (!Array.isArray(spec.allowedHosts) || spec.allowedHosts.length > JOB_TYPE_LIMITS.maxHosts) fail('bad_host', 'count');
  for (const host of spec.allowedHosts) if (!isHostname(host)) fail('bad_host', String(host));
  unique(spec.allowedHosts, 'bad_host');
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < JOB_TYPE_LIMITS.minTimeoutMs || spec.timeoutMs > JOB_TYPE_LIMITS.maxTimeoutMs) fail('bad_timeout');
  if (!Number.isSafeInteger(spec.maxLogBytes) || spec.maxLogBytes < JOB_TYPE_LIMITS.minLogBytes || spec.maxLogBytes > JOB_TYPE_LIMITS.maxLogBytes) fail('bad_log_limit');
  const artifacts = spec.artifacts === undefined ? undefined : validateArtifacts(spec.artifacts);
  const stage = spec.stage === undefined ? undefined : validateStage(spec.stage);
  return Object.freeze({
    name: spec.name,
    image: spec.image,
    instance: spec.instance,
    command: Object.freeze([...spec.command]),
    secrets: Object.freeze([...spec.secrets]),
    allowedHosts: Object.freeze([...spec.allowedHosts]),
    timeoutMs: spec.timeoutMs,
    maxLogBytes: spec.maxLogBytes,
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(stage === undefined ? {} : { stage }),
  });
}

function validateStage(spec: StageSpec): StageSpec {
  if (typeof spec.dir !== 'string' || !ABSOLUTE_PATH.test(spec.dir) || spec.dir === '/') fail('bad_stage', 'dir');
  if (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes < 1 || spec.maxBytes > JOB_TYPE_LIMITS.maxArtifactBytes) fail('bad_stage', 'maxBytes');
  if (!Number.isSafeInteger(spec.maxFiles) || spec.maxFiles < 1 || spec.maxFiles > JOB_TYPE_LIMITS.maxArtifactFiles) fail('bad_stage', 'maxFiles');
  return Object.freeze({ dir: spec.dir, maxBytes: spec.maxBytes, maxFiles: spec.maxFiles });
}

function validateArtifacts(spec: ArtifactSpec): ArtifactSpec {
  if (typeof spec.dir !== 'string' || !ABSOLUTE_PATH.test(spec.dir) || spec.dir === '/') fail('bad_artifacts', 'dir');
  if (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes < 1 || spec.maxBytes > JOB_TYPE_LIMITS.maxArtifactBytes) fail('bad_artifacts', 'maxBytes');
  if (!Number.isSafeInteger(spec.maxFiles) || spec.maxFiles < 1 || spec.maxFiles > JOB_TYPE_LIMITS.maxArtifactFiles) fail('bad_artifacts', 'maxFiles');
  return Object.freeze({ dir: spec.dir, maxBytes: spec.maxBytes, maxFiles: spec.maxFiles });
}

export class JobTypeRegistry {
  readonly #specs: ReadonlyMap<string, JobTypeSpec>;
  constructor(specs: readonly JobTypeSpec[]) {
    const map = new Map<string, JobTypeSpec>();
    for (const spec of specs) {
      const defined = defineJobType(spec);
      if (map.has(defined.name)) fail('duplicate_name', defined.name);
      map.set(defined.name, defined);
    }
    this.#specs = map;
  }
  get(name: string): JobTypeSpec | undefined {
    return this.#specs.get(name);
  }
  names(): readonly string[] {
    return [...this.#specs.keys()];
  }
}
