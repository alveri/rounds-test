---
name: verify-e2e
description: Verify CompetitorPulse end to end against a running docker compose stack — API contract, no LLM call on unchanged listings, snapshot survival when the LLM fails or is slow, and restart safety. Use after changing the poller, the summary worker, the API or the compose setup, and before saying the system works.
---

# Verify CompetitorPulse end to end

Unit tests prove the logic; this proves the running system. It uses the control endpoints of
the provided mock LLM server, which exist for exactly these checks.

Run `python3 scripts/e2e-smoke.py`; it automates the scenarios below (about 2 minutes). It builds
a throwaway compose project, `competitor-pulse-e2e`, with its own ports (app `3100`, mock-llm
`4101`, listing-stub `4102`, PostgreSQL `5533`) and removes it afterwards, so a development stack
is not touched. `--keep` leaves it up. The ports below are the development stack's, for going
through the scenarios by hand on a fresh one: app `3000`, mock-llm `4001`, listing-stub `4002`.

## Setup by hand

```bash
docker compose down -v && docker compose up --build -d
until curl -sf localhost:3000/health >/dev/null; do sleep 1; done
curl -s -X POST localhost:4001/control/reset
```

`down -v` matters and deletes the stack's data: the stub counter and the database must both start
from zero, otherwise the expected version sequence below is wrong.

Use `POST /api/competitors/:id/poll` to force a poll instead of waiting for the interval.
After each forced poll wait about 2 seconds (loop tick is 1 second).

The script sets `COMPOSE_POLL_INTERVAL_SECONDS=3600` so that only forced polls happen, and by
hand you should too: a scheduled poll mid-scenario adds versions and consumes the mock's injected
failures (`failNext` counts every request, not per snapshot). Track snapshots by `id`,
never by "newest". When it fails, walk through the failing scenario by hand, and check the
database (`docker compose exec db psql ...`) before concluding the system is wrong.

## Scenario A — contract and LLM cost

1. `POST /api/competitors {"id":"acme-crm"}` → expect `201`.
2. `GET /api/competitors` → an array containing `{"id":"acme-crm", ...}`.
3. Force 5 more polls (6 snapshots in total), then wait until no snapshot is `pending`.
4. `GET /api/competitors/acme-crm/snapshots` → expect:
   - 6 items, newest first (`fetchedAt` strictly descending, ISO 8601 ending in `Z`);
   - `changed` from oldest to newest: `false, true, true, true, false, false`;
   - `summary` is a non-empty string on the three changed items and `null` on the others.
5. `curl -s localhost:4001/control/stats` → `{"callCount": 3}`.
6. Force 2 more polls → `callCount` is still `3`. **This is the billing check.**

## Scenario B — the LLM fails

1. `curl -s -X POST localhost:4001/control/configure -d '{"failNext":3}'`
2. `POST /api/competitors {"id":"ferry-pay"}`, then force 1 more poll (versions 1 and 2).
3. Immediately: the version-2 snapshot is present with all four listing fields correct,
   `changed: true`, `summary: null`, `summaryStatus: "pending"`.
4. After about 30 seconds (attempts at 0 s, +5 s, +20 s): `summaryStatus: "failed"`,
   `summary: null`, listing fields unchanged. The app process is still up (`/health` is 200).
5. Force 1 more poll (version 3) → that snapshot reaches `ready`. Failures are per snapshot.

## Scenario C — the LLM is slow

1. `curl -s -X POST localhost:4001/control/configure -d '{"latencyMs":20000}'`
2. `POST /api/competitors {"id":"north-analytics"}`, force 1 more poll.
3. While the summary is pending:
   - `GET /api/competitors` answers in well under a second;
   - forcing a poll of `acme-crm` still adds a snapshot within about 2 seconds.
   A blocked poll loop or a blocked API here is a failure of the core requirement.
4. The pending summary is aborted at `LLM_TIMEOUT_MS` (15 s), not at 20 s, and is retried.
5. `curl -s -X POST localhost:4001/control/reset`

## Scenario D — restart

1. Note the snapshot count per competitor, then `docker compose restart app`.
2. After it is healthy: history is intact, and within the first 5 seconds no competitor gained
   more than one snapshot (no catch-up burst).
3. Any snapshot that was `pending` before the restart still reaches `ready` or `failed`.

## Scenario E — validation and removal

- `POST {"id":"acme-crm"}` again → `409`. `POST {"id":"Bad Id!"}` → `400`.
- `DELETE /api/competitors/acme-crm` → `204`; again → `404`.
- `GET /api/competitors/acme-crm/snapshots` → `404`.
- `POST {"id":"does-not-exist"}` → `201`; after a poll, the list shows a `lastPollError` for
  it and it has no snapshots.

## Reporting

State which scenarios passed and which failed, with the actual response or `callCount` for
each failure. Do not report success for a scenario you did not run. Finish with
`docker compose down -v` unless the stack is needed afterwards.
