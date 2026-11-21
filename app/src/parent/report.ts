// The simple report (PRD Happy Path, parent mode 2; wireframe pm-report and decision 22).
// Pure: derived from event and item_mastery rows (D-GURU-4-local-first-events).
import type { Db } from '../data/db';
import type { ChildProfile } from '../data/types';
import type { AnswerPayload, EventRow } from '../learning/events';
import { addDays, isHit, localDay, masteryRows, type MasteryRow } from '../learning/mastery';

/** One local day: lessons finished (repeats count) against the daily goal. */
export type ReportDay = { date: string; done: number; goal: number; met: boolean };

/** One lesson run, finished or left early. `at` is when it ended or was left. */
export type ReportLesson = {
  template_id: string;
  at: string;
  finished: boolean;
  done: number;
  total: number;
  practiceOnly: boolean;
  parentChecked: boolean;
};

export type Report = {
  days: ReportDay[];
  lessons: ReportLesson[];
  lettersMastered: number;
  nextDayRevision: { correct: number; total: number };
  needsPractice: string[];
};

const WEEK_DAYS = 7;
const RECENT_LESSONS = 10;
const NEEDS_PRACTICE = 5;

const isMiss = (a: AnswerPayload) => a.heard_kind === 'wrong' || a.heard_kind === 'silent';

/** The parts of an item_key, '<lang>:<kind>:<text>'. */
export function parseItemKey(itemKey: string): { lang: string; kind: string; text: string } {
  const [lang, kind, ...text] = itemKey.split(':');
  return { lang, kind, text: text.join(':') };
}

type Payload = Partial<AnswerPayload> & { items_done?: number; items_total?: number };
type Parsed = EventRow & { p: Payload };
type Run = { items: Set<string>; word: boolean; parentChecked: boolean };

/**
 * Lesson runs, oldest first. Answers belong to the run open in their session, whatever template_id
 * they carry (revision items keep their source lesson's id). A left lesson stays listed until the
 * same lesson is left again or finished, which replaces it: the next run of it is its resume.
 */
function lessonRuns(events: Parsed[]): ReportLesson[] {
  const open = new Map<string, Run>(); // by session
  const left = new Map<string, ReportLesson>(); // listed left entries, by template
  const out: ReportLesson[] = [];
  for (const { session_id, type, at, p } of events) {
    const session = session_id ?? '';
    if (type === 'lesson_start') {
      open.set(session, { items: new Set(), word: false, parentChecked: false });
    } else if (type === 'answer') {
      const run = open.get(session);
      if (!run) continue;
      run.items.add(p.item_key!);
      if (p.phase !== 'revision' && p.item_kind === 'word') run.word = true;
      if (p.decided_by === 'tap') run.parentChecked = true;
    } else if (type === 'lesson_end' || type === 'lesson_left') {
      const templateId = p.template_id!;
      const run = open.get(session);
      open.delete(session);
      const prior = left.get(templateId);
      if (prior) out.splice(out.indexOf(prior), 1);
      const finished = type === 'lesson_end';
      const total = finished ? (prior?.total ?? run?.items.size ?? 0) : p.items_total!;
      const entry: ReportLesson = {
        template_id: templateId,
        at,
        finished,
        done: finished ? total : p.items_done!,
        total,
        practiceOnly: !!(run?.word || prior?.practiceOnly),
        parentChecked: !!(run?.parentChecked || prior?.parentChecked),
      };
      out.push(entry);
      if (finished) left.delete(templateId);
      else left.set(templateId, entry);
    }
  }
  return out;
}

/**
 * Next-day revision: counted revision answers whose interval was 1 day when they came due
 * (`revision_interval_days`, D-GURU-38-upload-queue), decided by Shekru only (PRD Acceptance Criteria:
 * pilot figures use only `shekru` answers).
 */
function nextDayRevision(answers: AnswerPayload[]): Report['nextDayRevision'] {
  const due = answers.filter((a) => a.counts && a.phase === 'revision' && a.revision_interval_days === 1 && a.decided_by === 'shekru');
  return { correct: due.filter((a) => isHit(a.heard_kind)).length, total: due.length };
}

/** The child's report for the week ending `today` ('YYYY-MM-DD'). `events` are in recorded order. */
export function buildReport(
  events: EventRow[],
  mastery: MasteryRow[],
  profile: ChildProfile,
  today: string,
): Report {
  const parsed: Parsed[] = events.map((e) => ({ ...e, p: JSON.parse(e.payload) as Payload }));

  const goal = profile.lessons_per_day;
  const ended = new Map<string, number>();
  for (const e of parsed) {
    if (e.type !== 'lesson_end') continue;
    const day = localDay(e.at);
    ended.set(day, (ended.get(day) ?? 0) + 1);
  }
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => {
    const date = addDays(today, i - (WEEK_DAYS - 1));
    const done = ended.get(date) ?? 0;
    return { date, done, goal, met: done >= goal };
  });

  const lessons = lessonRuns(parsed)
    .reverse() // newest recorded first, so the stable sort keeps that order on equal times
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RECENT_LESSONS);

  const answers = parsed.filter((e) => e.type === 'answer').map((e) => e.p as AnswerPayload);

  const needsPractice: string[] = [];
  for (let i = answers.length - 1; i >= 0 && needsPractice.length < NEEDS_PRACTICE; i--) {
    const a = answers[i];
    if (a.counts && isMiss(a) && !needsPractice.includes(a.item_key)) needsPractice.push(a.item_key);
  }

  return {
    days,
    lessons,
    lettersMastered: mastery.filter((m) => m.state === 'mastered' && parseItemKey(m.item_key).kind === 'letter').length,
    nextDayRevision: nextDayRevision(answers),
    needsPractice,
  };
}

/** Reads the child's rows and builds their report for `today`. */
export function loadReport(db: Db, child: ChildProfile, today: string): Report {
  const events = db.all<EventRow>('SELECT child_id, session_id, at, type, payload FROM event WHERE child_id = ? ORDER BY rowid', [child.id]);
  return buildReport(events, masteryRows(db, child.id), child, today);
}
