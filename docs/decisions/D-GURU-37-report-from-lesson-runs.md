# D-GURU-37: The report reads lesson runs from events; next-day revision uses Shekru's answers only
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-37
**Confluence:** none

**Decision:** `buildReport` (`app/src/parent/report.ts`) splits the event log into lesson runs: answers belong to the run open in their session (from `lesson_start` to `lesson_end` or `lesson_left`), whatever `template_id` they carry. A listed left-early entry is replaced by the same lesson's next leave or finish, and a finished run takes the left entry's `items_total` (else the number of distinct items answered in the run). A lesson is practice only when a non-revision answer in it was a word item. Next-day revision counts counted revision answers whose item was at a 1-day interval just before the answer, found by replaying `applyAnswer`, and only those with `decided_by: 'shekru'`.

**Why:** The catalogue has no lesson kind and the event log stores no interval, so both must be derived from events. Revision answers keep their source lesson's `template_id` (`lesson/revision.ts`), so grouping answers by `template_id` would put them in the wrong lesson. Lessons in progress resume (D-GURU-20-in-progress-is-resumable), so the next run of a left lesson is its resume, not a new attempt. The PRD Acceptance Criteria say every pilot figure, next-day revision included, uses only `shekru` answers; tapped answers still update mastery (D-GURU-34-parent-helps), so letters mastered and needs-practice include them.

**Rejected:**
- Grouping answers by their own `template_id`: revision answers land in another lesson and could mark it practice only.
- Listing every leave of a lesson separately: a lesson left twice would show two "left early" rows for one lesson in progress.
- Storing the interval on each answer event: a schema-shape change to answer events for one report figure, when the replay gives the same result.
- Counting tapped revision answers in next-day revision: breaks the PRD rule for pilot figures.

**Impact:**
- Report figures stay rebuildable from `event` rows; do not add report-only columns or tables.
- Any future figure that is a pilot figure (accuracy, false praise, next-day revision) filters on `decided_by === 'shekru'`.
- If lessons gain a kind in the catalogue, practice only may read it, but must still be true for any run with a word answer.
