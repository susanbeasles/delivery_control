import { DeployError, fail } from './errors.ts';

export type Fetcher = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface BoundedResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export interface BoundedInit extends Omit<RequestInit, 'redirect'> {
  timeoutMs: number;
  maxBytes: number;
  /**
   * The Workers runtime rejects `redirect: 'error'` ("does not make sense at the edge"), so every
   * request is sent with `manual` and an unexpected 3xx is refused here instead. Only `manual` may
   * be named, which keeps `error` from creeping back in.
   */
  redirect?: 'manual';
  /** Hand 3xx responses back to the caller instead of refusing them. */
  allowRedirect?: boolean;
}

/**
 * One HTTP exchange with a hard timeout, no automatic redirects, and a streaming size cap that
 * aborts as soon as the limit is crossed. Network failures and 5xx/429 surface as retryable.
 */
export async function fetchBounded(fetcher: Fetcher, url: string, init: BoundedInit, code: string): Promise<BoundedResponse> {
  const { timeoutMs, maxBytes, allowRedirect = false, redirect: _manual, ...rest } = init;
  let response: Response;
  try {
    response = await fetcher(url, { ...rest, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    return fail(code, `request to ${safeOrigin(url)} failed`, { retryable: true, cause });
  }
  if (!allowRedirect && response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return fail(code, `request to ${safeOrigin(url)} was redirected`);
  }
  const bytes = await readBounded(response.body, maxBytes, code);
  return { status: response.status, headers: response.headers, bytes };
}

export async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number, code: string): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail(code, `response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof DeployError) throw cause;
    return fail(code, 'response body could not be read', { retryable: true, cause });
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Map a non-success HTTP status to a DeployError with the right retry semantics. */
export function statusError(code: string, what: string, status: number): DeployError {
  return new DeployError(code, `${what} returned HTTP ${status}`, { retryable: isRetryableStatus(status) });
}

export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
