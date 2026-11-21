# D-GURU-21: A child has at most one open session; app start closes the rest
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-21 (settled in the level 3 integration of GURU-1)
**Confluence:** none

**Decision:** Every place that needs a session calls `ensureSession` (`app/src/learning/session.ts`): it returns the child's open session, or starts one. The child picker (face tap) and the lesson route both use it. The root layout calls `closeOpenSessions` at app start. It closes only sessions started before this JS run, so a root remount in the same run (Android activity recreation, dev fast refresh) leaves a live sitting open.

**Why:** A session is one sitting (PRD Learning model). The picker started a new session on every tap, and nothing called `closeOpenSessions`, so a back-to-picker or a parent-mode visit left the old row open for ever with `active_ms` 0, and the session clock and active-time cap restarted from 0 each time. GURU-37 and GURU-38 read these rows.

**Rejected:**
- Ending the open session on every face tap: a parent visit or a back press mid-sitting would split one sitting into several and reset the cap.
- Closing stale sessions by age when the next one starts: needs a timeout the PRD does not define; app start is the moment the in-memory clock is lost anyway.

**Impact:**
- Do not call `startSession` from screens; use `ensureSession`. Only goodbye or Stop end a session, through `endSessionNow` (D-GURU-28-session-clock), and app start closes leftovers as `closed`.
- The style level is settled when a session starts (D-GURU-22-style-level-rule), so read `style_level` after `ensureSession`.
