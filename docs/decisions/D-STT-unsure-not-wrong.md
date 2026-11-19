# D-STT: When the model is unsure what it heard, a wrong verdict becomes "ask again"
**Status:** Accepted
**Date:** 2026-11-18
**Issue:** none (calibration step of the on-device judge, pending.md)
**Confluence:** none

**Decision:** If the model's own free decode scores below -10 nats per token (`UNSURE_PER_TOKEN`, `app/src/asr/judge.ts` and `tools/stt_bench/providers/indicconformer.py`), the clip is "unsure". An unsure clip whose verdict would be wrong (another letter or "other") is judged unclear instead, which the lesson treats as silence: "I didn't hear, say it again" once, and never "that's a different letter". An unsure clip judged correct stays correct.

**Why:**
- Son session 5 (2026-11-18, results/20261118-144403): six clips decoded as "आहे", "श आहे", "ह" were nearly silent (loudest frame -22 to -31 dBFS, 0.1 to 0.2 s above -40 dBFS; his clear answers peak at -5 to -16 dBFS). On near-silence the model invents a word, the judge picks the nearest letter, and four G/H quiz turns told him "wrong". Their free decodes scored -12 to -36 nats per token; clear answers score -0.1 to -6.
- Across every labelled set, the rule only turns wrong into unclear: ReadNet 31 correct-labelled clips judged wrong, 9 silent and 9 wrong-labelled clips now ask again; son sessions 1, 2, T1 and the synthetic set unchanged; no correct verdict lost, false accepts unchanged by construction.

**Rejected:**
- A louder silence cutoff (more than 0.25 s above -40 dBFS, or a peak above -25 dBFS): ReadNet's field phones record quietly, and 107 of its 290 correct answers have under 0.25 s above -40 dBFS. Any cutoff that caught the son's faint clips lost 30 to 68 ReadNet answers the judge gets right, and it depends on the phone's microphone gain.
- Making an unsure clip unclear whatever its verdict: the same ReadNet loss (57 to 68 correct answers at -15 and -10 per token).

**Limits:** A child who whispers a wrong letter is asked again rather than corrected (9 of 32 ReadNet wrong clips). A faint clip judged correct is still praised (son session 5 had one, a teach turn); no false accept among labelled clips so far.
