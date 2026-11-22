# D-GURU-10: Word-item language rules in the engine: ask, Marathi bridge, reveal
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-10
**Confluence:** none

**Decision:** Each word item has one target language. A quiz turn asks in the target language; a first miss plays the Marathi bridge (`hint`), a second miss reveals with the lesson's style teach line and listens for a repeat. A right meaning in Marathi or Hindi on an English-target item is the bridge step: acknowledge (`ack_meaning`, or shared `meaning_hi_ack_*` for Hindi, never repeating the Hindi word), ask again, no attempt used, `counts: false`. A second meaning on the same item goes on as a missed try with no "wrong" line, so the lesson always ends. A Hindi right meaning on a Marathi-target item is correct and counted; then, unless `ambiguous_lang`, an unscored follow-up (`ask_mr_*`; right gets a short praise line, anything else plays `model_mr` and listens once). Flagged items get `model_mr` only. The teach style (`mr_led` or `en_led`) is picked once per lesson from the child's level.

**Why:** PRD Language design 1 to 9. The engine applies the rules because they depend on the item's target, its flag and the phase, which belong to the lesson; the judge only classifies (TDD 2.2).

**Rejected:**
- Per-item language switching from the child's answers (PRD): it follows the judge's errors, needs language tags the judge cannot reliably produce, and roughly triples audio.
- Treating a meaning as a wrong attempt on English-target items: the child knew the item; PRD rule 8.

**Impact:**
- `tryagain_*` ("a different letter", named `wrong_*` before GURU-11) is played only for a wrong letter, never after silence and never on a word item.
- A `meaning` on a letter item is correct (it names the letter). A `meaning` in a teach turn or reveal repeat on a word item is handled as `wrong` (model again, then move on).
- `counts` is false for teach turns and reveal repeats, a first silence, the bridge step, the follow-up, and any miss on a word item while `wordItemsGated`; such items are also never added to the retry round (D-GURU-12-word-items-practice-only).
- `Position.bridged` and `Position.followup` carry the bridge and follow-up across a resume; a resume during the follow-up replays its question.
- After the last answer the engine queues the closing lines at once, so the position it returns is finished.
