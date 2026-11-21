// Lessons a parent assigns for a day. An unfinished assignment carries to the next day
// ahead of new ones (wireframe decision 14); buildTodayQueue does the carrying.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from '../data/db';

/** Assigns a lesson to the child for `date` ('YYYY-MM-DD'). */
export function assignLesson(db: Db, childId: string, templateId: string, date: string): void {
  const stamp = now();
  db.run(
    `INSERT INTO assignment (id, child_id, template_id, for_date, done_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    [randomUUID(), childId, templateId, date, stamp, stamp],
  );
}

/** Marks the child's open assignments of the lesson done at `at`; called when the lesson ends. */
export function completeAssignments(db: Db, childId: string, templateId: string, at: string): void {
  db.run('UPDATE assignment SET done_at = ?, updated_at = ? WHERE child_id = ? AND template_id = ? AND done_at IS NULL', [
    at,
    now(),
    childId,
    templateId,
  ]);
}
