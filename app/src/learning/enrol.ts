// Path enrolment: the class path for the child's board and class, and one skill path
// per goal. Progress (lesson_position, item_mastery) is keyed by lesson and item, not
// path, so changing enrolment never touches it.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from '../data/db';
import type { ChildProfile } from '../data/types';

type Source = 'class' | 'skill';

/** Makes the child's enrolments match their board, class and goals; safe to call repeatedly. */
export function ensureEnrolment(db: Db, child: ChildProfile): void {
  const wanted = new Map<string, Source>([
    [`class_${child.board}_${child.class}`, 'class'],
    ...child.goals.map((goal): [string, Source] => [`skill_${goal}`, 'skill']),
  ]);

  db.transaction(() => {
    const current = db.all<{ id: string; path_id: string; source: string }>(
      'SELECT id, path_id, source FROM path_enrollment WHERE child_id = ?',
      [child.id],
    );
    for (const row of current) {
      if (wanted.get(row.path_id) === row.source) wanted.delete(row.path_id);
      else db.run('DELETE FROM path_enrollment WHERE id = ?', [row.id]);
    }
    const stamp = now();
    for (const [pathId, source] of wanted) {
      db.run(
        `INSERT INTO path_enrollment (id, child_id, path_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), child.id, pathId, source, stamp, stamp],
      );
    }
  });
}
