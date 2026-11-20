// Lesson engine: turns a lesson file into steps and reacts to answers.
// No React, no audio, no clock. The rules live in the lesson file's
// `rules` and `flow`; this implements them, plus the word-item language rules
// (PRD Language design, D-GURU-10-language-design) and tutor variety
// (PRD Tutor variety, D-GURU-19-tutor-variety). It reports one event per
// answer; mastery is derived from the events elsewhere.
import { SURPRISE_STATES } from '../shekru/contract';
import { pickLine } from './lines';
import { endFamily, praiseFamily } from './praise';
import { interleaveRevision, shuffleQuiz } from './quizOrder';
import { revisionRef } from './revision';
import type {
  AnswerEvent, FlowEntry, Heard, Item, Lang, Lesson, Listen, Position, Prompts, RevisionItem, Say, Step, StyleLevel,
  Surprise,
} from './types';

const CHANCE = 0.5; // of a picture reaction after a right teach answer, and of a surprise in a lesson

/** What the judge matched, as AnswerEvent and the clip manifest record it. */
export function matchedOf(heard: Heard): { matched_text?: string; matched_lang?: Lang } {
  return {
    ...('text' in heard && heard.text !== undefined ? { matched_text: heard.text } : {}),
    ...('lang' in heard && heard.lang ? { matched_lang: heard.lang } : {}),
  };
}

// A line's on-screen text, when it differs from the voice text.
const captionOf = (captions: Record<string, string> | undefined, name: string) =>
  captions?.[name] ? { caption: captions[name] } : {};

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
    revision?: RevisionItem[]; // mixed into the quiz, never taught
  } = {},
): LessonEngine {
  const { styleLevel = 'mr_led', wordItemsGated = false, rng = Math.random, revision = [] } = opts;
  const resumed = !!opts.position && opts.position.version === lesson.version;
  const pos: Position = resumed ? structuredClone(opts.position!) : newPosition(lesson);
  // saves before GURU-19 kept one id per family
  for (const [family, h] of Object.entries(pos.last)) if (typeof h === 'string') pos.last[family] = [h];
  const queue: Step[] = [];
  let listening: Listen | null = null;

  const templateOf = new Map(revision.map((r) => [r.item, r.template_id]));
  const tpl = (item: Item) => templateOf.get(item) ?? lesson.template_id;
  // revision items by their Position.quiz ref, `<template_id>.<id>`
  const revisionByRef = new Map(revision.map((r) => [revisionRef(r), r.item]));

  const byId = (id: string) => {
    const item = lesson.items.find((i) => i.id === id);
    if (!item) throw new Error(`Unknown item id "${id}"`);
    return item;
  };
  // An entry of Position.quiz: a lesson item id, or a revision item's ref.
  const byRef = (ref: string) => {
    if (!ref.includes('.')) return byId(ref);
    const item = revisionByRef.get(ref);
    if (!item) throw new Error(`Revision item "${ref}" was not passed in`);
    return item;
  };
  const byDisplay = (display: string) => {
    const item = lesson.items.find((i) => i.display === display);
    if (!item) throw new Error(`Flow names "${display}" but no item displays it`);
    return item;
  };
  // A family's lines: `<family>_<n>`, or the bare family id.
  const variants = (family: string) => {
    const re = new RegExp(`^${family}(_\\d+)?$`);
    return Object.keys(prompts.lines).filter((id) => re.test(id));
  };
  // Random line of the family, not among its last 5 picks (TDD 2.4).
  const pick = (family: string) => {
    const { id, history } = pickLine(family, variants(family), pos.last[family] ?? [], rng);
    pos.last[family] = history;
    return id;
  };

  const shared = (family: string, state: string, item: Item | null = null, showAnchor = false): Say => {
    const id = pick(family);
    return { type: 'say', line: id, text: prompts.lines[id], ...captionOf(prompts.captions, id), state, item, showAnchor };
  };
  const lessonLine = (name: string, state: string): Say => ({
    type: 'say', line: `${lesson.template_id}.${name}`, text: lesson.lines[name], ...captionOf(lesson.captions, name),
    state, item: null, showAnchor: false,
  });
  const itemLine = (item: Item, name: string, state: string, showAnchor: boolean): Say => ({
    type: 'say', line: `${tpl(item)}.${item.id}.${name}`, text: (item.lines as Record<string, string>)[name],
    ...captionOf(item.captions, name), state, item, showAnchor,
  });
  // A line that opens the mic, and the listen it opens.
  const ask = (say: Say, kind: Listen['kind']): [Say, Listen] =>
    [say, { type: 'listen', item: say.item!, kind, showAnchor: say.showAnchor, prompt: say.text }];
  // Teach turn and reveal: word items use the lesson's style line.
  const teach = (item: Item) =>
    ask(itemLine(item, item.kind === 'word' ? `teach_${styleLevel}` : 'teach', 'talking', true), 'teach');
  const hint = (item: Item) => ask(itemLine(item, 'hint', 'hint', true), 'quiz');
  const gated = (item: Item) => wordItemsGated && item.kind === 'word';

  const itemsOf = (entry: FlowEntry): Item[] => {
    if (!('phase' in entry)) return [];
    if (entry.phase === 'retry') return pos.retry.map(byId);
    if (entry.phase === 'teach') return entry.order.map(byDisplay);
    // before the run's order is drawn, and in saves from before GURU-19
    return pos.quiz ? pos.quiz.map(byRef) : [...entry.order.map(byDisplay), ...revision.map((r) => r.item)];
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
  // The closing line plays at this flow entry, right after the last phase (0: no phase).
  const closeAt = lesson.flow.findLastIndex((e) => 'phase' in e) + 1;
  const itemsLeft = () => lesson.flow.slice(pos.flow).some((e, i) => itemsOf(e).length > (i === 0 ? pos.index : 0));

  // A fresh run may get one surprise, before any teach or quiz item but the first.
  if (!resumed && rng() < CHANCE) {
    const slots = lesson.flow
      .flatMap((e, flow) => ('phase' in e && e.phase !== 'retry' ? itemsOf(e).map((_, index) => ({ flow, index })) : []))
      .slice(1);
    if (slots.length) pos.surprise = slots[Math.floor(rng() * slots.length)];
  }
  const surprise = (): Surprise => {
    delete pos.surprise;
    const state = SURPRISE_STATES[Math.floor(rng() * SURPRISE_STATES.length)];
    if (state === 'celebrate') return { type: 'surprise', state };
    const line = pick('surprise_line');
    return { type: 'surprise', state, line, text: prompts.lines[line], ...captionOf(prompts.captions, line) };
  };

  // Queues the steps that open the current position. Also used on resume,
  // so a half-finished item restarts from its last mic-opening line.
  const fill = () => {
    for (;;) {
      const entry = lesson.flow[pos.flow];
      if (!entry) { queue.push({ type: 'done' }); return; }
      if ('play' in entry) {
        if (closeAt > 0 && pos.flow === closeAt) {
          queue.push(shared(endFamily(!!pos.missed), pos.missed ? 'talking' : 'correct'));
        }
        queue.push(lessonLine(entry.play, entry.state));
        nextEntry();
        return;
      }
      if (entry.phase === 'quiz' && !pos.quiz && pos.index === 0) {
        pos.quiz = interleaveRevision(shuffleQuiz(entry.order, rng).map((d) => byDisplay(d).id), [...revisionByRef.keys()], rng);
      }
      const items = itemsOf(entry);
      if (pos.index >= items.length) { nextEntry(); continue; } // empty retry round
      const item = items[pos.index];
      const opening = !pos.attempts && !pos.silences && !pos.repeats && !pos.reveal && !pos.bridged && !pos.followup;
      if (opening && pos.surprise?.flow === pos.flow && pos.surprise.index === pos.index) queue.push(surprise());
      if (entry.phase === 'teach') {
        queue.push(...teach(item));
        return;
      }
      if (pos.followup === 'ask') {
        queue.push(...ask(shared('ask_mr', 'talking', item, true), 'quiz'));
        return;
      }
      if (pos.followup === 'model') {
        queue.push(...ask(itemLine(item, 'model_mr', 'talking', true), 'teach'));
        return;
      }
      if (entry.phase === 'retry' && opening && pos.index === 0) queue.push(shared('retry_intro', 'talking'));
      if (pos.reveal) queue.push(...teach(item));
      else if (pos.attempts === 1) queue.push(...hint(item));
      else if (item.kind === 'word') queue.push(...ask(itemLine(item, 'ask', 'talking', false), 'quiz'));
      else queue.push(...ask(shared('ask', 'talking', item), 'quiz'));
      return;
    }
  };

  // A picture reaction after a right teach-phase answer. Each item has one teach turn per run,
  // so it reacts at most once.
  const react = (item: Item) => {
    const names = (['react_1', 'react_2'] as const).filter((n) => item.lines[n]);
    if (names.length && rng() < CHANCE) queue.push(itemLine(item, names[Math.floor(rng() * names.length)], 'talking', true));
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
        queue.push(shared('again', 'tryagain', item, true), ...teach(item));
        return;
      }
      queue.push(shared('moveon', 'talking', item, true)); // no praise for a wrong repeat
    } else {
      queue.push(shared('praise_first', 'correct', item, true));
      if (!pos.reveal) react(item); // a teach turn, not the repeat after a reveal
    }
    nextItem();
  };

  // rules.quiz_attempts: a missed try. tryagain says "a different letter", so it is
  // only for a wrong letter, never after silence or on a word item.
  // Returns whether the miss counts.
  const miss = (item: Item, phase: 'quiz' | 'retry' | 'revision', wrongLine: boolean) => {
    const counts = !gated(item);
    pos.silences = 0;
    pos.attempts++;
    if (counts) pos.streak = 0;
    if (pos.attempts === 1) {
      if (wrongLine) queue.push(shared('tryagain', 'tryagain', item));
      queue.push(...hint(item));
    } else {
      pos.reveal = true;
      if (counts) pos.missedLast = pos.missed = true;
      // rules.retry_round: a miss in the retry round is not queued again
      if (phase === 'quiz' && counts && !pos.retry.includes(item.id)) pos.retry.push(item.id);
      queue.push(...teach(item));
    }
    return counts;
  };

  // A right scored answer: the moment's praise, then the item's line naming the answer.
  const right = (item: Item) => {
    pos.streak = (pos.streak ?? 0) + 1;
    const family = praiseFamily({ attempt: pos.attempts + 1, streak: pos.streak, previousMissed: !!pos.missedLast });
    pos.missedLast = false;
    queue.push(shared(family, 'correct', item, true), itemLine(item, 'correct', 'correct', true));
  };

  // Returns whether the answer counts.
  const quizAnswer = (item: Item, heard: Heard, phase: 'quiz' | 'retry' | 'revision'): boolean => {
    // A right meaning on a word item, other than Hindi on a Marathi-target item, is the
    // bridge step (PRD Language design 8): acknowledge and ask again, not an attempt.
    if (heard.kind === 'meaning' && !(item.target_lang === 'mr' && heard.lang === 'hi')) {
      if (pos.bridged) {
        return miss(item, phase, false); // a second meaning goes on as a missed try, so the lesson always ends
      }
      pos.bridged = true;
      const shown = listening!.showAnchor;
      const ack = heard.lang === 'hi'
        ? shared('meaning_hi_ack', 'talking', item, shown) // never repeats the Hindi word
        : itemLine(item, 'ack_meaning', 'talking', shown);
      queue.push(...ask(ack, 'quiz'));
      return false;
    }
    if (heard.kind === 'correct' || heard.kind === 'meaning') {
      right(item);
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
    if (heard.kind === 'correct') queue.push(shared('praise_first', 'correct', item, true));
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
      const phase = pos.followup ? 'followup' : templateOf.has(item) ? 'revision' : entry.phase;
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
        template_id: tpl(item),
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
        ...matchedOf(heard),
      };
      return { position: structuredClone(pos), event };
    },
    position: () => structuredClone(pos),
  };
}
