# Central Cloudflare deployment implementation

This local increment is disabled and has not been deployed. `workflow_depot`
owns deployment policy and authorization. This repository supplies the single
credentialed enforcement service. Application jobs receive no Cloudflare token.
`repoctl` supplies the shared contract and signature-verification library; it is
not a second deployment authority.

The public executor accepts only an operation ID and pinned delivery-workflow
OIDC identity. A private service binding consumes the exact retained depot
authorization once. It binds artifact and metadata digests, source and signer,
the expected existing deployment, owned destination, execution run, expiry,
nonce and policy digest. The executor reads the immutable artifact from the
same R2 bucket as depot provenance and validates its exact bytes before upload.

The service journals intent, then requests a fresh private authority check
immediately before upload and again before activation. Ambiguous writes retain
the operation and target lock; they are not automatically retried. Verification
checks the resulting version, full deployment and owned domain. Only explicitly
named existing secrets may be inherited. No secret values, new resources,
migrations, arbitrary commands or application build hooks are accepted.

`CLOUDFLARE_API_TOKEN` belongs only to this trusted service. Optional
`GITHUB_READ_TOKEN` supports private source reads and is sent only to the fixed
GitHub API. Neither value is returned to callers, included in receipts or
configured in source. No credentials were created or accessed for this work.

The provider token itself cannot restrict uploads to one digest. The trusted
service enforces that restriction. Provider baseline reads and mutations are
separate requests, so independent writers can race them. Production activation
must resolve alternate deployment authority rather than claim atomic provider
compare-and-swap guarantees.

The implemented operation updates one existing Worker at its existing owned
domain. Coordinated multi-Worker rollout/rollback is not implemented. The
disabled configuration is not a replacement for the existing four-component
application release until that requirement is fulfilled.

Remaining integration includes commissioned signer candidate/receipt services,
real required scanner and independent reviewer evidence, exact candidate PR and
promotion wiring, pinned authorizer/executor workflows, actual target policy
and service-secret references, and successful Workers runtime qualification.
Local tests use synthetic adapters and network responses. No artifact upload,
account change, workflow dispatch, commit, push or deployment was performed.
# Existing ingress preservation

Targets without `ingress` retain the original exact custom-domain contract.
An approved route target may instead bind
`ingress: {type: "routes", zoneIDs: [...], routes: [{id, zoneID, pattern}]}`.
The operation must contain exactly the same value. Route hosts are exact;
wildcards are limited to the final path character. IDs are unique and sorted.
An internal target uses `ingress: {type: "service-only", zoneIDs: [...]}` and
explicit `zoneID: null, hostname: null`.

For both modes the provider checks the complete approved account-zone inventory,
each zone's route list, absence of custom domains for this Worker, and disabled
workers.dev/preview ingress. Repeated snapshots and checks before effects deny
observed drift. No route, domain or visibility setting is created or changed.
The provider APIs do not offer an atomic code/route transaction; external changes
between observations remain a qualification limitation.

Zone lists are credential-filtered. Commissioning must independently verify the
service credential can read all account zones and their routes and that the
approved `zoneIDs` inventory is complete. Successful partial lists alone do not
prove absence of hidden public ingress. The implementation follows Cloudflare's
[zone pagination](https://developers.cloudflare.com/api/resources/zones/methods/list/),
[zone route list](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/),
and [single-page Worker domain list](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/).
