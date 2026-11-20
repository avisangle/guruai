// Saved progress for the one local child. localStorage is the browser's on
// web and SQLite-backed (expo-sqlite) on Android/iOS, so writes are synchronous.
import 'expo-sqlite/localStorage/install';

import type { Position } from '../lesson/types';

// Boolean mastery per item_key, kept here until the sessions issue derives mastery from answer events.
export type Mastery = Record<string, { mastered: boolean }>;

const CHILD = 'default';
const KEY = `guru.progress.v1.${CHILD}`;

// mastery is per child; positions are per lesson template
type Stored = { mastery: Mastery; lessons: Record<string, Position> };

function read(): Stored {
  try {
    const raw = globalThis.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // unreadable data: start over
  }
  return { mastery: {}, lessons: {} };
}

export function loadProgress(templateId: string): { position: Position | null; mastery: Mastery } {
  const stored = read();
  return { position: stored.lessons[templateId] ?? null, mastery: stored.mastery };
}

export function saveProgress(templateId: string, progress: { position: Position; mastery: Mastery }) {
  const stored = read();
  stored.mastery = progress.mastery;
  stored.lessons[templateId] = progress.position;
  globalThis.localStorage.setItem(KEY, JSON.stringify(stored));
}

export function resetProgress() {
  globalThis.localStorage.removeItem(KEY);
}

// The lesson picked on the home screen, kept across launches.
const LESSON_KEY = `guru.lesson.v1.${CHILD}`;

export function loadLessonChoice(): string | null {
  try {
    return globalThis.localStorage.getItem(LESSON_KEY);
  } catch {
    return null;
  }
}

export function saveLessonChoice(templateId: string) {
  globalThis.localStorage.setItem(LESSON_KEY, templateId);
}
