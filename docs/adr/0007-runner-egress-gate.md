# 0007. Runner containers hold no Cloudflare token

Status: accepted, 2026-10-15

## Decision
Runner containers start with the internet disabled. All outbound HTTP(S) is intercepted into the
`EgressGate` Worker entrypoint, which allows only the hosts and paths of the job type, refuses
unexpected redirects, strips any credential the container sends and injects the right one per host
(Cloudflare API bearer token, R2 S3 SigV4 re-signing). The one secret a container must hold is
the OpenTofu state passphrase, passed to the single `exec` that needs it.

## Consequences
- A compromised provider plugin or tool cannot exfiltrate a token, only use the gate within its
  job type's allowlist.
- HTTPS interception requires the container to trust Cloudflare's container CA.
