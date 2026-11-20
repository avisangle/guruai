# D-GURU-12: Word items are practice only until the tap-mode judge test passes
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-12
**Confluence:** none

**Decision:** A `wrong` on a word item never changes its mastery row: it does not mark the item not learned, reset its revision interval, or hold the child back. `WORD_ITEMS_GATED` in `app/src/learning/config.ts` (true) is the one switch. Correct word answers still master and advance the item, and letter items count both ways.

**Why:** The on-device judge has not yet been measured on whole-word and meaning answers. Until a tap-mode judge test shows at least 80% of correct word answers accepted and at most 5% false praise, a `wrong` on a word is as likely to be the judge's miss as the child's, and holding a child back on it is worse than letting the item through.

**Rejected:**
- Counting word wrongs like letter wrongs: a misjudged child would be held back.
- Leaving word items out of mastery entirely: correct answers would not be remembered or revised.
- Only having the engine set `counts: false` on word wrongs: `applyAnswer` also checks the flag, so a stray `counts: true` cannot reach mastery and a rebuild gives the same rows.

**Impact:**
- Mastery code checks `WORD_ITEMS_GATED` before applying any `wrong` on a word item; nothing else gates word items.
- The engine still sets `counts: false` on word wrongs while the flag is true (TDD 2.3), so pilot figures exclude them.
- Turning the flag off needs the tap-mode judge test result above; record it as a new decision that supersedes this one.
