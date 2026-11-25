# D-GURU-42: An empty free decode means nothing heard, whatever the margin
**Status:** Accepted
**Date:** 2026-11-25
**Issue:** GURU-42
**Confluence:** none

**Decision:** Once a clip passes `isSilent` and the model has run, a greedy (free) decode with no tokens makes `decide` return `nothing`, whatever the closest answer's margin. Before, an empty decode returned `nothing` only above `OTHER_MARGIN_PER_TOKEN` and otherwise took the closest candidate. Same rule in `decide` in `app/src/asr/judge.ts` and in `tools/stt_bench/providers/indicconformer.py`; `golden.json` has a case for it. `judgeClip` maps `nothing` to silent, verdict `unclear`, so the lesson asks again once.

**Why:**
- On the 2026-11-25 phone test, household noise with nobody answering was judged a correct teach answer for अ, and 3.7 s of noise on a quiz turn for उ was judged a counted `wrong` "अ" (bug.md). Both clips were loud enough to pass `isSilent`, and both had an empty free decode under the margin, so the judge picked the shortest candidate.
- Bench, `indicconformer_closed`, before (fb89bce) and after (678fd17). Each cell is before -> after; one number means no change.

| set | correct accepted | false accepts | silent judged correct | unclear |
| --- | --- | --- | --- | --- |
| ReadNet letters | 156/290 -> 155/290 | 2/32 | 0/40 | 88 -> 94 |
| synthetic fixture | 16/24 | 0/8 | 0/3 | 3 -> 5 |
| son 1 (20261116-120148, tap) | 23/29 | 2/2 | 0/1 | 1 |
| son 2 (20261116-152122, tap) | 14/19 -> 13/19 | 1/5 | 0/0 | 0 -> 2 |
| owner T1 | 11/13 | 0/0 | 0/1 | 1 |
| son 6 (20261118-164413, tap) | 21/22 | 0/0 | 0/0 | 0 |
| 20261117-093124 (judge labels) | 5/5 | 14/23 | 0/0 | 2 |
| 20261117-121621 (judge labels) | 21/21 | 10/20 -> 9/20 | 0/2 | 2 -> 3 |
| 20261118-090922 (judge labels) | 43/43 | 12/35 -> 11/35 | 0/2 | 10 -> 11 |
| 20261122-205700 (judge labels) | 11/11 | 2/11 | 0/1 | 1 |

- 21 clips change, every one to `nothing`/unclear. Among them: one false accept removed (a wrong "B", present in two exports), 2 wrong-labelled and 2 silent-labelled ReadNet clips moved from a "wrong" verdict to asking again, and 2 synthetic clips moved from wrong to unclear.

**Accepted cost:** Two correct answers become unclear: a tap-labelled teach answer for ऐ in son session 2 (free log-likelihood -20.43, margin 0.69 nats per token, unsure; judged correct on the phone), and one ReadNet ह (margin 0.03, unsure). So the model can decode no tokens while the closest answer still fits the audio, and rule A asks that child again. The owner accepted this on 2026-11-25 (GURU-42 Jira comment): unclear only asks again, while the bug praised noise and counted a miss for it. Neither signal at hand (unsure, margin) separates the lost ऐ from the noise clips; the noise clips are not in any export on disk.

**Rejected:**
- Rule B, an unsure correct verdict asks again (turning it into silence in `classify`): D-STT-unsure-not-wrong measured making an unsure clip unclear whatever its verdict at 57 to 68 lost correct ReadNet answers (-15 and -10 nats per token). Rule A covers both observed noise clips without it.
- A louder silence cutoff (`SPEECH_DBFS`, `MIN_SPEECH_S`): 30 to 68 quiet ReadNet answers lost (D-STT-unsure-not-wrong).

**Impact:**
- In both judges, an empty free decode after the model run returns `nothing` before any candidate is chosen; do not reintroduce a margin test on that path. Non-empty decodes keep the D-STT-other-margin and D-STT-repeated-answers handling.
- `classify` is unchanged: an unsure correct verdict stays correct (D-STT-unsure-not-wrong).
- Any extra signal that would win back answers like the lost ऐ (sounding seconds, peak level, a margin bound for empty decodes) must be measured on real noise clips before it loosens this rule.
