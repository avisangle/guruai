# D-STT: Accept the vowel-length partner as a correct answer
**Status:** Accepted
**Date:** 2026-11-15
**Issue:** none (owner call after the first real-child benchmark)
**Confluence:** none

**Decision:** In a quiz turn, saying the short or long partner of a vowel counts as correct: इ for ई and ई for इ, उ for ऊ and ऊ for उ. The tutor still teaches and models the right letter (the `correct_<letter>` line names it). Each lesson item lists its partner in `assessment.also_correct`.

**Why:** No judge we can use separates the pairs reliably. On the owner's son (age 4) both local judges picked the short vowel for every ई and ऊ teach clip; on Shekru's adult voice the best allowed judge reached 6/10 on इ/ई and a vowel-duration check changed nothing. Rejecting a child who said the letter right would hurt more than missing a length slip, and Google Read Along leans lenient for the same reason (docs/stt-options.md).

**Rejected:**
- Strict scoring of the pairs: wrongly rejects real correct answers with today's models.
- Putting the partner in `accepted_variants`: those strings are also the closed-set candidates, so the partner letter would map to the wrong item and a judge's choice would stop naming the letter it heard.
- Re-asking on a close score: still no reliable signal to trigger it.

**Impact:**
- Lesson items with a length partner carry `also_correct: ["<partner letter>"]`; both evaluators (`app/src/lesson/evaluator.ts`, `tools/stt_bench/evaluator.py`) accept it. Closed-set candidates never include `also_correct`.
- The bench judges every clip by the current lesson file, so its length-pair tables show these confusions as false accepts by design. Revisit if a fine-tuned scorer separates the pairs on real children.
- Lessons must keep teaching the pairs apart in their lines; only the judgement is lenient.
