# D-GURU-19: Tutor variety: random lines without recent repeats, praise by moment, chance-based reactions and surprises, shuffled quiz kept on resume
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-19
**Confluence:** none

**Decision:** Every shared line is chosen at random from its family, avoiding that family's last 5 picks (TDD 2.4); the history lives in `Position.last` as family -> ids, oldest first. A correct quiz, retry or revision answer plays a line from the moment's praise family (comeback > after hint > streak at 3, 6, 9 ... > first try), then the item's `correct` line, which names the answer. The lesson closes with an `end_all` or `end_misses` line before the outro. A right teach-phase answer is followed by one of the item's picture reactions with chance 0.5, so at most once per item per run. A fresh run gets a surprise with chance 0.5: the slot is drawn at the start (any teach or quiz item but the first, never the retry round), stored in `Position.surprise` and cleared when it plays, so a lesson never has two. The quiz order is drawn with `shuffleQuiz` and `interleaveRevision` when the quiz starts and stored in `Position.quiz`, so a resume keeps it.

**Why:** PRD Tutor variety 1 to 5: children learn to predict a tutor whose lines, reactions and surprises come at fixed points. Storing every random choice that spans more than one answer in the position keeps resume identical to an uninterrupted run, and an injected rng keeps all of it testable.

**Rejected:**
- Fixed reaction slots and a surprise in every lesson: predictable; PRD Tutor variety 3 and 4.
- Avoiding only the last pick (the prototype's `pickRandom`) or cycling in order (`pickNext`): a child hears the same few lines within a lesson.
- Re-drawing the quiz order or the surprise on resume: the order would change under a half-finished quiz, and a resumed lesson could get a second surprise.
- Reactions on the reveal repeat in the quiz: that repeat follows a miss, and a fun picture line there reads as praise.

**Impact:**
- Shared lines go through `pickLine` only; a family's lines are `<family>_<n>` or the bare family id (`retry_intro`).
- Streak and comeback track scored answers only: teach turns, the follow-up, the bridge step, a first silence and misses on gated word items do not change them. An item "ends in a miss" when it is revealed.
- A surprise step is `{type: 'surprise', state, line?, text?}` with `state` from `TUTOR_STATES` (D-GURU-7-tutor-state-contract); `celebrate` has no line, the other states carry a `surprise_line` the player speaks after the silent one-shot.
- Revision items (`revision: {template_id, item}[]`) are never taught or sent to the retry round; their line ids and events use their own `template_id`, and their events have `phase: 'revision'`. A resume must pass the same revision items, or the engine throws.
- Positions saved before this change resume with their quiz in file order and no surprise.
