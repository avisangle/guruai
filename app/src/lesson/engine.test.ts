// GURU-10: engine v2. Contract: TDD 2.2 (Heard) and 2.3 (AnswerEvent) in the Epic GURU-1;
// language rules: PRD "Language design" 1-9, D-GURU-10-language-design.
// GURU-19: tutor variety wired in. Contract: TDD 2.4, the design rows for picture reactions and
// surprises in the Epic GURU-1; PRD "Tutor variety" 1-5; D-GURU-19-tutor-variety.
//
// Real shapes this file relies on (read, not assumed):
// - Heard, Lang, DecidedBy and the v2 Item (kind, target_lang, langs, ambiguous_lang, word lines)
//   are in ./types (GURU-2); items may carry `react_1` and `react_2` lines.
// - flow `order` names items by `display`; word-item line ids are `<template>.<item id>.<line>`.
// - pickLine, praiseFamily, endFamily, shuffleQuiz, interleaveRevision and FAMILIES (GURU-8);
//   TUTOR_STATES (GURU-7, ../shekru/contract).
// - Shared line ids are `<family>_<n>` (TDD 2.4). The pools themselves are GURU-11, which renames
//   ok_N -> praise_first_N, wrong_N -> tryagain_N and nohear -> nohear_1, so these tests pass
//   their own prompts: every FAMILIES family with 8 lines, none of the old ids.
// - Steps name a shared line by its family (`lines()` strips `_<n>`); `rawLines()` keeps the raw id.
import lessonsJson from '../content/generated/lessons.json';
import wordLessonJson from './__fixtures__/word-lesson.json';
import { TUTOR_STATES } from '../shekru/contract';
import { createLesson, isFinished, type LessonEngine } from './engine';
import { exactEvaluator, toAnswer } from './evaluator';
import { FAMILIES } from './lines';
import { interleaveRevision, shuffleQuiz } from './quizOrder';
import type { AnswerEvent, Heard, Item, Lang, Lesson, Listen, Position, Prompts, Say, Step } from './types';

// Adds picture reactions to every item, as GURU-11 will for the pilot lessons.
const withReacts = (l: Lesson): Lesson => ({
  ...l,
  items: l.items.map((i) => ({ ...i, lines: { ...i.lines, react_1: `${i.display} react 1`, react_2: `${i.display} react 2` } }) as Item),
});

const lessonJson = lessonsJson[0]; // स्वर १ (अ to ऊ): the letter cases below are written against it

const lesson = withReacts(lessonJson as unknown as Lesson);
const prompts: Prompts = {
  lines: Object.fromEntries(
    Object.keys(FAMILIES).flatMap((f) => Array.from({ length: 8 }, (_, n) => [`${f}_${n + 1}`, `${f} line ${n + 1}`])),
  ),
};
const T = lesson.template_id;
const TEACH = ['a', 'aa', 'i', 'ii', 'u', 'uu'];
const QUIZ = ['aa', 'u', 'i', 'a', 'uu', 'ii'];
// Constant rngs. NONE: no surprise, no reaction, and shuffleQuiz keeps the file order (Fisher-Yates
// with rng 0.99 swaps nothing), so the fixed-order cases below stay readable.
const NONE = () => 0.99;
const ALWAYS = () => 0;

type Kind = 'correct' | 'wrong' | 'silent';
type Result = { position: Position; event: AnswerEvent };
type Surprise = { type: 'surprise'; state: string; line?: string };
const heard = (a: Heard | Kind): Heard => (typeof a === 'string' ? ({ kind: a, by: 'shekru' } as Heard) : a);
const meaning = (text: string, lang: Lang): Heard => ({ kind: 'meaning', by: 'shekru', text, lang });

// Every answer() result, per engine.
const results = new WeakMap<LessonEngine, Result[]>();
const eventsOf = (engine: LessonEngine) => (results.get(engine) ?? []).map((r) => r.event);
const lastPosition = (engine: LessonEngine) => results.get(engine)!.at(-1)!.position;
function answer(engine: LessonEngine, a: Heard | Kind): Result {
  const res = engine.answer(heard(a)) as Result;
  results.set(engine, [...(results.get(engine) ?? []), res]);
  return res;
}

const start = (position?: Position | null, rng: () => number = NONE) => createLesson(lesson, prompts, { position, rng });

// Steps up to and including the next listen (or done).
function turn(engine: LessonEngine): Step[] {
  const steps: Step[] = [];
  for (;;) {
    const step = engine.next();
    steps.push(step);
    if (step.type === 'listen' || step.type === 'done') return steps;
  }
}
const isSurprise = (s: Step | Surprise): s is Surprise => s.type === 'surprise';
// Shared line id -> its family; lesson and item lines (they contain a dot) unchanged.
const fam = (id: string | undefined) => (id === undefined ? '<no line>' : id.includes('.') ? id : id.replace(/_\d+$/, ''));
const rawLines = (steps: Step[]) => steps.map((s) => {
  if (s.type === 'say') return s.line;
  if (s.type === 'listen') return `listen:${s.kind}:${s.item.id}`;
  if (isSurprise(s)) return `surprise:${s.state}`;
  return 'done';
});
const lines = (steps: Step[]) => rawLines(steps).map(fam);
const says = (steps: Step[]) => steps.filter((s): s is Say => s.type === 'say');

// Answers one listen and returns the steps up to the next one.
function reply(engine: LessonEngine, a: Heard | Kind) {
  answer(engine, a);
  return turn(engine);
}
// Plays the teach phase with correct answers; returns the turn that opens the quiz.
function toQuiz(engine: LessonEngine, taught = TEACH.length) {
  turn(engine);
  let steps: Step[] = [];
  for (let i = 0; i < taught; i++) steps = reply(engine, 'correct');
  return steps;
}
// Runs to the end, answering each listen with pick(step).
function finish(engine: LessonEngine, pick: (id: string, kind: string, n: number, item: Item) => Heard | Kind, first = turn(engine)) {
  const all = [...first];
  const seen: Record<string, number> = {};
  while (all.at(-1)!.type === 'listen') {
    const l = all.at(-1) as Listen;
    const key = `${l.kind}:${l.item.id}`;
    seen[key] = (seen[key] ?? 0) + 1;
    all.push(...reply(engine, pick(l.item.id, l.kind, seen[key], l.item)));
  }
  return all;
}

describe.each((lessonsJson as unknown as Lesson[]).map((l) => [l.template_id, l] as const))('lesson %s', (_id, l) => {
  test('every item is taught and quizzed once, and the run ends', () => {
    const engine = createLesson(l, prompts, { rng: () => 0 });
    const all = finish(engine, () => 'correct');
    const ids = (kind: string) => all.filter((s) => s.type === 'listen' && s.kind === kind).map((s) => (s as Listen).item.id).sort();
    const items = l.items.map((i) => i.id).sort();
    expect(ids('teach')).toEqual(items);
    expect(ids('quiz')).toEqual(items);
    expect(all.at(-1)!.type).toBe('done');
  });

  test('all wrong still ends, and no counted quiz answer is correct', () => {
    const engine = createLesson(l, prompts, { rng: () => 0 });
    expect(finish(engine, () => 'wrong').at(-1)!.type).toBe('done');
    const counted = eventsOf(engine).filter((e) => e.counts);
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.every((e) => e.heard_kind === 'wrong')).toBe(true);
  });
});

describe('flow', () => {
  test('starts with the intro in the hello state, then teaches the first item', () => {
    const steps = turn(start());
    expect(lines(steps)).toEqual([`${T}.intro`, `${T}.a.teach`, 'listen:teach:a']);
    expect(says(steps)[0]).toMatchObject({ state: 'hello', text: lesson.lines.intro, item: null });
    expect(says(steps)[1]).toMatchObject({ state: 'talking', showAnchor: true });
    expect(says(steps)[1].item?.display).toBe('अ');
  });

  test('teach phase follows the flow order', () => {
    const engine = start();
    const all = finish(engine, () => 'correct');
    const taught = all.filter((s) => s.type === 'listen' && s.kind === 'teach').map((s) => (s as Listen).item.id);
    expect(taught).toEqual(TEACH);
  });

  test('quiz_intro then the quiz (file order under NONE), each letter asked with a shared ask_* line', () => {
    const engine = start();
    const opening = toQuiz(engine);
    expect(lines(opening).slice(1)).toEqual([`${T}.quiz_intro`, 'ask', 'listen:quiz:aa']);
    expect(says(opening)[2]).toMatchObject({ state: 'talking', showAnchor: false });
    const all = finish(engine, () => 'correct', opening);
    expect(all.filter((s) => s.type === 'listen').map((s) => (s as Listen).item.id)).toEqual(QUIZ);
    expect(lines(all).filter((l) => l === 'ask')).toHaveLength(QUIZ.length);
  });

  test('full run with every answer right: no retry round, outro in the bye state, every quiz answer counted correct', () => {
    const engine = start();
    const all = finish(engine, () => 'correct');
    expect(lines(all)).not.toContain('retry_intro');
    expect(all.at(-1)).toEqual({ type: 'done' });
    expect(all.at(-2)).toMatchObject({ line: `${T}.outro`, state: 'bye' });
    expect(lines(all).at(-3)).toBe('end_all');
    expect(all.filter((s) => s.type === 'listen')).toHaveLength(12);
    expect(isFinished(lesson, lastPosition(engine))).toBe(true);
    const quiz = eventsOf(engine).filter((e) => e.phase === 'quiz');
    expect(quiz.map((e) => e.item_key).sort()).toEqual(lesson.items.map((i) => i.item_key).sort());
    expect(quiz.every((e) => e.counts && e.heard_kind === 'correct' && e.attempt === 1)).toBe(true);
    expect(engine.next()).toEqual({ type: 'done' });
  });

  test('every spoken line has text and a known audio id', () => {
    const ids = new Set([
      ...Object.keys(prompts.lines),
      ...Object.keys(lesson.lines).map((l) => `${T}.${l}`),
      ...lesson.items.flatMap((i) => Object.keys(i.lines).map((l) => `${T}.${i.id}.${l}`)),
    ]);
    const all = finish(start(), (_id, _kind, n) => (n <= 2 ? 'wrong' : 'silent'));
    for (const s of says(all)) {
      expect(ids.has(s.line)).toBe(true);
      expect(s.text).toBeTruthy();
    }
  });
});

describe('Listen.prompt', () => {
  // The listen right after nohear keeps the turn's prompt; every other listen is opened by the say before it.
  const checkPrompts = (all: Step[]) => {
    let checked = 0;
    all.forEach((s, i) => {
      if (s.type !== 'listen') return;
      const before = all[i - 1];
      expect(typeof s.prompt).toBe('string');
      if (before?.type === 'say' && fam(before.line) !== 'nohear') {
        expect(s.prompt).toBe(before.text);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(10);
  };

  test('letter lesson: every listen carries the voice text of the say that opened the mic', () => {
    checkPrompts(finish(start(), (_id, kind, n) => (kind === 'quiz' && n <= 2 ? 'wrong' : n === 1 ? 'silent' : 'correct')));
  });

  test('word lesson: also after the bridge step and the Hindi follow-up', () => {
    const engine = startWords();
    checkPrompts(finish(engine, (_id, kind, n, item) => (kind === 'teach' ? 'correct' : n === 1 ? meaningOf(item) : 'wrong')));
  });
});

describe('rules.teach_response', () => {
  test('right -> praise_first_* (was ok_*) then the next item; the event is a teach turn that does not count', () => {
    const engine = start();
    turn(engine);
    const { event } = answer(engine, 'correct');
    const steps = turn(engine);
    expect(lines(steps)).toEqual(['praise_first', `${T}.aa.teach`, 'listen:teach:aa']);
    expect(says(steps)[0].state).toBe('correct');
    expect(event).toMatchObject({
      template_id: T, item_key: 'mr:letter:अ', item_kind: 'letter', target_lang: 'mr',
      phase: 'teach', heard_kind: 'correct', decided_by: 'shekru', counts: false,
    });
  });

  test('1st wrong -> again_* and the teach line, listens again; 2nd wrong -> moveon_*, no praise', () => {
    const engine = start();
    turn(engine);
    const again = reply(engine, 'wrong');
    expect(lines(again)).toEqual(['again', `${T}.a.teach`, 'listen:teach:a']);
    expect(says(again)[0].state).toBe('tryagain');
    const on = reply(engine, 'wrong');
    expect(lines(on)).toEqual(['moveon', `${T}.aa.teach`, 'listen:teach:aa']);
    expect(says(on)[0].state).not.toBe('correct');
    expect(eventsOf(engine).map((e) => [e.phase, e.heard_kind, e.counts])).toEqual([['teach', 'wrong', false], ['teach', 'wrong', false]]);
  });

  test('wrong, then right -> praise_first_*', () => {
    const engine = start();
    turn(engine);
    reply(engine, 'wrong');
    expect(lines(reply(engine, 'correct'))[0]).toBe('praise_first');
  });

  test('silence -> nohear and listens once more; a second silence moves on', () => {
    const engine = start();
    turn(engine);
    const steps = reply(engine, 'silent');
    expect(lines(steps)).toEqual(['nohear', 'listen:teach:a']);
    expect(says(steps)[0].state).toBe('nohear');
    expect(lines(reply(engine, 'silent'))).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
  });

  test('silence, then speech -> praise_first_* and the next item', () => {
    const engine = start();
    turn(engine);
    reply(engine, 'silent');
    expect(lines(reply(engine, 'correct'))).toEqual(['praise_first', `${T}.aa.teach`, 'listen:teach:aa']);
  });

  test('no teach-phase event counts', () => {
    const engine = start();
    toQuiz(engine);
    const events = eventsOf(engine);
    expect(events).toHaveLength(TEACH.length);
    expect(events.every((e) => e.phase === 'teach' && !e.counts)).toBe(true);
  });
});

describe('rules.quiz_silence', () => {
  test('silence -> nohear and listen again; then a right answer counts', () => {
    const engine = start();
    toQuiz(engine);
    expect(lines(reply(engine, 'silent'))).toEqual(['nohear', 'listen:quiz:aa']);
    expect(lines(reply(engine, 'correct')).slice(0, 2)).toEqual(['praise_first', `${T}.aa.correct`]);
    expect(lastPosition(engine).retry).toEqual([]);
    expect(eventsOf(engine).at(-1)).toMatchObject({ phase: 'quiz', heard_kind: 'correct', counts: true, attempt: 1 });
  });

  test('a second silence counts as a wrong attempt, but goes straight to the hint', () => {
    const engine = start();
    toQuiz(engine);
    reply(engine, 'silent');
    expect(lines(reply(engine, 'silent'))).toEqual([`${T}.aa.hint`, 'listen:quiz:aa']);
    // after the hint the silence count starts again
    expect(lines(reply(engine, 'silent'))).toEqual(['nohear', 'listen:quiz:aa']);
    expect(lines(reply(engine, 'silent'))).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
  });

  test('an unsure silence is reported as unsure, never as wrong (D-STT-unsure-not-wrong)', () => {
    const engine = start();
    toQuiz(engine);
    const { event } = answer(engine, { kind: 'silent', by: 'shekru', unsure: true });
    expect(event).toMatchObject({ heard_kind: 'silent', unsure: true });
    expect(lines(turn(engine))).toEqual(['nohear', 'listen:quiz:aa']);
  });
});

describe('rules.quiz_attempts', () => {
  test('right answer -> first-try praise, then the item correct line; a counted first-try event carrying what was heard', () => {
    const engine = start();
    toQuiz(engine);
    const { event } = answer(engine, { kind: 'correct', by: 'tap', text: 'आ', lang: 'mr' });
    const steps = turn(engine);
    expect(lines(steps)).toEqual(['praise_first', `${T}.aa.correct`, 'ask', 'listen:quiz:u']);
    expect(says(steps).slice(0, 2).map((s) => s.state)).toEqual(['correct', 'correct']);
    expect(event).toMatchObject({
      item_key: 'mr:letter:आ', phase: 'quiz', heard_kind: 'correct', matched_text: 'आ', matched_lang: 'mr',
      decided_by: 'tap', attempt: 1, unsure: false, counts: true,
    });
  });

  test('1st wrong -> tryagain_* (was wrong_*) then the item hint, and listens again', () => {
    const engine = start();
    toQuiz(engine);
    const steps = reply(engine, 'wrong');
    expect(lines(steps)).toEqual(['tryagain', `${T}.aa.hint`, 'listen:quiz:aa']);
    expect(says(steps).map((s) => s.state)).toEqual(['tryagain', 'hint']);
    expect(says(steps)[1].showAnchor).toBe(true); // the picture is the hint
    // right after the hint: correct on the 2nd attempt, not sent to the retry round
    expect(lines(reply(engine, 'correct')).slice(0, 2)).toEqual(['praise_hint', `${T}.aa.correct`]);
    expect(lastPosition(engine).retry).toEqual([]);
    expect(eventsOf(engine).slice(-2).map((e) => [e.heard_kind, e.attempt, e.counts])).toEqual([['wrong', 1, true], ['correct', 2, true]]);
  });

  test('2nd wrong -> teach line as the reveal, child repeats (not counted), item goes to the retry round', () => {
    const engine = start();
    toQuiz(engine);
    reply(engine, 'wrong');
    const reveal = reply(engine, 'wrong');
    expect(lines(reveal)).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
    expect(says(reveal)[0]).toMatchObject({ state: 'talking', showAnchor: true });
    const after = reply(engine, 'correct'); // the child repeats the revealed letter
    expect(lines(after)).toEqual(['praise_first', 'ask', 'listen:quiz:u']);
    expect(lastPosition(engine).retry).toEqual(['aa']);
    expect(eventsOf(engine).slice(-3).map((e) => [e.heard_kind, e.counts])).toEqual([['wrong', true], ['wrong', true], ['correct', false]]);
  });

  test('silence on the repeat -> nohear and listens once more, then moves on', () => {
    const engine = start();
    toQuiz(engine);
    reply(engine, 'wrong');
    reply(engine, 'wrong');
    expect(lines(reply(engine, 'silent'))).toEqual(['nohear', 'listen:teach:aa']);
    expect(lines(reply(engine, 'silent'))).toEqual(['ask', 'listen:quiz:u']);
  });
});

describe('rules.retry_round', () => {
  // misses आ and इ in the quiz
  const missTwo = (retry: (id: string, n: number) => Kind) =>
    (id: string, kind: string, n: number): Kind => {
      if (kind === 'teach') return 'correct';
      if (id !== 'aa' && id !== 'i') return 'correct';
      return n <= 2 ? 'wrong' : retry(id, n - 2);
    };

  test('missed items are asked again after retry_intro, in the order missed, praised; retry answers are retry-phase events', () => {
    const engine = start();
    const all = lines(finish(engine, missTwo(() => 'correct')));
    const at = all.indexOf('retry_intro');
    expect(all.slice(at)).toEqual([
      'retry_intro', 'ask', 'listen:quiz:aa', 'praise_first', `${T}.aa.correct`,
      'ask', 'listen:quiz:i', 'praise_first', `${T}.i.correct`, 'end_misses', `${T}.outro`, 'done',
    ]);
    expect(all.filter((l) => l === 'retry_intro')).toHaveLength(1);
    const retry = eventsOf(engine).filter((e) => e.phase === 'retry');
    expect(retry.map((e) => [e.item_key, e.heard_kind, e.counts])).toEqual([
      ['mr:letter:आ', 'correct', true], ['mr:letter:इ', 'correct', true],
    ]);
  });

  test('still wrong in the retry round -> not asked a third time', () => {
    const engine = start();
    const all = lines(finish(engine, missTwo((id) => (id === 'aa' ? 'wrong' : 'correct'))));
    const at = all.indexOf('retry_intro');
    expect(all.slice(at)).toEqual([
      'retry_intro', 'ask', 'listen:quiz:aa', 'tryagain', `${T}.aa.hint`, 'listen:quiz:aa',
      `${T}.aa.teach`, 'listen:teach:aa', 'praise_first',
      // the previous scored item (आ, retry round) ended in a miss
      'ask', 'listen:quiz:i', 'praise_comeback', `${T}.i.correct`, 'end_misses', `${T}.outro`, 'done',
    ]);
    expect(lastPosition(engine).retry).toEqual(['aa', 'i']);
  });
});

describe('resume from a saved position', () => {
  const script = (_id: string, kind: string, n: number): Kind => (kind === 'quiz' && n <= 2 ? 'wrong' : 'correct');

  test('no saved position starts from the intro', () => {
    expect(lines(turn(start(null)))[0]).toBe(`${T}.intro`);
  });

  test('resuming after any answer reaches the same listens and the same events as an uninterrupted run', () => {
    const listensOf = (all: string[]) => all.filter((l) => l.startsWith('listen'));
    const uninterrupted = start();
    const whole = listensOf(lines(finish(uninterrupted, script)));
    const allEvents = eventsOf(uninterrupted);
    expect(whole.length).toBeGreaterThan(20);
    for (let stopAfter = 1; stopAfter <= whole.length; stopAfter++) {
      const seen: Record<string, number> = {};
      const counted = (id: string, kind: string) => {
        const key = `${kind}:${id}`;
        seen[key] = (seen[key] ?? 0) + 1;
        return script(id, kind, seen[key]);
      };
      const first = start();
      let steps = turn(first);
      let saved!: Position;
      for (let i = 0; i < stopAfter; i++) {
        const l = steps.at(-1) as Listen;
        saved = answer(first, counted(l.item.id, l.kind)).position;
        if (i < stopAfter - 1) steps = turn(first);
      }
      // what storage does: JSON round trip, new engine
      const resumed = start(JSON.parse(JSON.stringify(saved)));
      const rest = lines(finish(resumed, counted));
      expect(listensOf(rest)).toEqual(whole.slice(stopAfter));
      expect(rest.at(-1)).toBe('done');
      expect(eventsOf(resumed)).toEqual(allEvents.slice(stopAfter));
      if (stopAfter < whole.length) {
        expect(lastPosition(resumed).retry).toEqual(lastPosition(uninterrupted).retry);
      }
    }
  });

  test('resume mid teach restarts at the next untaught item, without the intro', () => {
    const first = start();
    turn(first);
    answer(first, 'correct');
    turn(first);
    const { position } = answer(first, 'correct');
    expect(lines(turn(start(position)))).toEqual([`${T}.i.teach`, 'listen:teach:i']);
  });

  test('resume at the start of the quiz replays quiz_intro', () => {
    const first = start();
    turn(first);
    let saved!: Position;
    for (let i = 0; i < 6; i++) { saved = answer(first, 'correct').position; if (i < 5) turn(first); }
    expect(lines(turn(start(saved)))).toEqual([`${T}.quiz_intro`, 'ask', 'listen:quiz:aa']);
  });

  test('resume after a 1st wrong reopens with the hint; a 2nd wrong still reveals', () => {
    const first = start();
    toQuiz(first);
    const resumed = start(answer(first, 'wrong').position);
    expect(lines(turn(resumed))).toEqual([`${T}.aa.hint`, 'listen:quiz:aa']);
    expect(lines(reply(resumed, 'wrong'))).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
  });

  test('resume after the reveal replays the reveal; the item is still in the retry round', () => {
    const first = start();
    toQuiz(first);
    answer(first, 'wrong');
    turn(first);
    const resumed = start(answer(first, 'wrong').position);
    expect(lines(turn(resumed))).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
    expect(lines(reply(resumed, 'correct')).slice(1)).toEqual(['ask', 'listen:quiz:u']);
    expect(lastPosition(resumed).retry).toEqual(['aa']);
  });

  test('resume inside the retry round keeps the missed list and does not replay retry_intro', () => {
    const first = start();
    const pick = (id: string, kind: string): Kind => (kind === 'quiz' && (id === 'aa' || id === 'i') ? 'wrong' : 'correct');
    let steps = turn(first);
    let saved!: Position;
    for (;;) {
      const l = steps.at(-1) as Listen;
      const inRetry = lines(steps).includes('retry_intro');
      saved = answer(first, inRetry ? 'correct' : pick(l.item.id, l.kind)).position;
      if (inRetry) break;
      steps = turn(first);
    }
    expect(saved.retry).toEqual(['aa', 'i']);
    // still end_misses after the resume: आ and इ were missed before it
    expect(lines(finish(start(saved), () => 'correct'))).toEqual(['ask', 'listen:quiz:i', 'praise_first', `${T}.i.correct`, 'end_misses', `${T}.outro`, 'done']);
  });

  test('resume keeps the line history: the resumed engine picks the same next ask_* as an uninterrupted one', () => {
    const first = start();
    toQuiz(first);
    const { position } = answer(first, 'correct');
    const next = rawLines(turn(first)).find((l) => /^ask_\d+$/.test(l));
    expect(rawLines(turn(start(JSON.parse(JSON.stringify(position)))))[0]).toBe(next);
  });

  test('a finished lesson stays finished; a position from another lesson version is dropped', () => {
    const first = start();
    finish(first, () => 'correct');
    const saved = lastPosition(first);
    expect(start(saved).next()).toEqual({ type: 'done' });
    expect(lines(turn(start({ ...saved, version: 0 })))[0]).toBe(`${T}.intro`);
  });
});

describe('engine misuse', () => {
  test('next() while listening and answer() while not listening throw', () => {
    const engine = start();
    expect(() => engine.answer(heard('correct'))).toThrow();
    turn(engine);
    expect(() => engine.next()).toThrow();
  });
});

// ---- word items (fixture: two English-target items, one Marathi-target, one ambiguous_lang) ----

const words = wordLessonJson as unknown as Lesson;
const W = words.template_id;
const wordPrompts: Prompts = {
  lines: {
    ...prompts.lines,
    meaning_hi_ack_1: 'हो, अर्थ बरोबर! इंग्लिशमध्ये?',
    meaning_hi_ack_2: 'बरोबर अर्थ! आता इंग्लिशमध्ये सांग?',
    ask_mr_1: 'मराठीत काय म्हणतात?',
    ask_mr_2: 'आता मराठीत सांग?',
  },
};
type WordOpts = { styleLevel?: 'mr_led' | 'en_led'; wordItemsGated?: boolean; position?: Position | null };
function startWords(opts: WordOpts = {}) {
  return createLesson(words, wordPrompts, { styleLevel: 'mr_led', wordItemsGated: false, rng: NONE, ...opts });
}
// The right meaning in the other language: Marathi for English-target items, Hindi for Marathi-target ones.
const meaningOf = (item: Item): Heard =>
  item.target_lang === 'en' ? meaning(item.assessment.accepted_variants[0], 'mr') : meaning(item.assessment.accepted_variants[0], 'hi');
// Quiz order: Apple, Tree, Cat, Water. Returns the turn that asks Tree.
function toTree(engine: LessonEngine) {
  toQuiz(engine, 4);
  return reply(engine, 'correct');
}

describe('word items: style and quiz turn', () => {
  test.each([['mr_led'], ['en_led']] as const)('%s: the teach turn plays the style teach line; events carry the style', (style) => {
    const engine = startWords({ styleLevel: style });
    expect(lines(turn(engine))).toEqual([`${W}.intro`, `${W}.apple.teach_${style}`, 'listen:teach:apple']);
    const { event } = answer(engine, 'correct');
    expect(event).toMatchObject({
      template_id: W, item_key: 'en:word:apple', item_kind: 'word', target_lang: 'en',
      phase: 'teach', style_level: style, counts: false,
    });
  });

  test("a quiz turn plays the item's ask line, never a shared ask_*; right answer -> its correct line, counted", () => {
    const engine = startWords();
    const opening = toQuiz(engine, 4);
    expect(lines(opening).slice(1)).toEqual([`${W}.quiz_intro`, `${W}.apple.ask`, 'listen:quiz:apple']);
    const { event } = answer(engine, { kind: 'correct', by: 'shekru', text: 'ॲपल', lang: 'en' });
    const next = turn(engine);
    expect(lines(next)).toContain(`${W}.apple.correct`);
    expect(lines(next).slice(-2)).toEqual([`${W}.tree.ask`, 'listen:quiz:tree']);
    expect(event).toMatchObject({ phase: 'quiz', heard_kind: 'correct', matched_text: 'ॲपल', matched_lang: 'en', attempt: 1, counts: true });
    const all = lines(finish(engine, () => 'correct', next));
    expect(all.filter((l) => l === 'ask')).toEqual([]);
  });

  test.each([['mr_led'], ['en_led']] as const)('%s: 1st miss -> the Marathi bridge hint; 2nd miss -> reveal with the style teach line, repeat', (style) => {
    const engine = startWords({ styleLevel: style });
    toQuiz(engine, 4);
    expect(lines(reply(engine, 'wrong')).slice(-2)).toEqual([`${W}.apple.hint`, 'listen:quiz:apple']);
    expect(lines(reply(engine, 'wrong'))).toEqual([`${W}.apple.teach_${style}`, 'listen:teach:apple']);
    expect(lines(reply(engine, 'correct')).slice(-2)).toEqual([`${W}.tree.ask`, 'listen:quiz:tree']);
    expect(lastPosition(engine).retry).toEqual(['apple']);
    expect(eventsOf(engine).slice(-3).map((e) => [e.heard_kind, e.attempt, e.counts])).toEqual([
      ['wrong', 1, true], ['wrong', 2, true], ['correct', expect.any(Number), false],
    ]);
  });

  test('silence keeps the letter rule: one nohear, then a missed try that goes straight to the hint', () => {
    const engine = startWords();
    toQuiz(engine, 4);
    expect(lines(reply(engine, 'silent'))).toEqual(['nohear', 'listen:quiz:apple']);
    expect(lines(reply(engine, 'silent'))).toEqual([`${W}.apple.hint`, 'listen:quiz:apple']);
  });
});

describe('English-target item: a right meaning is the bridge step', () => {
  test('Marathi meaning -> ack_meaning, ask again; not an attempt, not counted', () => {
    const engine = startWords();
    toQuiz(engine, 4);
    const { event } = answer(engine, meaning('सफरचंद', 'mr'));
    expect(lines(turn(engine))).toEqual([`${W}.apple.ack_meaning`, 'listen:quiz:apple']);
    expect(event).toMatchObject({ phase: 'quiz', heard_kind: 'meaning', matched_text: 'सफरचंद', matched_lang: 'mr', counts: false });
    // attempts unchanged: the English word now is still a first try
    const next = answer(engine, 'correct');
    expect(next.event).toMatchObject({ heard_kind: 'correct', attempt: 1, counts: true });
    expect(next.position.retry).toEqual([]);
  });

  test('Marathi meaning, then a wrong answer -> still the first miss (hint), then the reveal', () => {
    const engine = startWords();
    toQuiz(engine, 4);
    reply(engine, meaning('सफरचंद', 'mr'));
    expect(lines(reply(engine, 'wrong')).slice(-2)).toEqual([`${W}.apple.hint`, 'listen:quiz:apple']);
    expect(lines(reply(engine, 'wrong'))).toEqual([`${W}.apple.teach_mr_led`, 'listen:teach:apple']);
  });

  test('Hindi meaning -> shared meaning_hi_ack_*, the Hindi word is never said; not counted', () => {
    const engine = startWords();
    toQuiz(engine, 4);
    const { event } = answer(engine, meaning('सेब', 'hi'));
    const steps = turn(engine);
    expect(lines(steps)).toEqual(['meaning_hi_ack', 'listen:quiz:apple']);
    expect(says(steps).some((s) => s.text.includes('सेब'))).toBe(false);
    expect(event).toMatchObject({ phase: 'quiz', heard_kind: 'meaning', matched_lang: 'hi', counts: false });
  });

  test('a second meaning on the same item goes on as a missed try: hint, no "wrong" line', () => {
    const engine = startWords();
    toQuiz(engine, 4);
    reply(engine, meaning('सफरचंद', 'mr'));
    expect(lines(reply(engine, meaning('सफरचंद', 'mr')))).toEqual([`${W}.apple.hint`, 'listen:quiz:apple']);
  });

  test('answering every quiz turn with the meaning still ends the lesson', () => {
    const engine = startWords();
    const all = finish(engine, (_id, kind, _n, item) => (kind === 'teach' ? 'correct' : meaningOf(item)));
    expect(all.at(-1)).toEqual({ type: 'done' });
    expect(lines(all)).toEqual(expect.arrayContaining([`${W}.apple.ack_meaning`, `${W}.cat.ack_meaning`]));
  });
});

describe('Marathi-target item: Hindi right meaning', () => {
  test('praised as correct and counted, then an unscored Marathi follow-up; correct -> short praise, next item', () => {
    const engine = startWords();
    toTree(engine);
    const { event } = answer(engine, meaning('पेड़', 'hi'));
    const steps = turn(engine);
    expect(lines(steps)).toContain(`${W}.tree.correct`);
    expect(lines(steps).at(-2)).toBe('ask_mr');
    expect((steps.at(-1) as Listen).item.id).toBe('tree');
    expect((steps.at(-1) as Listen).prompt).toBe(says(steps).at(-1)!.text);
    expect(event).toMatchObject({ item_key: 'mr:word:झाड', phase: 'quiz', heard_kind: 'meaning', matched_lang: 'hi', attempt: 1, counts: true });

    const follow = answer(engine, 'correct');
    const next = turn(engine);
    expect(follow.event).toMatchObject({ item_key: 'mr:word:झाड', phase: 'followup', heard_kind: 'correct', counts: false });
    expect(says(next)[0].state).toBe('correct');
    expect(lines(next)).not.toContain(`${W}.tree.model_mr`);
    expect(lines(next).slice(-2)).toEqual([`${W}.cat.ask`, 'listen:quiz:cat']);
    expect(follow.position.retry).toEqual([]);
  });

  test('follow-up not answered in Marathi -> model_mr and one listen for the repeat, then the next item', () => {
    const engine = startWords();
    toTree(engine);
    reply(engine, meaning('पेड़', 'hi'));
    const { event } = answer(engine, 'wrong');
    const model = turn(engine);
    expect(lines(model)[0]).toBe(`${W}.tree.model_mr`);
    expect((model.at(-1) as Listen).item.id).toBe('tree');
    expect(event).toMatchObject({ phase: 'followup', heard_kind: 'wrong', counts: false });
    const repeat = answer(engine, 'wrong');
    const next = turn(engine);
    expect(repeat.event.counts).toBe(false);
    expect(lines(next).slice(-2)).toEqual([`${W}.cat.ask`, 'listen:quiz:cat']);
    expect(lines(next)).not.toContain('tryagain');
  });

  test('ambiguous_lang item: praised as correct, model_mr only, no follow-up listen', () => {
    const engine = startWords();
    toTree(engine);
    reply(engine, 'correct'); // Tree
    reply(engine, 'correct'); // Cat, now asking Water
    const { event } = answer(engine, meaning('पानी', 'hi'));
    const steps = turn(engine);
    expect(lines(steps)).toEqual(expect.arrayContaining([`${W}.water.correct`, `${W}.water.model_mr`]));
    expect(lines(steps)).not.toContain('ask_mr');
    expect(steps.some((s) => s.type === 'listen' && s.item.id === 'water')).toBe(false);
    expect(steps.at(-1)).toEqual({ type: 'done' });
    expect(event).toMatchObject({ item_key: 'mr:word:पाणी', heard_kind: 'meaning', counts: true });
  });

  test('resume during the follow-up replays its question', () => {
    const first = startWords();
    toTree(first);
    const { position } = answer(first, meaning('पेड़', 'hi'));
    const resumed = startWords({ position: JSON.parse(JSON.stringify(position)) });
    const steps = turn(resumed);
    expect(lines(steps)[0]).toBe('ask_mr');
    expect((steps.at(-1) as Listen).item.id).toBe('tree');
    expect(answer(resumed, 'correct').event).toMatchObject({ phase: 'followup', counts: false });
    expect(lines(turn(resumed)).slice(-2)).toEqual([`${W}.cat.ask`, 'listen:quiz:cat']);
  });
});

describe('wordItemsGated (D-GURU-12-word-items-practice-only)', () => {
  test('a word item missed twice is not sent to the retry round and its wrong answers do not count', () => {
    const engine = startWords({ wordItemsGated: true });
    toQuiz(engine, 4);
    reply(engine, 'wrong');
    reply(engine, 'wrong');
    reply(engine, 'correct'); // the repeat; now asking Tree
    const { event, position } = answer(engine, 'correct');
    expect(position.retry).toEqual([]);
    const apple = eventsOf(engine).filter((e) => e.item_key === 'en:word:apple' && e.phase === 'quiz');
    expect(apple.length).toBeGreaterThanOrEqual(2);
    expect(apple.every((e) => !e.counts)).toBe(true);
    expect(event).toMatchObject({ item_key: 'mr:word:झाड', heard_kind: 'correct', counts: true });
    const all = lines(finish(engine, () => 'correct'));
    expect(all).not.toContain('retry_intro');
  });

  test('letter items are not gated', () => {
    const engine = createLesson(lesson, prompts, { wordItemsGated: true, rng: NONE });
    toQuiz(engine);
    reply(engine, 'wrong');
    reply(engine, 'wrong');
    expect(lastPosition(engine).retry).toEqual(['aa']);
    expect(eventsOf(engine).slice(-2).every((e) => e.counts)).toBe(true);
  });
});

// ---- GURU-19: tutor variety (PRD Tutor variety 1-5, TDD 2.4, D-GURU-19-tutor-variety) ----

// Deterministic rng in [0, 1).
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const swar2 = withReacts(lessonsJson[1] as unknown as Lesson); // स्वर २: ए ऐ ओ औ अं
const quizOrder = (l: Lesson) => (l.flow.find((e) => 'phase' in e && e.phase === 'quiz') as { order: string[] }).order;
const idOf = (l: Lesson) => (display: string) => l.items.find((i) => i.display === display)!.id;
const quizListens = (steps: Step[]) => steps.filter((s): s is Listen => s.type === 'listen' && s.kind === 'quiz').map((s) => s.item.id);
const withoutSurprises = (l: string[]) => l.filter((x) => !x.startsWith('surprise:'));
// Shared line ids in play order, including a surprise's line.
const sharedPicks = (steps: Step[]) =>
  steps.flatMap((s) => (s.type === 'say' && !String(s.line).includes('.') ? [s.line] : isSurprise(s) && s.line ? [s.line] : []));
// Mixed answers from their own rng, so the engine's rng is untouched.
const mixed = (choose: () => number) => (_id: string, kind: string, _n: number, item: Item): Heard | Kind => {
  const r = choose();
  if (kind === 'teach') return r < 0.7 ? 'correct' : r < 0.85 ? 'wrong' : 'silent';
  if (item.kind === 'word' && r < 0.2) return meaningOf(item);
  return r < 0.5 ? 'correct' : r < 0.8 ? 'wrong' : 'silent';
};

describe('GURU-19 shared line pools', () => {
  // स्वर १ plus four items of स्वर २, taught and quizzed in that order.
  const extra = swar2.items.slice(0, 4);
  const ten: Lesson = {
    ...lesson,
    items: [...lesson.items, ...extra],
    flow: lesson.flow.map((e) => ('order' in e ? { ...e, order: [...e.order, ...extra.map((i) => i.display)] } : e)),
  };

  test('every shared line is from its pool; none repeats within the last 5 picks of its family over a 10-item run; Position.last keeps those 5, oldest first', () => {
    expect(ten.items).toHaveLength(10);
    for (let seed = 1; seed <= 20; seed++) {
      const engine = createLesson(ten, prompts, { rng: seeded(seed) });
      const all = finish(engine, mixed(seeded(1000 + seed)));
      expect(all.at(-1)).toEqual({ type: 'done' });
      const byFamily: Record<string, string[]> = {};
      for (const id of sharedPicks(all)) {
        expect([id, prompts.lines[id] !== undefined]).toEqual([id, true]);
        const picks = (byFamily[fam(id)] ??= []);
        expect([seed, id, picks.slice(-5).includes(id)]).toEqual([seed, id, false]);
        picks.push(id);
      }
      expect(byFamily.ask.length).toBeGreaterThanOrEqual(10);
      const last = lastPosition(engine).last as unknown as Record<string, string[]>;
      for (const [f, picks] of Object.entries(byFamily)) expect([f, last[f]]).toEqual([f, picks.slice(-5)]);
      for (const [f, h] of Object.entries(last)) expect([f, h.length <= 5 && h.every((id) => fam(id) === f)]).toEqual([f, true]);
    }
  });
});

describe('GURU-19 praise by moment and the closing line', () => {
  // The line right before each item `correct` line, in play order.
  const praiseBeforeCorrect = (l: string[]) => l.flatMap((x, i) => (x.endsWith('.correct') ? [l[i - 1]] : []));
  // Quiz answers per item and attempt; teach turns and reveal repeats are answered right.
  const script = (quiz: Record<string, (Heard | Kind)[]>) => (id: string, kind: string, n: number): Heard | Kind =>
    (kind === 'teach' ? 'correct' : quiz[id]?.[n - 1] ?? 'correct');
  const cases: [string, () => Lesson, Record<string, (Heard | Kind)[]>, string[], string | null][] = [
    ['all right on a 5-item lesson: the teach answers do not start the streak', () => swar2, {},
      ['praise_first', 'praise_first', 'praise_streak', 'praise_first', 'praise_first'], 'end_all'],
    ['a wrong answer breaks the streak, a first silence does not', () => lesson, { i: ['wrong', 'correct'], a: ['silent', 'correct'] },
      ['praise_first', 'praise_first', 'praise_hint', 'praise_first', 'praise_streak', 'praise_first'], null],
    ['comeback after a missed item; the retry answer is praised too; a miss ends with end_misses', () => lesson,
      { aa: ['wrong', 'wrong'], i: ['wrong', 'correct'] },
      ['praise_comeback', 'praise_hint', 'praise_first', 'praise_streak', 'praise_first', 'praise_first'], 'end_misses'],
    ['a Hindi meaning on a Marathi-target item is praised; its follow-up turn does not count toward the streak', () => words,
      { tree: [meaning('पेड़', 'hi'), 'correct'] },
      ['praise_first', 'praise_first', 'praise_streak', 'praise_first'], 'end_all'],
  ];

  test.each(cases)('%s', (_name, of, quiz, praise, end) => {
    const l = of();
    const all = withoutSurprises(lines(finish(createLesson(l, prompts, { rng: NONE }), script(quiz))));
    expect(praiseBeforeCorrect(all)).toEqual(praise);
    if (end) {
      expect(all.filter((x) => x.startsWith('end_'))).toEqual([end]);
      expect(all.slice(-3)).toEqual([end, `${l.template_id}.outro`, 'done']);
    }
  });
});

describe('GURU-19 picture reactions', () => {
  // अ right; आ right but has no react lines; इ wrong then right; ई wrong twice (moveon);
  // उ silent then right; ऊ silent twice. Every quiz answer wrong, so each item is revealed twice
  // (quiz and retry round) and its repeat is a right teach-turn answer.
  const noReactAa: Lesson = {
    ...lesson,
    items: lesson.items.map((i) => {
      if (i.id !== 'aa') return i;
      const { react_1: _r1, react_2: _r2, ...rest } = i.lines as Record<string, string>;
      return { ...i, lines: rest } as unknown as Item;
    }),
  };
  const teachScript: Record<string, Kind[]> = {
    a: ['correct'], aa: ['correct'], i: ['wrong', 'correct'], ii: ['wrong', 'wrong'], u: ['silent', 'correct'], uu: ['silent', 'silent'],
  };
  const pick = (id: string, kind: string, n: number): Kind => (kind === 'teach' ? teachScript[id][n - 1] ?? 'correct' : 'wrong');
  const reactsOf = (all: string[], id: string) => all.filter((x) => x.startsWith(`${T}.${id}.react_`));

  test('rng below 0.5: praise then one of the item react lines after a right teach answer, at most once per item per run; none after a wrong or silent answer or without react lines; rng 0.5: none', () => {
    const steps = finish(createLesson(noReactAa, prompts, { rng: () => 0.49 }), pick);
    const all = withoutSurprises(lines(steps));
    const quizIntro = all.indexOf(`${T}.quiz_intro`);
    for (const [id, nextTeach] of [['a', 'aa'], ['i', 'ii'], ['u', 'uu']]) {
      const at = all.indexOf(reactsOf(all, id)[0]);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(quizIntro);
      expect(all.slice(at - 1, at + 2)).toEqual(['praise_first', expect.stringMatching(new RegExp(`^${T}\\.${id}\\.react_[12]$`)), `${T}.${nextTeach}.teach`]);
      const say = says(steps).find((s) => s.line === all[at])!;
      const item = lesson.items.find((i) => i.id === id)!;
      expect(say).toMatchObject({ item: expect.objectContaining({ id }), showAnchor: true });
      expect(say.text).toBe((item.lines as Record<string, string>)[all[at].split('.').at(-1)!]);
    }
    for (const id of TEACH) expect([id, reactsOf(all, id).length <= 1]).toEqual([id, true]);
    expect(reactsOf(all, 'aa')).toEqual([]);
    expect(all.slice(0, quizIntro).filter((x) => /\.(ii|uu)\.react_/.test(x))).toEqual([]);
    expect(all[all.indexOf('moveon') + 1]).toBe(`${T}.u.teach`);

    const none = lines(finish(createLesson(noReactAa, prompts, { rng: () => 0.5 }), pick));
    expect(none.filter((x) => /\.react_\d$/.test(x))).toEqual([]);
  });
});

describe('GURU-19 surprises', () => {
  const SURPRISES = ['sneeze', 'dropnut', 'dance', 'celebrate'];

  test('rng below 0.5 at the start: exactly one surprise; 0.5 or above: none', () => {
    for (const [c, n] of [[0, 1], [0.49, 1], [0.5, 0], [0.99, 0]]) {
      for (const l of [lesson, words]) {
        const all = finish(createLesson(l, prompts, { rng: () => c }), () => 'correct');
        expect([c, l.template_id, all.filter(isSurprise).length]).toEqual([c, l.template_id, n]);
      }
    }
  });

  test('seeded runs: at most one per lesson and not in every lesson; a TUTOR_STATES surprise state, celebrate silent, any line from surprise_line; only between two items, never inside a listening turn', () => {
    const states = new Set<string>();
    let lessonsWithOne = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const l = seed % 2 ? lesson : words;
      const engine = createLesson(l, prompts, { rng: seeded(seed) });
      const choose = mixed(seeded(5000 + seed));
      // every step, with the position saved by the answer before it
      const all: Step[] = [];
      const savedAt: (Position | null)[] = [];
      const seen: Record<string, number> = {};
      let saved: Position | null = null;
      for (;;) {
        const steps = turn(engine);
        for (const s of steps) { all.push(s); savedAt.push(saved); }
        const l2 = steps.at(-1)!;
        if (l2.type !== 'listen') break;
        const key = `${l2.kind}:${l2.item.id}`;
        seen[key] = (seen[key] ?? 0) + 1;
        saved = answer(engine, choose(l2.item.id, l2.kind, seen[key], l2.item)).position;
      }
      const at = all.flatMap((s, k) => (isSurprise(s) ? [k] : []));
      expect([seed, at.length <= 1]).toEqual([seed, true]);
      if (!at.length) continue;
      lessonsWithOne++;
      const k = at[0];
      const s = all[k] as unknown as Surprise;
      states.add(s.state);
      expect(SURPRISES).toContain(s.state);
      expect(TUTOR_STATES).toContain(s.state);
      if (s.state === 'celebrate') expect(s.line).toBeUndefined();
      else if (s.line !== undefined) expect([fam(s.line), prompts.lines[s.line] !== undefined]).toEqual(['surprise_line', true]);
      expect(all.slice(0, k).some((x) => x.type === 'listen')).toBe(true);
      expect(all.slice(k + 1).some((x) => x.type === 'listen')).toBe(true);
      expect(all[k + 1].type).not.toBe('listen');
      const p = savedAt[k]!;
      expect([seed, { attempts: p.attempts, silences: p.silences, reveal: p.reveal, bridged: !!p.bridged, followup: p.followup ?? null }])
        .toEqual([seed, { attempts: 0, silences: 0, reveal: false, bridged: false, followup: null }]);
    }
    expect(lessonsWithOne).toBeGreaterThan(0);
    expect(lessonsWithOne).toBeLessThan(200);
    expect([...states].sort()).toEqual([...SURPRISES].sort());
  });
});

describe('GURU-19 quiz order', () => {
  const order = quizOrder(lesson);

  test('the first quiz pass follows shuffleQuiz over the displays with the injected rng; a resumed lesson keeps the saved order', () => {
    for (const c of [0, 0.3, 0.49]) {
      const expected = shuffleQuiz(order, () => c).map(idOf(lesson));
      expect([c, quizListens(finish(start(null, () => c), () => 'correct'))]).toEqual([c, expected]);
    }
    const shuffled = shuffleQuiz(order, ALWAYS).map(idOf(lesson));
    expect(shuffled).not.toEqual(QUIZ); // the order really changes

    // two quiz answers, then resume with an rng under which a fresh shuffle keeps the file order
    const first = start(null, ALWAYS);
    toQuiz(first);
    answer(first, 'correct');
    turn(first);
    const { position } = answer(first, 'correct');
    const rest = quizListens(finish(start(JSON.parse(JSON.stringify(position)), NONE), () => 'correct'));
    expect(shuffled.slice(2)).not.toEqual(QUIZ.slice(2));
    expect(rest).toEqual(shuffled.slice(2));
  });
});

describe('GURU-19 revision items', () => {
  const R = swar2.template_id;
  const revision = ['o', 'am'].map((id) => ({ template_id: R, item: swar2.items.find((i) => i.id === id)! }));

  test('interleaved into the quiz with interleaveRevision, not taught, using their own template line ids; their events have phase revision', () => {
    for (const c of [0, 0.3]) {
      const rng = () => c;
      const engine = createLesson(lesson, prompts, { rng, revision });
      const steps = finish(engine, (id, kind, n) => (kind === 'quiz' && id === 'o' && n === 1 ? 'wrong' : 'correct'));
      const all = withoutSurprises(lines(steps));
      const expected = interleaveRevision(shuffleQuiz(quizOrder(lesson), rng).map(idOf(lesson)), ['o', 'am'], rng);
      expect(expected.indexOf('o')).toBeGreaterThan(0); // between new items
      expect([c, quizListens(steps)]).toEqual([c, expected]);
      expect(steps.filter((s): s is Listen => s.type === 'listen' && s.kind === 'teach').map((s) => s.item.id)).toEqual(TEACH);

      const hint = all.indexOf(`${R}.o.hint`);
      expect(all.slice(hint - 1, hint + 4)).toEqual(['tryagain', `${R}.o.hint`, 'listen:quiz:o', 'praise_hint', `${R}.o.correct`]);
      const am = all.indexOf(`${R}.am.correct`);
      expect(all[am - 1]).toMatch(/^praise_/);
      expect(all.filter((x) => x.startsWith(`${T}.o.`) || x.startsWith(`${T}.am.`))).toEqual([]);

      const events = eventsOf(engine);
      expect(events.filter((e) => e.phase === 'revision').map((e) => [e.item_key, e.heard_kind, e.attempt, e.counts])).toEqual([
        ['mr:letter:ओ', 'wrong', 1, true], ['mr:letter:ओ', 'correct', 2, true], ['mr:letter:अं', 'correct', 1, true],
      ]);
      expect(events.filter((e) => e.phase === 'quiz').map((e) => e.item_key).sort()).toEqual(lesson.items.map((i) => i.item_key).sort());
    }
  });
});

// Contract for GURU-18 (Listen.prompt, Heard in) and GURU-19 (engine v2: Heard, events, Position). Shape only.
describe('contract: engine v2 for GURU-18 and GURU-19', () => {
  test('createLesson(lesson, prompts, {position, styleLevel, wordItemsGated, rng}); answer(heard) -> {position, event}; Listen.prompt; no mastery', () => {
    const engine = createLesson(words, wordPrompts, { position: null, styleLevel: 'en_led', wordItemsGated: true, rng: () => 0 });
    const listen = turn(engine).at(-1) as Listen;
    expect(listen).toEqual(expect.objectContaining({
      type: 'listen', item: expect.any(Object), kind: expect.any(String), prompt: expect.any(String), showAnchor: expect.any(Boolean),
    }));
    const res = engine.answer({ kind: 'correct', by: 'shekru' }) as unknown as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual(['event', 'position']);
    expect(res.position).toEqual(expect.objectContaining({
      version: expect.any(Number), flow: expect.any(Number), index: expect.any(Number), retry: expect.any(Array), last: expect.any(Object),
    }));
    expect(res.position).not.toHaveProperty('mastery');
    expect(res.event).toEqual(expect.objectContaining({
      template_id: expect.any(String),
      item_key: expect.any(String),
      item_kind: expect.any(String),
      target_lang: expect.any(String),
      phase: expect.any(String),
      heard_kind: expect.any(String),
      decided_by: expect.any(String),
      attempt: expect.any(Number),
      unsure: expect.any(Boolean),
      style_level: expect.any(String),
      counts: expect.any(Boolean),
    }));
  });
});

// Contract for GURU-28 (lesson player v2): engine variety. Shape only.
describe('contract: engine variety for GURU-28', () => {
  test("createLesson(..., {revision: {template_id, item}[]}); step {type: 'surprise', state, line?}; Position.last: family -> up to 5 ids", () => {
    const engine = createLesson(lesson, prompts, { rng: ALWAYS, revision: [{ template_id: swar2.template_id, item: swar2.items[0] }] });
    const all = finish(engine, () => 'correct');
    const surprise = all.find(isSurprise) as unknown as Record<string, unknown>;
    expect(surprise).toEqual(expect.objectContaining({ type: 'surprise', state: expect.any(String) }));
    expect(TUTOR_STATES).toContain(surprise.state);
    expect(['undefined', 'string']).toContain(typeof surprise.line);
    expect(eventsOf(engine).some((e) => e.phase === 'revision')).toBe(true);
    const last = lastPosition(engine).last as unknown as Record<string, unknown>;
    expect(Object.keys(last).length).toBeGreaterThan(0);
    for (const h of Object.values(last)) {
      expect(Array.isArray(h)).toBe(true);
      expect((h as unknown[]).length).toBeLessThanOrEqual(5);
      expect((h as unknown[]).every((id) => typeof id === 'string')).toBe(true);
    }
  });
});

describe('evaluator stub', () => {
  const a = lesson.items[0];
  test('expected answer and accepted variants are correct', () => {
    expect(exactEvaluator.evaluate(a, 'अ')).toBe('correct');
    expect(exactEvaluator.evaluate(a, ' अननस. ')).toBe('correct');
    expect(exactEvaluator.evaluate(a, 'अ  अननसाचा!')).toBe('correct');
  });
  test('another letter is wrong, an empty transcript is unclear', () => {
    expect(exactEvaluator.evaluate(a, 'आ')).toBe('wrong');
    expect(exactEvaluator.evaluate(a, '  ')).toBe('unclear');
  });
  test('vowel-length partner counts as correct, other letters stay wrong', () => {
    const i = lesson.items.find((it) => it.id === 'i')!;
    const uu = lesson.items.find((it) => it.id === 'uu')!;
    expect(exactEvaluator.evaluate(i, 'ई')).toBe('correct');
    expect(exactEvaluator.evaluate(uu, 'उ')).toBe('correct');
    expect(exactEvaluator.evaluate(i, 'उ')).toBe('wrong');
    expect(exactEvaluator.evaluate(a, 'आ')).toBe('wrong');
  });
  test('verdict to engine answer', () => {
    expect(toAnswer('unclear', 'quiz')).toBe('silent');
    expect(toAnswer('unclear', 'teach')).toBe('silent');
    expect(toAnswer('wrong', 'teach')).toBe('correct');
    expect(toAnswer('wrong', 'quiz')).toBe('wrong');
    expect(toAnswer('correct', 'quiz')).toBe('correct');
  });
});
