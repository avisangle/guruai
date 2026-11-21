# D-GURU-16: Audio packs by class band; paths share lessons, packs never do
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-16
**Confluence:** none

**Decision:** A lesson sits in exactly one pack (`content/paths/packs.json`), while any number of paths may list it. The 8 KG lessons are listed by the Nursery, Junior KG and Senior KG class paths of both boards (their own `classes` field) and by the Marathi or English letters skill path. Packs follow class bands: `starter` (`tpl_kg_mr_swar_1`, `tpl_kg_en_letters_1`), `kg` (the other six), then `class1`, `class2`, `en-words` and `numbers`, empty until their lessons exist. A path's `pack` names the pack that holds the lessons first added for it; `lessonPack` in `generated/paths.json` is the authority for which pack a lesson needs.

This refines the PRD's "packs are split by learning path" (Technical Constraints) and "per-path audio packs" (Downloads): packs are split by class band, and a path names the pack its lessons start in.

**Why:** The same lesson serves three classes, both boards and a skill path, so a pack per path would put one lesson's audio in several packs, which downloads it twice and lets copies drift. A class band is the unit a child's packs follow once the class is known (D-GURU-14-downloads-starter-pack), and the boards share the KG lessons.

**Rejected:**
- A pack per path: one lesson in many packs.
- A pack per skill (`mr-letters`, `en-letters`): class paths mix both languages and would name no single pack.
- Splitting the KG lessons across Nursery, Junior KG and Senior KG: the lessons are written for all three, and a Senior KG child with only a class path would miss the vowels.

**Impact:**
- Code that needs a lesson's pack reads `lessonPack`, never the path's `pack`.
- A path may list lessons from other packs (every KG path lists the `starter` lessons).
- A pack may be empty; pack build and publish (GURU-23) skips empty packs.
- `generated/lessons.json` is the lessons reachable from a path, ordered by path file name and then unit order; the KG unit order (Marathi vowels, Marathi consonants, English letters) keeps the earlier menu order.
