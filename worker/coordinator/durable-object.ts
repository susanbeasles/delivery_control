import { DurableObject } from 'cloudflare:workers';
import { fail } from '../lib/errors.ts';
import { PATTERNS } from '../lib/validate.ts';
import { coordinatorEngine } from '../wiring.ts';
import type { CoordinatorEngine } from './engine.ts';
import { durableObjectStore, type TxStore } from './store.ts';
import type { AdmissionResult, DeploymentState, PromotionRequest } from './types.ts';

interface Key {
  application: string;
  environment: string;
}

/**
 * One instance per `application:environment` (`COORDINATOR.getByName(key)`). The first call binds
 * the instance to its key; any later call naming a different key is refused, so a routing bug can
 * never mix two environments' state.
 */
export class Coordinator extends DurableObject<Env> {
  private readonly store: TxStore;
  private engine: CoordinatorEngine | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = durableObjectStore(ctx.storage);
  }

  private bind(key?: Key): CoordinatorEngine {
    const stored = this.store.get<Key>('identity');
    if (key) {
      if (!PATTERNS.application.test(key.application) || !PATTERNS.environment.test(key.environment)) fail('internal', 'invalid coordinator key');
      if (stored && (stored.application !== key.application || stored.environment !== key.environment)) {
        fail('internal', 'coordinator identity mismatch');
      }
      if (!stored) this.store.put('identity', { application: key.application, environment: key.environment });
    }
    const identity = stored ?? key;
    if (!identity) return fail('internal', 'coordinator has no identity yet');
    this.engine ??= coordinatorEngine(this.env, this.store, identity, (at) => this.ctx.storage.setAlarm(at));
    return this.engine;
  }

  async admit(input: { request: PromotionRequest; tokenHash: string; githubEnvironment: string }): Promise<AdmissionResult> {
    return this.bind(input.request).admit(input.request, input.tokenHash, input.githubEnvironment);
  }

  async advance(key: Key): Promise<string> {
    return this.bind(key).advance();
  }

  async status(input: Key & { deploymentId: string }): Promise<DeploymentState | null> {
    return this.bind(input).status(input.deploymentId);
  }

  /** A runner job this coordinator waits on reached a terminal state; resume without waiting for the poll. */
  async runnerJobFinished(_input: { deploymentId: string; jobId: string }): Promise<void> {
    await this.bind().nudge();
  }

  override async alarm(): Promise<void> {
    if (!this.store.get<Key>('identity')) return;
    await this.bind().alarm();
  }
}
