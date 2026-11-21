# D-GURU-32: The lesson screen reads its moments off the engine's steps and position
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-32
**Confluence:** none

**Decision:** `usePlayerLoop` works out each lesson moment from what the engine already emits, without new fields on engine steps:
- **Correct:** a `say` step whose line is in a `praise_*` family (`familyOf` in `lines.ts`). The reward is three ticks for `praise_streak` and a star for any other praise family, teach-turn praise included. It lasts while later lines are about the same item.
- **"Didn't hear":** a listen step that is the same object as the previous one, which the engine re-queues after `nohear`.
- **Finished:** a `say` step with no item while the position is finished. The engine queues the closing lines with the last answer.
- **Surprise:** the `surprise` step.

The item dots are a pure function of the engine `Position` (`dotStates`), using the engine's own `itemRefsOf`. An item is done once no turn is left for it. A missed quiz item stays undone until its retry turn.

**Why:** `engine.test.ts` compares whole steps with `toEqual`, so a new step field would change dozens of engine assertions for a display concern. Each signal used here is part of the engine's stated behaviour: shared line ids are `<family>_<n>` (D-GURU-19-tutor-variety), and the closing lines are queued with the last answer. Dots derived from the position also come out right after a resume or a pause, where an answer-by-answer tally kept in the player would start from zero.

**Rejected:**
- `moment` / `family` / `again` fields on engine steps: churns the engine tests, and the engine has no reason to know about the screen.
- Counting finished items from `onAnswer` events in the player: wrong after a resume, and it needs its own copy of the retry rules.
- Rebuilding the streak from `praiseFamily()` with position fields: a second copy of the precedence rule, which could disagree with the line the engine actually picked.

**Impact:**
- If the engine stops re-queuing the same `Listen` object after "didn't hear" (for example, it clones queued steps), the ear badge stops showing. Such a change must carry the reopened-turn signal some other way.
- Closing lines must keep `item: null` and be queued only after the position is finished, or the finished moment starts at the wrong time.
- The engine and the dots must share the "which items does a flow entry ask" rule through `itemRefsOf`. Do not copy that rule into the UI.
- Opening parent mode from the lesson's lock pauses the lesson (`ParentLock`'s `onOpen`), so no audio or mic keeps running behind the unlock screen (the pause itself is D-GURU-28-lesson-pause).
