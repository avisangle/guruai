# D-GURU-28: A paused lesson continues from the engine's live position
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-28
**Confluence:** none

**Decision:** Pausing (button, app leaving the foreground, or a line the system stops mid-way) cancels the run, stops audio and the mic, and keeps the engine. Continue builds a new engine from `engine.position()`, the in-memory position, so Shekru asks the open question again before the mic opens (wireframe `l-paused`). The saved `lesson_position` is only read when the route opens. A phone call is detected in `useLinePlayer` as a line that was playing and stopped without finishing, since expo-audio 58 pauses its players on Android audio-focus loss and emits no JavaScript event for it. App-state changes are ignored while the mic permission prompt is open.

**Why:** The saved position only moves after an answer. Resuming from it after a pause before the first answer would replay the intro and draw a second surprise, which D-GURU-19-tutor-variety rules out. The in-memory position already holds the drawn quiz order, the surprise slot and the line history. The permission prompt backgrounds the app on some phones even when permission is already granted, and that would pause a lesson that has only just started.

**Rejected:**
- Resume from the saved `lesson_position`: replays the intro and re-draws the surprise when no answer has been given yet.
- Keep the old engine and replay its queued steps: the engine is waiting for `answer()` after a listen step and cannot step back.
- Native audio-focus listener: needs a native module and a new EAS build for something the line player can observe.

**Impact:**
- Code that pauses a lesson must go through `usePlayerLoop`'s `pause`, never restart the route. A resume must pass the same revision items as the paused run.
- A call that comes while the mic is open (no line playing) is only caught when the in-call screen sends the app to the background. Catching it during a listen turn needs a native audio-focus signal.
- `useLinePlayer` treats any stop it did not cause, after a line started playing, as an interruption. A new audio path that pauses the line player without `stop()` will pause the lesson.
