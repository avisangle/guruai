// The session summary uploaded with the summaries consent (TDD 2.9): built from the session row and
// its events. Ids, codes and answers only: no nickname, picture, age or free text.
import lessonsJson from '../content/generated/lessons.json';
import type { Db } from '../data/db';
import { getDevice } from '../data/device';
import { getChild } from '../data/profiles';
import type { AnswerEvent } from '../learning/events';
import type { Lesson } from '../lesson/types';

const LESSONS = lessonsJson as unknown as Lesson[];
const BY_ID = new Map(LESSONS.map((l) => [l.template_id, l]));

type SessionRow = { child_id: string; started_at: string; ended_at: string | null; end_reason: string | null; parent_helps: number | null };
type EventRow = { at: string; type: string; payload: string };
type StoredAnswer = AnswerEvent & { clip?: string; revision_interval_days?: number };

export type LessonSummary = {
  template_id: string;
  started_at: string;
  ended_at: string | null;
  finished: boolean;
  items_total: number;
  items_resolved: number;
};

/** The item's expected answers: from its lesson, else (a revision item) from any lesson holding it. */
function expectedFor(templateId: string, itemKey: string): string[] {
  const find = (l: Lesson | undefined) => l?.items.find((i) => i.item_key === itemKey);
  const item = find(BY_ID.get(templateId)) ?? LESSONS.map(find).find((i) => i);
  return item?.assessment.expected ?? [];
}

export function buildSessionSummary(db: Db, sessionId: string, opts: { appVersion: string }) {
  const session = db.get<SessionRow>('SELECT child_id, started_at, ended_at, end_reason, parent_helps FROM session WHERE id = ?', [sessionId]);
  if (!session) throw new Error(`no session ${sessionId}`);
  const device = getDevice(db);
  const child = getChild(db, session.child_id);
  if (!child) throw new Error(`no child for session ${sessionId}`);

  // A clip is named only while it is queued or uploaded in this session's folder (TDD 2.9).
  const clips = new Set(
    db
      .all<{ path: string }>("SELECT path FROM upload_item WHERE kind = 'clip' AND session_id = ?", [sessionId])
      .map((r) => r.path.split('/').pop()),
  );

  const lessons: LessonSummary[] = [];
  const answers: Record<string, unknown>[] = [];
  const open = (templateId: string) => [...lessons].reverse().find((l) => l.template_id === templateId && l.ended_at === null);
  const events = db.all<EventRow>('SELECT at, type, payload FROM event WHERE session_id = ? ORDER BY at, rowid', [sessionId]);
  for (const e of events) {
    const p = JSON.parse(e.payload);
    if (e.type === 'lesson_start') {
      const total = BY_ID.get(p.template_id)?.items.length ?? 0;
      lessons.push({ template_id: p.template_id, started_at: e.at, ended_at: null, finished: false, items_total: total, items_resolved: 0 });
    } else if (e.type === 'lesson_end') {
      const l = open(p.template_id);
      if (l) Object.assign(l, { ended_at: e.at, finished: true, items_resolved: l.items_total });
    } else if (e.type === 'lesson_left') {
      const l = open(p.template_id);
      if (l) Object.assign(l, { ended_at: e.at, items_total: p.items_total, items_resolved: p.items_done });
    } else if (e.type === 'answer') {
      const a = p as StoredAnswer;
      answers.push({
        at: e.at,
        template_id: a.template_id,
        item_key: a.item_key,
        item_kind: a.item_kind,
        target_lang: a.target_lang,
        phase: a.phase,
        heard_kind: a.heard_kind,
        ...(a.matched_text !== undefined && { matched_text: a.matched_text }),
        ...(a.matched_lang !== undefined && { matched_lang: a.matched_lang }),
        expected: expectedFor(a.template_id, a.item_key),
        decided_by: a.decided_by,
        attempt: a.attempt,
        unsure: a.unsure,
        counts: a.counts,
        ...(a.phase === 'revision' && a.revision_interval_days != null && { revision_interval_days: a.revision_interval_days }),
        ...(a.clip && clips.has(a.clip) && { clip: a.clip }),
      });
    }
  }
  // A lesson the app closed on ends with the session.
  for (const l of lessons) l.ended_at ??= session.ended_at;

  return {
    format: 1,
    app_version: opts.appVersion,
    device_id: device.device_id,
    child_code: child.child_code,
    session_id: sessionId,
    started_at: session.started_at,
    ended_at: session.ended_at,
    end_reason: session.end_reason,
    parent_helps: session.parent_helps === 1,
    judge_check: device.judge_check,
    judge_p90_ms: device.judge_p90_ms,
    class: child.class,
    medium: child.medium,
    style_level: child.style_level,
    lessons,
    answers,
  };
}

export type SessionSummary = ReturnType<typeof buildSessionSummary>;
