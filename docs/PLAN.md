# Plan

Work top to bottom. A step is done only when its check passes; then tick it and commit.
Estimated total: about 3 h 45 min for steps 0–9.

- [x] **0. Scaffold (15 min)**
  - `git init`, npm workspaces (`server`, `web`), TypeScript strict, Vitest, `.gitignore`, `.env.example`.
  - Copy `listings.json` → `server/fixtures/`, `mock-llm-server.py` → `mock-llm/` (unchanged).
  - `docker-compose.yml` with only `db` (postgres:17) for now.
  - Check: `npm run typecheck` and `npm test` pass on the empty project; `docker compose up -d db` is healthy.

- [x] **1. Schema and migrations (15 min)**
  - `config.ts` (Zod env), `db/schema.ts` per `docs/ARCHITECTURE.md`, generated SQL migration, `db/migrate.ts`.
  - Check: after `npm run db:migrate` both tables, the enum and three indexes exist (`\d+` in psql).

- [x] **2. Listing stub (15 min)**
  - `stub/fixture-sequence.ts` (pure), `stub/server.ts` (`GET /listings/:id`, 404 for unknown id),
    `source/http-listing-source.ts` with timeout and Zod validation of the response.
  - Check: unit test — 6 calls for `acme-crm` return versions 1, 2, 3, 4, 4, 4; counters are per id; unknown id → not found.

- [x] **3. Tracking API (20 min)**
  - Four contract endpoints, id validation, `/health`.
  - Check: tests through `app.inject` — 201, 204, 400, 404, 409; list reflects add/remove; snapshots come newest first.

- [x] **4. Poller and diffing (35 min)**
  - `domain/listing.ts` (normalise, hash, field diff), `polling/poller.ts` (`claimDue`, `pollOnce`), `lib/loop.ts`, `POST /api/competitors/:id/poll`.
  - Check: integration test — 6 polls produce 6 rows with `changed` = false, true, true, true, false, false
    and statuses none, pending, pending, pending, none, none; two concurrent `claimDue` calls never return the same id;
    a source error creates no row and sets `last_poll_error`; deleting mid-fetch discards the result.

- [x] **5. Summary worker (35 min)**
  - `summary/summary-client.ts`, `openai-summary-client.ts`, `prompt.ts`, `worker.ts` (`summarizeOnce`).
  - Check: tests with a fake client — success → `ready` with text; 3 failures → `failed`, `summary` null, listing
    fields intact; a hanging client is aborted at the timeout; an unchanged poll causes 0 client calls;
    a `ready` row is never overwritten.

- [x] **6. Frontend (30 min)**
  - Vite + React, two routes, `api.ts`, five caption states, error messages, dev proxy; Fastify serves `web/dist`.
  - Check: in a browser — add `acme-crm`, open the timeline, watch it grow, see a summary and a "no change" card, remove it.

- [x] **7. Docker (20 min)**
  - Multi-stage `Dockerfile`, compose with `app`, `db`, `listing-stub`, `mock-llm`; demo interval 15 s.
  - Check: fresh clone, `docker compose up --build`, UI works on http://localhost:3000 with no other setup.

- [x] **8. End-to-end verification (20 min)**
  - `scripts/e2e-smoke.py` implementing the scenarios in `.claude/skills/verify-e2e/SKILL.md`.
  - Check: the script exits 0 against a fresh compose stack.

- [x] **9. README (20 min)**
  - How to run (compose and bare), which LLM option is used and how to switch to a real provider,
    assumptions, key decisions and trade-offs, AI tools used, what would come next.
  - Check: every command in the README was run as written and works.

- [x] **10. Review follow-up**
  - Fix the review's findings, split HTTP, services, repositories and workers, add CI, linting,
    probes, metrics and a separate migration step. See "Code review" in the README.
  - Check: `make check` and `make e2e` pass; each fix has a test that fails without it.

## Deliberately out of scope

- Cloud deployment (the third bonus) — decided against by the owner. README still describes
  how it would be deployed.
- A real LLM provider — the provided mock server is the chosen option; the base URL stays configurable.
- Redis / BullMQ / pg-boss — PostgreSQL handles one poll per 3 seconds.
- Auth, roles, multi-tenancy — excluded by the assignment.
- Styling and component libraries — not judged.
- WebSocket / SSE — a 5 s refetch is enough for data that changes every 15 minutes.
- Summary cache keyed by (previous hash, new hash) — mention in README as a next step.
