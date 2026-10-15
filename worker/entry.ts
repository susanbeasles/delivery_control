import { parseTerraformSubject } from './runner/subject.ts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { parseDeploySubject } from './contracts/subject.ts';
import type { AdmissionResult, DeployKick, DeploymentState, PromotionRequest } from './coordinator/types.ts';
import { summarize } from './lib/errors.ts';
import { sha256Hex } from './lib/json.ts';
import { isoAt, log, systemClock, uuidv7 } from './lib/runtime.ts';
import { PATTERNS, Shape } from './lib/validate.ts';
import { resolveEnvironment } from './registry/registry.ts';
import { registry } from './wiring.ts';
import { getRunnerJobStatus, submitTerraformJob } from './runner/index.ts';
import type { RunnerJobStatus } from './runner/api.ts';

/**
 * The deployer's only inbound surfaces: RPC from the authorizer (service binding, entrypoint
 * `Deployer`) and its own queue. There is no route and `fetch` answers 404.
 */

type ConsumeResult =
  | { ok: true; grant: { action: string; subjectDigest: string; sub: string; jti: string; expiresAt: number } }
  | { ok: false; error: 'unknown' | 'replay' | 'expired' | 'mismatch' };

interface AuthorizerRpc {
  consume(input: { tokenHash: string; action: string; subject: unknown }): Promise<ConsumeResult>;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

async function consumeGrant(env: Env, token: unknown, action: string, subject: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return 'grant_malformed';
  const tokenHash = await sha256Hex(token);
  const authorizer = env.AUTHORIZER as unknown as AuthorizerRpc;
  const result = await authorizer.consume({ tokenHash, action, subject });
  if (!result.ok) return `grant_${result.error}`;
  if (result.grant.action !== action) return 'grant_mismatch';
  return null;
}

export class Deployer extends WorkerEntrypoint<Env> {
  async admit(input: { token: string; subject: unknown }): Promise<AdmissionResult> {
    try {
      const subject = parseDeploySubject(input?.subject);
      // The grant is consumed before anything else: a request that fails later cannot be replayed.
      const denied = await consumeGrant(this.env, input.token, 'deploy', input.subject);
      if (denied) return { status: 'REJECTED', error: denied };
      const tokenHash = await sha256Hex(input.token);

      const reg = await registry(this.env)();
      const { application, environment } = resolveEnvironment(reg, subject.application, subject.environment);
      if (application.repositoryId !== subject.repositoryId || application.repository !== subject.repository) {
        return { status: 'REJECTED', error: 'repository_mismatch' };
      }
      const now = systemClock.now();
      const request: PromotionRequest = {
        schema: 'promotion-request/v1',
        requestId: uuidv7(now),
        intent: subject.intent,
        application: subject.application,
        environment: subject.environment,
        repository: subject.repository,
        repositoryId: subject.repositoryId,
        releaseTag: subject.releaseTag,
        sourceCommit: subject.sourceCommit,
        releaseManifestSha256: subject.assets?.manifest.sha256 ?? null,
        assets: subject.assets,
        expectedCurrentGeneration: null,
        registryRevision: reg.revision,
        githubDeploymentId: null,
        requestedAt: isoAt(now),
      };
      const coordinator = this.env.COORDINATOR.getByName(`${subject.application}:${subject.environment}`);
      const result = (await coordinator.admit({ request, tokenHash, githubEnvironment: environment.githubEnvironment })) as AdmissionResult;
      log('info', 'deploy.admission', { application: subject.application, environment: subject.environment, releaseTag: subject.releaseTag, status: result.status });
      return result;
    } catch (error) {
      const s = summarize(error);
      log('warn', 'deploy.admission_rejected', { code: s.code });
      return { status: 'REJECTED', error: s.code };
    }
  }

  async status(input: { application: string; environment: string; deploymentId: string }): Promise<DeploymentState | null> {
    const s = new Shape(input, 'bad_request', 'status', ['application', 'environment', 'deploymentId']);
    const application = s.string('application', PATTERNS.application);
    const environment = s.string('environment', PATTERNS.environment);
    const deploymentId = s.string('deploymentId', PATTERNS.uuidv7);
    const coordinator = this.env.COORDINATOR.getByName(`${application}:${environment}`);
    return (await coordinator.status({ application, environment, deploymentId })) as DeploymentState | null;
  }

  async runJob(input: { token: string; job: { type: string; subject: unknown } }): Promise<RunnerJobStatus | { state: 'rejected'; error: string }> {
    try {
      const type = input?.job?.type;
      if (type !== 'terraform.plan' && type !== 'terraform.apply') return { state: 'rejected', error: 'bad_job_type' };
      const action = type === 'terraform.plan' ? 'infra.plan' : 'infra.apply';
      // Shape first, as admit and the root runner do: a malformed request must not burn the grant.
      parseTerraformSubject(input.job.subject, { stack: 'infra', operation: type === 'terraform.plan' ? 'plan' : 'apply' });
      const denied = await consumeGrant(this.env, input.token, action, input.job.subject);
      if (denied) return { state: 'rejected', error: denied };
      return await submitTerraformJob(this.env, input.job.subject, action);
    } catch (error) {
      return { state: 'rejected', error: summarize(error).code };
    }
  }

  async jobStatus(input: { jobId: string }): Promise<RunnerJobStatus | null> {
    const s = new Shape(input, 'bad_request', 'jobStatus', ['jobId']);
    return getRunnerJobStatus(this.env, s.string('jobId', PATTERNS.uuidv7));
  }
}

function parseKick(body: unknown): DeployKick {
  const s = new Shape(body, 'kick_invalid', 'kick', ['schema', 'application', 'environment', 'deploymentId', 'kick']);
  s.literal('schema', 'deploy-kick/v1');
  return {
    schema: 'deploy-kick/v1',
    application: s.string('application', PATTERNS.application),
    environment: s.string('environment', PATTERNS.environment),
    deploymentId: s.string('deploymentId', PATTERNS.uuidv7),
    kick: s.int('kick', 0, Number.MAX_SAFE_INTEGER),
  };
}

export const handlers = {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      let kick: DeployKick;
      try {
        kick = parseKick(message.body);
      } catch {
        // A malformed kick can never become valid; drop it loudly rather than poison the queue.
        log('error', 'queue.malformed_kick', { messageId: message.id });
        message.ack();
        continue;
      }
      try {
        const coordinator = env.COORDINATOR.getByName(`${kick.application}:${kick.environment}`);
        const outcome = await coordinator.advance({ application: kick.application, environment: kick.environment });
        log('info', 'queue.kick', { deploymentId: kick.deploymentId, outcome: String(outcome) });
        message.ack();
      } catch (error) {
        log('warn', 'queue.kick_failed', { deploymentId: kick.deploymentId, code: summarize(error).code, attempts: message.attempts });
        message.retry({ delaySeconds: Math.min(30 * message.attempts, 300) });
      }
    }
  },
} satisfies ExportedHandler<Env>;
