// GURU-10: engine v2. Contract: TDD 2.2 (Heard) and 2.3 (AnswerEvent) in the Epic GURU-1;
// language rules: PRD "Language design" 1-9, D-GURU-10-language-design.
//
// Real shapes this file relies on (read, not assumed):
// - Heard, Lang, DecidedBy and the v2 Item (kind, target_lang, langs, ambiguous_lang, word lines)
//   are in ./types (GURU-2).
// - flow `order` names items by `display`; word-item line ids are `<template>.<item id>.<line>`.
// - prompts.json has no meaning_hi_ack_* or ask_mr_* yet (the shared pools are another issue),
//   so the word tests add two of each to the prompts they pass in.
import lessonsJson from '../content/generated/lessons.json';
import promptsJson from '../content/generated/prompts.json';
import wordLessonJson from './__fixtures__/word-lesson.json';
import { createLesson, isFinished, type LessonEngine } from './engine';
import { exactEvaluator, toAnswer } from './evaluator';
import type { AnswerEvent, Heard, Item, Lang, Lesson, Listen, Position, Prompts, Say, Step } from './types';

const lessonJson = lessonsJson[0]; // स्वर १ (अ to ऊ): the letter cases below are written against it

const lesson = lessonJson as unknown as Lesson;
const prompts = promptsJson as Prompts;
const T = lesson.template_id;
const TEACH = ['a', 'aa', 'i', 'ii', 'u', 'uu'];
const QUIZ = ['aa', 'u', 'i', 'a', 'uu', 'ii'];

type Kind = 'correct' | 'wrong' | 'silent';
type Result = { position: Position; event: AnswerEvent };
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

const start = (position?: Position | null, rng: () => number = () => 0) => createLesson(lesson, prompts, { position, rng });

// Steps up to and including the next listen (or done).
function turn(engine: LessonEngine): Step[] {
  const steps: Step[] = [];
  for (;;) {
    const step = engine.next();
    steps.push(step);
    if (step.type !== 'say') return steps;
  }
}
const lines = (steps: Step[]) => steps.map((s) => (s.type === 'say' ? s.line : s.type === 'listen' ? `listen:${s.kind}:${s.item.id}` : 'done'));
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

  test('quiz_intro then the quiz in the flow order, ask_* rotating', () => {
    const engine = start();
    const opening = toQuiz(engine);
    expect(lines(opening).slice(1)).toEqual([`${T}.quiz_intro`, 'ask_1', 'listen:quiz:aa']);
    expect(says(opening)[2]).toMatchObject({ state: 'talking', showAnchor: false });
    const all = finish(engine, () => 'correct', opening);
    expect(all.filter((s) => s.type === 'listen').map((s) => (s as Listen).item.id)).toEqual(QUIZ);
    expect(lines(all).filter((l) => l.startsWith('ask_'))).toEqual(['ask_1', 'ask_2', 'ask_3', 'ask_1', 'ask_2', 'ask_3']);
  });

  test('full run with every answer right: no retry round, outro in the bye state, every quiz answer counted correct', () => {
    const engine = start();
    const all = finish(engine, () => 'correct');
    expect(lines(all)).not.toContain('retry_intro');
    expect(all.at(-1)).toEqual({ type: 'done' });
    expect(all.at(-2)).toMatchObject({ line: `${T}.outro`, state: 'bye' });
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
    expect(ids.size).toBe(33);
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
      if (before?.type === 'say' && before.line !== 'nohear') {
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
  test('right -> ok_* then the next item; the event is a teach turn that does not count', () => {
    const engine = start();
    turn(engine);
    const { event } = answer(engine, 'correct');
    const steps = turn(engine);
    expect(lines(steps)).toEqual([expect.stringMatching(/^ok_\d$/), `${T}.aa.teach`, 'listen:teach:aa']);
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
    expect(lines(again)).toEqual(['again_1', `${T}.a.teach`, 'listen:teach:a']);
    expect(says(again)[0].state).toBe('tryagain');
    const on = reply(engine, 'wrong');
    expect(lines(on)).toEqual(['moveon_1', `${T}.aa.teach`, 'listen:teach:aa']);
    expect(says(on)[0].state).not.toBe('correct');
    expect(eventsOf(engine).map((e) => [e.phase, e.heard_kind, e.counts])).toEqual([['teach', 'wrong', false], ['teach', 'wrong', false]]);
  });

  test('wrong, then right -> ok_*', () => {
    const engine = start();
    turn(engine);
    reply(engine, 'wrong');
    expect(lines(reply(engine, 'correct'))[0]).toMatch(/^ok_\d$/);
  });

  test('silence -> nohear and listens once more; a second silence moves on', () => {
    const engine = start();
    turn(engine);
    const steps = reply(engine, 'silent');
    expect(lines(steps)).toEqual(['nohear', 'listen:teach:a']);
    expect(says(steps)[0].state).toBe('nohear');
    expect(lines(reply(engine, 'silent'))).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
  });

  test('silence, then speech -> ok_* and the next item', () => {
    const engine = start();
    turn(engine);
    reply(engine, 'silent');
    expect(lines(reply(engine, 'correct'))).toEqual([expect.stringMatching(/^ok_\d$/), `${T}.aa.teach`, 'listen:teach:aa']);
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
    expect(lines(reply(engine, 'correct'))[0]).toBe(`${T}.aa.correct`);
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
  test('right answer -> the item correct line; a counted first-try event carrying what was heard', () => {
    const engine = start();
    toQuiz(engine);
    const { event } = answer(engine, { kind: 'correct', by: 'tap', text: 'आ', lang: 'mr' });
    const steps = turn(engine);
    expect(lines(steps)).toEqual([`${T}.aa.correct`, 'ask_2', 'listen:quiz:u']);
    expect(says(steps)[0].state).toBe('correct');
    expect(event).toMatchObject({
      item_key: 'mr:letter:आ', phase: 'quiz', heard_kind: 'correct', matched_text: 'आ', matched_lang: 'mr',
      decided_by: 'tap', attempt: 1, unsure: false, counts: true,
    });
  });

  test('1st wrong -> wrong_* then the item hint, and listens again', () => {
    const engine = start();
    toQuiz(engine);
    const steps = reply(engine, 'wrong');
    expect(lines(steps)).toEqual([expect.stringMatching(/^wrong_\d$/), `${T}.aa.hint`, 'listen:quiz:aa']);
    expect(says(steps).map((s) => s.state)).toEqual(['tryagain', 'hint']);
    expect(says(steps)[1].showAnchor).toBe(true); // the picture is the hint
    // right after the hint: correct on the 2nd attempt, not sent to the retry round
    expect(lines(reply(engine, 'correct'))[0]).toBe(`${T}.aa.correct`);
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
    expect(lines(after)).toEqual([expect.stringMatching(/^ok_\d$/), 'ask_2', 'listen:quiz:u']);
    expect(lastPosition(engine).retry).toEqual(['aa']);
    expect(eventsOf(engine).slice(-3).map((e) => [e.heard_kind, e.counts])).toEqual([['wrong', true], ['wrong', true], ['correct', false]]);
  });

  test('silence on the repeat -> nohear and listens once more, then moves on', () => {
    const engine = start();
    toQuiz(engine);
    reply(engine, 'wrong');
    reply(engine, 'wrong');
    expect(lines(reply(engine, 'silent'))).toEqual(['nohear', 'listen:teach:aa']);
    expect(lines(reply(engine, 'silent'))).toEqual(['ask_2', 'listen:quiz:u']);
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

  test('missed items are asked again after retry_intro, in the order missed; retry answers are retry-phase events', () => {
    const engine = start();
    const all = lines(finish(engine, missTwo(() => 'correct')));
    const at = all.indexOf('retry_intro');
    expect(all.slice(at)).toEqual([
      'retry_intro', 'ask_1', 'listen:quiz:aa', `${T}.aa.correct`,
      'ask_2', 'listen:quiz:i', `${T}.i.correct`, `${T}.outro`, 'done',
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
      'retry_intro', 'ask_1', 'listen:quiz:aa', expect.stringMatching(/^wrong_\d$/), `${T}.aa.hint`, 'listen:quiz:aa',
      `${T}.aa.teach`, 'listen:teach:aa', expect.stringMatching(/^ok_\d$/),
      'ask_2', 'listen:quiz:i', `${T}.i.correct`, `${T}.outro`, 'done',
    ]);
    expect(lastPosition(engine).retry).toEqual(['aa', 'i']);
  });
});

describe('variants', () => {
  test('ok_* and wrong_* never repeat back to back, ask_* never repeats', () => {
    let seed = 7;
    const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 40; run++) {
      const all = lines(finish(start(undefined, rng), (_id, kind, n) => (kind === 'quiz' && n <= 2 ? 'wrong' : 'correct')));
      for (const family of ['ok', 'wrong', 'ask']) {
        const used = all.filter((l) => l.startsWith(`${family}_`));
        expect(used.length).toBeGreaterThan(5);
        used.forEach((id, i) => { if (i) expect(id).not.toBe(used[i - 1]); });
      }
    }
  });

  test('every ok_* and wrong_* variant gets used', () => {
    const all = new Set<string>();
    for (let run = 0; run < 20; run++) {
      lines(finish(start(undefined, Math.random), (_id, kind, n) => (kind === 'quiz' && n <= 2 ? 'wrong' : 'correct'))).forEach((l) => all.add(l));
    }
    for (const id of ['ok_1', 'ok_2', 'ok_3', 'wrong_1', 'wrong_2']) expect(all).toContain(id);
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
    expect(lines(turn(start(saved)))).toEqual([`${T}.quiz_intro`, 'ask_1', 'listen:quiz:aa']);
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
    expect(lines(reply(resumed, 'correct')).slice(1)).toEqual(['ask_2', 'listen:quiz:u']);
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
    expect(lines(finish(start(saved), () => 'correct'))).toEqual(['ask_2', 'listen:quiz:i', `${T}.i.correct`, `${T}.outro`, 'done']);
  });

  test('resume keeps the variant rotation going', () => {
    const first = start();
    toQuiz(first); // used ask_1
    const { position } = answer(first, 'correct');
    expect(lines(turn(start(position)))[0]).toBe('ask_2');
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
  return createLesson(words, wordPrompts, { styleLevel: 'mr_led', wordItemsGated: false, rng: () => 0, ...opts });
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
    expect(all.filter((l) => /^ask_\d+$/.test(l))).toEqual([]);
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
    expect(lines(steps)).toEqual([expect.stringMatching(/^meaning_hi_ack_\d+$/), 'listen:quiz:apple']);
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
    expect(lines(steps).at(-2)).toMatch(/^ask_mr_\d+$/);
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
    expect(lines(next).some((l) => /^wrong_\d+$/.test(l))).toBe(false);
  });

  test('ambiguous_lang item: praised as correct, model_mr only, no follow-up listen', () => {
    const engine = startWords();
    toTree(engine);
    reply(engine, 'correct'); // Tree
    reply(engine, 'correct'); // Cat, now asking Water
    const { event } = answer(engine, meaning('पानी', 'hi'));
    const steps = turn(engine);
    expect(lines(steps)).toEqual(expect.arrayContaining([`${W}.water.correct`, `${W}.water.model_mr`]));
    expect(lines(steps).some((l) => /^ask_mr_\d+$/.test(l))).toBe(false);
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
    expect(lines(steps)[0]).toMatch(/^ask_mr_\d+$/);
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
    const engine = createLesson(lesson, prompts, { wordItemsGated: true, rng: () => 0 });
    toQuiz(engine);
    reply(engine, 'wrong');
    reply(engine, 'wrong');
    expect(lastPosition(engine).retry).toEqual(['aa']);
    expect(eventsOf(engine).slice(-2).every((e) => e.counts)).toBe(true);
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
