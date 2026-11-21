# D-GURU-27: The word-item judge test counts a meaning as judged correct
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-27
**Confluence:** none

**Decision:** In the bench's "Word-item judge test" (`tools/stt_bench/bench.py`), a clip whose Heard kind is `meaning` counts as judged correct on both sides of the gate: it is an accepted answer on a correct-labelled clip and false praise on a wrong- or silent-labelled one. Only tap-labelled clips (no `label_by`) of word items (`item_key` kind `word`) count; no such clips gives `n/a`, never a pass.

**Why:** A meaning is one of the item's own accepted answers, and the app's verdict for it is `correct` (`VERDICT` in `app/src/asr/lessonJudge.ts`). The lesson never tells the child "wrong" after one: a Hindi meaning on a Marathi-target item is counted as correct, and on an English-target item it is acknowledged and asked again (D-GURU-10-language-design). So a wrong or silent answer judged `meaning` gets a positive response, and the test that lifts `WORD_ITEMS_GATED` (D-GURU-12-word-items-practice-only) should count it against the judge.

**Rejected:**
- Counting only Heard `correct` as false praise: it would hide misjudged wrong answers that the lesson still acknowledges, so the gate would pass more easily.
- Counting a meaning as not accepted on correct-labelled clips: the tester's tap says the child was right, and the app treats it as right.
- Including `label_by: judge` clips: their label is the judge's own verdict, so they cannot check it (D-STT-judge-drives-lesson).

**Impact:**
- The two gate numbers use the bench `verdict` (`correct`, with `meaning` folded in), not the Heard kind.
- Thresholds are inclusive and use integer arithmetic: exactly 80% accepted and exactly 5% false praise pass (`WORD_ACCEPT_MIN`, `WORD_FALSE_PRAISE_MAX`).
