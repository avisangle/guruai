// Answer events (TDD 2.3): appended to `event`, with item_mastery updated in the same transaction.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from '../data/db';
import { applyAnswer, localDay, MASTERY_COLUMNS, type MasteryRow } from './mastery';

/** One listening turn, as the lesson engine emits it (TDD 2.3). */
export type AnswerEvent = {
  template_id: string;
  item_key: string;
  item_kind: 'letter' | 'word';
  target_lang: 'mr' | 'en';
  phase: 'teach' | 'quiz' | 'retry' | 'revision' | 'followup';
  heard_kind: 'correct' | 'meaning' | 'wrong' | 'silent';
  matched_text?: string;
  matched_lang?: 'mr' | 'en' | 'hi';
  decided_by: 'shekru' | 'tap';
  attempt: number;
  unsure: boolean;
  style_level: 'mr_led' | 'en_led';
  counts: boolean;
};

/** What the session layer adds to each answer. `at` is an ISO timestamp. */
export type AnswerContext = {
  childId: string;
  sessionId: string;
  at: string;
  ms?: number;
  margin?: number;
};

/** A stored `event` row. */
export type EventRow = {
  child_id: string;
  session_id: string | null;
  at: string;
  type: string;
  payload: string;
};

/** Appends the answer event and applies it to item_mastery, atomically. */
export function recordAnswer(db: Db, ctx: AnswerContext, event: AnswerEvent): void {
  db.transaction(() => {
    const stamp = now();
    const payload = JSON.stringify({ ...event, ms: ctx.ms, margin: ctx.margin });
    db.run(
      'INSERT INTO event (id, child_id, session_id, at, type, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), ctx.childId, ctx.sessionId, ctx.at, 'answer', payload, stamp, stamp],
    );

    const current =
      db.get<MasteryRow>(
        `SELECT ${MASTERY_COLUMNS} FROM item_mastery WHERE child_id = ? AND item_key = ? AND lang = ?`,
        [ctx.childId, event.item_key, event.target_lang],
      ) ?? undefined;
    const next = applyAnswer(current, event, localDay(ctx.at));
    if (!next || next === current) return;

    db.run(
      `INSERT INTO item_mastery (id, ${MASTERY_COLUMNS}, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (child_id, item_key, lang) DO UPDATE SET state = excluded.state, streak = excluded.streak,
         interval_days = excluded.interval_days, next_due = excluded.next_due,
         last_result = excluded.last_result, updated_at = excluded.updated_at`,
      [
        randomUUID(),
        ctx.childId,
        next.item_key,
        next.lang,
        next.state,
        next.streak,
        next.interval_days,
        next.next_due,
        next.last_result,
        stamp,
        stamp,
      ],
    );
  });
}
