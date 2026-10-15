import { JobFailure } from './errors.mjs';

/**
 * The single result document the agent writes to stdout (`runner-result/v1`). The Durable Object
 * treats it as authoritative only when the agent also exits 0.
 */

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_MESSAGE = 500;

export function successDocument(jobId, result) {
  return { schema: 'runner-result/v1', jobId, outcome: 'succeeded', result, error: null };
}

/** Any thrown value becomes a bounded failure; only JobFailure keeps its code and message. */
export function failureDocument(jobId, error) {
  const known = error instanceof JobFailure;
  const code = known && CODE.test(error.code) ? error.code : 'agent_error';
  const message = known ? boundMessage(error.message) : `unexpected ${error instanceof Error ? error.name : typeof error}`;
  return { schema: 'runner-result/v1', jobId, outcome: known && error.uncertain ? 'uncertain' : 'failed', result: null, error: { code, message } };
}

export function boundMessage(text) {
  const clean = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
}
