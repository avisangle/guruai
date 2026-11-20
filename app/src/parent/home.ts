// Parent home per child (wireframes pm-home, pm-home-2). Sections in decision 23 order:
// Up next, waiting for download, Pending, Revision due, Completed (collapsed).
import lessonsJson from '../content/generated/lessons.json';
import pathsJson from '../content/generated/paths.json';
import type { Db } from '../data/db';
import type { ChildProfile } from '../data/types';
import { dueRevision } from '../learning/mastery';
import { buildTodayQueue, type DueItem, type QueueInput, type TodayQueue } from '../learning/queue';
import { lessonsDoneToday } from '../learning/session';

export type HomeSection =
  | { id: 'upNext' | 'waiting' | 'pending'; lessons: string[] }
  | { id: 'revision'; items: DueItem[] }
  | { id: 'completed'; lessons: string[]; collapsed: boolean };

export type HomeInput = Pick<QueueInput, 'inProgress' | 'assignments' | 'finished' | 'due'> & { queue: TodayQueue };

/** Pending is every started or assigned lesson that is not finished and not already listed above it. */
export function homeSections({ queue, inProgress, assignments, finished, due }: HomeInput): HomeSection[] {
  const upNext = queue.stops.flatMap((s) => (s.kind === 'lesson' ? [s.template_id] : []));
  const waiting = queue.waitingForDownload;
  const listed = new Set([...upNext, ...waiting, ...finished]);
  const open = [...inProgress, ...assignments.filter((a) => a.done_at === null).map((a) => a.template_id)];
  const pending = [...new Set(open)].filter((id) => !listed.has(id));
  return [
    { id: 'upNext', lessons: upNext },
    ...(waiting.length > 0 ? [{ id: 'waiting' as const, lessons: waiting }] : []),
    { id: 'pending', lessons: pending },
    { id: 'revision', items: due },
    { id: 'completed', lessons: finished, collapsed: true },
  ];
}

type LessonInfo = { template_id: string; title: string; learning_language?: string };
const LESSONS = lessonsJson as unknown as LessonInfo[];
const TITLES = new Map(LESSONS.map((l) => [l.template_id, l.title]));
const LESSON_LANG: Record<string, string> = Object.fromEntries(
  LESSONS.flatMap((l) => (l.learning_language ? [[l.template_id, l.learning_language.slice(0, 2)]] : [])),
);
const PATHS = new Map(pathsJson.paths.map((p) => [p.path_id, p]));

export const lessonTitle = (templateId: string) => TITLES.get(templateId) ?? templateId;

export type ChildHome = {
  done: number;
  goal: number;
  sections: HomeSection[];
  /** Unfinished lessons assigned for today or carried over from earlier days. */
  assigned: string[];
};

/** Reads the child's queue inputs and builds their home on the local day `today` ('YYYY-MM-DD'). */
export function loadChildHome(db: Db, child: ChildProfile, today: string, isInstalled: (id: string) => boolean): ChildHome {
  const ids = (sql: string) => db.all<{ id: string }>(sql, [child.id]).map((r) => r.id);
  const inProgress = ids('SELECT template_id AS id FROM lesson_position WHERE child_id = ? ORDER BY updated_at DESC');
  const finished = ids(
    `SELECT json_extract(payload, '$.template_id') AS id FROM event
     WHERE child_id = ? AND type = 'lesson_end' GROUP BY id ORDER BY MAX(at) DESC`,
  );
  const paths = ids('SELECT path_id AS id FROM path_enrollment WHERE child_id = ? ORDER BY created_at').flatMap((id) => {
    const path = PATHS.get(id);
    return path ? [path] : [];
  });
  const assignments = db.all<QueueInput['assignments'][number]>(
    'SELECT template_id, for_date, done_at FROM assignment WHERE child_id = ? AND done_at IS NULL ORDER BY for_date',
    [child.id],
  );
  const due = dueRevision(db, child.id, today).map(({ item_key, lang }) => ({ item_key, lang }));
  const done = lessonsDoneToday(db, child.id, today);
  const goal = child.lessons_per_day;

  const queue = buildTodayQueue({
    today,
    goal,
    doneToday: done,
    inProgress,
    assignments,
    paths,
    finished,
    due,
    lessonLang: LESSON_LANG,
    isInstalled,
  });
  return {
    done,
    goal,
    sections: homeSections({ queue, inProgress, assignments, finished, due }),
    assigned: assignments.filter((a) => a.for_date <= today).map((a) => a.template_id),
  };
}
