import { JobFailure } from './errors.mjs';

/**
 * HTTP from the agent. Every request is intercepted by the egress gate, which signs or authorizes
 * it; the agent never sends credentials. Redirects are errors, bodies are bounded.
 */

export async function request(url, { method = 'GET', body = undefined, headers = {}, maxBytes, timeoutMs = 120_000 }) {
  let response;
  try {
    response = await fetch(url, { method, body, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new JobFailure('gate_request_failed', `${method} ${new URL(url).hostname} failed: ${cause instanceof Error ? cause.message : 'error'}`);
  }
  if (method === 'HEAD' || response.body === null) return { status: response.status, bytes: Buffer.alloc(0) };
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new JobFailure('gate_response_too_large', `${new URL(url).hostname} response exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return { status: response.status, bytes: Buffer.concat(chunks) };
}
