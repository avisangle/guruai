# D-GURU-7: Every tutor exposes 14 states, including four silent surprise one-shots
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-7
**Confluence:** none

**Decision:** The tutor state contract grows from 10 to 14 states: the existing hello, idle, talking, listening, thinking, correct, tryagain, hint, nohear and bye, plus `sneeze`, `dropnut`, `dance` and `celebrate`. The four new states are one-shots of 2 to 4 s that hand over to `idle` and have no voice line. `TUTOR_STATES` in `app/src/shekru/contract.ts` is the list in code. This replaces D-CHAR-swap-ready-tutor and carries its other rules forward unchanged.

**Why:** PRD Tutor variety 4 adds occasional surprises between items (a sneeze, a dropped nut, a little dance, a celebration without speech). If they lived only in Shekru's rig, the engine would branch on the tutor and every later tutor (Tai, Pati) would have to rediscover what to provide. Extending the contract once (PRD Risks, tutor variety row) keeps lessons tutor-neutral and gives each future rig a fixed checklist.

**Rejected:**
- Surprises as Shekru-only extras the engine checks for: lesson code would depend on one tutor's rig, which D-CHAR-swap-ready-tutor ruled out.
- Building a surprise from existing states (correct plus an fx, idle plus a sound): reads as a repeat of praise, not a surprise, and a tutor could not give each one its own character.
- Speaking surprise states: jokes and fun facts are separate voice lines played over `talking`; a speaking surprise would need per-tutor audio for every animation and lip-sync during a full-body move.
- Looping surprise states: the lesson would have to end them itself; a one-shot that returns to `idle` cannot get stuck between items.

**Impact:**
- Every tutor exposes the same state machine contract: the 14 states in `TUTOR_STATES` and the same 9 visemes (rest, AA, EE, I, O, OO, MBP, FV, LTD), with identical input names. `contract.test.ts` checks Shekru's generated animation against the list.
- `sneeze`, `dropnut`, `dance` and `celebrate` are one-shots of 2 to 4 s whose `next` is `idle`, and no voice line drives the mouth during them. Code that plays a surprise waits for the hand-over to `idle` and does not pair it with a line.
- Lesson scripts are character-neutral text. A tutor is config: art file, voice ID, voice settings. Audio packs are generated and stored per tutor, and a device downloads only the selected tutor's pack.
- Lesson content must never depend on one tutor's unique trait. The letter or word being taught always appears in the lesson UI; a tutor may echo it (Pati's slate) only as decoration.
- The selected tutor is a single setting on the child profile, set during profile setup and changeable in PIN-locked parent mode. It is a preference, not personal data.
- Adding or removing a state is a new decision that supersedes this one.
