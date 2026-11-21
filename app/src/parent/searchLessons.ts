// Lesson search for the assign screen (wireframe pm-assign): by lesson name or by a word it teaches.
// English words are found in Latin letters ("apple"), Marathi in Devanagari ("आगगाडी").
import type { Lesson } from '../lesson/types';

/** Latin words of a caption; its Devanagari is the voice text and is not searched. */
const latinWords = (caption: string) => caption.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g)?.join(' ') ?? '';

const captionText = (captions: Record<string, string> | undefined) => Object.values(captions ?? {}).map(latinWords);

/** One lowercase line per searchable field: title, item displays, anchor words, caption Latin words. */
function haystack(lesson: Lesson): string {
  return [
    lesson.title,
    ...captionText(lesson.captions),
    ...lesson.items.flatMap((item) => [item.display, item.anchor.word, ...captionText(item.captions)]),
  ]
    .join('\n')
    .toLowerCase();
}

/** Template ids of the lessons in `index` matching `query`, case-insensitively, in index order; all for a blank query. */
export function searchLessons(index: readonly Lesson[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return index.filter((lesson) => q === '' || haystack(lesson).includes(q)).map((l) => l.template_id);
}
