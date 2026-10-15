# 0004. Release bytes are bound three times, then live only in a locked bucket

Status: accepted, 2026-10-15

## Decision
1. The authorizer captures GitHub's per-asset SHA-256 for an immutable release.
2. The deployer downloads into `release-staging`, passing that digest to R2, which refuses
   mismatching bytes. The manifest's own digests bind every target artifact and module.
3. The runner verifies the Sigstore attestation for the archive and the manifest against the
   registered release workflow and the source commit.
Only then are the bytes copied, create-only, into `releases`, whose bucket lock is indefinite. All
later reads, including rollbacks and other environments, come from `releases`.

## Consequences
- GitHub is not consulted again for a release once ingested; a rollback works during a GitHub outage.
- A tag re-published with different bytes is refused as `release_bytes_conflict`, never overwritten.
