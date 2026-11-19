# D-CHAR: Gemini TTS for tutor voices, Whisper for lip-sync timing
**Status:** Accepted
**Date:** 2026-11-14
**Issue:** none (Shekru voice test, review page https://claude.ai/artifact/TG9T3trLW6458Dk61FQsFC)
**Confluence:** none

**Decision:** Tutor voice lines are generated with Gemini TTS (`gemini-3.8-flash-tts`), with a per-character voice and style prompt. Shekru's voice is Puck. Mouth timing comes from aligning each line's words to the audio locally with Whisper (`stable-ts`, `large-v3-turbo`).

**Why:** In a side-by-side listening test the user found Gemini's delivery talks to a 5-year-old, while every ElevenLabs voice tried sounded aimed at adults. Gemini also adds small unscripted touches (laughs, giggles), which the user judged to improve engagement.

**Rejected:**
- ElevenLabs v4, already subscribed: returns exact per-letter timestamps and followed the script word for word, but 7 voices (Marathi conversational, Hindi cartoon), with and without emotion tags at the most expressive setting, all sounded adult-directed.
- Suppressing Gemini's additions in the style prompt: removes the engagement the user wanted.
- ElevenLabs forced alignment for timing: needs a key permission not granted, and a local aligner avoids a paid dependency. Whisper word starts were within 40 ms (median) and 140 ms (p90) of ElevenLabs' own timestamps over 308 words.
- Timing from loudness alone: mouth shapes drift from the sounds.

**Impact:**
- A character's voice is a voice name plus its style prompt; both live in `tools/gen_voice.py` and must not change once lines ship, or new clips will not match old ones.
- Gemini may add words of its own; that is allowed. Every script word must still be spoken: each new clip is transcribed and regenerated (up to 3 times) when a script word is dropped or changed. Existing takes are only reported, never replaced; use `--redo` to replace one deliberately.
- Lip-sync timing is aligned to the words actually spoken (the transcript), so added laughs move the mouth too.
- Speech-to-text output varies between runs; a flag is a prompt to listen, not proof of a bad take.

**Terms risk (accepted 2026-11-15):** Gemini API and Google Cloud generative AI terms bar use "as part of" a service likely to be accessed by under-18s (`docs/provider-terms.md`). Whether offline, human-reviewed audio bundled as files counts is unclear. The owner chose to keep Gemini for Shekru. Consequence if Google disagrees: loss of API access, so no new lines in Puck's voice; existing files are not covered by any deletion clause we found. Mitigations: ask Google in writing; keep one audio pack per tutor so a voice switch means regenerating files only; decide before producing the full catalogue.
