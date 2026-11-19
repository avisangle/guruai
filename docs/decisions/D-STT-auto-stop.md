# D-STT: Listening turns stop by themselves (1.5 s after speech, 4 s with none)
**Status:** Accepted
**Date:** 2026-11-16
**Issue:** none (owner request: "too long waiting")
**Confluence:** none

**Decision:** After the chime the mic records until 1.5 s of quiet follows at least 0.15 s of sound, or 4 s pass with no sound, or 10 s in all. Sound is a 30 ms frame louder than -40 dBFS, the judge's own sound gate. Code: `app/src/asr/endpoint.ts`.

**Why:**
- Before, recording ran until the tester tapped, so every turn waited on an adult.
- The first child pauses up to about 1.3 s between the letter and its word ("क ... कमळाचा"). Replaying his 56 clips (two sessions) through the rule and re-judging the cut audio: 1.0 s cut two correct quiz answers short; 1.5 s left the judge's results at 37 vs 38 of 56 on the full clips; 2.0 s was no better and slower.
- A cut after the letter alone still scores as correct: the letter is an accepted answer.

**Rejected:** a level relative to each clip's noise floor (no noisy-room clips yet to tune it; pending.md sound gate item); 1.0 s end silence (cut answers); waiting 5 s for a silent child (the owner asked for less waiting).

**Impact:** One child, quiet home. Re-check END_SILENCE_MS and NO_SPEECH_MS on other children and noisier rooms. A child who talks on after the cut is heard over Shekru's reply.
