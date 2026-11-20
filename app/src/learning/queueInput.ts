// Reads a child's QueueInput from SQLite and the bundled catalogue, for buildTodayQueue().
import lessonsJson from '../content/generated/lessons.json';
import pathsJson from '../content/generated/paths.json';
import type { Db } from '../data/db';
import type { ChildProfile } from '../data/types';
import type { Lesson } from '../lesson/types';
import { dueRevision } from './mastery';
import type { QueueInput } from './queue';
import { lessonsDoneToday } from './session';

const LESSONS = lessonsJson as unknown as Lesson[];
const TITLES = new Map(LESSONS.map((l) => [l.template_id, l.title]));
const LESSON_LANG: Record<string, string> = Object.fromEntries(
  LESSONS.flatMap((l) => (l.learning_language ? [[l.template_id, l.learning_language.slice(0, 2)]] : [])),
);
const PATHS = new Map(pathsJson.paths.map((p) => [p.path_id, p]));

/** The lesson's catalogue title, or its id when the catalogue does not list it. */
export const lessonTitle = (templateId: string) => TITLES.get(templateId) ?? templateId;

/** The child's queue inputs on the local day `today` ('YYYY-MM-DD'); only unfinished assignments. */
export function readQueueInput(db: Db, child: ChildProfile, today: string, isInstalled: (id: string) => boolean): QueueInput {
  const ids = (sql: string) => db.all<{ id: string }>(sql, [child.id]).map((r) => r.id);
  return {
    today,
    goal: child.lessons_per_day,
    doneToday: lessonsDoneToday(db, child.id, today),
    inProgress: ids('SELECT template_id AS id FROM lesson_position WHERE child_id = ? ORDER BY updated_at DESC'),
    assignments: db.all<QueueInput['assignments'][number]>(
      'SELECT template_id, for_date, done_at FROM assignment WHERE child_id = ? AND done_at IS NULL ORDER BY for_date',
      [child.id],
    ),
    paths: ids('SELECT path_id AS id FROM path_enrollment WHERE child_id = ? ORDER BY created_at').flatMap((id) => {
      const path = PATHS.get(id);
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
