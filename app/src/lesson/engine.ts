// Lesson engine: turns a lesson file into steps and reacts to answers.
// No React, no audio, no clock. The rules live in the lesson file's
// `rules` and `flow`; this implements them.
import type { Answer, FlowEntry, Item, Lesson, Listen, Mastery, Position, Progress, Prompts, Say, Step } from './types';

export function newPosition(lesson: Lesson): Position {
  return { version: lesson.version, flow: 0, index: 0, attempts: 0, silences: 0, reveal: false, retry: [], last: {} };
}

export function isFinished(lesson: Lesson, position: Position) {
  return position.flow >= lesson.flow.length;
}

export type LessonEngine = {
  // Next step to perform. After a `listen` step, call answer() first.
  next(): Step;
  // Feeds the child's answer and returns the progress to save.
  answer(answer: Answer): Progress;
  progress(): Progress;
};

export function createLesson(
  lesson: Lesson,
  prompts: Prompts,
  saved?: { position?: Position | null; mastery?: Mastery },
  rng: () => number = Math.random,
): LessonEngine {
  const pos: Position = saved?.position && saved.position.version === lesson.version
    ? structuredClone(saved.position)
    : newPosition(lesson);
  const mastery: Mastery = structuredClone(saved?.mastery ?? {});
  const queue: Step[] = [];
  let listening: Listen | null = null;

  const byId = (id: string) => {
    const item = lesson.items.find((i) => i.id === id);
    if (!item) throw new Error(`Unknown item id "${id}"`);
    return item;
  };
  const byDisplay = (display: string) => {
    const item = lesson.items.find((i) => i.display === display);
    if (!item) throw new Error(`Flow names "${display}" but no item displays it`);
    return item;
  };
  const variants = (family: string) =>
    Object.keys(prompts.lines)
      .filter((id) => new RegExp(`^${family}_\\d+$`).test(id))
      .sort((a, b) => +a.split('_')[1] - +b.split('_')[1]);

  const shared = (id: string, state: string, item: Item | null = null, showAnchor = false): Say =>
    ({ type: 'say', line: id, text: prompts.lines[id], state, item, showAnchor });
  const lessonLine = (name: string, state: string): Say =>
    ({ type: 'say', line: `${lesson.template_id}.${name}`, text: lesson.lines[name], state, item: null, showAnchor: false });
  const itemLine = (item: Item, name: keyof Item['lines'], state: string, showAnchor: boolean): Say =>
    ({ type: 'say', line: `${lesson.template_id}.${item.id}.${name}`, text: item.lines[name], state, item, showAnchor });
  const listen = (item: Item, kind: Listen['kind'], showAnchor: boolean): Listen => ({ type: 'listen', item, kind, showAnchor });

  // Random variant, never the one used last time.
  const pickRandom = (family: string) => {
    const all = variants(family);
    const pool = all.length > 1 ? all.filter((id) => id !== pos.last[family]) : all;
    return (pos.last[family] = pool[Math.floor(rng() * pool.length)]);
  };
  // Variants in order, wrapping around.
  const pickNext = (family: string) => {
    const all = variants(family);
    return (pos.last[family] = all[(all.indexOf(pos.last[family]) + 1) % all.length]);
  };

  const itemsOf = (entry: FlowEntry): Item[] => {
    if (!('phase' in entry)) return [];
    return entry.phase === 'retry' ? pos.retry.map(byId) : entry.order.map(byDisplay);
  };
  const nextItem = () => {
    pos.index++;
    pos.attempts = 0;
    pos.silences = 0;
    pos.repeats = 0;
    pos.reveal = false;
    if (pos.index >= itemsOf(lesson.flow[pos.flow]).length) nextEntry();
  };
  const nextEntry = () => {
    pos.flow++;
    pos.index = 0;
  };

  // Queues the steps that open the current position. Also used on resume,
  // so a half-finished item restarts from its last mic-opening line.
  const fill = () => {
    for (;;) {
      const entry = lesson.flow[pos.flow];
      if (!entry) { queue.push({ type: 'done' }); return; }
      if ('play' in entry) {
        queue.push(lessonLine(entry.play, entry.state));
        nextEntry();
        return;
      }
      const items = itemsOf(entry);
      if (pos.index >= items.length) { nextEntry(); continue; } // empty retry round
      const item = items[pos.index];
      if (entry.phase === 'teach') {
        queue.push(itemLine(item, 'teach', 'talking', true), listen(item, 'teach', true));
        return;
      }
      const fresh = pos.index === 0 && pos.attempts === 0 && pos.silences === 0 && !pos.reveal;
      if (entry.phase === 'retry' && fresh) queue.push(shared('retry_intro', 'talking'));
      if (pos.reveal) queue.push(itemLine(item, 'teach', 'talking', true), listen(item, 'teach', true));
      else if (pos.attempts === 1) queue.push(itemLine(item, 'hint', 'hint', true), listen(item, 'quiz', true));
      else queue.push(shared(pickNext('ask'), 'talking', item), listen(item, 'quiz', false));
      return;
    }
  };

  // rules.teach_response; also closes the repeat after a reveal. Never changes mastery.
  const teachResponse = (item: Item, answer: Answer) => {
    if (answer === 'silent') {
      if (pos.silences === 0) {
        pos.silences = 1; // nohear asks for a repeat, so listen once more
        queue.push(shared('nohear', 'nohear', item, true), listening!);
        return;
      }
    } else if (answer === 'wrong') {
      if (!pos.repeats) {
        pos.repeats = 1; // model the letter again and listen again
        queue.push(shared(pickRandom('again'), 'tryagain', item, true), itemLine(item, 'teach', 'talking', true), listen(item, 'teach', true));
        return;
      }
      queue.push(shared(pickRandom('moveon'), 'talking', item, true)); // no praise for a wrong repeat
    } else {
      queue.push(shared(pickRandom('ok'), 'correct', item, true));
    }
    nextItem();
  };

  const quizAnswer = (item: Item, answer: Answer, phase: 'quiz' | 'retry') => {
    if (answer === 'correct') {
      mastery[item.item_key] = { mastered: true }; // rules.mastered_when
      queue.push(itemLine(item, 'correct', 'correct', true));
      nextItem();
      return;
    }
    // rules.quiz_silence
    if (answer === 'silent' && pos.silences === 0) {
      pos.silences = 1;
      queue.push(shared('nohear', 'nohear', item, listening!.showAnchor), listening!);
      return;
    }
    // rules.quiz_attempts
    pos.silences = 0;
    pos.attempts++;
    if (pos.attempts === 1) {
      // wrong_* says "a different letter", which is untrue after silence: go straight to the hint
      if (answer !== 'silent') queue.push(shared(pickRandom('wrong'), 'tryagain', item));
      queue.push(itemLine(item, 'hint', 'hint', true), listen(item, 'quiz', true));
      return;
    }
    pos.reveal = true;
    mastery[item.item_key] ??= { mastered: false };
    // rules.retry_round: a miss in the retry round is not queued again
    if (phase === 'quiz' && !pos.retry.includes(item.id)) pos.retry.push(item.id);
    queue.push(itemLine(item, 'teach', 'talking', true), listen(item, 'teach', true));
  };

  const progress = (): Progress => structuredClone({ position: pos, mastery });

  return {
    next() {
      if (listening) throw new Error('answer() must be called after a listen step');
      if (!queue.length) fill();
      const step = queue.shift()!;
      if (step.type === 'listen') listening = step;
      return step;
    },
    answer(answer) {
      if (!listening) throw new Error('answer() called while not listening');
      const entry = lesson.flow[pos.flow];
      if (!('phase' in entry)) throw new Error('Listening outside a phase');
      const { item } = listening;
      if (entry.phase === 'teach' || pos.reveal) teachResponse(item, answer);
      else quizAnswer(item, answer, entry.phase);
      listening = null;
      return progress();
    },
    progress,
  };
}
