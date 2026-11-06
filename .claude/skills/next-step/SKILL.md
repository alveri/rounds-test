---
name: next-step
description: Implement the next unchecked step of docs/PLAN.md for CompetitorPulse — build it, run that step's acceptance check, tick the box and prepare the commit. Use when asked to continue, do the next step, or implement step N of the plan.
---

# Implement the next plan step

1. Read `docs/PLAN.md` and pick the first unchecked step (or the step number given as an
   argument). Do not start a later step while an earlier one is unchecked.
2. Read the parts of `docs/ARCHITECTURE.md` the step touches, and the matching section of the
   assignment at `../fullstack_developer_backend_focus-assignment/instructions.md` when the
   step implements a stated requirement.
3. Implement only that step. If something outside its scope looks wrong, note it at the end
   instead of fixing it now.
4. Run the step's **Check** exactly as written, plus `npm run typecheck` and `npm test`.
   If the check cannot be run (for example Docker is not available), say so — do not tick the box.
5. When the check passes: tick the box in `docs/PLAN.md`, update the Commands section of
   `CLAUDE.md` if scripts changed, and propose a one-line commit message. Commit only if asked.
6. Report in three parts: what was built, the check output, and any decision that differs
   from `docs/ARCHITECTURE.md` (with the reason). A deviation also means updating that file
   and the Assumptions list in `CLAUDE.md`.

For steps 4, 5, 7 and 8, finish by running the `verify-e2e` skill once the compose stack exists.
