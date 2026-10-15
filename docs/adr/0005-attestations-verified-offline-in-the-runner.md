# 0005. Attestations are verified with GitHub's verifier in a no-egress container

Status: accepted, 2026-10-15

## Context
Verifying a Sigstore bundle means X.509 chain validation, transparency-log or timestamp proofs and
certificate extension checks. Writing that by hand in a Worker is a large, security-critical
surface.

## Decision
The `release.verify` runner job runs `gh attestation verify` against a pinned, reviewed trusted
root baked into the image, with the internet disabled and no egress allowed. The coordinator checks
the result against the registry (repository, signer workflow) and the authorized digests.

## Consequences
- The trusted root is a commissioning input and rotates by pull request.
- Verification takes a container start (seconds), which the coordinator waits for without holding
  its lease.
