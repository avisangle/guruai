# D-GURU-28: One in-memory active clock per session, shared across screens
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-28
**Confluence:** none

**Decision:** `sessionClock(sessionId)` (`app/src/learning/sessionClock.ts`) keeps one `ActiveClock` per open session in a module map, started on first use. The lesson player feeds it activity and pauses it while paused; Stop reads it into `session.active_ms` and drops it. If no session is open when the lesson route opens (a lesson started from the old home menu), the route opens one.

**Why:** A session spans the queue, several lessons and goodbye (PRD Learning model), so the clock cannot live in the lesson screen: the cap check at a lesson's end and the goodbye screen (GURU-33) need the time of the whole sitting. It stays in memory because `closeOpenSessions` already treats a killed app's active time as lost.

**Rejected:**
- A clock per lesson screen: loses the time spent on the queue and in earlier lessons, so the 30-minute cap would never be reached across lessons.
- Persisting active time on every activity: a write per line and per answer for a figure the PRD accepts losing on a kill.
- Refusing to play without an open session: until the child picker (GURU-29) opens sessions, no lesson could run.

**Impact:** Screens that end a session (goodbye, Stop) read `sessionClock(id).activeMs(now)` for `active_ms` and then call `dropSessionClock(id)`. Code that pauses the lesson must also pause the clock.
