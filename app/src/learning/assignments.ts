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
