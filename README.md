# CompetitorPulse

Tracks competitors' product listings over time and uses an LLM to explain, in plain English,
what changed between two consecutive snapshots.

- **Backend:** Node.js 24, TypeScript (strict), Fastify, PostgreSQL 17 with Drizzle migrations
- **Frontend:** React, Vite, React Router, TanStack Query
- **LLM:** the provided mock server (`mock-llm/mock-llm-server.py`), through the OpenAI SDK
- **Run:** one command with Docker Compose

## Quick start

Requires Docker with Compose v2.

```bash
docker compose up --build
```

Open http://localhost:3000, track `acme-crm`, `north-analytics` or `ferry-pay`, and click
into one. The first snapshot appears within a second; after that a new one arrives every
15 seconds, and each change gets an AI summary. **Check now** polls immediately.

```bash
docker compose down -v   # stop and reset everything, including the stub's version counters
```

Five services start: `app` (API, UI, scheduler and summary worker; port 3000), `db`
(PostgreSQL; host port 5433), `migrate` (applies migrations once, then exits), `listing-stub`
(the fixture data source; 4002) and `mock-llm` (the provided mock LLM; 4001). All are published
on localhost only. Change the demo poll interval with `COMPOSE_POLL_INTERVAL_SECONDS=60 docker
compose up`, and the host ports with `APP_PORT`, `DB_PORT`, `MOCK_LLM_PORT` and `STUB_PORT`.

The same with `make` (also needs `curl`); plain `make` lists the targets:

| Command | What it does |
| --- | --- |
| `make build` | Build the images; run it after changing the code |
| `make start` | Start everything in the background and wait until healthy |
| `make start INTERVAL=60` | The same, polling every 60 seconds |
| `make seed` | Track `acme-crm`, `north-analytics` and `ferry-pay` |
| `make clear` | Remove all competitors with their history and rewind the stub |
| `make logs` | Follow the app logs |
| `make stop` | Stop everything, keep the data |
| `make reset` | Stop everything and delete the data |
| `make check` | Lint, typecheck and test (needs `db` up) |
| `make e2e` | End-to-end checks on a separate, throwaway stack |

## LLM option

**The provided mock LLM server.** It needs no key and costs nothing. Its replies echo the
start of the prompt, which this app opens with the changed fields, so a mock summary
reads like:

> Mock AI summary (not a real model). Based on what you sent: "Changed: price: "$29/mo" -> "$39/mo" …

The app talks to it with the official `openai` package, so any OpenAI-compatible endpoint
works with three variables (not tested here with a real provider):

```yaml
# docker-compose.yml, service app
LLM_BASE_URL: https://api.openai.com/v1   # or http://host.docker.internal:11434/v1 for Ollama
LLM_API_KEY: ${OPENAI_API_KEY}
LLM_MODEL: gpt-4o-mini
```

The mock's control API is published on localhost, so failure handling can be shown live:

```bash
curl -X POST localhost:4001/control/configure -d '{"failNext": 3}'      # next 3 calls return 500
curl -X POST localhost:4001/control/configure -d '{"latencyMs": 20000}' # every call takes 20 s
curl localhost:4001/control/stats                                       # {"callCount": N}
curl -X POST localhost:4001/control/reset
```

## How it works

```
 Browser (React) ──REST──▶ ┌──────────────── app (one Node.js process) ───────────────┐
                           │  HTTP API        Poll loop             Summary worker     │
                           └──────┬──────────────┬──────────▲──────────────┬───▲──────┘
                                  │              │ fetch    │              │   │ chat/completions
                                  │              ▼          │              │   │
                                  │        listing-stub ────┘              │   mock-llm
                                  ▼              ▼                         ▼
                           ┌──────────────────── PostgreSQL ────────────────────────────┐
                           │ competitors: next_poll_at = the schedule                    │
                           │ snapshots:   every fetch + summary_status = the LLM queue   │
                           └─────────────────────────────────────────────────────────────┘
```

The poll loop and the summary worker share nothing but the database. A snapshot is
committed before any LLM call is made, so a slow or failing LLM can neither lose a snapshot
nor hold up polling.

### Scheduling

The schedule is a column, `competitors.next_poll_at`, not a set of timers. Every second
the poll loop claims due competitors in one statement:

```sql
UPDATE competitors SET next_poll_at = now() + interval, poll_lease_until = now() + lease
WHERE id IN (SELECT id FROM competitors
             WHERE next_poll_at <= now() AND (poll_lease_until IS NULL OR poll_lease_until <= now())
             ORDER BY next_poll_at LIMIT <free slots> FOR UPDATE SKIP LOCKED)
RETURNING id;
```

- **No double polls.** A claim takes a lease (`poll_lease_until`), which the finished poll
  releases, so overlapping ticks, several app instances or **Check now** during a slow fetch
  never run two polls of one competitor. This matters because a fetch is not idempotent: each
  one consumes a version from the source, and snapshots must be stored in fetch order. The
  lease is `FETCH_TIMEOUT_MS` + 30 s, so a process that dies mid-fetch blocks nothing for long.
- **Restart-safe.** The schedule survives restarts. After downtime each competitor is polled
  once, not once per missed interval.
- **Spread out.** Each competitor keeps the phase it was added with, so 300 competitors every
  15 minutes means one fetch about every 3 seconds, not a burst every quarter hour.
- **Bounded.** At most `POLL_CONCURRENCY` fetches run at once, each capped by
  `FETCH_TIMEOUT_MS`. A slow source holds one slot and nothing else.

### Persistence and diffing

Every successful fetch inserts a snapshot row, changed or not, so the timeline is complete.
Whether something changed is decided by comparing a SHA-256 of the four trimmed fields with
the previous snapshot's hash. It is exact, free and never asks the LLM.

The fetch happens outside any transaction. The write is one short transaction: lock the
competitor row (if it was deleted mid-fetch, the result is dropped), read the previous
snapshot, insert the new one.

| Case | `changed` | Summary |
| --- | --- | --- |
| First snapshot of a competitor | `false` | none, nothing to compare with |
| Same hash as the previous one | `false` | none, no LLM call |
| Different hash | `true` | `pending`, picked up by the summary worker |

### LLM integration

- **The row is the job.** A changed snapshot is stored with `summary_status = 'pending'`, so
  there is no separate queue to fall out of sync. A worker loop claims due rows with
  `FOR UPDATE SKIP LOCKED`, counts the attempt and leases the row past the call timeout; if
  the process dies mid-call, the row becomes due again when the lease runs out.
- **Bounded calls.** Each call has a hard timeout (`LLM_TIMEOUT_MS`, 15 s) and SDK retries are
  off. The worker makes at most `LLM_MAX_ATTEMPTS` (8; 3 in compose, so failures show up within
  a demo) calls per snapshot, including when the process keeps dying mid-call: a claim past the
  last attempt fails the row without calling the LLM. Unchanged and first snapshots cost nothing.
- **Retries that fit the failure.** Backoff is 5 s, 20 s, 80 s, 320 s, 21 min, then 1 h with up
  to 20% jitter, so 8 attempts ride out an outage of over 2 hours (`LLM_BACKOFF_SECONDS`).
  `Retry-After` is honoured. 400, 401, 403, 404 and 422 fail at once: retrying cannot help.
- **Recovery.** `POST /api/summaries/retry-failed` puts every `failed` summary back in the queue
  with a fresh budget, for after a longer outage or a fixed API key. It is the one way a snapshot
  can exceed `LLM_MAX_ATTEMPTS`, and it takes an explicit request.
- **Bounded input.** A listing over the field limits or 256 KB is a poll error. Each field is
  clipped to 2,000 characters in the prompt, so a huge description cannot inflate the bill.
- **Snapshots are never touched.** The worker writes only the `summary_*` columns, and only
  while the row is still `pending`, so it can neither damage a snapshot nor overwrite a
  summary that already exists.
- **Clean shutdown.** On `SIGTERM` the loops stop claiming, in-flight polls finish, and in-flight
  LLM calls are aborted. Their row is due again at once; the attempt stays counted, because the
  aborted call may have been billed.
- **Untrusted input.** Listing text is third-party content. The prompt quotes it as data, the
  system message says not to follow instructions inside it, and the UI renders summaries as
  plain text.

## API

The four endpoints from the assignment behave exactly as specified. Additions are marked.

| Method and path | Success | Errors |
| --- | --- | --- |
| `GET /api/competitors` | `200` `[{ id, createdAt, lastPolledAt, lastPollError }]` | |
| `POST /api/competitors` `{ "id": "acme-crm" }` | `201` | `400` invalid id, `409` already tracked |
| `DELETE /api/competitors/:id` | `204` | `404` |
| `GET /api/competitors/:id/snapshots?limit=200&before=<id>` | `200` `[Snapshot]`, newest first | `404` |
| `POST /api/competitors/:id/poll` *(added)* | `202`, polls within a second | `404` |
| `POST /api/summaries/retry-failed` *(added)* | `200` `{ "requeued": n }` | |
| `GET /readyz`, `GET /health` *(added)* | `200` when the database answers | `503` |
| `GET /livez` *(added)* | `200` while the loops tick | `503`, names the stalled loop |
| `GET /metrics` *(added)* | `200`, Prometheus text format | |
| `GET /openapi.json` *(added)* | `200`, OpenAPI generated from the route schemas | |

`Snapshot` has the contract fields (`fetchedAt`, `title`, `tagline`, `price`,
`description`, `changed`, `summary`) plus `id`, `summaryStatus` (`none`, `pending`, `ready`,
`failed`) and `initial`. `summary` is `null` unless `summaryStatus` is `ready`; the UI uses
the status to tell "pending" from "unavailable".

## Assumptions

- The first snapshot of a competitor has `changed: false` and no summary (`initial: true`).
- Adding an id that is already tracked returns `409`.
- Ids are lowercase slugs, `^[a-z0-9][a-z0-9-]{0,63}$`; anything else returns `400`.
- An id the data source does not know is accepted. Each poll then fails, and the error is
  shown in the list (`lastPollError`) without creating snapshots.
- Removing a competitor deletes its history. Adding it again starts a new history.
- The timeline API returns the latest 200 snapshots by default; `limit` and `before` page
  further back. The UI loads 50 at a time, with a button for older ones.
- The listing stub is a separate process. Restarting the app does not rewind the
  competitors' "websites" to version 1; `docker compose down -v` resets both.
- The stub keeps its version counters in memory. After `docker compose stop` or `down`
  without `-v`, the history stays but the stub starts again from version 1, so the versions
  replay as new changes, each with an LLM call. That comes from the stub, not the app: a real
  website would not rewind. For a clean start use `docker compose down -v`.
- Snapshot times are stored in UTC and shown in the browser's local time.

## Testing

```bash
docker compose up -d db                  # tests use a separate database, competitorpulse_test
npm install
npm run lint                             # oxlint, type-aware (no-floating-promises and friends)
npm run typecheck
npm test                                 # 106 tests: unit + integration against PostgreSQL
make e2e                                 # throwaway stack on its own ports, 42 end-to-end checks (~2 min)
```

`make e2e` runs `python3 scripts/e2e-smoke.py` and needs only Docker with Compose v2 and Python 3.
To look around afterwards, run the script with `--keep` (the app is on http://localhost:3100), then
remove the stack with `COMPOSE_PROJECT_NAME=competitor-pulse-e2e docker compose down -v`. If its
ports are taken, set `E2E_APP_PORT`, `E2E_MOCK_LLM_PORT`, `E2E_STUB_PORT` and `E2E_DB_PORT`.

The integration tests drive `pollOnce` and `summarizeOnce` directly with a manual clock,
so they cover concurrency and retries without waiting on timers. One test runs the real
OpenAI client against `mock-llm-server.py`.

The end-to-end script uses the mock's control API to show: 3 LLM calls for 3 changes and
none for repeated polls; snapshots kept and summaries `failed` after injected 500s, then
recovered through a requeue; the API and polling unaffected while the LLM hangs, and the call
aborted at 15 s; a restart with a summary in flight losing nothing and polling nothing twice;
validation errors; and the probes, metrics and migration step. It uses a compose project of
its own (`competitor-pulse-e2e`, ports 3100, 4101, 4102, 5533) and removes it afterwards, so it
never touches a development stack.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, the build and the end-to-end script.
`typescript-eslint` does not support TypeScript 7 yet, so linting uses oxlint with `oxlint-tsgolint`.

## Running without Docker

```bash
cp .env.example .env
docker compose up -d db
npm install
python3 mock-llm/mock-llm-server.py      # terminal 1, port 4001
npm run stub -w server                   # terminal 2, port 4002
npm run db:migrate -w server             # once, and after pulling new migrations
npm run dev -w server                    # terminal 3, port 3000
npm run dev -w web                       # terminal 4, http://localhost:5173
```

Settings are environment variables, validated at startup (`server/src/config.ts`); see
`.env.example` for all of them. `POLL_INTERVAL_SECONDS` defaults to 900 (15 minutes).

## Production notes

The design targets the stated load: a few hundred competitors polled every 15 minutes,
with LLM calls billed per request. For 300 competitors that is 28,800 snapshot rows and,
at most, as many LLM calls as there are real changes.

- **Scaling out.** `ROLE=api` serves HTTP and `ROLE=worker` runs the poll and summary loops, so
  each scales on its own (`ROLE=all`, the default, runs both in one process). More instances work
  without code changes, because all work is claimed with `SKIP LOCKED`.
- **Migrations.** A deploy step of their own, as in compose (`server/dist/db/migrate.js`), guarded
  by an advisory lock, so overlapping runs wait for each other. Migrations run in a transaction,
  so on a table this size a new index would need `CREATE INDEX CONCURRENTLY` by hand.
- **Database.** Use managed PostgreSQL, and add monthly partitions or a retention policy for
  `snapshots`. Pool size, connect timeout and statement timeout are set through env.
- **Storage.** A `listing_versions` table would stop unchanged snapshots from copying text.
- **Probes.** `/livez` for restarts (it never touches the database, so an outage does not restart
  every instance), `/readyz` for traffic.
- **Metrics.** `/metrics` exposes poll lag, failing competitors, pending and failed summaries, loop
  tick age, and poll and LLM attempt counters by outcome. Alert on poll lag and on attempts per day.
- **LLM cost.** Cache summaries by (previous hash, new hash) for listings that flip back and
  forth, and add a daily call budget.

Not built, deliberately: auth (excluded by the assignment), Redis or a queue library
(PostgreSQL handles this load), WebSockets (a 5-second refetch suits data that changes
every 15 minutes), styling, and cloud deployment.

## Code review

After the system was finished, it was reviewed as a senior engineer would review it: the
code and the infrastructure against the assignment, with each suspected bug reproduced before
being reported. The design held up (snapshot before LLM, schedule in the database, hash-based
diffing). Everything found has been addressed, with two exceptions: cloud deployment stays out
of scope, and the image is still about 234 MB, because the stub and fixtures it lost weigh little.

### Bugs

| Bug | Evidence | Fix |
| --- | --- | --- |
| Removing a competitor got slower as `snapshots` grew: the `previous_id` foreign key (`ON DELETE SET NULL`) had no index, so each deleted snapshot scanned the whole table | 300k rows, 1,000 snapshots deleted: **17 s, against 17 ms with the index**. Extrapolated to a year of history (10.5M rows), it would take hours | Index `snapshots_previous_idx` |
| **Check now** during a fetch started a second poll of the same competitor, because `next_poll_at` was both the schedule and the lease and the button moved it back. The same happened with an interval shorter than the fetch | The source served `$1, $2, $3`; the history stored `$1 -> $3 -> $2`, a wrong timeline with extra billed LLM calls | Separate lease column `poll_lease_until`. The click is kept and runs after the fetch in flight |
| `LLM_MAX_ATTEMPTS` was checked only after a call returned, so a process dying mid-call retried without limit | With a limit of 3: attempts 1 to 6 were claimed and the row stayed `pending` | A claim past the limit fails the row without calling the LLM |
| Retries stopped after about 25 s, so a short LLM outage left every change in that window `failed` for good. A bad key was retried like a 5xx, and `Retry-After` was ignored | Read from the code | Backoff up to 1 h with jitter, permanent errors fail at once, `Retry-After`, requeue endpoint |
| Calls aborted by a clean shutdown handed their attempt back, so repeated restarts could bill more than the limit | Read from the code | The attempt stays counted |
| Listing fields and source responses had no size limit, and the text went into the billed prompt twice | Read from the code | Field limits, a 256 KB response limit, prompt fields clipped to 2,000 characters |
| Any API error stopped the timeline's auto-refresh for good, including a transient 500 | Read from the code | It stops only on 404. Checked in a browser: with the database stopped for 10 s, the page recovered and showed the next snapshot without a reload |
| The duplicate-id message showed the current input, not the id that was submitted | Read from the code | The message uses the submitted id |
| Remove deleted a whole history in one click, and the UI could not go past the latest 200 snapshots | Read from the code | A confirmation step, and paging with **Load older snapshots** |

Backend fixes have regression tests. The lease, attempt limit, permanent errors, `Retry-After`,
size limits, migration lock and stalled-loop probe were confirmed to fail with the fix reverted.
The frontend's pure helpers have unit tests; its screens were checked by hand in a browser.

### Structure

- Routes hold no SQL or 404 checks: they parse with Zod through `fastify-type-provider-zod`,
  call `CompetitorService`, and domain errors become status codes in one place. Response schemas
  also generate `/openapi.json`.
- Each layer has one job: `repositories/` holds the SQL, `services/` the decisions,
  `workers/` the loops and slots, and `domain/` the pure rules, which are tested without a database.
- Logs are structured, with `competitorId`, `snapshotId` and `attempt` as fields.

### Infrastructure

- CI, plus a type-aware linter with `no-floating-promises`, which matters most in code that
  starts background tasks.
- Migrations moved from app start to their own compose service, and take an advisory lock.
- The image gained a `HEALTHCHECK`, source maps at runtime and an npm cache mount; the stub
  and fixtures moved to their own build target and are no longer in the app image.
- Compose: `app` on localhost like the others, `init` and `restart: on-failure` everywhere.
- `/livez`, `/readyz` and `/metrics`; pool connect and statement timeouts; `ROLE=api|worker|all`.
- The end-to-end script runs on its own compose project, so it can no longer wipe a dev stack.

## Project layout

```
server/src/
  main.ts               composition root (ROLE), graceful shutdown
  config.ts             environment schema
  db/                   Drizzle schema, client, migrations runner (SQL in server/drizzle/)
  domain/               listing rules, retry policy, domain errors; pure, no I/O
  repositories/         all SQL: claims, snapshots, queue stats
  services/             pollOnce, summarizeOnce, CompetitorService
  workers/              the poll and summary loops: ticks and concurrency slots
  summary/              SummaryClient, OpenAI client, prompt
  source/               ListingSource and its HTTP implementation
  stub/                 the fixture-sequence listing stub (separate process and image)
  http/                 Fastify app, routes, schemas, DTOs, probes and metrics
  lib/                  loop, clock, logger, counters
web/src/                api.ts, App.tsx, pages/CompetitorList.tsx, pages/CompetitorTimeline.tsx
scripts/e2e-smoke.py    end-to-end checks on a throwaway compose stack
.github/workflows/      CI
docs/                   ARCHITECTURE.md (design and rejected alternatives), PLAN.md
```

## AI tools used

The architecture and the technology stack are my own work: I designed the system (the schedule
in the database, snapshot committed before any LLM call, hash-based diffing, the lease and retry
model) and chose the stack myself. I used **[Claude Code](https://claude.com/claude-code)**,
Anthropic's coding agent, over two working sessions to implement that design, write tests and
review the result. Results were checked against the running system rather than taken on trust.

| Tool | What it did |
| --- | --- |
| Claude Code, model Claude Fable 5.1 | Read the assignment and turned my architecture into a step plan (`docs/PLAN.md`) that I then scoped and approved |
| Claude Code, model Claude Opus 5.5 | Implemented steps 0-9 of `docs/PLAN.md`, wrote the tests and the end-to-end script, ran every check |
| Claude in Chrome | Clicked through the UI in a real browser: add, duplicate, timeline, remove |
| Claude Code, models Claude Fable 5.1 and Claude Opus 5.5 | Fable reviewed the finished code and infrastructure; Opus made the fixes, the refactoring and the infrastructure changes, with tests (see [Code review](#code-review)) |

How the agent was steered:

- **Plan first, then one step at a time.** Each step in `docs/PLAN.md` has an acceptance
  check, and the next step started only after it passed. The commits were squashed into one
  before submission, so the steps are not visible in the git history.
- **A committed project harness.** `CLAUDE.md` lists the invariants that must not be weakened
  (no network call inside a transaction, the snapshot is committed before any LLM call, only
  the worker calls the LLM, the API contract is literal). `.claude/rules/` holds backend and
  frontend rules. `.claude/skills/` has `next-step` (build the next plan step and run its
  check) and `verify-e2e` (run the end-to-end scenarios).

What I decided and drove:

- **Architecture and stack:** I planned the architecture and chose the technologies.
- **Scope:** the mock LLM as the LLM option and no cloud deployment. I also confirmed the
  assumptions listed above.
- **Behaviour:** I questioned the stub rewinding to version 1 after a restart, which led to
  documenting that behaviour in this README, and I asked for the `make` commands.
- **Review and refactoring:** I commissioned the senior-level review of the finished system,
  pointed it at thin controllers with the logic moved into services, and chose what to act on:
  everything except deployment.
- **Verification:** I had the project's environments removed and everything retested from scratch.

What the checks caught, and what was fixed:

- The SPA fallback answered a rebuilt JS bundle with `index.html`, so the page rendered
  blank. Found in the browser; fixed, and covered by a test.
- Compose read the project `.env`, so the demo polled every 15 minutes instead of 15 seconds.
  Fixed with a separate `COMPOSE_POLL_INTERVAL_SECONDS`.
- The first end-to-end run failed twice. The cause was in the script, not the system:
  scheduled polls mid-scenario used up the mock's global `failNext` budget. Confirmed in the
  database before changing the script.
