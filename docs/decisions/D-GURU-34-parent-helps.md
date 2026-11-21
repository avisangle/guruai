# D-GURU-34: Answer buttons only behind the parent's "मी उत्तरं तपासेन" switch
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-34
**Confluence:** none

**Decision:** The बरोबर / चूक / शांत buttons appear in a child's lesson only when a parent has turned on that child's "मी उत्तरं तपासेन" switch on parent home, behind the parent lock. With it on, the buttons show during the answer turn only (after the chime, gone while Shekru speaks), the tapped button is the answer (`decided_by: 'tap'`), and the mic and judge are not started. The switch lasts for the child's session, through pauses and calls, and turns off at its end: goodbye or Stop clear it (`parentHelps.end`), and app close ends it because the state lives only in memory (`app/src/parent/parentHelps.ts`). Turned on with no session open, it applies to the next session started in this app run. Carried over from D-STT-judge-drives-lesson: otherwise the on-device judge's verdict is the answer (`unclear` and judge errors count as `silent`), and the tester's tap mode and its buttons exist only in test builds.

**Why:** The PRD (Happy Path, parent mode 3) and wireframe decision 9 put the buttons behind the parent: shown to the child whenever the judge could not run, children press "correct" whatever they said. Memory-only state means a forgotten switch never outlives the app process.

**Rejected:**
- Buttons shown automatically when the judge cannot run (D-STT-judge-drives-lesson): children press "correct" whatever they said.
- Persisting the switch in SQLite: it would survive app close, which the PRD says ends it.
- Routing tapped answers through `useRecording` and teaching it to skip the mic: the lesson takes answers from a separate tap source (`lesson/tapSource.ts`) while the switch is on, so nothing in the mic path runs.

**Impact:**
- In release builds no answer buttons render unless `useParentHelps(childId)` is true, whatever `readiness()` or the judge says. The tester's inner source (`useTesterAnswers`) is passed to `useRecording` only when `IS_TEST_BUILD`.
- Every screen that ends a session (goodbye, Stop) passes `parentHelps.end(childId)` to `endSessionNow`, which stores it as `session.parent_helps`. `end` returns true if the switch was on at any point since the last end.
- With the switch on, `readiness()` is `ready` (the queue screen passes `useParentHelps(id)`), and the lesson skips the mic permission prompt.
- Tapped answers update mastery and revision like Shekru's verdicts; D-GURU-12-word-items-practice-only applies either way.
