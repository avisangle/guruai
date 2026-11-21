// The lesson loop: runs the engine's steps with the tutor, the line player and the answer
// source. Pausing (the pause button, the app leaving the foreground, a line the system
// interrupts) stops audio and the mic; continuing rebuilds the engine from its current
// position, so Shekru asks the open question again before the mic opens (D-GURU-28-lesson-pause).
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import promptsJson from '../content/generated/prompts.json';
import type { Db } from '../data/db';
import { getChild } from '../data/profiles';
import { WORD_ITEMS_GATED } from '../learning/config';
import { localDay } from '../learning/mastery';
import { lessonEnded, lessonsDoneToday, shouldEndAfterLesson } from '../learning/session';
import type { useLinePlayer } from '../screens/useLinePlayer';
import anim from '../shekru/generated/shekru.anim.json';
import type { AnswerSource } from './answerSource';
import { familyOf } from './lines';
import { createLesson, isFinished, newPosition, type LessonEngine } from './engine';
import type { AnswerEvent, Item, Lesson, Listen, Position, Prompts, RevisionItem, StyleLevel } from './types';

const prompts = promptsJson as Prompts;
const STATE_DEFS = anim.states as Record<string, { loop?: boolean; duration: number }>;
const THINKING_MS = 600;
const GESTURE_TAIL_MS = 250; // a one-shot gesture finishes even when its line is shorter

export type LinePlayer = ReturnType<typeof useLinePlayer>;

export type PlayerView = {
  caption: string;
  card: { item: Item; showAnchor: boolean } | null;
  listening: boolean;
  /** The listen turn reopened after "didn't hear". */
  again: boolean;
  /** A right answer's reward, until the next item, turn or moment: a star, or three ticks for streak praise. */
  correct: 'star' | 'ticks' | null;
  /** surprise: Shekru centre stage for the step. finished: from the closing line on. */
  moment: 'surprise' | 'finished' | null;
  paused: boolean;
  /** Engine position at the current step, for the item dots. */
  position: Position;
};

type Options = {
  lesson: Lesson;
  styleLevel: StyleLevel;
  revision: RevisionItem[];
  start: Position | null; // saved position, or null for a fresh run
  source: AnswerSource;
  lines: LinePlayer;
  tutor: { setState(state: string): void };
  /** Runs alongside the first lines and finishes before the first listen turn: the mic permission prompt. */
  prepare?: () => Promise<void>;
  onAnswer(event: AnswerEvent, position: Position): void;
  /** Tutor speech, a listen turn or an answer. */
  onActivity(): void;
  onPause(): void;
  onResume(): void;
  onDone(): void;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oneShotMs = (state: string) => {
  const def = STATE_DEFS[state];
  return def && !def.loop ? def.duration * 1000 : 0;
};

export function usePlayerLoop(opts: Options) {
  const [view, setView] = useState<PlayerView>(() => ({
    caption: '', card: null, listening: false, again: false, correct: null, moment: null, paused: false,
    position: opts.start ?? newPosition(opts.lesson),
  }));
  const show = useCallback((change: Partial<PlayerView>) => setView((v) => ({ ...v, ...change })), []);
  const o = useRef(opts);
  o.current = opts;
  const token = useRef(0); // bumping it cancels a running loop
  const live = useRef(false); // a run is in progress (not paused, not ended)
  const engine = useRef<LessonEngine | null>(null);
  const prepared = useRef<Promise<void>>(Promise.resolve());
  // The permission prompt can background the app (even when already granted, on Samsung);
  // that must not pause the lesson.
  const preparing = useRef(false);

  /** Stops audio and the mic, and cancels the running loop. */
  const halt = useCallback(() => {
    token.current++;
    live.current = false;
    o.current.source.cancel();
    o.current.lines.stop();
  }, []);

  const pause = useCallback(() => {
    if (!live.current) return;
    halt();
    o.current.tutor.setState('idle');
    o.current.onPause();
    show({ caption: '', listening: false, paused: true });
  }, [halt, show]);

  const run = useCallback(async (position: Position | null) => {
    const mine = ++token.current;
    const alive = () => mine === token.current;
    const { lesson, styleLevel, revision } = o.current;
    const eng = createLesson(lesson, prompts, { position, styleLevel, revision, wordItemsGated: WORD_ITEMS_GATED });
    engine.current = eng;
    live.current = true;
    // Speaks a line; false when the run stops here (stopped, or interrupted by the system).
    const say = async (line: string, text: string) => {
      if ((await o.current.lines.play(line, text)) !== 'interrupted') return alive();
      pause();
      return false;
    };
    let lastListen: Listen | null = null; // the last listen turn; the engine queues it again after "didn't hear"
    let praised: { item: Item; reward: 'star' | 'ticks' } | null = null;
    for (;;) {
      const { tutor, source, onActivity, onAnswer } = o.current;
      const step = eng.next();
      if (step.type === 'done') break;
      const position = eng.position();
      if (step.type === 'surprise') {
        praised = null;
        // a silent one-shot that hands back to idle, then its line over talking (D-GURU-7-tutor-state-contract)
        tutor.setState(step.state);
        show({ caption: '', correct: null, moment: 'surprise', position });
        onActivity();
        await wait(oneShotMs(step.state));
        if (!alive()) return;
        if (step.line) {
          tutor.setState('talking');
          show({ caption: step.caption ?? step.text ?? '' });
          if (!(await say(step.line, step.text ?? ''))) return;
        }
      } else if (step.type === 'say') {
        const started = Date.now();
        const family = familyOf(step.line);
        if (family?.startsWith('praise_')) praised = { item: step.item!, reward: family === 'praise_streak' ? 'ticks' : 'star' };
        else if (step.item !== praised?.item) praised = null;
        show({
          card: step.item && { item: step.item, showAnchor: step.showAnchor },
          caption: step.caption ?? step.text,
          correct: praised?.reward ?? null,
          // the closing lines are queued with the last answer, so the position is finished by then
          moment: !step.item && isFinished(lesson, position) ? 'finished' : null,
          position,
        });
        tutor.setState(step.state);
        onActivity();
        if (!(await say(step.line, step.text))) return;
        await wait(Math.max(0, oneShotMs(step.state) + GESTURE_TAIL_MS - (Date.now() - started)));
      } else {
        await prepared.current;
        if (!alive()) return;
        praised = null;
        show({
          card: { item: step.item, showAnchor: step.showAnchor }, caption: '', listening: true, again: step === lastListen,
          correct: null, moment: null, position,
        });
        lastListen = step;
        o.current.lines.chime();
        tutor.setState('listening');
        onActivity();
        const heard = await source.listen(step);
        if (!alive()) return;
        show({ listening: false });
        tutor.setState('thinking');
        onActivity();
        const thinking = wait(THINKING_MS); // the writes run inside the thinking pause
        const { position: next, event } = eng.answer(heard);
        onAnswer(event, next);
        await thinking;
      }
      if (!alive()) return;
    }
    live.current = false;
    o.current.onDone();
  }, [show, pause]);

  const resume = useCallback(() => {
    if (live.current || !engine.current) return;
    show({ paused: false });
    o.current.onResume();
    run(engine.current.position());
  }, [run, show]);

  useEffect(() => {
    preparing.current = true;
    prepared.current = Promise.resolve(o.current.prepare?.()).finally(() => {
      preparing.current = false;
    });
    run(o.current.start);
    return halt;
  }, [run, halt]);

  // Leaving the app pauses exactly like the pause button.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && !preparing.current) pause();
    });
    return () => sub.remove();
  }, [pause]);

  return { view, pause, resume };
}

export type LessonEndContext = {
  childId: string;
  sessionId: string;
  templateId: string;
  at: Date;
  activeMs: number;
};

/**
 * The lesson reached its end: records lesson_end, then says where the child goes next.
 * Goodbye when the daily goal is met or the active-time cap reached, else today's queue.
 */
export function onLessonEnd(db: Db, ctx: LessonEndContext): 'goodbye' | 'queue' {
  const at = ctx.at.toISOString();
  lessonEnded(db, { childId: ctx.childId, sessionId: ctx.sessionId, at }, ctx.templateId);
  const child = getChild(db, ctx.childId);
  if (!child) return 'queue';
  const done = lessonsDoneToday(db, ctx.childId, localDay(at));
  return shouldEndAfterLesson({ done, goal: child.lessons_per_day, activeMs: ctx.activeMs, capMin: child.active_cap_min })
    ? 'goodbye'
    : 'queue';
}
