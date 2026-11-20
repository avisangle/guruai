// The lesson loop: runs the engine's steps with the tutor, the line player and the answer
// source. Pausing stops audio and the mic; continuing rebuilds the engine from its current
// position, so Shekru asks the open question again before the mic opens.
import { useCallback, useEffect, useRef, useState } from 'react';

import promptsJson from '../content/generated/prompts.json';
import type { Db } from '../data/db';
import { getChild } from '../data/profiles';
import { WORD_ITEMS_GATED } from '../learning/config';
import { localDay } from '../learning/mastery';
import { lessonEnded, lessonsDoneToday, shouldEndAfterLesson } from '../learning/session';
import anim from '../shekru/generated/shekru.anim.json';
import type { AnswerSource } from './answerSource';
import { createLesson, type LessonEngine } from './engine';
import type { AnswerEvent, Item, Lesson, Position, Prompts, RevisionItem, StyleLevel } from './types';

const prompts = promptsJson as Prompts;
const STATE_DEFS = anim.states as Record<string, { loop?: boolean; duration: number }>;
const THINKING_MS = 600;
const GESTURE_TAIL_MS = 250; // a one-shot gesture finishes even when its line is shorter

/** useLinePlayer's shape. */
export type LinePlayer = {
  /** Resolves when the line ends or is stopped. */
  play(id: string, text: string): Promise<void>;
  stop(): void;
  chime(): void;
};

export type PlayerView = {
  caption: string;
  card: { item: Item; showAnchor: boolean } | null;
  listening: boolean;
  paused: boolean;
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
  const [view, setView] = useState<PlayerView>({ caption: '', card: null, listening: false, paused: false });
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

  const run = useCallback(async (position: Position | null) => {
    const mine = ++token.current;
    const alive = () => mine === token.current;
    const { lesson, styleLevel, revision } = o.current;
    const eng = createLesson(lesson, prompts, { position, styleLevel, revision, wordItemsGated: WORD_ITEMS_GATED });
    engine.current = eng;
    live.current = true;
    for (;;) {
      const { lines, tutor, source, onActivity, onAnswer } = o.current;
      const step = eng.next();
      if (step.type === 'done') break;
      if (step.type === 'surprise') {
        // a silent one-shot that hands back to idle, then its line over talking (D-GURU-7-tutor-state-contract)
        tutor.setState(step.state);
        show({ caption: '' });
        onActivity();
        await wait(oneShotMs(step.state));
        if (!alive()) return;
        if (step.line) {
          tutor.setState('talking');
          show({ caption: step.caption ?? step.text ?? '' });
          await lines.play(step.line, step.text ?? '');
        }
      } else if (step.type === 'say') {
        const started = Date.now();
        show({ card: step.item && { item: step.item, showAnchor: step.showAnchor }, caption: step.caption ?? step.text });
        tutor.setState(step.state);
        onActivity();
        await lines.play(step.line, step.text);
        if (!alive()) return;
        await wait(Math.max(0, oneShotMs(step.state) + GESTURE_TAIL_MS - (Date.now() - started)));
      } else {
        await prepared.current;
        if (!alive()) return;
        show({ card: { item: step.item, showAnchor: step.showAnchor }, caption: '', listening: true });
        lines.chime();
        tutor.setState('listening');
        onActivity();
        const heard = await source.listen(step);
        if (!alive()) return;
        show({ listening: false });
        onActivity();
        const { position: next, event } = eng.answer(heard);
        onAnswer(event, next);
        tutor.setState('thinking');
        await wait(THINKING_MS);
      }
      if (!alive()) return;
    }
    live.current = false;
    o.current.onDone();
  }, [show]);

  /** Stops audio and the mic; the run can continue or not. */
  const halt = useCallback(() => {
    token.current++;
    live.current = false;
    o.current.source.cancel();
    o.current.lines.stop();
  }, []);

  const pause = useCallback(() => {
    if (!live.current || preparing.current) return;
    halt();
    o.current.tutor.setState('idle');
    o.current.onPause();
    show({ caption: '', listening: false, paused: true });
  }, [halt, show]);

  const resume = useCallback(() => {
    if (live.current || !engine.current) return;
    show({ paused: false });
    o.current.onResume();
    run(engine.current.position());
  }, [run, show]);

  useEffect(() => {
    preparing.current = true;
    prepared.current = (async () => {
      try {
        await o.current.prepare?.();
      } finally {
        preparing.current = false;
      }
    })();
    run(o.current.start);
    return halt;
  }, [run, halt]);

  return { view, pause, resume, halt };
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
