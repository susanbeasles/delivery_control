// Egress gate for container traffic. Containers start with `enableInternet: false`; every HTTP and HTTPS request they
// make is intercepted into a Worker entrypoint that runs this gate. Only exact allowlisted hostnames over HTTPS pass.
// Responses are returned as they are: a redirect is handed back to the job, never followed on its behalf.
import { isHostname, JobTypeError } from './job-type.ts';

export type OutboundDenial = 'bad_url' | 'not_https' | 'port_not_allowed' | 'credentials_in_url' | 'host_not_allowed';

export type OutboundDecision = { readonly allow: true; readonly host: string } | { readonly allow: false; readonly reason: OutboundDenial };

export function decideOutbound(input: string | URL, allowedHosts: ReadonlySet<string>): OutboundDecision {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return { allow: false, reason: 'bad_url' };
  }
  if (url.protocol !== 'https:') return { allow: false, reason: 'not_https' };
  if (url.port !== '' && url.port !== '443') return { allow: false, reason: 'port_not_allowed' };
  if (url.username !== '' || url.password !== '') return { allow: false, reason: 'credentials_in_url' };
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.has(host)) return { allow: false, reason: 'host_not_allowed' };
  return { allow: true, host };
}

export type Upstream = (request: Request) => Promise<Response>;

const defaultUpstream: Upstream = (request) => fetch(request);

/** Build the fetch handler for one job's allowlist. Throws `JobTypeError` if a hostname is malformed. */
export function createOutboundFetch(allowedHosts: readonly string[], upstream: Upstream = defaultUpstream): (request: Request) => Promise<Response> {
  for (const host of allowedHosts) if (!isHostname(host)) throw new JobTypeError('bad_host', host);
  const allowed: ReadonlySet<string> = new Set(allowedHosts);
  return async (request: Request): Promise<Response> => {
    const decision = decideOutbound(request.url, allowed);
    if (!decision.allow) {
      return new Response(`runner egress refused: ${decision.reason}\n`, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return upstream(new Request(request, { redirect: 'manual' }));
  };
}
