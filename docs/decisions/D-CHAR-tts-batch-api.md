# D-CHAR: New lesson lines are voiced through the Gemini Batch API
**Status:** Accepted
**Date:** 2026-11-17
**Issue:** none (owner request: "club api request for Gemini TTS")
**Confluence:** none

**Decision:** `tools/gen_voice.py --batch` sends every line still needing a take as one Gemini Batch API job, checks each take with Scribe, and resubmits only the failures (3 rounds at most; the last round's take is kept and flagged). Use it for any run of more than a few lines.

**Why:**
- Interactive `generateContent` on `gemini-3.8-flash-tts` is capped at 100 requests per day on Tier 1. A 93-line run stopped after 11 lines (the take checker also wasted retries, `bug.md` 2026-11-16).
- Batch jobs count against separate limits (enqueued tokens), cost half, and the TTS model lists `batchGenerateContent`. The 93 English lines took 115 requests in 3 jobs, about 25 minutes in all; a 1-line probe returned in 90 s.
- Same model, voice and style prompt, so batch takes match the earlier interactive ones (`D-CHAR-gemini-tts-voice`).

**Rejected:**
- Waiting for the daily reset: blocks a run for up to a day, and 82 lines plus retries could hit the cap again.
- Several lines in one request, split afterwards: fewer requests, but cutting the audio at line boundaries needs forced alignment and risks clipped words and one line's tone bleeding into the next.
- Raising the quota tier: an account change for the owner, and it doesn't lower the cost.

**Trade-off:** Google promises batch results only within 24 hours (minutes so far), so a quick single-line redo can still use the interactive path (`--redo=` without `--batch`).
