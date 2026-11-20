# D-GURU-25: The parent session lives in memory and ends only while unlocked
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-25
**Confluence:** none

**Decision:** `ParentModeProvider` holds the unlocked parent session in React state, never on disk, so a restarted app always starts in child mode. The idle timer (2 min, then a 10 s warning) and the return on `AppState` `background` act only while a session is unlocked; the unlock screen itself is never closed by going to the background. The unlock screen counts wrong PINs since the last wait itself, because the gate exposes only `verifyPin`'s `{ ok, waitUntil }`, and picks the wait copy from the wait's length measured against `lockoutFor`.

**Why:** On Android, choosing "Use PIN or pattern" in the system unlock prompt opens the phone's credential screen as a separate activity, which sends the app to `background`. Returning to child mode on that event during unlock would cancel the parent's own unlock. A session on disk would survive a restart and give a child who reopens the app parent mode. The gate's API (D-GURU-13-parent-gate) is fixed by its tests and the fake gate in `parentShell.test.tsx`, so the screen cannot ask the gate for its failed count or current wait.

**Rejected:**
- Return to child mode on any `background` event: breaks unlocking with the phone's PIN or pattern.
- Persisting the session (or an unlock timestamp) in SQLite: survives a restart, which the PRD's "returns to child mode when it goes to the background" rules out.
- Adding `failedCount()` / `waitUntil()` to the gate: would change GURU-13's contract and its fake for a message that is only slightly off after a restart mid-cycle.

**Impact:**
- Code that checks `AppState` for parent mode must keep the `unlocked` condition.
- "Tries left" can read 2 when only 1 is left after the app was restarted or the unlock screen reopened mid-cycle; a screen opened during a persisted wait shows the keypad until the first PIN, and a reopened wait can show an earlier stage's copy. The countdown and the gate's refusal are always right. Exposing the count and wait from the gate fixes all three.
