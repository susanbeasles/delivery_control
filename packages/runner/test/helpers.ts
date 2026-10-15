import { JobController } from '../src/controller.ts';
import { JobTypeRegistry, type JobTypeSpec } from '../src/job-type.ts';
import type { ControllerEvent, StagedFile } from '../src/ports.ts';
import { FakeAlarms, FakeClock, FakeContainer, FakeOutbound, MemorySecrets, MemorySink, MemoryStore, encoder, until } from './fakes.ts';

export const JOB_ID = '018f3a2e-7c4b-7a11-9d2e-3f4a5b6c7d8e';
export const KEY = 'c'.repeat(64);
export const SECRET_VALUE = 'cf-token-value-0123456789abcdef';

export const planSpec: JobTypeSpec = {
  name: 'terraform.plan',
  image: 'deployer',
  instance: 'standard-1',
  command: ['/usr/local/bin/runner-job'],
  secrets: ['CF_PLAN'],
  allowedHosts: ['api.cloudflare.com', 'github.com'],
  timeoutMs: 60_000,
  maxLogBytes: 8_192,
};

export function envelopeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    job_id: JOB_ID,
    job_type: 'terraform.plan',
    idempotency_key: KEY,
    inputs: { repo: 'susanbeasles/infra', sha: 'a'.repeat(40) },
    requested_by: { sub: 'repo:susanbeasles/infra:environment:plan', run_id: '123' },
    created_at: '2026-10-15T12:00:00Z',
    ...overrides,
  };
}

export const envelopeBytes = (overrides: Record<string, unknown> = {}): Uint8Array => encoder.encode(JSON.stringify(envelopeJson(overrides)));

export function harness(spec: JobTypeSpec = planSpec, secrets: Record<string, string> = { CF_PLAN: SECRET_VALUE }, stageFiles: StagedFile[] = []) {
  const container = new FakeContainer();
  const store = new MemoryStore();
  const alarms = new FakeAlarms();
  const clock = new FakeClock();
  const sink = new MemorySink();
  const events: ControllerEvent[] = [];
  const outbounds: FakeOutbound[] = [];
  const secretSource = new MemorySecrets(secrets);
  const controller = new JobController({
    container,
    store,
    alarms,
    clock,
    sink,
    secrets: secretSource,
    outbound: (spec, envelope) => {
      const binding = new FakeOutbound(spec, envelope);
      outbounds.push(binding);
      return binding;
    },
    jobTypes: new JobTypeRegistry([spec]),
    observe: (event) => events.push(event),
    stage: async () => stageFiles,
  });
  /** Resolves once the job command has been exec'ed in the fake container. */
  const started = (count = 1) => until(() => container.execs.length >= count, `${count} exec(s)`);
  return { container, store, alarms, clock, sink, events, outbounds, controller, started, secrets: secretSource };
}

export const logKey = (file: string): string => `logs/terraform.plan/${JOB_ID}/${file}`;
