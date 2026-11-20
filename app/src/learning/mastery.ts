// Mastery per child, item and language, with spaced revision (PRD Learning model).
// Derived from answer events only, so it can always be rebuilt (D-GURU-4-local-first-events).
import { randomUUID } from 'expo-crypto';

import type { Db } from '../data/db';
import { WORD_ITEMS_GATED } from './config';
import type { AnswerEvent, EventRow } from './events';

/** Mastery of one item in one language. Dates are local calendar days, 'YYYY-MM-DD'. */
export type ItemMastery = {
  item_key: string;
  lang: string;
  state: 'learning' | 'mastered';
  streak: number;
  interval_days: number;
  next_due: string | null;
  last_result: string | null;
};

export type MasteryRow = ItemMastery & { child_id: string };

const COLUMNS = 'child_id, item_key, lang, state, streak, interval_days, next_due, last_result';

/** Revision intervals in days; a correct revision moves one step, a miss goes back to the first. */
const INTERVALS = [1, 3, 7, 14, 30];

const pad = (n: number) => String(n).padStart(2, '0');

/** The phone's local calendar day of an ISO timestamp. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The ISO bounds [from, to) of a local calendar day 'YYYY-MM-DD', for comparing with `at`. */
export function localDayBounds(day: string): { from: string; to: string } {
  const [y, m, d] = day.split('-').map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

// Calendar arithmetic in UTC so daylight-saving shifts cannot skip or repeat a day.
function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const nextInterval = (days: number) => INTERVALS.find((i) => i > days) ?? INTERVALS[INTERVALS.length - 1];

/**
 * Applies one answer to an item's mastery. Pure: returns `row` itself when the answer
 * does not count, else a new row (or a first row when `row` is undefined).
 */
export function applyAnswer(row: ItemMastery | undefined, event: AnswerEvent, today: string): ItemMastery | undefined {
  if (!event.counts) return row;
  if (WORD_ITEMS_GATED && event.item_kind === 'word' && event.heard_kind === 'wrong') return row;

  const hit = event.heard_kind === 'correct' || event.heard_kind === 'meaning';
  const base: ItemMastery = row ?? {
    item_key: event.item_key,
    lang: event.target_lang,
    state: 'learning',
    streak: 0,
    interval_days: 0,
    next_due: null,
    last_result: null,
  };
  const next: ItemMastery = { ...base, streak: hit ? base.streak + 1 : 0, last_result: event.heard_kind };
  const schedule = (days: number) => ({ ...next, state: 'mastered' as const, interval_days: days, next_due: addDays(today, days) });

  if (base.state !== 'mastered') return hit ? schedule(INTERVALS[0]) : next;
  // Mastered: any miss resets revision to 1 day; only a revision check moves it up the ladder.
  if (!hit) return schedule(INTERVALS[0]);
  return event.phase === 'revision' ? schedule(nextInterval(base.interval_days)) : next;
}

/** The stored row for one item in one language, if any. */
export function getMastery(db: Db, childId: string, itemKey: string, lang: string): MasteryRow | undefined {
  return (
    db.get<MasteryRow>(`SELECT ${COLUMNS} FROM item_mastery WHERE child_id = ? AND item_key = ? AND lang = ?`, [
      childId,
      itemKey,
      lang,
    ]) ?? undefined
  );
}

/** Inserts or replaces the row for (child_id, item_key, lang). `stamp` is the write time. */
export function saveMastery(db: Db, row: MasteryRow, stamp: string): void {
  db.run(
    `INSERT INTO item_mastery (id, ${COLUMNS}, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (child_id, item_key, lang) DO UPDATE SET state = excluded.state, streak = excluded.streak,
       interval_days = excluded.interval_days, next_due = excluded.next_due,
       last_result = excluded.last_result, updated_at = excluded.updated_at`,
    [
      randomUUID(),
      row.child_id,
      row.item_key,
      row.lang,
      row.state,
      row.streak,
      row.interval_days,
      row.next_due,
      row.last_result,
      stamp,
      stamp,
    ],
  );
}

/** The child's mastered items due for revision on or before `date` ('YYYY-MM-DD'). */
export function dueRevision(db: Db, childId: string, date: string): MasteryRow[] {
  return db.all<MasteryRow>(
    `SELECT ${COLUMNS} FROM item_mastery
     WHERE child_id = ? AND state = 'mastered' AND next_due <= ?
     ORDER BY next_due, item_key, lang`,
    [childId, date],
  );
}

/** Mastery rebuilt from `event` rows, given in the order they were recorded. */
export function rebuildMastery(events: Iterable<EventRow>): MasteryRow[] {
  const rows = new Map<string, MasteryRow>();
  for (const e of events) {
    if (e.type !== 'answer') continue;
    const event = JSON.parse(e.payload) as AnswerEvent;
    const key = `${e.child_id}\n${event.item_key}\n${event.target_lang}`;
    const prev = rows.get(key);
    const next = applyAnswer(prev, event, localDay(e.at));
    if (next && next !== prev) rows.set(key, { ...next, child_id: e.child_id });
  }
  return [...rows.values()];
}
