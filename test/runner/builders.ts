import { gzipSync } from 'node:zlib';
import type { RunnerJobRequest, RunnerJobType } from '../../worker/runner/api.ts';
import type { PlanSummary } from '../../worker/runner/plan-summary.ts';
import { STACKS, type StackName } from '../../worker/runner/profiles.ts';
import { sha256 } from './fakes.ts';

/** Test data builders. Ids are fixed so failures are reproducible. */

export const ACCOUNT = '1a799c6e699d2ef7e87398692ce3ad7b';
export const JOB_ID = '0199e7a0-0000-7000-8000-000000000001';
export const OTHER_JOB_ID = '0199e7a0-0000-7000-8000-000000000002';
export const COMMIT = 'c'.repeat(40);
export const TREE = 'e'.repeat(40);
export const HEAD = 'd'.repeat(40);
export const POLICY_COMMIT = 'f'.repeat(40);
export const NOW_MS = Date.parse('2026-10-15T12:00:00.000Z');
export const NOW = NOW_MS / 1000;
export const PASSPHRASE = 'Pq7_runnerPassphraseValue-0123456789abcdefXYZ';

export const SECRETS = {
  CF_PLAN: 'cfplanTOKENvalue0123456789abcdefABCDEF01',
  CF_APPLY: 'cfapplyTOKENvalue0123456789abcdefABCDEF0',
  CF_ROOT_PLAN: 'cfrootplanTOKEN0123456789abcdefABCDEF012',
  CF_ROOT_APPLY: 'cfrootapplyTOKEN0123456789abcdefABCDEF01',
  R2_STATE_RO: 'r2roTOKENvalue0123456789abcdefABCDEF0123',
  R2_STATE_RW: 'r2rwTOKENvalue0123456789abcdefABCDEF0123',
  R2_STATE_ROOT: 'r2rootTOKENvalue0123456789abcdefABCDEF01',
  TF_ENCRYPTION_INFRA: PASSPHRASE,
  TF_ENCRYPTION_ROOT: PASSPHRASE.replace('infra', 'root0'),
  GITHUB_APP_KEY: 'not-used-in-these-tests',
};

export const TOKEN_IDS = {
  R2_STATE_RO_TOKEN_ID: '1'.repeat(32),
  R2_STATE_RW_TOKEN_ID: '2'.repeat(32),
  R2_STATE_ROOT_TOKEN_ID: '3'.repeat(32),
};

export function secretEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = { ACCOUNT_ID: ACCOUNT, GITHUB_APP_ID: '0', ...TOKEN_IDS };
  for (const [name, value] of Object.entries(SECRETS)) env[name] = { get: async () => value };
  return env;
}

export function subject(operation: 'plan' | 'apply', stack: StackName = 'infra', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'terraform-subject/v1',
    operation,
    stack,
    repository: STACKS[stack].repository,
    repositoryId: STACKS[stack].repositoryId,
    pullRequest: operation === 'plan' ? 12 : null,
    commit: COMMIT,
    treeSha: TREE,
    headSha: operation === 'plan' ? HEAD : null,
    requestedBy: {
      actorId: 215839550,
      runId: 1234567890,
      runAttempt: 1,
      workflowRef: `${STACKS[stack].repository}/.github/workflows/pipeline.yml@refs/heads/main`,
      jobWorkflowRef: 'susanbeasles/workflow_depot/.github/workflows/pipeline.yml@refs/heads/main',
      eventName: 'pull_request',
    },
    ...overrides,
  };
}

export const RELEASE_BYTES = {
  'release.zip': new TextEncoder().encode('PK\u0003\u0004 pretend zip bytes '.repeat(40)),
  'release.manifest.json': new TextEncoder().encode('{"schema":"release-manifest/v2"}'),
  'attestation.sigstore.json': new TextEncoder().encode('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}'),
};

export const DEPLOYMENT_ID = '0199e7a0-0000-7000-8000-0000000000dd';

export function releaseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: 'susanbeasles/ProsRUs',
    sourceCommit: COMMIT,
    releaseTag: 'v1.4.2',
    signerWorkflow: 'susanbeasles/workflow_depot/.github/workflows/release.yml',
    files: (Object.keys(RELEASE_BYTES) as Array<keyof typeof RELEASE_BYTES>).map((name) => ({
      name,
      key: `staging/${DEPLOYMENT_ID}/${name}`,
      sha256: sha256(RELEASE_BYTES[name]),
      size: RELEASE_BYTES[name].byteLength,
    })),
    ...overrides,
  };
}

export function request(type: RunnerJobType, input: unknown, overrides: Partial<RunnerJobRequest> = {}): RunnerJobRequest {
  return { jobId: JOB_ID, type, deadlineAt: NOW + 30 * 60, input: input as RunnerJobRequest['input'], notify: null, ...overrides };
}

export function terraformRequest(type: 'terraform.plan' | 'terraform.apply' | 'root.plan' | 'root.apply', overrides: Partial<RunnerJobRequest> = {}): RunnerJobRequest {
  const stack: StackName = type.startsWith('root.') ? 'infra-root' : 'infra';
  return request(type, subject(type.endsWith('.plan') ? 'plan' : 'apply', stack), overrides);
}

export function planSummary(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    schema: 'terraform-plan-summary/v1',
    jobId: JOB_ID,
    stack: 'infra',
    repository: STACKS.infra.repository,
    commit: COMMIT,
    treeSha: TREE,
    policyCommit: POLICY_COMMIT,
    addCount: 1,
    changeCount: 2,
    destroyCount: 0,
    policy: [{ rule: '*', result: 'pass', messages: ['12 policy checks passed'] }],
    policyPassed: true,
    stateSerial: 7,
    stateLineage: '3f2a1c6e-1111-2222-3333-444455556666',
    planSha256: 'a'.repeat(64),
    planJsonSha256: 'b'.repeat(64),
    ...overrides,
  };
}

/** Minimal ustar archive builder for tar tests and fake tarballs. */
export interface TarEntry {
  path: string;
  type?: '0' | '5' | '2' | '1' | '3' | '6';
  data?: string;
  linkpath?: string;
  mode?: number;
  pax?: Record<string, string>;
}

function header(name: string, size: number, type: string, linkpath: string, mode: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write(linkpath.slice(0, 100), 157, 'utf8');
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const b of block) sum += b;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}

function pad(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

export function tarBytes(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.pax) {
      const body = Object.entries(e.pax)
        .map(([k, v]) => {
          const record = ` ${k}=${v}\n`;
          let length = record.length + 1;
          while (`${length}${record}`.length !== length) length = `${length}${record}`.length;
          return `${length}${record}`;
        })
        .join('');
      parts.push(header('PaxHeader', Buffer.byteLength(body), 'x', '', 0o644), pad(Buffer.from(body)));
    }
    const data = Buffer.from(e.data ?? '');
    parts.push(header(e.path, data.length, e.type ?? '0', e.linkpath ?? '', e.mode ?? 0o644), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tarGz(entries: TarEntry[]): Buffer {
  return gzipSync(tarBytes(entries));
}

/** A GitHub API double: trees, branch heads and tarballs behind a codeload redirect. */
export function fakeGitHub(options: { trees?: Record<string, string>; main?: string; tarballs?: Record<string, Uint8Array> } = {}) {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const trees = options.trees ?? { [COMMIT]: TREE };
  const fetcher = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ url: url.toString(), authorization: headers.get('authorization') });
    const commitMatch = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/([a-f0-9]{40})$/.exec(url.pathname);
    if (url.hostname === 'api.github.com' && commitMatch) {
      const tree = trees[commitMatch[1] ?? ''];
      return tree ? Response.json({ sha: commitMatch[1], tree: { sha: tree } }) : new Response('{}', { status: 404 });
    }
    if (url.hostname === 'api.github.com' && /\/commits\/main$/.test(url.pathname)) return new Response(`${options.main ?? POLICY_COMMIT}\n`);
    const tarball = /^\/repos\/([^/]+\/[^/]+)\/tarball\/([a-f0-9]{40})$/.exec(url.pathname);
    if (url.hostname === 'api.github.com' && tarball) {
      return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/${tarball[1]}/legacy.tar.gz/${tarball[2]}?token=SHORTLIVED` } });
    }
    if (url.hostname === 'codeload.github.com') {
      const sha = url.pathname.split('/').pop() ?? '';
      const bytes = options.tarballs?.[sha] ?? tarGz([{ path: `repo-${sha.slice(0, 7)}/`, type: '5' }, { path: `repo-${sha.slice(0, 7)}/main.tf`, data: 'terraform {}\n' }]);
      return new Response(bytes);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetcher, seen, tokens: { repositoryToken: async () => 'ghs_installationTokenForTests0123456789' } };
}
