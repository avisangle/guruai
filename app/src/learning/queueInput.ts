// Reads a child's QueueInput from SQLite and the bundled catalogue, for buildTodayQueue().
import lessonsJson from '../content/generated/lessons.json';
import pathsJson from '../content/generated/paths.json';
import type { Db } from '../data/db';
import type { ChildProfile } from '../data/types';
import type { Lesson } from '../lesson/types';
import { pathsFor } from './enrol';
import { dueRevision } from './mastery';
import { resumePosition, savedLessons } from './positions';
import type { QueueInput } from './queue';
import { lessonsDoneToday } from './session';

const LESSONS = lessonsJson as unknown as Lesson[];
const BY_ID = new Map(LESSONS.map((l) => [l.template_id, l]));
const LESSON_LANG: Record<string, string> = Object.fromEntries(
  LESSONS.flatMap((l) => (l.learning_language ? [[l.template_id, l.learning_language.slice(0, 2)]] : [])),
);
const PATHS = new Map(pathsJson.paths.map((p) => [p.path_id, p]));

/** The lesson's catalogue title, or its id when the catalogue does not list it. */
export const lessonTitle = (templateId: string) => BY_ID.get(templateId)?.title ?? templateId;

/** Lessons with a resumable position, newest first (D-GURU-20-in-progress-is-resumable). */
function openPositions(db: Db, childId: string): string[] {
  return savedLessons(db, childId).filter((id) => {
    const lesson = BY_ID.get(id);
    return lesson && resumePosition(db, childId, lesson);
  });
}

/** The child's queue inputs on the local day `today` ('YYYY-MM-DD'); only unfinished assignments. */
export function readQueueInput(db: Db, child: ChildProfile, today: string, isInstalled: (id: string) => boolean): QueueInput {
  const ids = (sql: string) => db.all<{ id: string }>(sql, [child.id]).map((r) => r.id);
  const enrolled = new Set(ids('SELECT path_id AS id FROM path_enrollment WHERE child_id = ?'));
  return {
    today,
    goal: child.lessons_per_day,
    doneToday: lessonsDoneToday(db, child.id, today),
    inProgress: openPositions(db, child.id),
    assignments: db.all<QueueInput['assignments'][number]>(
      'SELECT template_id, for_date, done_at FROM assignment WHERE child_id = ? AND done_at IS NULL ORDER BY for_date',
      [child.id],
    ),
    // Enrolled paths in pathsFor() order (class path, then goals); creation order changes when a class changes.
    paths: pathsFor(child).flatMap(([id]) => {
      const path = enrolled.has(id) ? PATHS.get(id) : undefined;
      return path ? [path] : [];
    }),
    // Most recently finished first.
    finished: ids(
      `SELECT json_extract(payload, '$.template_id') AS id FROM event
       WHERE child_id = ? AND type = 'lesson_end' GROUP BY id ORDER BY MAX(at) DESC`,
    ),
    due: dueRevision(db, child.id, today).map(({ item_key, lang }) => ({ item_key, lang })),
    lessonLang: LESSON_LANG,
    isInstalled,
  };
}
