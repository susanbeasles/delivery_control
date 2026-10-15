# 0006. The deployer owns application Worker scripts; Terraform owns everything pointing at them

Status: accepted, 2026-10-15

## Context
The spec forbids the `infra` apply token from touching Workers Scripts, and gives each deploy
target its own Workers Scripts Edit token. Provider 5.28.0's `cloudflare_worker` resource would
need Workers Scripts Write.

## Decision
The deployer creates a target's script on its first deploy, uploads a version per release, keeps
workers.dev and preview URLs disabled, and never deletes a script. Terraform owns custom domains,
routes and Access applications. Rego rule P7 forbids `cloudflare_worker`, `cloudflare_workers_script`,
`cloudflare_worker_version` and `cloudflare_workers_deployment` in any plan.

## Consequences
- A new target's domain is applied after its first deploy.
- Script deletion is a manual, deliberate act outside both systems.
