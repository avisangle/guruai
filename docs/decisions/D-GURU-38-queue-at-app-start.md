# D-GURU-38: A sitting closed at app start gets its summary then, and the upload queue starts with the app
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-38 (integrate level 6 of GURU-1)
**Confluence:** none

**Decision:** On app start, the root layout closes the sessions an earlier run left open and gets their ids back (`closeLeftOpenSessions`), then calls `sessionEnded` for each. A summary is written only if `consent_summaries` is on at that moment. The layout then calls `runUploads()`, so the 30-day sweep, a waiting deletion request and pending uploads do not wait for a new session end.

**Why:** Children often leave by closing the app, and those sittings had no `summary.json`. The GURU-39 pilot report counts sittings only from summaries, so it undercounted them. The previous run's sitting ended when that run died. Between then and the next start, nobody can change consent, so consent at app start is the consent in force when the sitting ended. The queue used to be created on first use, so a family that stopped doing lessons kept its clips on the phone past 30 days.

**Rejected:**
- Backfilling, on each queue run, every ended session that has no summary item. This would send sittings that ended while consent was off, as soon as consent came back on. The 30-day sweep would also keep deleting and recreating those items.
- Returning the ids from `closeOpenSessions` itself. That would change the void, one-argument shape that GURU-21 promised its dependents. The wrapper also returns exactly what was closed, whatever rule `closeOpenSessions` uses.

**Impact:**
- If another path ends a session as `closed` (for example, the day-boundary close proposed in PR #39), it must call `sessionEnded` for that session too. `closeLeftOpenSessions` shows the pattern.
- App start now creates the live upload queue when `EXPO_PUBLIC_UPLOAD_URL` and `EXPO_PUBLIC_UPLOAD_KEY` are set. Without them, nothing changes.
