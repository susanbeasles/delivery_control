# Signed source publication

`createSourcePublisher` publishes retained objects from the same complete bare
Git store used by the source snapshotter. It sends an already verified signed
candidate to an immutable `promotion/<sequence>/shadow` ref and creates its
deterministic draft PR. The original source history and main remain unchanged.
Paired approved source/main tags use the same create-only transport.

Install the source core's private `authorizePublication` capability and existing
builder-role credential adapter in the isolated delivery service. The grant
binds one exact durable effect reservation; no public arbitrary ref or PR write
endpoint exists. The credential adapter must return the one configured numeric
repository with exactly contents/write, pull_requests/write and metadata/read.
No credential is accepted from a source job or returned to it.

The Git executable digest, fixed operator-owned bare clone and HTTPS repository
are installed configuration. System/global Git configuration, hooks, credential
helpers, prompts and alternate protocols are disabled. An empty expected-ref
lease permits creation only. A lost mutation response is reconciled by exact
readback and never causes automatic re-publication.

Local tests exercise actual object storage, full parent/tree/blob closure,
create-only command construction, synthetic provider responses, current policy
revocation, expiry and ambiguous results. They do not qualify real credentials,
GitHub protections, signer hardware, PR publication or main promotion. Existing
promotion still requires its owner, independent validator and execution-owner
envelopes; only the existing executor advances main from M to signed S.

Run `node --test test/source-git.test.mjs test/source-publisher.test.mjs`.
