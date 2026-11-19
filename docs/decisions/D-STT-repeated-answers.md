# D-STT: An answer repeated 2 or 3 times counts as said once; repeats never pick the letter
**Status:** Accepted
**Date:** 2026-11-17
**Issue:** none (calibration step of the on-device judge, pending.md)
**Confluence:** none

**Decision:** The closed-set judge picks the closest answer from single-answer scores, as before. Only for that answer it also scores the answer said 2 and 3 times in a row, and the smallest "other" margin per token of the three counts (`REPEATS = 3` in `app/src/asr/judge.ts` and `tools/stt_bench/providers/indicconformer.py`). A free decode equal to an answer said 2 or 3 times is that answer.

**Why:**
- A 4-year-old repeats or self-corrects ("डी फोर्ड डी फोड डी फोर्", "इमारत इमालत", "गाय गाय गाय"). Said once, the answer explains only part of the audio, so the free decode beat it by more than 3.0 nats per token and the judge said "other".
- Labelled sets, before -> after (`STT_BENCH_IC_REPEATS=1` vs default): ReadNet letters correct accepted 151/290 -> 156/290, false accepts 2/32 -> 2/32; synthetic 16/24 -> 16/24, false accepts 0/8 -> 0/8; son sessions 1, 2 and the owner's T1: one more correct ("हम् गाय गाय गाय"), false accepts unchanged. Son session 4 (judge labels only, results/20261117-174756): 6 quiz answers newly accepted, 4 of them clear repeats of the right answer.
- Only one answer is re-scored, so the phone does one extra CTC pass (all three counts in one pass, `ctcRepeatLogLikelihoods`).

**Rejected:** Scoring every answer with its best repeat count and picking the letter from those scores. A short answer repeated soaks up a longer answer's audio: "उ उसासा" (right, ऊ उसाचा) became उ×3, whose margin per token failed, so a correct answer turned into "other".

**Limits:** Same answer only; "ए ... बी फॉर बॉल" (two different answers) is still "other". Repeats loosen the margin for short letters on unrelated speech too: in son session 4 "एक" was accepted as A and "इ इज एक एक" as इ (ई item, accepted through `also_correct`); unknown whether he said the letter. Re-check false accepts on the next tester-labelled sessions.
