---
paths:
  - "web/**"
---

# Frontend rules

The frontend is graded on working end to end, not on looks. Keep it small.

- Two routes only: `/` (list) and `/competitors/:id` (timeline). No global state library.
- Plain HTML elements and at most a few lines of inline or single-file CSS. No UI kit, no Tailwind.
- All requests go through `web/src/api.ts`, which holds the response types and throws a
  typed error carrying the HTTP status. Components never call `fetch` directly.
- Server state lives in TanStack Query. Invalidate the list after add/remove; the timeline
  uses `refetchInterval: 5000` and stops only on 404, so a transient error cannot freeze it.
- The timeline card shows: fetched time (`toLocaleString()`), title, tagline, price,
  description, and exactly one caption chosen from `summaryStatus`, `changed`, `initial`:
  summary text / "Summary pending…" / "Summary unavailable" / "No change since previous snapshot" / "Initial snapshot".
- Render summaries and listing fields as text. Never use `dangerouslySetInnerHTML`.
- Show a readable message for 400 and 409 on add, and for 404 on the timeline.
- Relative URLs only (`/api/...`); the Vite dev proxy and the production server share one origin.
