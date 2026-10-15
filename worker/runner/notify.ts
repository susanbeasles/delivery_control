import type { CoordinatorRunnerCallback, RunnerNotify } from './api.ts';

/**
 * Best-effort nudge to the coordinator that waits on a job; the coordinator also polls, so a lost
 * nudge only delays it. The caller logs failures and never retries them.
 */
export interface CoordinatorNamespace {
  getByName(name: string): unknown;
}

export async function notifyCoordinator(namespace: CoordinatorNamespace | undefined, notify: RunnerNotify, jobId: string): Promise<void> {
  if (namespace === undefined) return;
  const coordinator = namespace.getByName(`${notify.application}:${notify.environment}`) as CoordinatorRunnerCallback;
  await coordinator.runnerJobFinished({ deploymentId: notify.deploymentId, jobId });
}
