/** Bounds for everything the runner reads, writes or waits for. One place, so reviews see them all. */

const KiB = 1024;
const MiB = 1024 * KiB;

export const LIMITS = {
  /** Single result document on the agent's stdout. */
  resultBytes: 256 * KiB,
  /** Captured stderr per job; the rest is dropped with a marker. */
  logBytes: 16 * MiB,
  /** R2 multipart part size for the stderr log (R2 requires equal parts of at least 5 MiB). */
  logPartBytes: 5 * MiB,
  /** Repository tarball at the job's commit. Terraform repositories are small; this is generous. */
  sourceTarballBytes: 32 * MiB,
  /** infra-root tarball at `main`, which carries the policy bundle. */
  policyTarballBytes: 16 * MiB,
  /** Release assets streamed from `release-staging` for `release.verify`. */
  releaseZipBytes: 256 * MiB,
  releaseManifestBytes: 1 * MiB,
  attestationBytes: 4 * MiB,
  /** Stored plan file read back for the apply binding check. */
  planFileBytes: 64 * MiB,
  planSummaryBytes: 256 * KiB,
  /** Earliest and latest acceptable deadline, relative to submission. */
  minDeadlineSeconds: 120,
  /** The container's PID 1 exits after 2 h; every deadline leaves it 20 minutes of margin. */
  maxDeadlineSeconds: 100 * 60,
  /** Heartbeat alarm while a job runs: keeps the object resident and the watchdog prompt. */
  heartbeatMs: 30_000,
  /** Delay between attempts to confirm the container is gone. */
  cleanupRetryMs: 30_000,
  /** Preparation (downloads) is retried this many times on retryable errors, then fails. */
  prepareAttempts: 3,
  prepareRetryMs: 15_000,
  /** Readiness probe: attempts and spacing after `start()`. */
  readinessAttempts: 40,
  readinessIntervalMs: 1_500,
} as const;

/** Fixed paths inside the runner image. */
export const IMAGE = {
  imageName: 'runner',
  node: '/usr/local/bin/node',
  agent: '/opt/runner/agent/main.mjs',
  probe: '/opt/runner/agent/probe.mjs',
  user: '10001',
  cwd: '/tmp',
  cloudflareCa: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
  instance: 'standard-1',
} as const;

/** Internal host the gate serves for job artifacts (`PUT`/`GET /{name}`), never forwarded anywhere. */
export const ARTIFACT_HOST = 'artifacts.runner.internal';
