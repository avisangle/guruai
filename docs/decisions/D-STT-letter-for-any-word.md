# D-STT: "<letter> for <any word>" is judged on the letter alone
**Status:** Accepted
**Date:** 2026-11-18
**Issue:** none (calibration step of the on-device judge, pending.md)
**Confluence:** none

**Decision:** When the closed-set judge would say "other" and the model's free decode holds a "for" word ("फॉर", "फोर", "फर") after its first word, the judge rebuilds the answer as each lesson letter name followed by the free decode's own tail from "for" on ("ए" + "फॉर एरोप्लेन", "बी" + "फॉर एरोप्लेन", ...). The best of those is the choice if its margin per token of the letter name (said once or up to `REPEATS` times) is within `OTHER_MARGIN_PER_TOKEN`. Letter names are the answers that have a "<name> फॉर <word>" answer in the same item, so Marathi lessons are untouched. Same code in `app/src/asr/judge.ts` and `tools/stt_bench/providers/indicconformer.py`.

**Why:**
- The son answers with his own words: "A for aeroplane, A for ambulance, A for axe", "जी जी फॉर गुड". The lesson lists one word per letter, so these were "other" and he heard he was wrong while knowing the letter. A letter lesson asks for the letter.
- The tail is the same for every letter, so the word cannot favour one; only the audio of the letter name decides.
- On the 26 English clips with "for" in sessions 3 to 5, the letter picked from the name alone equals the full judge's choice on all 26. It rescues 4 clips that were "other" ("ए फोर डिकेटर", "इ फोर एन स", "जी जी फॉर गुड" twice) and keeps an adult's "म बोर्तबाात बोल ना न इ फोर ..." as "other". Marathi sets and ReadNet have no "<name> फॉर" answers, so nothing there changes.

**Rejected:**
- More words per letter in the lesson (aeroplane, ambulance, axe...): no end to a child's words, and every extra answer is scored on every clip.
- Judging every clip with a "for" on the letter alone: "पे फॉर ॲपल" is A today because the word matches the lesson's apple; the letter alone loses that evidence. The rule only rescues clips that would otherwise be "other".

**Limits:** "A for ball" counts as A. A letter lesson accepts that; the word is in the clip's note for review. Few labelled clips so far: no tester-labelled false accept can be measured yet.
