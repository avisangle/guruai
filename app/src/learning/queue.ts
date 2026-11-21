// Today's queue (PRD Learning model; wireframes c-queue, c-queue-mid, c-queue-first).
// Lessons fill the daily goal in order: a lesson in progress, assigned lessons (unfinished
// ones from earlier days first, decision 14), then the next lesson of each active path.
// Due revision rides along in lessons and never counts toward the goal.
import type { ItemMastery } from './mastery';

/** A due revision item, as returned by dueRevision(). */
export type DueItem = Pick<ItemMastery, 'item_key' | 'lang'>;

export type QueueInput = {
  today: string; // 'YYYY-MM-DD'
  goal: number; // child.lessons_per_day
  doneToday: number; // lesson_end events today, repeats included
  inProgress: string[]; // template ids with a resumable lesson_position (current version, not finished)
  assignments: { template_id: string; for_date: string; done_at: string | null }[];
  paths: { path_id: string; units: { unit_id: string; lessons: string[] }[] }[]; // active, enrolment order
  finished: string[]; // template ids with any lesson_end
  due: DueItem[]; // dueRevision(db, childId, today)
  lessonLang: Record<string, string>; // template id -> 'mr' | 'en'
  isInstalled: (templateId: string) => boolean;
};

export type LessonStop = { kind: 'lesson'; template_id: string; revision: DueItem[] };
export type RevisionStop = { kind: 'revision'; items: DueItem[] };
export type Stop = LessonStop | RevisionStop;

export type TodayQueue = {
  stops: Stop[];
  goal: number;
  done: number;
  goalMet: boolean;
  /** Lessons that would be queued but whose audio pack is not on the phone. */
  waitingForDownload: string[];
};

const REVISION_PER_LESSON = 3;
const REVISION_STOP_MAX = 8; // about 2 to 3 minutes

/** Lesson candidates in queue order, without repeats. */
function candidates(input: QueueInput): string[] {
  const assigned = input.assignments
    .filter((a) => a.done_at === null && a.for_date <= input.today)
    .sort((a, b) => a.for_date.localeCompare(b.for_date))
    .map((a) => a.template_id);

  const picked = new Set([...input.inProgress, ...assigned]);
  const finished = new Set(input.finished);
  // Each path offers only its next lesson. If that lesson is not installed it waits;
  // the path does not skip ahead, since lessons build on the ones before.
  for (const path of input.paths) {
    const next = path.units.flatMap((u) => u.lessons).find((id) => !finished.has(id) && !picked.has(id));
    if (next) picked.add(next);
  }
  return [...picked];
}

/** Builds today's stops from plain data; reads no clock or database. */
export function buildTodayQueue(input: QueueInput): TodayQueue {
  const room = Math.max(0, input.goal - input.doneToday);
  const lessons: LessonStop[] = [];
  const waitingForDownload: string[] = [];
  let due = input.due;
  for (const id of candidates(input)) {
    if (!input.isInstalled(id)) waitingForDownload.push(id);
    else if (lessons.length < room) {
      const revision = due.filter((d) => d.lang === input.lessonLang[id]).slice(0, REVISION_PER_LESSON);
      due = due.filter((d) => !revision.includes(d));
      lessons.push({ kind: 'lesson', template_id: id, revision });
    }
  }

  const stops: Stop[] = [...lessons];
  if (due.length > 0) stops.splice(1, 0, { kind: 'revision', items: due.slice(0, REVISION_STOP_MAX) });

  return { stops, goal: input.goal, done: input.doneToday, goalMet: input.doneToday >= input.goal, waitingForDownload };
}
