---
paths:
  - "server/**"
---

# Backend rules

Read `docs/ARCHITECTURE.md` before changing anything under `server/src/services`,
`server/src/repositories`, `server/src/workers`, `server/src/summary` or `server/src/db`.

## Layers

- Routes parse and delegate. No SQL and no status-code decisions beyond the success code.
- All SQL lives in `repositories/`. Pure rules live in `domain/`. Loops in `workers/` stay thin.
- Logs are structured: `log.info({ competitorId }, 'fixed message')`, never interpolated.

## Transactions and network

- Never `await` a network call (listing source, LLM) between `BEGIN` and `COMMIT`.
- The poll transaction is: lock the competitor row `FOR UPDATE`, read its latest snapshot,
  insert the new snapshot, update `last_polled_at`. Nothing else.
- If the locked competitor row is missing, the competitor was deleted mid-fetch: discard
  the result and return. Do not treat it as an error.

## Claiming work

- Claims are single statements: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`.
- A poll claim moves `next_poll_at` forward and sets `poll_lease_until`; `pollOnce` releases it.
  The lease is separate from the schedule because `requestPoll` moves the schedule back.
- A summary claim increments `summary_attempts` and moves `summary_next_attempt_at` forward,
  which is its lease. `summarizeOnce` fails a claim past `LLM_MAX_ATTEMPTS` without calling the LLM.
- Loops never overlap with themselves: schedule the next tick after the current one settles.
  Claim at most `limit - inFlight` rows per tick.

## The listing source

- It is stateful: every call consumes one version for that id. Call it only from `pollOnce`,
  exactly once per claimed competitor. Do not add fetch retries, warm-ups or previews.
- Validate its response with Zod. A 404, a timeout or an invalid body is a poll error:
  no snapshot row, message into `last_poll_error`.

## The LLM

- Only `summarizeOnce` calls `SummaryClient`. HTTP handlers and the poller never do.
- Every call has an `AbortSignal` timeout from config. SDK-level retries stay off.
- Write the result with a guarded update: `… WHERE id = $1 AND summary_status = 'pending'`.
- The client classifies errors (`PermanentSummaryError`, `RateLimitedSummaryError`); the backoff
  lives in `domain/retry-policy.ts`.
- Keep the changed-fields line at the very start of the user message (the mock server echoes
  the first 160 characters).

## HTTP

- Zod schema for params, query and body on every route; never trust `:id` unvalidated.
- Map database rows to the contract shape in one place (`toSnapshotDto`): camelCase,
  `fetchedAt` via `toISOString()`, `summary` null unless status is `ready`.
- Do not rename or retype contract fields. Additive changes only.

## Tests

- Integration tests run against the compose `db`; each test starts from truncated tables.
- Drive time through the injected clock and call `pollOnce` / `summarizeOnce` directly.
  No `setTimeout`-based waiting.
- Any change to claiming, diffing or summary status needs a test that would fail without it.
