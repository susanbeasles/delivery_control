# Protected-ref execution

The isolated executor obtains its single credential lease, observes the exact
candidate and current protected tip, then requests fresh GitHub OIDC authorization
from `/v1/execution/check` immediately before PATCH. The response must match the
entire leased intent and original lease expiry; denied, changed or expired
confirmation prevents any update. Cleanup revokes the token and reports outcome
for independent controller reconciliation even when that final check denies.

The check mints no additional token and returns no provider secret. The actual
controller must verify pinned executor identity, current owner/hardware/policy,
live issued lease, enrolled baseline and exact fast-forward candidate. It remains
disabled until commissioning and live qualification. Provider restrictions must
close races outside the final observation; this is not an atomic policy/ref CAS.

`node --test test/releases.test.mjs test/execution.test.ts` passes13 tests,
including exact successful confirmation and denied/expired/foreign check cleanup.
These standalone tests use synthetic controller/provider responses. repoctl's
controller suite additionally verifies actual RSA OIDC signatures and durable
broker integration. No live promotion or credential issuance is qualified by
these tests. The source-release manager is a separate pipeline.
