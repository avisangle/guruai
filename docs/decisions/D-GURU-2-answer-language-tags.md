# D-GURU-2: Answer languages live in a parallel `assessment.langs` map
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-2
**Confluence:** none

**Decision:** An item's answer languages are a map from answer text to `Lang[]` in `assessment.langs`. An answer not listed is tagged `[target_lang]`; a text may carry several tags. `expected` and `accepted_variants` stay plain string arrays.

**Why:** `tools/stt_bench`, `tools/stt_bench/asr_tokens.py` and `tools/gen_voice.py` read `expected` and `accepted_variants` as string arrays today. A side map adds the language without touching any of them, and the default keeps every existing lesson valid with no tags at all.

**Rejected:**
- `{text, lang}` objects inside `expected`/`accepted_variants`: every reader of the arrays (bench, tokenizer, voicing, app judge) would have to change in the same release.
- One language per answer: a word such as a shared loanword is a correct answer in two languages, so a text needs a list.

**Impact:**
- Every key of `assessment.langs` must be one of the item's `expected`/`accepted_variants` texts; `app/src/content/validate.ts` fails the build otherwise. `also_correct` stays outside the map (D-STT-lenient-vowel-length).
- Two answers with disjoint tag sets that normalise equal (`app/src/asr/normalise.ts`) or whose token ids (`app/src/asr/generated/mr-tokens.json`) are within edit distance 2 fail the build unless the item sets `ambiguous_lang: true`. Code that reads an answer's language goes through the default (`langs[text] ?? [target_lang]`), never `langs[text]` alone.
