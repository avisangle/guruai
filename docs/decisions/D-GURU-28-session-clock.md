# D-GURU-28: One in-memory active clock per session, shared across screens
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-28
**Confluence:** none

**Decision:** `sessionClock(sessionId)` (`app/src/learning/sessionClock.ts`) keeps one `ActiveClock` per open session in a module map, started on first use. The lesson player feeds it activity and pauses it while paused; Stop ends the session through `endSessionNow`, which stores the clock's time in `session.active_ms` and drops the clock. The lesson route gets its session from `ensureSession` (D-GURU-21-one-open-session), so a lesson opened from the tester menu (`/tester`), with no child picker before it, has one too.

**Why:** A session spans the queue, several lessons and goodbye (PRD Learning model), so the clock cannot live in the lesson screen: the cap check at a lesson's end and the goodbye screen (GURU-33) need the time of the whole sitting. It stays in memory because `closeOpenSessions` already treats a killed app's active time as lost.

**Rejected:**
- A clock per lesson screen: loses the time spent on the queue and in earlier lessons, so the 30-minute cap would never be reached across lessons.
- Persisting active time on every activity: a write per line and per answer for a figure the PRD accepts losing on a kill.
- Refusing to play without an open session: lessons opened from the tester menu, which skips the child picker, could not run.

**Impact:** Screens that end a session (goodbye, Stop) call `endSessionNow`, which stores the clock's active time and forgets the clock; never `endSession` with a hand-computed `active_ms`. Code that pauses the lesson must also pause the clock.
