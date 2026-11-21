// Lesson search for the assign screen (wireframe pm-assign): by lesson name or by a word it teaches.
// English words are found in Latin letters ("apple"), Marathi in Devanagari ("आगगाडी").
import type { Lesson } from '../lesson/types';

/** The Latin words of each caption, space-joined so "ice cream" still matches; Devanagari is voice text. */
const latin = (captions?: Record<string, string>) =>
  Object.values(captions ?? {}).map((c) => c.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g)?.join(' ') ?? '');

const haystacks = new WeakMap<Lesson, string>();

/** One lowercase text per lesson: title, item displays, anchor words, caption Latin words. Built once per lesson. */
function haystack(lesson: Lesson): string {
  let text = haystacks.get(lesson);
  if (text === undefined) {
    text = [
      lesson.title,
      ...latin(lesson.captions),
      ...lesson.items.flatMap((item) => [item.display, item.anchor.word, ...latin(item.captions)]),
    ]
      .join('\n')
      .toLowerCase();
    haystacks.set(lesson, text);
  }
  return text;
}

/** Template ids of the lessons in `index` matching `query`, case-insensitively, in index order; all for a blank query. */
export function searchLessons(index: readonly Lesson[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return index.filter((lesson) => q === '' || haystack(lesson).includes(q)).map((l) => l.template_id);
}
