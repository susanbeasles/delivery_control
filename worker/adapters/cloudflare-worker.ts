import { MODULE_CONTENT_TYPES, type WorkerArtifact } from '../contracts/artifact.ts';
import { DeployError, fail } from '../lib/errors.ts';
import type { RegistryTarget } from '../registry/registry.ts';
import {
  SCRIPT_NOT_FOUND,
  createScript,
  deployVersion,
  disableSubdomain,
  listVersions,
  readActiveDeployment,
  uploadVersion,
  type ApiContext,
  type UploadModule,
  type VersionMetadata,
} from './cloudflare-api.ts';

/**
 * Adapter `cloudflare-worker/v1`: put one Worker script on an exact, verified build.
 *
 * Bindings come only from the registry; the artifact may name bindings but never define them.
 * Every upload carries the operation id in its version message, so after a crash the adapter
 * finds its own upload instead of creating a second one. Deploy and rollback both end with one
 * version serving 100 % of traffic.
 */

export interface ResolvedModule {
  name: string;
  type: WorkerArtifact['modules'][number]['type'];
  bytes: Uint8Array;
}

export interface WorkerDeployInput {
  api: ApiContext;
  target: RegistryTarget;
  artifact: WorkerArtifact;
  modules: ResolvedModule[];
  operationId: string;
  deploymentId: string;
  releaseTag: string;
}

export interface WorkerDeployResult {
  versionId: string;
  created: boolean;
}

/** The version serving the script before we touch it; null means a first deploy. */
export async function readPriorVersion(api: ApiContext, scriptName: string): Promise<string | null> {
  try {
    const active = await readActiveDeployment(api, scriptName);
    if (active === null) return null;
    if (active.versionId === null) {
      fail('prior_state_unsupported', `${scriptName} is serving a split deployment; finish or revert it before deploying`);
    }
    return active.versionId;
  } catch (error) {
    if (error instanceof DeployError && error.code === SCRIPT_NOT_FOUND) return null;
    throw error;
  }
}

export function composeBindings(target: RegistryTarget, artifact: WorkerArtifact, releaseTag: string, deploymentId: string): Array<Record<string, string>> {
  const registryNames = new Set(target.bindings.map((b) => b.name));
  for (const name of artifact.bindings) {
    if (!registryNames.has(name)) fail('binding_not_registered', `artifact requires binding ${name}, which the registry does not grant to ${target.id}`);
  }
  return [
    ...target.bindings.map((b) => ({ ...b })),
    { type: 'plain_text', name: 'DEPLOY_RELEASE_TAG', text: releaseTag },
    { type: 'plain_text', name: 'DEPLOY_ID', text: deploymentId },
  ];
}

export function operationMessage(operationId: string, releaseTag: string): string {
  return `deployer ${releaseTag} op=${operationId}`;
}

export async function deployWorker(input: WorkerDeployInput): Promise<WorkerDeployResult> {
  const { api, target, artifact, operationId, releaseTag } = input;
  const metadata: VersionMetadata = {
    main_module: artifact.mainModule,
    compatibility_date: artifact.compatibilityDate,
    compatibility_flags: artifact.compatibilityFlags,
    bindings: composeBindings(target, artifact, releaseTag, input.deploymentId),
    annotations: { 'workers/message': operationMessage(operationId, releaseTag), 'workers/tag': releaseTag },
  };
  if (target.keepBindings.length > 0) metadata.keep_bindings = [...target.keepBindings];
  const modules: UploadModule[] = input.modules.map((m) => ({ name: m.name, contentType: MODULE_CONTENT_TYPES[m.type], bytes: m.bytes }));
  const marker = `op=${operationId}`;

  // Reconcile first: a previous attempt may have uploaded (and even deployed) this operation.
  let existing: string | null = null;
  let scriptExists = true;
  try {
    existing = (await listVersions(api, target.scriptName)).find((v) => v.message?.endsWith(marker) === true)?.id ?? null;
  } catch (error) {
    if (!(error instanceof DeployError && error.code === SCRIPT_NOT_FOUND)) throw error;
    scriptExists = false;
  }

  if (!scriptExists) {
    // First deploy from absent code: create the script serving this build, then keep it private.
    await createScript(api, target.scriptName, metadata, modules);
    await disableSubdomain(api, target.scriptName);
    const created = (await listVersions(api, target.scriptName)).find((v) => v.message?.endsWith(marker) === true);
    if (!created) fail('cloudflare_api', 'created script but cannot find its version');
    return { versionId: created.id, created: true };
  }

  const versionId = existing ?? (await uploadVersion(api, target.scriptName, metadata, modules));
  const active = await readActiveDeployment(api, target.scriptName);
  if (active?.versionId !== versionId) {
    await deployVersion(api, target.scriptName, versionId, operationMessage(operationId, releaseTag));
  }
  // Asserted on every deploy, not only on creation: a retry after a crash must still close it, and
  // drift (someone enabling workers.dev by hand) is corrected by the next release.
  await disableSubdomain(api, target.scriptName);
  return { versionId, created: existing === null };
}

/** Route all traffic back to a prior version. Idempotent. */
export async function rollbackWorker(api: ApiContext, scriptName: string, priorVersionId: string, operationId: string): Promise<void> {
  const active = await readActiveDeployment(api, scriptName);
  if (active?.versionId === priorVersionId) return;
  await deployVersion(api, scriptName, priorVersionId, `deployer rollback op=${operationId}`);
}
