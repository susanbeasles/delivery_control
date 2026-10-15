# 0001. Admission is authenticated by GitHub OIDC in the authorizer, not by an Access service token

Status: accepted, 2026-10-15

## Context
The control-plane spec lists `services.susanb.dev/v1/*` as "service-auth only" behind Cloudflare
Access. It also says GitHub holds no secrets. An Access service token is a client id and secret;
GitHub Actions would have to store it.

## Decision
`POST /v1/token` is not behind an Access application. The authorizer Worker authenticates the
GitHub Actions OIDC token itself (signature against GitHub's JWKS, issuer, audience, lifetime,
owner, repository, pinned reusable workflow, ref, replay). Every other path on the host is blocked
at the edge by a WAF rule in `infra`, and `/v1/token` is rate limited per IP.

## Consequences
- GitHub holds no long-lived credential for the control plane.
- The OIDC token is short-lived (at most 10 minutes) and single-use (jti replay ledger).
- The Worker's verification code is the security boundary for that path, so it carries one test
  per error code.
