// Sessions, lesson events and the daily lesson goal (PRD Learning model).
// A session is one sitting: from the child tapping their face to goodbye, Stop, or the app closing.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from '../data/db';
import { getChild } from '../data/profiles';
import { completeAssignments } from './assignments';
import { appendEvent, type EventContext } from './events';
import { localDayBounds } from './mastery';
import { applyStyleLevelAtSessionStart } from './styleLevel';

export type EndReason = 'goodbye' | 'stop' | 'closed';

export type SessionEnd = { at: string; activeMs: number; parentHelps: boolean };

/** Opens a session for the child at `at` (ISO) and returns its id; the style level is settled first. */
export function startSession(db: Db, childId: string, at: string): string {
  // Outside the transaction below: live Db transactions do not nest (bug.md).
  applyStyleLevelAtSessionStart(db, childId);
  const id = randomUUID();
  db.transaction(() => {
    const stamp = now();
    db.run('INSERT INTO session (id, child_id, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      childId,
      at,
      stamp,
      stamp,
    ]);
    appendEvent(db, { childId, sessionId: id, at }, 'session_start', {}, stamp);
  });
  return id;
}

/** The child's open session (not ended), the latest if several, or null. */
export function openSession(db: Db, childId: string): string | null {
  return (
    db.get<{ id: string }>(
      'SELECT id FROM session WHERE child_id = ? AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1',
      [childId],
    )?.id ?? null
  );
}

/** The child's open session, or a new one: one sitting spans the picker, parent visits and lessons (D-GURU-21-one-open-session). */
export function ensureSession(db: Db, childId: string, at: string): string {
  return openSession(db, childId) ?? startSession(db, childId, at);
}

/** Ends a session the child or parent ended; `closed` is for closeOpenSessions only. */
export function endSession(db: Db, sessionId: string, reason: Exclude<EndReason, 'closed'>, end: SessionEnd): void {
  db.run('UPDATE session SET ended_at = ?, end_reason = ?, active_ms = ?, parent_helps = ?, updated_at = ? WHERE id = ?', [
    end.at,
    reason,
    end.activeMs,
    end.parentHelps ? 1 : 0,
    now(),
    sessionId,
  ]);
}

/**
 * On app start: closes sessions an earlier run left open, as `closed` at their last event.
 * Their active time lived in memory and is lost, so active_ms stays as stored.
 */
export function closeOpenSessions(db: Db): void {
  db.run(
    `UPDATE session SET end_reason = 'closed', updated_at = ?,
       ended_at = COALESCE((SELECT MAX(at) FROM event WHERE event.child_id = session.child_id
         AND event.at >= session.started_at AND event.session_id = session.id), started_at)
     WHERE ended_at IS NULL`,
    [now()],
  );
}

export function lessonStarted(db: Db, ctx: EventContext, templateId: string): void {
  appendEvent(db, ctx, 'lesson_start', { template_id: templateId });
}

/** The lesson reached its end; this is what counts toward the daily goal, and it completes its assignments. */
export function lessonEnded(db: Db, ctx: EventContext, templateId: string): void {
  appendEvent(db, ctx, 'lesson_end', { template_id: templateId });
  completeAssignments(db, ctx.childId, templateId, ctx.at);
}

/** The lesson was left before its end, after `done` of `total` items. */
export function lessonLeft(db: Db, ctx: EventContext, templateId: string, items: { done: number; total: number }): void {
  appendEvent(db, ctx, 'lesson_left', { template_id: templateId, items_done: items.done, items_total: items.total });
}

/** Lessons the child finished on a local calendar day ('YYYY-MM-DD'), repeats included. */
export function lessonsDoneToday(db: Db, childId: string, date: string): number {
  const { from, to } = localDayBounds(date);
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM event WHERE child_id = ? AND type = 'lesson_end' AND at >= ? AND at < ?`,
    [childId, from, to],
  )!.n;
}

/** Lessons the child ever finished, repeats included: the stars, which are never taken away (decision 5). */
export function lessonsFinished(db: Db, childId: string): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM event WHERE child_id = ? AND type = 'lesson_end'`, [childId])!.n;
}

/** Template ids the child finished on a local calendar day, in finishing order, without repeats. */
export function lessonsEndedOn(db: Db, childId: string, date: string): string[] {
  const { from, to } = localDayBounds(date);
  const rows = db.all<{ template_id: string }>(
    `SELECT json_extract(payload, '$.template_id') AS template_id FROM event
     WHERE child_id = ? AND type = 'lesson_end' AND at >= ? AND at < ? ORDER BY at, rowid`,
    [childId, from, to],
  );
  return [...new Set(rows.map((r) => r.template_id))];
}

/** True once any child has finished a lesson on this phone. */
export function anyLessonEnded(db: Db): boolean {
  return !!db.get(`SELECT 1 FROM event WHERE type = 'lesson_end' LIMIT 1`);
}

/** True once the child has finished their lessons_per_day on that local day. */
export function goalMetToday(db: Db, childId: string, date: string): boolean {
  const child = getChild(db, childId);
  return !!child && lessonsDoneToday(db, childId, date) >= child.lessons_per_day;
}

/** Call at a lesson's end only: true when the goal is met or the active-time cap (null = off) is reached. */
export function shouldEndAfterLesson(state: { done: number; goal: number; activeMs: number; capMin: number | null }): boolean {
  return state.done >= state.goal || (state.capMin !== null && state.activeMs >= state.capMin * 60_000);
}
