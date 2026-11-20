// Revision items for one lesson run (D-GURU-19-tutor-variety).
import type { DueItem } from '../learning/queue';
import type { Lesson, Position, RevisionItem } from './types';

/** A revision item's entry in Position.quiz: `<template_id>.<item id>`. */
export const revisionRef = (r: RevisionItem) => `${r.template_id}.${r.item.id}`;

/**
 * The queue stop's due items, plus any the saved quiz order still names (a resume must pass the
 * same ones or the engine throws). Never the lesson's own items.
 */
export function revisionFor(lessons: Lesson[], lesson: Lesson, due: DueItem[], saved: Position | null): RevisionItem[] {
  const own = new Set(lesson.items.map((i) => i.item_key));
  const quiz = new Set(saved?.quiz ?? []);
  const wanted = new Set(due.map((d) => `${d.item_key}\n${d.lang}`));
  const found = new Map<string, RevisionItem>();
  for (const l of lessons) {
    for (const item of l.items) {
      if (own.has(item.item_key)) continue;
      const r = { template_id: l.template_id, item };
      const key = `${item.item_key}\n${item.target_lang}`;
      if (quiz.has(revisionRef(r))) found.set(key, r); // the saved run's copy wins
      else if (!found.has(key) && wanted.delete(key)) found.set(key, r); // first lesson that has a due item
    }
  }
  return [...found.values()];
}
