# D-GURU-20: "In progress" means a resumable position, read the same way everywhere
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-20 (settled in the level 3 integration of GURU-1)
**Confluence:** none

**Decision:** A lesson is in progress for the queue when its saved `lesson_position` is for the lesson's current version and not finished (`isFinished`). That is the lesson route's resume rule, and `readQueueInput` uses the same helper. Positions are kept after a lesson ends.

**Why:** The engine saves a finished position after the last answer, and `savePosition` never clears a row. `readQueueInput` counted every row, so each finished lesson headed today's queue for ever: the child replayed it daily and never reached the next path lesson.

**Rejected:** Deleting the position at `lesson_end`: one more write on the lesson-end path, and a position from an older lesson version would still count until replaced.

**Impact:** The rule lives in `resumePosition` (`app/src/learning/positions.ts`), used by the lesson route and `readQueueInput`. Anything that lists in-progress lessons (queue, parent home, goodbye) takes them from `readQueueInput`'s `inProgress`, never from raw `lesson_position` rows.
