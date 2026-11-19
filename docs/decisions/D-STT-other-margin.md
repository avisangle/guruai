# D-STT: "Other" margin 3.0 nats per token, set from the first real child's sessions
**Status:** Accepted
**Date:** 2026-11-16
**Issue:** none (calibration step of the on-device judge, pending.md)
**Confluence:** none

**Decision:** The closed-set judge calls an answer "other" only when the model's own free decode beats the closest lesson answer by more than 3.0 nats per token of that answer (`OTHER_MARGIN_PER_TOKEN`, was 1.5). Same value in the app (`app/src/asr/judge.ts`) and the bench (`tools/stt_bench/providers/indicconformer.py`).

**Why:**
- A 4-year-old answers with the letter plus its word and normal child sound swaps (र→ल/ळ/फ, च→ज, a leading "ह"/"हो"): "इ इमाफतीजा" for "इ इमारतीचा". Those clips land 1.7 to 3.1 nats per token above the best answer, so 1.5 rejected most correct answers.
- First son session (32 clips, `tools/stt_bench/results/20261116-173650`), re-decided from the saved scores: correct answers accepted 12/29 at 1.5, 21/29 at 3.0, 22/29 at 3.5. ReadNet letters (322 clips): 136/290, 144/290, 147/290.
- False accepts did not move up to 3.5 (son 2/2 wrong clips, both already accepted at 1.5; ReadNet 2/32). The first rise is at 5.0 (ReadNet 3/32). 3.0 keeps headroom below that.

**Rejected:** 3.5: one more son clip, less margin before false accepts rise, on one child's data.

**Limits:** One child, one session. The margin does not touch vowel-length confusions (अ said as आ is accepted at any margin); the owner accepts that for now. Re-check when more children's sessions exist.
