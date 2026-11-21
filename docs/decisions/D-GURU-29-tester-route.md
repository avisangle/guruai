# D-GURU-29: Tester tools live on a test-only /tester route, linked from the child picker
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-29 (settled in the level 4 integration of GURU-1)
**Confluence:** none

**Decision:** The tester screen (`app/src/screens/LessonScreen.tsx`: lesson menu, recording panel, tap mode, child code, clip export, demo link) is the route `/tester` (`app/src/app/tester.tsx`), which redirects to `/` outside test builds like `/demo` and `/probe`. The child picker shows a "Tester tools" link to it inside `TestOnly`.

**Why:** GURU-29 made `/` the child picker, and the tester screen had been the home route, so in every build nothing could turn on recording or tap mode or export clips. The recording switches are process-wide (`screens/useRecording.ts`): the tester screen sets them and the lesson route uses them, so the panel needs a screen of its own, not a place inside the lesson. Tap-labelled clip exports are the input for the stt_bench judge tests (GURU-27).

**Rejected:**
- A Settings entry: Settings sits behind the parent lock, and a tester switching between child and parent screens on every session gains nothing from the gate in a build children never get.
- Mounting the recording panel inside the lesson player: the panel's text fields and export need the whole screen, and the lesson screen is the child's.

**Impact:** Tester-only screens are routes that redirect to `/` when `IS_TEST_BUILD` is false, and their links are wrapped in `TestOnly`; `app/src/config/build.test.tsx` covers both. Do not delete `LessonScreen.tsx` as dead code: `/tester` is its route.
