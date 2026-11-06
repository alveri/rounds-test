# Architecture

One Node.js process plays three roles — HTTP API, poll loop, summary worker — that `ROLE=api`
and `ROLE=worker` can split into separate processes, on top of PostgreSQL, which is both the store and the queue. A snapshot is committed with
`summary_status = 'pending'`; the LLM is called later, by a different loop. A slow or
failing LLM can therefore neither lose a snapshot nor delay polling.

```
 Browser (React SPA)      listing-stub (own process)     LLM (mock / OpenAI / Ollama)
        | REST /api              ^ GET /listings/:id            ^ chat/completions
        v                        |                              |
 +--------------------------- app (one process) ---------------------------+
 |  HTTP API               Poll loop                  Summary worker       |
 +------|----------------------|----------------------------|--------------+
        v read/write           v claim, insert snapshot     v claim pending
 +------------------------------ PostgreSQL -------------------------------+
 |  competitors (schedule: next_poll_at)   snapshots (history + summary queue) |
 +-------------------------------------------------------------------------+
```

## Data model

The snapshot row is also the summary job, so "snapshot exists but job is missing" cannot happen.

```sql
CREATE TABLE competitors (
  id              text PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  next_poll_at    timestamptz NOT NULL DEFAULT now(),  -- schedule
  poll_lease_until timestamptz,                        -- set while a poll is in flight
  last_polled_at  timestamptz,
  last_poll_error text
);
CREATE INDEX competitors_due_idx ON competitors (next_poll_at);

CREATE TYPE summary_status AS ENUM ('none', 'pending', 'ready', 'failed');

CREATE TABLE snapshots (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competitor_id text NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  previous_id   bigint REFERENCES snapshots(id) ON DELETE SET NULL,
  fetched_at    timestamptz NOT NULL,
  title         text NOT NULL,
  tagline       text NOT NULL,
  price         text NOT NULL,
  description   text NOT NULL,
  content_hash  text NOT NULL,     -- sha256 of the four fields
  changed       boolean NOT NULL,
  summary                 text,
  summary_status          summary_status NOT NULL DEFAULT 'none',
  summary_attempts        integer NOT NULL DEFAULT 0,
  summary_next_attempt_at timestamptz,
  summary_error           text
);
CREATE INDEX snapshots_timeline_idx ON snapshots (competitor_id, id DESC);
CREATE INDEX snapshots_previous_idx ON snapshots (previous_id);  -- ON DELETE SET NULL lookups
CREATE INDEX snapshots_pending_idx  ON snapshots (summary_next_attempt_at)
  WHERE summary_status = 'pending';
CREATE INDEX snapshots_failed_idx   ON snapshots (id) WHERE summary_status = 'failed';
```

## Poll loop

A loop ticks every second and claims due competitors, at most as many as it has free slots:

```sql
UPDATE competitors SET next_poll_at = now() + $interval, poll_lease_until = now() + $lease
WHERE id IN (
  SELECT id FROM competitors
  WHERE next_poll_at <= now() AND (poll_lease_until IS NULL OR poll_lease_until <= now())
  ORDER BY next_poll_at
  LIMIT $free_slots
  FOR UPDATE SKIP LOCKED)
RETURNING id;
```

- `poll_lease_until` is the lease: two ticks, two app instances or "Check now" during a slow
  fetch never start a second poll of a competitor. This matters because the source is stateful:
  a duplicate poll consumes a version, and overlapping polls can store snapshots out of order.
  It is separate from `next_poll_at` because the schedule can move back. `pollOnce` releases it;
  after a crash it expires (`FETCH_TIMEOUT_MS` + 30 s). A "Check now" during a fetch runs right after it.
- The schedule survives restarts. After downtime each competitor is polled once, not once
  per missed interval.
- Each competitor keeps its own phase from the moment it was added, so load is spread:
  300 competitors per 900 s is one fetch every 3 s on average.
- `POLL_CONCURRENCY` bounds parallel fetches; `FETCH_TIMEOUT_MS` bounds each one.
- A new competitor has `next_poll_at = now()`, so its first snapshot appears within a second.
- Source error: no snapshot row, the message goes to `last_poll_error`, next try on schedule.

## Persisting and diffing

1. Fetch the listing (no transaction open).
2. Normalise: trim the four fields. `content_hash = sha256(JSON.stringify([title, tagline, price, description]))`.
3. One transaction: `SELECT … FROM competitors WHERE id = $1 FOR UPDATE` (gone → discard the
   result, the competitor was deleted mid-fetch); read the latest snapshot; insert the new one;
   set `last_polled_at`, clear `last_poll_error`.

| Case | `changed` | `summary_status` | `previous_id` |
| --- | --- | --- | --- |
| First snapshot | false | none | null |
| Hash equals previous | false | none | previous |
| Hash differs | true | pending | previous |

Volume: 300 competitors × 96 polls/day = 28,800 rows/day, about 10.5M rows/year. The
timeline reads through `(competitor_id, id DESC)`. Production follow-ups: monthly
partitions, retention, or a `listing_versions` table so unchanged snapshots stop copying text.

## Summary worker

LLM option in use: the provided mock server (`mock-llm/mock-llm-server.py`, compose service
`mock-llm`). It needs no key and costs nothing; no real provider is configured or tested.

- Every second, claim `pending` rows whose `summary_next_attempt_at <= now()` with
  `FOR UPDATE SKIP LOCKED`. The claim increments `summary_attempts` and pushes
  `summary_next_attempt_at` forward (visibility timeout, in case the process dies mid-call).
- Call the LLM with an `AbortSignal` timeout of `LLM_TIMEOUT_MS`, `max_tokens` 120, SDK
  retries off (`maxRetries: 0`) — retries are the worker's job. At most `LLM_CONCURRENCY` calls at once.
- Success: `UPDATE … SET summary = $1, summary_status = 'ready' WHERE id = $2 AND summary_status = 'pending'`.
- Failure or timeout: back off (5 s, 20 s, 80 s, 320 s, 21 min, then 1 h, with up to 20% jitter;
  `LLM_BACKOFF_SECONDS`), honouring `Retry-After`. After `LLM_MAX_ATTEMPTS` the row becomes
  `failed`; `summary` stays null and the snapshot is untouched.
- 400, 401, 403, 404 and 422 mean retrying cannot help: the client throws `PermanentSummaryError`
  and the row fails at once.
- Cost ceiling: `LLM_MAX_ATTEMPTS` LLM requests per changed snapshot, 0 for unchanged or first
  snapshots. A claim past the last attempt (the process kept dying mid-call) fails the row without
  a call. A call aborted by shutdown keeps its attempt, since it may have been billed.
- Recovery: `POST /api/summaries/retry-failed` requeues every `failed` row with a fresh budget.
- Delivery: the LLM may be called more than once for a row (at-least-once), the summary is
  written once (guarded update).
- Prompt: the user message starts with the changed fields, e.g. `price: "$29/mo" -> "$39/mo"`,
  followed by both versions. The mock server echoes the first 160 characters, so its output
  reads as a real summary. The system message says the listing text is data, not instructions.
- `SummaryClient.summarize(input, signal): Promise<string>` is the seam. Switching provider is
  three env vars: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.

## HTTP API

| Method and path | Success | Errors | Origin |
| --- | --- | --- | --- |
| `GET /api/competitors` | 200 `[{ id, createdAt, lastPolledAt, lastPollError }]` | — | contract |
| `POST /api/competitors` `{ id }` | 201 `{ id }` | 400 invalid id, 409 duplicate | contract |
| `DELETE /api/competitors/:id` | 204 | 404 | contract |
| `GET /api/competitors/:id/snapshots?limit&before` | 200 `[Snapshot]`, newest first | 404 | contract |
| `POST /api/competitors/:id/poll` | 202, sets `next_poll_at = now()` | 404 | extra (demo) |
| `POST /api/summaries/retry-failed` | 200 `{ requeued }` | — | extra (recovery) |
| `GET /readyz`, `GET /health` | 200, checks the DB | 503 | extra |
| `GET /livez` | 200 while the loops tick; never touches the DB | 503 | extra |
| `GET /metrics` | 200, Prometheus text format | — | extra |
| `GET /openapi.json` | 200, generated from the route schemas | — | extra |

`Snapshot` = contract fields plus `id`, `summaryStatus` (`none` / `pending` / `ready` /
`failed`) and `initial`. `summary` is null unless `summaryStatus` is `ready`.

## Frontend

- `/` — add form, list with Remove (and a confirmation step), last poll error per competitor, messages for 400 / 409.
- `/competitors/:id` — snapshot cards, 50 per page with a button for older ones, refetch every
  5 s (stops only on 404, so a transient error does not freeze the page). Caption states: summary text,
  "Summary pending…", "Summary unavailable", "No change since previous snapshot", "Initial snapshot".
- Dev: Vite proxies `/api` to the server. Build: Fastify serves `web/dist` (one origin, no CORS).
- Response types live in `web/src/api.ts`; no shared package for ~20 lines of types.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROLE` | `all` | `api`, `worker` or both in one process |
| `LOG_LEVEL` | `info` | pino log level |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `DB_POOL_SIZE` | 10 | Connections per process |
| `DB_CONNECT_TIMEOUT_MS` | 5000 | Waiting for a pool connection |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | One SQL statement |
| `PORT` | 3000 | HTTP port |
| `LOOP_STALL_SECONDS` | 120 | `/livez` fails when a loop has not finished a tick for this long |
| `POLL_INTERVAL_SECONDS` | 900 | Poll interval; compose sets 15 for the demo |
| `POLL_CONCURRENCY` | 5 | Parallel source fetches |
| `FETCH_TIMEOUT_MS` | 10000 | Source fetch timeout |
| `LISTING_SOURCE_URL` | `http://localhost:4002` | Listing stub base URL |
| `LLM_BASE_URL` | `http://localhost:4001/v1` | Mock server or a real provider |
| `LLM_API_KEY` | `mock` | Provider key |
| `LLM_MODEL` | `mock-llm` | Model name |
| `LLM_TIMEOUT_MS` | 15000 | Timeout of one LLM call |
| `LLM_MAX_ATTEMPTS` | 8 | Attempts per snapshot; compose sets 3 for the demo |
| `LLM_BACKOFF_SECONDS` | `5,20,80,320,1280,3600` | Pause before each retry; the last repeats |
| `LLM_CONCURRENCY` | 4 | Parallel LLM calls |

## Layout

```
competitor-pulse/
  README.md  CLAUDE.md  Dockerfile  docker-compose.yml  .env.example  .oxlintrc.json
  .github/workflows/ci.yml
  mock-llm/mock-llm-server.py        # provided, unchanged
  scripts/e2e-smoke.py
  server/
    drizzle/                         # SQL migrations
    fixtures/listings.json           # provided, unchanged
    src/
      main.ts                        # composition root (ROLE), graceful shutdown
      config.ts                      # Zod env schema
      db/           schema.ts  client.ts  migrate.ts
      domain/       listing.ts  retry-policy.ts  errors.ts     # pure rules, no I/O
      repositories/ competitors.ts  snapshots.ts  metrics.ts   # all SQL
      services/     polling.ts  summaries.ts  competitors.ts   # pollOnce, summarizeOnce, CompetitorService
      workers/      poll-worker.ts  summary-worker.ts          # loops and concurrency slots
      http/         app.ts  competitors.routes.ts  summaries.routes.ts  ops.routes.ts  schemas.ts  dto.ts
      source/       listing-source.ts  http-listing-source.ts
      stub/         fixture-sequence.ts  server.ts             # separate entry point and image
      summary/      summary-client.ts  openai-summary-client.ts  prompt.ts
      lib/          loop.ts  clock.ts  logger.ts  metrics.ts
    test/
  web/
    src/  main.tsx  App.tsx  api.ts  pages/CompetitorList.tsx  pages/CompetitorTimeline.tsx
    test/
```

## Runtime

- `docker compose up --build` starts `db`, `migrate`, `mock-llm`, `listing-stub`, `app`. `migrate`
  applies migrations under an advisory lock and exits, and `app` starts only after it succeeds.
  The app itself never migrates. It serves the UI on port 3000.
- Multi-stage Dockerfile with two targets: `app` (default; no stub, no fixtures) and `stub`. Both
  are slim, without dev dependencies, run as a non-root user and have a `HEALTHCHECK`.
- `SIGTERM`: loops stop claiming, in-flight polls finish, in-flight LLM calls are aborted and their
  rows are due again, then the HTTP server and the pool close.
- More instances are safe as is, because all claims use `SKIP LOCKED`.
- Production differences: managed PostgreSQL, LLM key in a secret store, an alert on poll lag and
  on LLM calls per day from `/metrics`.

## Rejected alternatives

| Option | Why not here |
| --- | --- |
| `setInterval` over all competitors | Overlapping ticks, bursts, schedule lost on restart, double polls with two instances |
| BullMQ + Redis, pg-boss | New infrastructure or a library hiding the very decisions being graded; load is one poll per 3 s |
| LLM call inside the poll | A 20 s LLM response would hold a poll slot and couple snapshot durability to the LLM |
| SQLite or a JSON file | Single writer, no `SKIP LOCKED`; a real database with migrations is a stated bonus |
| LLM decides whether something changed | Paid call on every poll; a hash comparison is exact and free |
