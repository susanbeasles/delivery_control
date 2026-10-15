import { fail } from '../lib/errors.ts';
import { sha256Hex } from '../lib/json.ts';
import type { RunnerJobType } from './api.ts';
import type { SigV4Credentials } from './egress/sigv4.ts';
import { JOB_PROFILES, type CloudflareSecretName, type PassphraseSecretName, type StateSecretName, type StateTokenIdName } from './profiles.ts';

/**
 * The bindings the runner reads, as one structural type that both the deployer's and the root
 * runner's environments satisfy. Credentials are optional here because each Worker binds only
 * its own; a job whose credential is missing fails closed when the credential is first needed.
 */

export interface SecretBinding {
  get(): Promise<string>;
}

export interface RunnerEnv {
  RUNNER: DurableObjectNamespace;
  RUNNER_LOGS: R2Bucket;
  TF_PLANS: R2Bucket;
  STAGING?: R2Bucket;
  COORDINATOR?: DurableObjectNamespace;
  ACCOUNT_ID: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_KEY: SecretBinding;
  /** `root` only in the root runner's configuration. */
  RUNNER_ROLE?: string;
  CF_PLAN?: SecretBinding;
  CF_APPLY?: SecretBinding;
  CF_ROOT_PLAN?: SecretBinding;
  CF_ROOT_APPLY?: SecretBinding;
  R2_STATE_RO?: SecretBinding;
  R2_STATE_RW?: SecretBinding;
  R2_STATE_ROOT?: SecretBinding;
  R2_STATE_RO_TOKEN_ID?: string;
  R2_STATE_RW_TOKEN_ID?: string;
  R2_STATE_ROOT_TOKEN_ID?: string;
  TF_ENCRYPTION_INFRA?: SecretBinding;
  TF_ENCRYPTION_ROOT?: SecretBinding;
}

type SecretName = CloudflareSecretName | StateSecretName | PassphraseSecretName;

/** Cloudflare API tokens and R2 token values are printable ASCII without spaces. */
const TOKEN_VALUE = /^[\x21-\x7e]{20,1024}$/;
const TOKEN_ID = /^[a-f0-9]{32}$/;
/** Passphrases come from `secrets.generate` (base64url of 32 random bytes); HCL-safe by construction. */
const PASSPHRASE = /^[A-Za-z0-9_-]{32,128}$/;

async function readSecret(env: RunnerEnv, name: SecretName, pattern: RegExp): Promise<string> {
  const binding = env[name];
  if (binding === undefined) return fail('credential_unbound', `${name} is not bound to this runner`);
  let value: string;
  try {
    value = await binding.get();
  } catch (cause) {
    return fail('credential_unavailable', `${name} could not be read`, { retryable: true, cause });
  }
  // Only the name is ever reported, never the value or its length.
  if (typeof value !== 'string' || !pattern.test(value)) fail('credential_invalid', `${name} has an unexpected format`);
  return value;
}

export async function cloudflareToken(env: RunnerEnv, type: RunnerJobType): Promise<string> {
  const grant = JOB_PROFILES[type].cloudflare;
  if (grant === null) return fail('credential_not_granted', `${type} has no Cloudflare credential`);
  return readSecret(env, grant.secret, TOKEN_VALUE);
}

/** R2 S3 credentials derived from a Cloudflare token: id = token id, secret = SHA-256 hex of the value. */
export async function stateCredentials(env: RunnerEnv, type: RunnerJobType): Promise<SigV4Credentials> {
  const grant = JOB_PROFILES[type].state;
  if (grant === null) return fail('credential_not_granted', `${type} has no state credential`);
  const accessKeyId = env[grant.tokenId as StateTokenIdName];
  if (typeof accessKeyId !== 'string' || !TOKEN_ID.test(accessKeyId)) fail('credential_unconfigured', `${grant.tokenId} is not configured`);
  const value = await readSecret(env, grant.secret, TOKEN_VALUE);
  return { accessKeyId, secretAccessKey: await sha256Hex(value) };
}

/** The one secret a container holds: the OpenTofu state passphrase, in the `exec` env of terraform jobs. */
export async function statePassphrase(env: RunnerEnv, type: RunnerJobType): Promise<string | null> {
  const name = JOB_PROFILES[type].passphrase;
  if (name === null) return null;
  return readSecret(env, name, PASSPHRASE);
}
