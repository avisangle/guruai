# D-GURU-17: tools/voice_latin.json overrides the built-in Latin map
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-17
**Confluence:** none

**Decision:** The take checker in `tools/gen_voice.py` maps English words, which the speech-to-text transcript writes in Latin letters, back to the script's Devanagari spelling. Extra pairs for that map live in `tools/voice_latin.json`. The file is merged over the built-in `LATIN` dict, so a pair in the file replaces a built-in pair with the same key. Keys are lowercased when they are merged.

**Why:** Adding a word, or fixing a spelling the lessons write differently, should be a data edit and not a code change.

**Rejected:**
- Built-in pairs win over the file: then a wrong built-in spelling could only be fixed in code.
- Adding `"a": "अ"` for the article in "Look, a banana!" (voiced "लुक, अ बनाना!"): a key matches every instance of that word, so it would replace the letter name `a -> ए` and every "A for Apple" take would be checked against "अ". The take check allows one edit per short word, so "अ" against "ए" still passes without the pair.

**Impact:** A key in `tools/voice_latin.json` must never collide with a letter name (`a` to `z`) or with a built-in picture word unless the intent is to change how every line using that word is checked.
