# D-GURU-22: Style level changes at session start from the word first-try rate
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-22
**Confluence:** none

**Decision:** A child's style level (`mr_led` or `en_led`) changes only when a session starts, from the first-try rate on counted word answers in the last 2 sessions that have any. At least 8 counted answers are needed; a rate of 0.8 or more moves `mr_led` to `en_led`, 0.4 or less moves `en_led` to `mr_led`. A counted answer is on a word item, in a `quiz`, `retry` or `revision` turn, and not `silent`; tap answers and gated word misses (`counts: false`) count. A first try is `attempt === 1` and `correct`, so a right `meaning` or a right second try counts as an answer but not as a first try. The starting level comes from the school medium (English-medium `en_led`, Marathi-medium `mr_led`), and a parent's lock keeps it. The numbers are provisional (PRD open question) and live in `app/src/learning/config.ts`.

**Why:** PRD Language design 3: the level moves between sessions, never inside a lesson. Silent answers say nothing about the style. Tap answers are the parent's honest verdict. Gated misses are excluded from mastery only because the judge may be wrong (D-GURU-12-word-items-practice-only), and leaving them out here would push every child towards `en_led`.

**Rejected:**
- Changing style inside a lesson: PRD Non-Goals.
- A window of the last 2 sessions of any kind: a letters-only sitting would take a slot and hide the word answers the rule is about.
- Using `counts` to filter answers: it drops gated word misses, so the rate could only go up while `WORD_ITEMS_GATED` is on.

**Impact:**
- `startSession` calls `applyStyleLevelAtSessionStart` before its own transaction, because live `Db.transaction` does not nest (tests nest through savepoints, so they would not catch it). Keep it outside until the live adapter nests.
- Each change appends a `style_change` event `{ from, to }` with a null `session_id`; nothing else writes `child_profile.style_level` except the parent's settings.
- Tune the thresholds only in `config.ts`.
