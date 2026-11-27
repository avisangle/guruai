# D-GURU-52: No revision-only stop in the pilot
**Status:** Accepted
**Date:** 2026-11-27
**Issue:** GURU-52
**Confluence:** none

**Decision:** For the pilot, `buildTodayQueue` emits lesson stops only and the trail draws none for revision. Due revision is asked only inside lessons: at most 3 items per lesson, in the lesson's language. Refines PRD line ~99 (leftover revision stop).

**Why:** Nothing plays a revision-only stop. The start button opens the first lesson stop, the lesson route needs a template, and a goal-met queue goes to goodbye. The child saw a stop they could never reach. The owner chose not to build a new route, session and report handling before the pilot.

**PRD criterion (~304), "Revision due is always in today's queue and does not count toward the goal", now means:** due items are mixed into the quiz of today's lessons in their language, up to 3 per lesson. Items that do not fit stay due (`next_due` unchanged) and are asked in the next such lesson. Revision never counts toward the goal.

**Rejected:**
- Build a revision-only route and player for the pilot: too much new surface before the pilot.
- Keep the stop on the trail without a player: the child sees a stop they cannot reach.
- Raise `REVISION_PER_LESSON` to fit all due items: longer lessons and a quiz dominated by old items.

**Accepted cost:** on a day with few lessons, or none in an item's language, due items wait, so next-day revision may run later than day 1 for some items.

**Impact:** `buildTodayQueue` returns lesson stops only. Any code that brings back a revision stop also needs a route that plays it, and must supersede this record.
