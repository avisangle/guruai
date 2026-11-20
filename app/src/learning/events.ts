// Answer events (TDD 2.3): appended to `event`, with item_mastery updated in the same transaction.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from '../data/db';
import type { StyleLevel } from '../data/types';
import type { DecidedBy, Heard, Item, ItemKind, Lang } from '../lesson/types';
import { applyAnswer, getMastery, localDay, saveMastery } from './mastery';

/** One listening turn, as the lesson engine emits it (TDD 2.3). */
export type AnswerEvent = {
  template_id: string;
  item_key: string;
  item_kind: ItemKind;
  target_lang: Item['target_lang'];
  phase: 'teach' | 'quiz' | 'retry' | 'revision' | 'followup';
  heard_kind: Heard['kind'];
  matched_text?: string;
  matched_lang?: Lang;
  decided_by: DecidedBy;
  attempt: number;
  unsure: boolean;
  style_level: StyleLevel;
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

    const current = getMastery(db, ctx.childId, event.item_key, event.target_lang);
    const next = applyAnswer(current, event, localDay(ctx.at));
    if (next && next !== current) saveMastery(db, { ...next, child_id: ctx.childId }, stamp);
  });
}
