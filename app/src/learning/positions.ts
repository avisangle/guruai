// Where a child left each lesson, per child and template, so a lesson can resume.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from '../data/db';
import { isFinished } from '../lesson/engine';
import type { Lesson, Position } from '../lesson/types';

/** Inserts or replaces the child's position in a template. */
export function savePosition(db: Db, childId: string, templateId: string, position: Position): void {
  const stamp = now();
  db.run(
    `INSERT INTO lesson_position (id, child_id, template_id, version, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (child_id, template_id) DO UPDATE SET
       version = excluded.version, position = excluded.position, updated_at = excluded.updated_at`,
    [randomUUID(), childId, templateId, position.version, JSON.stringify(position), stamp, stamp],
  );
}

/** The saved position, or null if none is saved or it was saved for another lesson version. */
export function loadPosition(db: Db, childId: string, templateId: string, version: number): Position | null {
  const row = db.get<{ position: string }>(
    'SELECT position FROM lesson_position WHERE child_id = ? AND template_id = ? AND version = ?',
    [childId, templateId, version],
  );
  return row ? JSON.parse(row.position) : null;
}

/** The position the lesson resumes from: saved for its current version and not finished (D-GURU-20-in-progress-is-resumable). */
export function resumePosition(db: Db, childId: string, lesson: Lesson): Position | null {
  const saved = loadPosition(db, childId, lesson.template_id, lesson.version);
  return saved && !isFinished(lesson, saved) ? saved : null;
}

/** Template ids with a saved position for the child, newest first. */
export function savedLessons(db: Db, childId: string): string[] {
  return db
    .all<{ id: string }>('SELECT template_id AS id FROM lesson_position WHERE child_id = ? ORDER BY updated_at DESC', [childId])
    .map((r) => r.id);
}
