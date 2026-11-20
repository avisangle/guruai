// Lesson engine: turns a lesson file into steps and reacts to answers.
// No React, no audio, no clock. The rules live in the lesson file's
// `rules` and `flow`; this implements them, plus the word-item language rules
// (PRD Language design, D-GURU-10-language-design). It reports one event per
// answer; mastery is derived from the events elsewhere.
import type { AnswerEvent, FlowEntry, Heard, Item, Lesson, Listen, Position, Prompts, Say, Step, StyleLevel } from './types';

export function newPosition(lesson: Lesson): Position {
  return { version: lesson.version, flow: 0, index: 0, attempts: 0, silences: 0, reveal: false, retry: [], last: {} };
}

export function isFinished(lesson: Lesson, position: Position) {
  return position.flow >= lesson.flow.length;
}

export type LessonEngine = {
  // Next step to perform. After a `listen` step, call answer() first.
  next(): Step;
  // Feeds the child's answer; returns the position to save and the answer's event.
  answer(heard: Heard): { position: Position; event: AnswerEvent };
  position(): Position;
};

export function createLesson(
  lesson: Lesson,
  prompts: Prompts,
  opts: {
    position?: Position | null;
    styleLevel?: StyleLevel;
    wordItemsGated?: boolean; // D-GURU-12-word-items-practice-only
    rng?: () => number;
  } = {},
): LessonEngine {
  const { styleLevel = 'mr_led', wordItemsGated = false, rng = Math.random } = opts;
  const pos: Position = opts.position && opts.position.version === lesson.version
    ? structuredClone(opts.position)
    : newPosition(lesson);
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
  const variants = (family: string) => {
    const n = (id: string) => +id.slice(family.length + 1);
    return Object.keys(prompts.lines)
      .filter((id) => new RegExp(`^${family}_\\d+$`).test(id))
      .sort((a, b) => n(a) - n(b));
  };

  const shared = (id: string, state: string, item: Item | null = null, showAnchor = false): Say =>
    ({ type: 'say', line: id, text: prompts.lines[id], state, item, showAnchor });
  const lessonLine = (name: string, state: string): Say =>
    ({ type: 'say', line: `${lesson.template_id}.${name}`, text: lesson.lines[name], state, item: null, showAnchor: false });
  const itemLine = (item: Item, name: string, state: string, showAnchor: boolean): Say =>
    ({ type: 'say', line: `${lesson.template_id}.${item.id}.${name}`, text: (item.lines as Record<string, string>)[name], state, item, showAnchor });
  // A line that opens the mic, and the listen it opens.
  const ask = (say: Say, kind: Listen['kind']): [Say, Listen] =>
    [say, { type: 'listen', item: say.item!, kind, showAnchor: say.showAnchor, prompt: say.text }];
  // Teach turn and reveal: word items use the lesson's style line.
  const teach = (item: Item) =>
    ask(itemLine(item, item.kind === 'word' ? `teach_${styleLevel}` : 'teach', 'talking', true), 'teach');
  const hint = (item: Item) => ask(itemLine(item, 'hint', 'hint', true), 'quiz');
  const gated = (item: Item) => wordItemsGated && item.kind === 'word';

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
    pos.bridged = false;
    delete pos.followup;
    if (pos.index >= itemsOf(lesson.flow[pos.flow]).length) nextEntry();
  };
  const nextEntry = () => {
    pos.flow++;
    pos.index = 0;
  };
  // Some item is still to be asked, from the current position on.
  const itemsLeft = () => lesson.flow.slice(pos.flow).some((e, i) => itemsOf(e).length > (i === 0 ? pos.index : 0));

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
        queue.push(...teach(item));
        return;
      }
      if (pos.followup === 'ask') {
        queue.push(...ask(shared(pickRandom('ask_mr'), 'talking', item, true), 'quiz'));
        return;
      }
      if (pos.followup === 'model') {
        queue.push(...ask(itemLine(item, 'model_mr', 'talking', true), 'teach'));
        return;
      }
      const fresh = pos.index === 0 && pos.attempts === 0 && pos.silences === 0 && !pos.reveal && !pos.bridged;
      if (entry.phase === 'retry' && fresh) queue.push(shared('retry_intro', 'talking'));
      if (pos.reveal) queue.push(...teach(item));
      else if (pos.attempts === 1) queue.push(...hint(item));
      else if (item.kind === 'word') queue.push(...ask(itemLine(item, 'ask', 'talking', false), 'quiz'));
      else queue.push(...ask(shared(pickNext('ask'), 'talking', item), 'quiz'));
      return;
    }
  };

  // rules.teach_response; also closes the repeat after a reveal.
  const teachResponse = (item: Item, heard: Heard) => {
    // on a word item a meaning is not the word being taught
    const kind = heard.kind === 'meaning' ? 'wrong' : heard.kind;
    if (kind === 'silent') {
      if (pos.silences === 0) {
        pos.silences = 1; // nohear asks for a repeat, so listen once more
        queue.push(shared('nohear', 'nohear', item, true), listening!);
        return;
      }
    } else if (kind === 'wrong') {
      if (!pos.repeats) {
        pos.repeats = 1; // model the item again and listen again
        queue.push(shared(pickRandom('again'), 'tryagain', item, true), ...teach(item));
        return;
      }
      queue.push(shared(pickRandom('moveon'), 'talking', item, true)); // no praise for a wrong repeat
    } else {
      queue.push(shared(pickRandom('ok'), 'correct', item, true));
    }
    nextItem();
  };

  // rules.quiz_attempts: a missed try. wrong_* says "a different letter", so it is
  // only for a wrong letter, never after silence or on a word item.
  // Returns whether the miss counts.
  const miss = (item: Item, phase: 'quiz' | 'retry', wrongLine: boolean) => {
    pos.silences = 0;
    pos.attempts++;
    if (pos.attempts === 1) {
      if (wrongLine) queue.push(shared(pickRandom('wrong'), 'tryagain', item));
      queue.push(...hint(item));
    } else {
      pos.reveal = true;
      // rules.retry_round: a miss in the retry round is not queued again
      if (phase === 'quiz' && !gated(item) && !pos.retry.includes(item.id)) pos.retry.push(item.id);
      queue.push(...teach(item));
    }
    return !gated(item);
  };

  // Returns whether the answer counts.
  const quizAnswer = (item: Item, heard: Heard, phase: 'quiz' | 'retry'): boolean => {
    // A right meaning on a word item, other than Hindi on a Marathi-target item, is the
    // bridge step (PRD Language design 8): acknowledge and ask again, not an attempt.
    if (heard.kind === 'meaning' && !(item.target_lang === 'mr' && heard.lang === 'hi')) {
      if (pos.bridged) {
        return miss(item, phase, false); // a second meaning goes on as a missed try, so the lesson always ends
      }
      pos.bridged = true;
      const shown = listening!.showAnchor;
      const ack = heard.lang === 'hi'
        ? shared(pickRandom('meaning_hi_ack'), 'talking', item, shown) // never repeats the Hindi word
        : itemLine(item, 'ack_meaning', 'talking', shown);
      queue.push(...ask(ack, 'quiz'));
      return false;
    }
    if (heard.kind === 'correct' || heard.kind === 'meaning') {
      queue.push(itemLine(item, 'correct', 'correct', true));
      // Hindi right meaning on a Marathi-target item (PRD Language design 7)
      if (heard.kind === 'meaning') {
        if (!item.ambiguous_lang) {
          pos.followup = 'ask'; // fill() asks for the Marathi word
          return true;
        }
        queue.push(itemLine(item, 'model_mr', 'talking', true));
      }
      nextItem();
      return true;
    }
    // rules.quiz_silence
    if (heard.kind === 'silent' && pos.silences === 0) {
      pos.silences = 1;
      queue.push(shared('nohear', 'nohear', item, listening!.showAnchor), listening!);
      return false;
    }
    return miss(item, phase, heard.kind === 'wrong' && item.kind === 'letter');
  };

  // The unscored Marathi follow-up: right gets short praise; anything else
  // models the word (fill) and listens once for the repeat.
  const followupAnswer = (item: Item, heard: Heard) => {
    if (heard.kind === 'correct') queue.push(shared(pickRandom('ok'), 'correct', item, true));
    else if (pos.followup === 'ask') {
      pos.followup = 'model';
      return;
    }
    nextItem();
  };

  return {
    next() {
      if (listening) throw new Error('answer() must be called after a listen step');
      if (!queue.length) fill();
      const step = queue.shift()!;
      if (step.type === 'listen') listening = step;
      return step;
    },
    answer(heard) {
      if (!listening) throw new Error('answer() called while not listening');
      const entry = lesson.flow[pos.flow];
      if (!('phase' in entry)) throw new Error('Listening outside a phase');
      const { item } = listening;
      const phase = pos.followup ? 'followup' : entry.phase;
      const attempt = pos.attempts + 1;
      // a meaning on a letter item names the letter
      const rule: Heard = heard.kind === 'meaning' && item.kind === 'letter' ? { ...heard, kind: 'correct' } : heard;
      let counts = false;
      if (phase === 'followup') followupAnswer(item, rule);
      else if (phase === 'teach' || pos.reveal) teachResponse(item, rule);
      else counts = quizAnswer(item, rule, phase);
      listening = null;
      // After the last answer, queue the closing lines now so the saved position is finished.
      if (!queue.some((s) => s.type === 'listen') && !itemsLeft()) while (queue.at(-1)?.type !== 'done') fill();
      const event: AnswerEvent = {
        template_id: lesson.template_id,
        item_key: item.item_key,
        item_kind: item.kind,
        target_lang: item.target_lang,
        phase,
        heard_kind: heard.kind,
        decided_by: heard.by,
        attempt,
        unsure: heard.kind === 'silent' && !!heard.unsure,
        style_level: styleLevel,
        counts,
      };
      if ('text' in heard && heard.text !== undefined) event.matched_text = heard.text;
      if ('lang' in heard && heard.lang) event.matched_lang = heard.lang;
      return { position: structuredClone(pos), event };
    },
    position: () => structuredClone(pos),
  };
}
