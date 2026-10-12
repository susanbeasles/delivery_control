# Cloudflare execution caller

The disabled `execute-cloudflare.yml` dispatch calls the same-commit reusable
`cloudflare-executor.yml` job. Its built-in Node caller checks exact repository,
numeric IDs, main/workflow refs, event and run coordinates, then waits at most
120 seconds for the existing depot authority to approve that exact execution
run. Only successful `pending` responses are polled, at most 24 times. Denials,
malformed responses, changed IDs, timeouts and transport failures stop the caller.

The caller obtains a fresh operation-bound GitHub OIDC token and sends exactly
`{operationID,oidcToken}` once to the existing trusted deployer. It never retries
an execute POST, including a lost response. Inspect retained authority/deployer
state before any retry: the original operation can already be consumed or
uncertain. A workflow rerun has a new attempt and cannot inherit the old grant.
The caller logs only waiting run coordinates and a strictly validated nonsecret
completion receipt. Cloudflare credentials stay in the service.

| Identity | Required value |
| --- | --- |
| repository / numeric ID | `susanbeasles/delivery_control` / `1405415291` |
| owner ID / ref / event | `215839550` / `refs/heads/main` / `workflow_dispatch` |
| workflowRef | `susanbeasles/delivery_control/.github/workflows/execute-cloudflare.yml@refs/heads/main` |
| jobWorkflowRef | `susanbeasles/delivery_control/.github/workflows/cloudflare-executor.yml@refs/heads/main` |
| audience | `delivery-control-cloudflare-deployer:<operationID>` |
| authority readiness | `https://pipeline.vespoli.me/v1/deployments/status` |
| execution endpoint | `https://deploy.vespoli.me/v1/deployments/execute` |

Repository identities were verified by read-only GitHub metadata. Endpoint names
are approved source proposals, not deployed infrastructure. Local reusable paths
resolve the caller's actual commit; retained depot policy must separately pin
both final signed workflow SHAs and approved actor IDs. There is no self-referential
SHA placeholder pretending to be active. The source `CONFIG.enabled` switch stays
false until that commissioning is complete. No job input or repository variable
can redirect OIDC/provider traffic or enable the script.

The executor checks out only its trusted repository at `github.sha`, installs no
application dependencies and downloads no application artifacts. The service
reads the already retained exact artifact after consuming depot authority.
There is no native Cloudflare OIDC exchange, provider credential in a job, or new
deployment authority. Existing service/evidence/target qualification requirements
still apply; this caller does not create them.

Local verification: `node --test test/cloudflare-execution-caller.test.mjs`.
Tests use synthetic network responses and a fake clock. No workflow was started,
source uploaded, credential read or provider operation performed for this change.
