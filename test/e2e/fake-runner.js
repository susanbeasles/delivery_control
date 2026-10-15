// Stand-in for the container runner in the offline end-to-end run. The real `release.verify`
// executes `gh attestation verify` in a container, which needs a built image. This double reads
// the staged files back from R2 and checks their digests, so staging is exercised for real; it
// does not check Sigstore signatures. It is never deployed.
import { DurableObject } from 'cloudflare:workers';

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export class FakeRunnerJob extends DurableObject {
  async submit(request) {
    const existing = await this.ctx.storage.get('job');
    if (existing && JSON.stringify(existing.request) !== JSON.stringify(request)) throw new Error('job_conflict');
    if (!existing) await this.ctx.storage.put('job', { request, view: await this.run(request) });
    return (await this.ctx.storage.get('job')).view;
  }

  async status() {
    const job = await this.ctx.storage.get('job');
    return job ? job.view : null;
  }

  async run(request) {
    const now = new Date().toISOString();
    const base = { jobId: request.jobId, type: request.type, logKey: null, submittedAt: now, finishedAt: now };
    const input = request.input;
    for (const file of input.files) {
      const object = await this.env.STAGING.get(file.key);
      if (!object) return { ...base, state: 'failed', result: null, error: { code: 'staging_missing', message: file.name } };
      const digest = hex(await crypto.subtle.digest('SHA-256', await object.arrayBuffer()));
      if (digest !== file.sha256) return { ...base, state: 'failed', result: null, error: { code: 'staging_digest_mismatch', message: file.name } };
    }
    return {
      ...base,
      state: 'succeeded',
      error: null,
      result: {
        verified: true,
        subjects: input.files.filter((f) => f.name !== 'attestation.sigstore.json').map((f) => ({ name: f.name, sha256: f.sha256 })),
        signerWorkflow: `${input.signerWorkflow}@refs/heads/main`,
        sourceRepository: input.repository,
        sourceDigest: input.sourceCommit,
        sourceRef: 'refs/heads/main',
        verifier: 'e2e-fake (digests only)',
      },
    };
  }
}

export default {
  fetch() {
    return new Response('not found', { status: 404 });
  },
};
