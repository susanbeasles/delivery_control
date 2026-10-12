import { DurableObject } from 'cloudflare:workers';
import { createCloudflareDeployer, handleDeploymentRequest } from './cloudflare-deployer.mjs';
import { boundedBytes, createCloudflareProvider } from './cloudflare-provider.mjs';

const unavailable = () => Response.json({ error: 'deployer_not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });

function authorityBinding(binding) {
  if (typeof binding?.fetch !== 'function') throw Error('Missing private deployment authority');
  const call = async (action, body) => {
    const response = await binding.fetch(new Request(`https://deployment-authority.internal/v1/deployments/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    }));
    if (!response.ok) { await response.body?.cancel(); throw Error('Deployment authority denied'); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response.body, 64000)));
  };
  return {
    consume: input => call('consume', input),
    check: input => call('check', input),
    complete: input => call('complete', input),
  };
}

export class DeploymentJob extends DurableObject {
  async fetch(request) {
    if (this.env.DEPLOYER_ENABLED !== 'true') return unavailable();
    try {
      const executor = createCloudflareDeployer({
        storage: this.ctx.storage,
        authority: authorityBinding(this.env.DEPLOYMENT_AUTHORITY),
        artifacts: this.env.DEPLOYMENT_ARTIFACTS,
        provider: createCloudflareProvider({ token: this.env.CLOUDFLARE_API_TOKEN, githubToken: this.env.GITHUB_READ_TOKEN }),
        policy: JSON.parse(this.env.DEPLOYMENT_POLICY_JSON),
      });
      return await handleDeploymentRequest(request, executor, { enabled: true });
    } catch { return unavailable(); }
  }
}

export default {
  async fetch(request, env) {
    return handleDeploymentRequest(request, {
      async execute(input) {
        if (!env.DEPLOYMENT_JOBS || !env.DEPLOYMENT_AUTHORITY || !env.DEPLOYMENT_ARTIFACTS) throw Error('Missing deployment bindings');
        const stub = env.DEPLOYMENT_JOBS.get(env.DEPLOYMENT_JOBS.idFromName(input.operationID));
        const response = await stub.fetch(new Request('https://deployment-job.internal/v1/deployments/execute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
        }));
        if (!response.ok) { await response.body?.cancel(); throw Error('Deployment failed'); }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response.body, 4096)));
      },
    }, { enabled: env.DEPLOYER_ENABLED === 'true' });
  },
};
