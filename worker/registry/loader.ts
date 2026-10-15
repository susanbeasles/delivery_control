import { fail } from '../lib/errors.ts';
import type { Clock } from '../lib/runtime.ts';
import { parseRegistryBytes, type Registry } from './registry.ts';

/**
 * Reads the Terraform-written registry from KV. A short isolate cache keeps hot paths cheap; KV is
 * itself eventually consistent (about 60 s), which is accepted for registry edits and recorded per
 * deployment as `registryRevision`.
 */

const CACHE_MS = 30_000;
let cached: { at: number; registry: Registry } | null = null;

export async function loadRegistry(kv: KVNamespace, clock: Clock, accountId: string): Promise<Registry> {
  const now = clock.now();
  if (cached && now - cached.at < CACHE_MS) return cached.registry;
  let raw: ArrayBuffer | null;
  try {
    raw = await kv.get('registry', 'arrayBuffer');
  } catch (cause) {
    return fail('registry_unavailable', 'registry could not be read', { retryable: true, cause });
  }
  if (raw === null) fail('registry_unavailable', 'registry is not provisioned (infra Terraform writes it)');
  const registry = parseRegistryBytes(new Uint8Array(raw));
  if (registry.accountId !== accountId) fail('registry_invalid', 'registry belongs to a different account');
  cached = { at: now, registry };
  return registry;
}

/** Tests only. */
export function resetRegistryCache(): void {
  cached = null;
}
