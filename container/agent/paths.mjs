/** Fixed locations inside the runner image (see container/Dockerfile). */
export const PATHS = Object.freeze({
  workdir: '/tmp/job',
  tofu: '/opt/runner/bin/tofu',
  conftest: '/opt/runner/bin/conftest',
  gh: '/opt/runner/bin/gh',
  tofurc: '/opt/runner/tofurc',
  trustedRoot: '/opt/runner/trust/trusted_root.jsonl',
  cloudflareCa: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
});

/** Minimal environment every tool starts from; nothing is inherited from the agent. */
export function baseToolEnv(ctx) {
  return {
    PATH: '/opt/runner/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: ctx.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    // Every TLS connection leaves through the egress gate, which presents the Cloudflare
    // containers CA; Go tools (tofu, conftest, gh) read SSL_CERT_FILE. No public CA is needed.
    SSL_CERT_FILE: ctx.paths.cloudflareCa,
  };
}
