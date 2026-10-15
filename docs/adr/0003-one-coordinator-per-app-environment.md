# 0003. One coordinator per application and environment; the queue only wakes it

Status: accepted, 2026-10-15

## Context
Deployments for one application and environment must never overlap, must survive crashes at any
point, and should not deploy stale releases when pushes land in quick succession.

## Decision
A SQLite-backed Durable Object per `application:environment` holds all state for that key. Every
decision is a synchronous transaction. Execution runs under a fenced lease in slices of at most
50 seconds. Side effects are recorded before and after they run and carry operation ids so a retry
reconciles instead of repeating. One deployment is active; one request waits next in line; a newer
request replaces the waiting one. A `deploy` for a release older than the committed or in-flight
one is refused. State changes and their consequences (ledger writes, GitHub statuses, queue kicks)
are written to an outbox in the same transaction and delivered afterwards. The Cloudflare Queue
carries only wake-up kicks; the alarm is the watchdog that drives progress if a kick is lost.

## Consequences
- At-least-once delivery everywhere is safe: duplicate kicks find a held lease or nothing to do.
- Newest-wins means intermediate releases may never deploy. That is intended for push-to-main.
