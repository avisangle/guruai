# D-CHAR: Launch with Shekru only, behind a swap-ready tutor setup
**Status:** Accepted
**Date:** 2026-11-14
**Issue:** none (character review round 1)
**Confluence:** none

**Decision:** The app launches with one tutor character, Shekru (शेकरू, the Indian giant squirrel). The app is built so more tutors (Tai, Pati) can be added later and chosen per child profile, without changing lesson code.

**Why:** Each extra character multiplies the most expensive character work (layered art, Rive rig, 10 animated states), plus a full voice-line set and testing on every lesson screen. Shipping one keeps the 13–17 week launch plan intact. Designing for swapping now costs little; retrofitting it after lessons are written around one character costs a lot.

**Rejected:**
- All three tutors at launch: roughly triples the character art and animation budget, and squeezes the launch timeline before there is any retention data showing a choice matters.
- One tutor with no swap design: rules out a parent or child choice later without reworking lessons and audio packaging.
- Tai or Pati first: the user picked Shekru after the review page (https://claude.ai/artifact/TG9T3trLW6458Dk61FQsFC).

**Impact:**
- Every tutor exposes the same Rive state machine contract: the same 10 states (hello, idle, talking, listening, thinking, correct, try again, hint, didn't hear, bye) and the same 9 visemes (rest, AA, EE, I, O, OO, MBP, FV, LTD), with identical input names.
- Lesson scripts are character-neutral text. A tutor is config: art file, voice ID, voice settings. Audio packs are generated and stored per tutor, and a device downloads only the selected tutor's pack.
- Lesson content must never depend on one tutor's unique trait. The letter or word being taught always appears in the lesson UI; a tutor may echo it (Pati's slate) only as decoration.
- The selected tutor is a single setting on the child profile, set during profile setup and changeable in PIN-locked parent mode. It is a preference, not personal data.
