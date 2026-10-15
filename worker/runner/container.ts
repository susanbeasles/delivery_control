import { DeployError, fail } from '../lib/errors.ts';
import type { ExecOptions, ExecProcessPort } from './exec.ts';
import { IMAGE, LIMITS } from './limits.ts';

/**
 * Lifecycle of the job's container: configure egress, start with the internet disabled, wait for
 * a readiness probe, and on cleanup destroy and confirm it is gone. Typed against the subset of
 * the platform `Container` the runner uses, so tests pass a fake.
 */

export interface ContainerStart {
  image: string;
  instance: typeof IMAGE.instance;
  enableInternet: false;
  env: Record<string, string>;
}

export interface ContainerPort<Gate = unknown> {
  readonly running: boolean;
  readonly images: Record<string, string>;
  start(options: ContainerStart): void;
  destroy(error?: unknown): Promise<void>;
  inspect(): Promise<{ image: string } | null>;
  exec(cmd: string[], options: ExecOptions | { stdout: 'pipe'; stderr: 'pipe'; user: string; cwd: string; env: Record<string, string> }): Promise<ExecProcessPort>;
  interceptOutboundHttps(addr: string, binding: Gate): Promise<void>;
  interceptOutboundHttp(addr: string, binding: Gate): Promise<void>;
}

export interface BootOptions<Gate> {
  gate: Gate;
  /** Environment for the container's PID 1. Never carries a credential. */
  env: Record<string, string>;
  sleep(ms: number): Promise<void>;
}

/** Every outbound HTTP and HTTPS request, to any host, goes to the gate; the gate denies by default. */
export async function bootContainer<Gate>(container: ContainerPort<Gate>, options: BootOptions<Gate>): Promise<void> {
  const image = container.images[IMAGE.imageName];
  if (typeof image !== 'string' || image === '') fail('image_unconfigured', `container image "${IMAGE.imageName}" is not configured`);
  if (container.running) fail('container_already_running', 'a container is already running for this job');
  await container.interceptOutboundHttps('*', options.gate);
  await container.interceptOutboundHttp('*', options.gate);
  container.start({ image, instance: IMAGE.instance, enableInternet: false, env: options.env });
  await waitUntilReady(container, options.sleep);
  const info = await container.inspect();
  if (!info || !sameImage(info.image, image)) fail('image_mismatch', 'running container is not the configured runner image');
}

/** The probe exits 0 once the image's agent and the interception CA are in place. */
async function waitUntilReady<Gate>(container: ContainerPort<Gate>, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < LIMITS.readinessAttempts; attempt++) {
    try {
      const probe = await container.exec([IMAGE.node, IMAGE.probe], { stdout: 'pipe', stderr: 'pipe', user: IMAGE.user, cwd: IMAGE.cwd, env: {} });
      await Promise.all([probe.stdout?.cancel(), probe.stderr?.cancel()]);
      if ((await probe.exitCode) === 0) return;
    } catch {
      // Not ready yet: the process API is unavailable until the container has booted.
    }
    await sleep(LIMITS.readinessIntervalMs);
  }
  fail('container_not_ready', 'container did not become ready', { retryable: true });
}

/** Digest-pinned references compare by digest; anything else must match exactly. */
function sameImage(actual: string, configured: string): boolean {
  const digest = /@(sha256:[a-f0-9]{64})$/.exec(configured)?.[1];
  return digest ? actual === configured || actual.endsWith(`@${digest}`) || actual === digest : actual === configured;
}

/**
 * Destroy, then confirm: `running` is false and `inspect()` reports nothing. A failed or
 * unconfirmed destroy returns false so the caller keeps retrying from its alarm.
 */
export async function destroyAndConfirm<Gate>(container: ContainerPort<Gate>): Promise<boolean> {
  try {
    // Always called, even when `running` is already false: a stopped container may still exist.
    await container.destroy(new DeployError('job_finished', 'runner job finished'));
  } catch {
    // Destroying an absent container may throw; the confirmation below decides.
  }
  try {
    return container.running === false && (await container.inspect()) === null;
  } catch {
    return false;
  }
}
