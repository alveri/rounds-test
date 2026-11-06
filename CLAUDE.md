# CompetitorPulse

Take-home assignment (Fullstack Developer, backend focus). The system tracks competitor
product listings, stores every fetched snapshot, and asks an LLM to summarise what changed
between two consecutive snapshots.

- Spec (source of truth, not committed here): `../fullstack_developer_backend_focus-assignment/instructions.md`
- Design and the reasons behind it: `docs/ARCHITECTURE.md`
- Work order with acceptance checks: `docs/PLAN.md`

## What is being graded

Backend decisions: persistence, scheduling, and how the LLM call is integrated. The React
frontend only has to work; visual polish is not judged. The budget is about 3 hours, so
prefer the smallest correct solution. If a change would add infrastructure (Redis, a queue
library, a shared types package, auth, websockets), stop and ask first.

## Decisions made by the owner

- **LLM option: the provided mock server** (`mock-llm/mock-llm-server.py`). README must say so.
  The base URL, key and model stay configurable through env, but no real provider is set up or tested.
- **No cloud deployment.** Bonuses in scope: real database with migrations, Dockerfile + docker-compose.

## Stack

- Node.js 24, TypeScript `strict`, npm workspaces: `server/`, `web/`
- Server: Fastify + Zod, Drizzle ORM + drizzle-kit, PostgreSQL 17, `openai` SDK with a configurable base URL
- Web: React + Vite, React Router, TanStack Query, no CSS framework
- Tests: Vitest. Lint: oxlint with `oxlint-tsgolint` (`typescript-eslint` does not support TS 7).
  Runtime: Docker Compose (`app`, `db`, `migrate`, `listing-stub`, `mock-llm`)

## Commands

Only commands that exist today are listed. Add a line when a step adds a script.

Compose reads `.env` from the project root. The app's interval inside compose comes from
`COMPOSE_POLL_INTERVAL_SECONDS` (default 15), not `POLL_INTERVAL_SECONDS`, so the local
`.env` (900 s) does not slow the demo down. Only one stack can own ports 3000/4001/4002:
stop locally started servers before `docker compose up`.

```
cp .env.example .env               # once; server scripts read ../.env if present
docker compose up --build         # everything: UI + API on http://localhost:3000, polling every 15 s
docker compose down -v             # stop and reset (database AND the stub's version counters)
docker compose up -d db            # only PostgreSQL, for running server/tests outside Docker
make                               # lists build, start [INTERVAL=n], seed, clear, logs, stop, reset, check, e2e
python3 scripts/e2e-smoke.py       # scenarios A-F on a throwaway stack with its own ports (~2 min); --keep leaves it up
npm run lint                       # oxlint --type-aware
npm install                        # all workspaces
npm run typecheck                  # tsc --noEmit in both workspaces
npm test                           # vitest in server and web; server needs `db` up
npm run build                      # tsc -> server/dist, vite -> web/dist
npm run dev -w server              # tsx watch src/main.ts
npm run dev -w web                 # vite dev server, proxies /api to localhost:3000
npm run stub -w server             # listing stub on :4002 (GET /listings/:id)
npm run db:generate -w server      # drizzle-kit: new SQL migration from src/db/schema.ts
npm run db:migrate -w server       # apply migrations to DATABASE_URL (compose: the `migrate` service; the app never does)
```

Tests use a separate database, `competitorpulse_test` (override with `TEST_DATABASE_URL`).
`test/global-setup.ts` creates and migrates it; each test file truncates tables in `beforeEach`.
Never point tests at the dev database.

Ports: app 3000, mock-llm 4001, listing-stub 4002, web dev 5173. PostgreSQL is published on
host port **5433** (`DB_PORT`), because 5432 is taken by a local PostgreSQL on this machine;
inside the compose network it is `db:5432`.

Toolchain notes: TypeScript 7, Vitest 5, Vite 8. The server is ESM with `NodeNext`
resolution, so relative imports carry a `.js` extension (`import { x } from './x.js'`).
npm prints an `install-scripts` warning for esbuild; it is harmless here (tsx and vite work).

## Invariants

These are the decisions the interview will probe. Do not weaken them without asking.

1. **API contract is literal.** `GET /api/competitors`, `POST /api/competitors` → 201,
   `DELETE /api/competitors/:id` → 204, `GET /api/competitors/:id/snapshots` → array, newest
   first. Snapshot fields `fetchedAt` (ISO 8601 UTC), `title`, `tagline`, `price`,
   `description`, `changed`, `summary` keep these exact names and types. Extra fields are fine.
2. **Every successful fetch inserts exactly one snapshot row**, changed or not.
3. **No network call inside a DB transaction.** Fetch first, then one short transaction.
4. **The snapshot is committed before any LLM call.** An LLM failure or timeout may only
   touch the `summary_*` columns of that row.
5. **The LLM is called only by the summary worker, only for rows with
   `summary_status = 'pending'`.** Never for an unchanged snapshot, never for the first
   snapshot of a competitor. At most `LLM_MAX_ATTEMPTS` calls per snapshot, unless someone
   explicitly requeues it with `POST /api/summaries/retry-failed`.
6. **The schedule lives in `competitors.next_poll_at`.** Due rows are claimed with
   `FOR UPDATE SKIP LOCKED` and the claim moves `next_poll_at` forward and takes the
   `poll_lease_until` lease. No per-competitor timers, no in-memory schedule.
7. **The listing source is stateful**: each call advances a per-id counter. Only the poller
   calls it, once per claim. No preview fetches, no retry of a fetch that succeeded.
8. **Every interval, timeout and concurrency limit comes from env** through `server/src/config.ts`.
9. **Schema changes go through Drizzle migrations** committed in `server/drizzle/`.
10. **Provided files stay byte-identical**: `mock-llm/mock-llm-server.py`, `server/fixtures/listings.json`.

## Conventions

- No `any`, no unexplained non-null assertions. Validate with Zod at every boundary: env,
  HTTP input, listing-source response, LLM response.
- Layers: routes parse and delegate; `services/` decide (`pollOnce`, `summarizeOnce`, which take
  db, `ListingSource`, `SummaryClient` and clock as arguments, and `CompetitorService`);
  `repositories/` hold all SQL; `workers/` are thin loops; `domain/` is pure. A business rule
  failing is a domain error, mapped to a status code once, in `http/app.ts`.
- Tests use real PostgreSQL and fake `ListingSource` / `SummaryClient`. Never sleep on real
  timers in a test; call `pollOnce` / `summarizeOnce` directly.
- Listing text is untrusted third-party content: it goes to the LLM as data, and the UI
  renders summaries as plain text.
- One commit per finished step of `docs/PLAN.md`, after its acceptance check passes.
- README must stay true: how to run, which LLM option is used and how to switch, the
  assumptions below, and which AI tools were used.

## Assumptions (mirror these in README)

Confirmed by the owner on 2026-11-05 — implement as written, do not reopen them.

- First snapshot of a competitor: `changed: false`, `summary: null`, `initial: true`.
- `POST` of an existing id → 409. Invalid id (not `^[a-z0-9][a-z0-9-]{0,63}$`) → 400.
- An id unknown to the source is accepted; the poll error is stored in `last_poll_error`.
- `DELETE` removes the competitor and its history; unknown id → 404.
- The timeline API returns the latest 200 snapshots by default; `limit` and `before` page
  further back. The UI asks for 50 at a time.
- The listing stub runs as its own process, so restarting `app` does not reset the sequence.
