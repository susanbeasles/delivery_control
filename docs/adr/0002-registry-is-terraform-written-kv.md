# 0002. The deployment registry is a Terraform-written KV value

Status: accepted, 2026-10-15

## Context
The RFC requires that only Terraform defines which applications, environments and targets exist,
and with which bindings. The deployer must read that registry at runtime and must not be able to
widen it. The Cloudflare provider can write Workers KV values; it cannot write R2 objects or D1 rows.

## Decision
`infra` writes `deploy-registry/v1` as the value of key `registry` in KV namespace
`deploy-registry`. The deployer validates it fatally on every load (30 s isolate cache) and records
the revision on each deployment.

## Consequences
- KV is eventually consistent (about 60 s). A registry edit can take a minute to apply. Revoking a
  target is therefore not instantaneous; the authorizer policy is the faster kill switch.
- Bindings for a target come only from the registry; a release can never add one.
