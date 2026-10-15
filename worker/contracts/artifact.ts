import { fail } from '../lib/errors.ts';
import { parseCanonicalJsonBytes } from '../lib/json.ts';
import { PATTERNS, Shape } from '../lib/validate.ts';

/** `worker-artifact/v1` (CONTRACTS.md section 1.3). The bytes must already be canonical JSON. */

export type ModuleType = 'esm' | 'cjs' | 'text' | 'data' | 'wasm' | 'sourcemap';

export interface ArtifactModule {
  name: string;
  path: string;
  type: ModuleType;
  sha256: string;
}

export interface WorkerArtifact {
  schema: 'worker-artifact/v1';
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  modules: ArtifactModule[];
  bindings: string[];
}

const CODE = 'artifact_invalid';
export const MAX_ARTIFACT_DOCUMENT_BYTES = 256 * 1024;
export const MAX_MODULE_TOTAL_BYTES = 10 * 1024 * 1024;
export const RESERVED_BINDINGS = ['DEPLOY_RELEASE_TAG', 'DEPLOY_ID'] as const;

export const MODULE_CONTENT_TYPES: Record<ModuleType, string> = {
  esm: 'application/javascript+module',
  cjs: 'application/javascript',
  text: 'text/plain',
  data: 'application/octet-stream',
  wasm: 'application/wasm',
  sourcemap: 'application/source-map',
};

export function parseWorkerArtifact(bytes: Uint8Array): WorkerArtifact {
  const value = parseCanonicalJsonBytes(bytes, MAX_ARTIFACT_DOCUMENT_BYTES, CODE);
  const s = new Shape(value, CODE, 'artifact', ['schema', 'mainModule', 'compatibilityDate', 'compatibilityFlags', 'modules', 'bindings']);
  s.literal('schema', 'worker-artifact/v1');
  const modules = s.array('modules', 1, 64).map((raw, index): ArtifactModule => {
    const m = new Shape(raw, CODE, `artifact.modules[${index}]`, ['name', 'path', 'type', 'sha256']);
    return {
      name: m.string('name', PATTERNS.archivePath, 256),
      path: m.string('path', PATTERNS.archivePath, 256),
      type: m.oneOf('type', ['esm', 'cjs', 'text', 'data', 'wasm', 'sourcemap'] as const),
      sha256: m.string('sha256', PATTERNS.sha256),
    };
  });
  if (new Set(modules.map((m) => m.name)).size !== modules.length) fail(CODE, 'artifact.modules: duplicate module names');
  const mainModule = s.string('mainModule', PATTERNS.archivePath, 256);
  const main = modules.find((m) => m.name === mainModule);
  if (!main || (main.type !== 'esm' && main.type !== 'cjs')) fail(CODE, 'artifact.mainModule: must name an esm or cjs module');

  const compatibilityDate = s.string('compatibilityDate', /^\d{4}-\d{2}-\d{2}$/);
  if (Number.isNaN(Date.parse(`${compatibilityDate}T00:00:00.000Z`))) fail(CODE, 'artifact.compatibilityDate: invalid date');
  const bindings = s.stringArray('bindings', PATTERNS.bindingName, 0, 64);
  for (const name of bindings) {
    if (name.startsWith('DEPLOY_')) fail(CODE, `artifact.bindings: ${name} is reserved for the deployer`);
  }
  return {
    schema: 'worker-artifact/v1',
    mainModule,
    compatibilityDate,
    compatibilityFlags: s.stringArray('compatibilityFlags', /^[a-z0-9_]{1,64}$/, 0, 32),
    modules,
    bindings,
  };
}
