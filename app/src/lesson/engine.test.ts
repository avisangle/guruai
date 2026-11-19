import lessonsJson from '../content/generated/lessons.json';
import promptsJson from '../content/generated/prompts.json';
import { createLesson, isFinished, type LessonEngine } from './engine';
import { exactEvaluator, toAnswer } from './evaluator';
import type { Answer, Lesson, Progress, Prompts, Say, Step } from './types';

const lessonJson = lessonsJson[0]; // स्वर १ (अ to ऊ): the cases below are written against it

const lesson = lessonJson as unknown as Lesson;
const prompts = promptsJson as Prompts;
const T = lesson.template_id;
const TEACH = ['a', 'aa', 'i', 'ii', 'u', 'uu'];
const QUIZ = ['aa', 'u', 'i', 'a', 'uu', 'ii'];

const start = (saved?: Progress, rng: () => number = () => 0) => createLesson(lesson, prompts, saved, rng);

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
function reply(engine: LessonEngine, answer: Answer) {
  engine.answer(answer);
  return turn(engine);
}
// Plays the teach phase with correct answers; returns the turn that opens the quiz.
function toQuiz(engine: LessonEngine) {
  turn(engine);
  let steps: Step[] = [];
  for (let i = 0; i < TEACH.length; i++) steps = reply(engine, 'correct');
  return steps;
}
// Runs to the end, answering each listen with pick(step).
function finish(engine: LessonEngine, pick: (id: string, kind: string, n: number) => Answer, first = turn(engine)) {
  const all = [...first];
  const seen: Record<string, number> = {};
  while (all.at(-1)!.type === 'listen') {
    const l = all.at(-1) as Extract<Step, { type: 'listen' }>;
    const key = `${l.kind}:${l.item.id}`;
    seen[key] = (seen[key] ?? 0) + 1;
    all.push(...reply(engine, pick(l.item.id, l.kind, seen[key])));
  }
  return all;
}

describe.each((lessonsJson as unknown as Lesson[]).map((l) => [l.template_id, l] as const))('lesson %s', (_id, l) => {
  test('every item is taught and quizzed once, and the run ends', () => {
    const engine = createLesson(l, prompts, undefined, () => 0);
    const all = finish(engine, () => 'correct');
    const ids = (kind: string) => all.filter((s) => s.type === 'listen' && s.kind === kind).map((s) => (s as any).item.id).sort();
    const items = l.items.map((i) => i.id).sort();
    expect(ids('teach')).toEqual(items);
    expect(ids('quiz')).toEqual(items);
    expect(all.at(-1)!.type).toBe('done');
  });

  test('all wrong still ends, with every item left unmastered', () => {
    const engine = createLesson(l, prompts, undefined, () => 0);
    expect(finish(engine, () => 'wrong').at(-1)!.type).toBe('done');
    expect(Object.values(engine.progress().mastery).every((m) => !m.mastered)).toBe(true);
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
    const taught = all.filter((s) => s.type === 'listen' && s.kind === 'teach').map((s) => (s as any).item.id);
    expect(taught).toEqual(TEACH);
  });

  test('quiz_intro then the quiz in the flow order, ask_* rotating', () => {
    const engine = start();
    const opening = toQuiz(engine);
    expect(lines(opening).slice(1)).toEqual([`${T}.quiz_intro`, 'ask_1', 'listen:quiz:aa']);
    expect(says(opening)[2]).toMatchObject({ state: 'talking', showAnchor: false });
    const all = finish(engine, () => 'correct', opening);
    expect(all.filter((s) => s.type === 'listen').map((s) => (s as any).item.id)).toEqual(QUIZ);
    expect(lines(all).filter((l) => l.startsWith('ask_'))).toEqual(['ask_1', 'ask_2', 'ask_3', 'ask_1', 'ask_2', 'ask_3']);
  });

  test('full run with every answer right: no retry round, outro in the bye state, all mastered', () => {
    const engine = start();
    const all = finish(engine, () => 'correct');
    expect(lines(all)).not.toContain('retry_intro');
    expect(all.at(-1)).toEqual({ type: 'done' });
    expect(all.at(-2)).toMatchObject({ line: `${T}.outro`, state: 'bye' });
    expect(all.filter((s) => s.type === 'listen')).toHaveLength(12);
    const { position, mastery } = engine.progress();
    expect(isFinished(lesson, position)).toBe(true);
    expect(lesson.items.every((i) => mastery[i.item_key].mastered)).toBe(true);
    expect(engine.next()).toEqual({ type: 'done' });
  });

  test('every spoken line has text and a known audio id', () => {
    const ids = new Set([
      ...Object.keys(prompts.lines),
      ...Object.keys(lesson.lines).map((l) => `${T}.${l}`),
      ...lesson.items.flatMap((i) => Object.keys(i.lines).map((l) => `${T}.${i.id}.${l}`)),
    ]);
    expect(ids.size).toBe(33);
    const all = finish(start(), (_id, kind, n) => (n <= 2 ? 'wrong' : 'silent'));
    for (const s of says(all)) {
      expect(ids.has(s.line)).toBe(true);
      expect(s.text).toBeTruthy();
    }
  });
});

describe('rules.teach_response', () => {
  test('right -> ok_* then the next item', () => {
    const engine = start();
    turn(engine);
    const steps = reply(engine, 'correct');
    expect(lines(steps)).toEqual([expect.stringMatching(/^ok_\d$/), `${T}.aa.teach`, 'listen:teach:aa']);
    expect(says(steps)[0].state).toBe('correct');
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
    expect(engine.progress().mastery).toEqual({});
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

  test('teach turns do not touch mastery', () => {
    const engine = start();
    toQuiz(engine);
    expect(engine.progress().mastery).toEqual({});
  });
});

describe('rules.quiz_silence', () => {
  test('silence -> nohear and listen again; then a right answer counts', () => {
    const engine = start();
    toQuiz(engine);
    expect(lines(reply(engine, 'silent'))).toEqual(['nohear', 'listen:quiz:aa']);
    expect(lines(reply(engine, 'correct'))[0]).toBe(`${T}.aa.correct`);
    expect(engine.progress().position.retry).toEqual([]);
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
});

describe('rules.quiz_attempts', () => {
  test('right answer -> the item correct line, mastered', () => {
    const engine = start();
    toQuiz(engine);
    const steps = reply(engine, 'correct');
    expect(lines(steps)).toEqual([`${T}.aa.correct`, 'ask_2', 'listen:quiz:u']);
    expect(says(steps)[0].state).toBe('correct');
    expect(engine.progress().mastery['mr:letter:आ']).toEqual({ mastered: true });
  });

  test('1st wrong -> wrong_* then the item hint, and listens again', () => {
    const engine = start();
    toQuiz(engine);
    const steps = reply(engine, 'wrong');
    expect(lines(steps)).toEqual([expect.stringMatching(/^wrong_\d$/), `${T}.aa.hint`, 'listen:quiz:aa']);
    expect(says(steps).map((s) => s.state)).toEqual(['tryagain', 'hint']);
    expect(says(steps)[1].showAnchor).toBe(true); // the picture is the hint
    // right after the hint: mastered, not sent to the retry round
    expect(lines(reply(engine, 'correct'))[0]).toBe(`${T}.aa.correct`);
    const { position, mastery } = engine.progress();
    expect(position.retry).toEqual([]);
    expect(mastery['mr:letter:आ'].mastered).toBe(true);
  });

  test('2nd wrong -> teach line as the reveal, child repeats, item goes to the retry round', () => {
    const engine = start();
    toQuiz(engine);
    reply(engine, 'wrong');
    const reveal = reply(engine, 'wrong');
    expect(lines(reveal)).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
    expect(says(reveal)[0]).toMatchObject({ state: 'talking', showAnchor: true });
    const after = reply(engine, 'correct'); // the child repeats the revealed letter
    expect(lines(after)).toEqual([expect.stringMatching(/^ok_\d$/), 'ask_2', 'listen:quiz:u']);
    const { position, mastery } = engine.progress();
    expect(position.retry).toEqual(['aa']);
    expect(mastery['mr:letter:आ']).toEqual({ mastered: false });
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

describe('rules.retry_round and mastered_when', () => {
  // misses आ and इ in the quiz
  const missTwo = (retry: (id: string, n: number) => Answer) =>
    (id: string, kind: string, n: number): Answer => {
      if (kind === 'teach') return 'correct';
      if (id !== 'aa' && id !== 'i') return 'correct';
      return n <= 2 ? 'wrong' : retry(id, n - 2);
    };

  test('missed items are asked again after retry_intro, in the order missed', () => {
    const engine = start();
    const all = lines(finish(engine, missTwo(() => 'correct')));
    const at = all.indexOf('retry_intro');
    expect(all.slice(at)).toEqual([
      'retry_intro', 'ask_1', 'listen:quiz:aa', `${T}.aa.correct`,
      'ask_2', 'listen:quiz:i', `${T}.i.correct`, `${T}.outro`, 'done',
    ]);
    expect(all.filter((l) => l === 'retry_intro')).toHaveLength(1);
    const { mastery } = engine.progress();
    expect(lesson.items.every((i) => mastery[i.item_key].mastered)).toBe(true);
  });

  test('still wrong in the retry round -> left unmastered, not asked a third time', () => {
    const engine = start();
    const all = lines(finish(engine, missTwo((id) => (id === 'aa' ? 'wrong' : 'correct'))));
    const at = all.indexOf('retry_intro');
    expect(all.slice(at)).toEqual([
      'retry_intro', 'ask_1', 'listen:quiz:aa', expect.stringMatching(/^wrong_\d$/), `${T}.aa.hint`, 'listen:quiz:aa',
      `${T}.aa.teach`, 'listen:teach:aa', expect.stringMatching(/^ok_\d$/),
      'ask_2', 'listen:quiz:i', `${T}.i.correct`, `${T}.outro`, 'done',
    ]);
    const { position, mastery } = engine.progress();
    expect(mastery['mr:letter:आ'].mastered).toBe(false);
    expect(mastery['mr:letter:इ'].mastered).toBe(true);
    expect(position.retry).toEqual(['aa', 'i']);
  });

  test('an item mastered in an earlier session stays mastered after a miss', () => {
    const engine = start({ position: null as any, mastery: { 'mr:letter:आ': { mastered: true } } });
    finish(engine, missTwo(() => 'wrong'));
    expect(engine.progress().mastery['mr:letter:आ'].mastered).toBe(true);
    expect(engine.progress().mastery['mr:letter:इ'].mastered).toBe(false);
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

describe('resume from saved progress', () => {
  const script = (_id: string, kind: string, n: number): Answer => (kind === 'quiz' && n <= 2 ? 'wrong' : 'correct');
  const fresh = () => lines(finish(start(), script));

  test('no saved position starts from the intro', () => {
    expect(lines(turn(start({ position: null as any, mastery: {} })))[0]).toBe(`${T}.intro`);
  });

  test('resuming after any answer reaches the same listens and the same result as an uninterrupted run', () => {
    const listensOf = (all: string[]) => all.filter((l) => l.startsWith('listen'));
    const uninterrupted = start();
    const whole = listensOf(lines(finish(uninterrupted, script)));
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
      let saved!: Progress;
      for (let i = 0; i < stopAfter; i++) {
        const l = steps.at(-1) as Extract<Step, { type: 'listen' }>;
        saved = first.answer(counted(l.item.id, l.kind));
        if (i < stopAfter - 1) steps = turn(first);
      }
      // what storage does: JSON round trip, new engine
      const resumed = start(JSON.parse(JSON.stringify(saved)));
      const rest = lines(finish(resumed, counted));
      expect(listensOf(rest)).toEqual(whole.slice(stopAfter));
      expect(rest.at(-1)).toBe('done');
      expect(resumed.progress().mastery).toEqual(uninterrupted.progress().mastery);
      expect(resumed.progress().position.retry).toEqual(uninterrupted.progress().position.retry);
    }
  });

  test('resume mid teach restarts at the next untaught item, without the intro', () => {
    const first = start();
    turn(first);
    first.answer('correct');
    turn(first);
    const saved = first.answer('correct');
    expect(lines(turn(start(saved)))).toEqual([`${T}.i.teach`, 'listen:teach:i']);
  });

  test('resume at the start of the quiz replays quiz_intro', () => {
    const first = start();
    turn(first);
    let saved!: Progress;
    for (let i = 0; i < 6; i++) { saved = first.answer('correct'); if (i < 5) turn(first); }
    expect(lines(turn(start(saved)))).toEqual([`${T}.quiz_intro`, 'ask_1', 'listen:quiz:aa']);
  });

  test('resume after a 1st wrong reopens with the hint; a 2nd wrong still reveals', () => {
    const first = start();
    toQuiz(first);
    const saved = first.answer('wrong');
    const resumed = start(saved);
    expect(lines(turn(resumed))).toEqual([`${T}.aa.hint`, 'listen:quiz:aa']);
    expect(lines(reply(resumed, 'wrong'))).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
  });

  test('resume after the reveal replays the reveal; the item is still in the retry round', () => {
    const first = start();
    toQuiz(first);
    first.answer('wrong');
    turn(first);
    const saved = first.answer('wrong');
    const resumed = start(saved);
    expect(lines(turn(resumed))).toEqual([`${T}.aa.teach`, 'listen:teach:aa']);
    expect(lines(reply(resumed, 'correct')).slice(1)).toEqual(['ask_2', 'listen:quiz:u']);
    expect(resumed.progress().position.retry).toEqual(['aa']);
  });

  test('resume inside the retry round keeps the missed list and does not replay retry_intro', () => {
    const first = start();
    const pick = (id: string, kind: string): Answer => (kind === 'quiz' && (id === 'aa' || id === 'i') ? 'wrong' : 'correct');
    let steps = turn(first);
    let saved!: Progress;
    for (;;) {
      const l = steps.at(-1) as Extract<Step, { type: 'listen' }>;
      const inRetry = lines(steps).includes('retry_intro');
      saved = first.answer(inRetry ? 'correct' : pick(l.item.id, l.kind));
      if (inRetry) break;
      steps = turn(first);
    }
    expect(saved.position.retry).toEqual(['aa', 'i']);
    expect(lines(finish(start(saved), () => 'correct'))).toEqual(['ask_2', 'listen:quiz:i', `${T}.i.correct`, `${T}.outro`, 'done']);
  });

  test('resume keeps the variant rotation going', () => {
    const first = start();
    toQuiz(first); // used ask_1
    const saved = first.answer('correct');
    expect(lines(turn(start(saved)))[0]).toBe('ask_2');
  });

  test('a finished lesson stays finished; a position from another lesson version is dropped', () => {
    const first = start();
    finish(first, () => 'correct');
    const saved = first.progress();
    expect(start(saved).next()).toEqual({ type: 'done' });
    const old = { ...saved, position: { ...saved.position, version: 0 } };
    const restarted = start(old);
    expect(lines(turn(restarted))[0]).toBe(`${T}.intro`);
    expect(restarted.progress().mastery).toEqual(saved.mastery);
  });
});

describe('engine misuse', () => {
  test('next() while listening and answer() while not listening throw', () => {
    const engine = start();
    expect(() => engine.answer('correct')).toThrow();
    turn(engine);
    expect(() => engine.next()).toThrow();
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
