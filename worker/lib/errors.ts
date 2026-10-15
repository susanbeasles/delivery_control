/**
 * Every failure in the control plane carries a stable, machine-readable code. Messages are for
 * humans, bounded, and never contain secret material. `retryable` marks transient conditions
 * (network, 5xx, contention) that a later attempt may resolve; everything else is final.
 */
export class DeployError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DeployError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function fail(code: string, message: string, options?: { retryable?: boolean; cause?: unknown }): never {
  throw new DeployError(code, message, options);
}

export function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DeployError(code, message);
}

const MAX_MESSAGE = 500;

export interface ErrorSummary {
  code: string;
  message: string;
  retryable: boolean;
}

/** Reduce any thrown value to a bounded summary that is safe to persist and report. */
export function summarize(error: unknown): ErrorSummary {
  if (error instanceof DeployError) {
    return { code: error.code, message: bound(error.message), retryable: error.retryable };
  }
  // Unknown errors are treated as internal and retryable: they usually mean a platform hiccup.
  // Their message may echo arbitrary input, so only the class name is kept.
  const name = error instanceof Error ? error.name : typeof error;
  return { code: 'internal', message: bound(`unexpected ${name}`), retryable: true };
}

function bound(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
}
