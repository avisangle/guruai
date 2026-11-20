# D-GURU-3: Score every answer with a 4-year-old's sound swaps, as the same item
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-3
**Confluence:** none

**Decision:** Each lesson answer is also scored with word-final चा said सा, every र said ल, and both ("उंदराचा" as "उंदलाचा", "उंदरासा", "उंदलासा"), as more answers of the same item. On by default in the app (`childSwaps` in `app/src/asr/judge.ts`, applied in `lessonCandidates()`) and the bench (`child_swaps` in `tools/stt_bench/providers/indicconformer.py`; `STT_BENCH_IC_CHILD_SWAPS=0` turns it off).

**Why:**
- The son's sixth session (2026-11-18) failed all 4 Marathi misses the same way: the model heard him cleanly, but he says "उंदराचा" as "उनलासा" and "ऊसाचा" as "उसासा", normal at 4, so no answer matched.
- On the tap-labelled son sessions 1, 2 and 6, correct accepts rose from 56/79 to 62/79 (session 6: 18 to 21 of 22). Synthetic (24/32, false accepts 0/8) and ReadNet (177/322, false accepts 2/32) did not move; son false accepts stayed 3/7.
- Re-run for GURU-3 on the synthetic fixture with the bench default on and with `STT_BENCH_IC_CHILD_SWAPS=0`: 24/32 agreement, 0/8 false accepts both ways.

**Rejected:** Raising the "other" margin to 3.5 nats per token instead: it gained less on the son's sessions (59/79) and loosens every answer, not just these sounds.

**Impact:**
- The app and the bench apply the same swaps in the same order (originals first, then for each answer: चा to सा, र to ल, both), each text once with the original winning a clash. Changing either side means regenerating `app/src/asr/__fixtures__/golden.json` (`phone_golden.py`, which always runs with swaps on) and `generated/mr-tokens.json` (`asr_tokens.py`, which tokenises every swap).
- A swapped text counts as its source answer, keeping that answer's language, only when the judge chose the asked item. "ल" chosen as the ल item stays the ल item's answer when र is asked, as the bench scores it.
- An answer holding the sounds is scored up to 4 times per clip on the phone (itself and its swaps).
