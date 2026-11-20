// /lesson/<template>?child=<id>&stop=<LessonStop JSON>: one lesson for a child, inside their
// open session. Resumes at the saved answer; a finished lesson starts over.
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import lessonsJson from '../../content/generated/lessons.json';
import { now } from '../../data/db';
import { liveDb } from '../../data/liveDb';
import { getChild } from '../../data/profiles';
import { loadPosition } from '../../learning/positions';
import type { DueItem, LessonStop } from '../../learning/queue';
import { openSession, startSession } from '../../learning/session';
import { isFinished } from '../../lesson/engine';
import { LessonPlayer, type LessonPlayerProps } from '../../lesson/LessonPlayer';
import type { Lesson, Position, RevisionItem } from '../../lesson/types';

const LESSONS = lessonsJson as unknown as Lesson[];

// Revision items from the stop, plus any the saved quiz order still names (a resume must pass
// the same ones, D-GURU-19-tutor-variety). Never this lesson's own items.
function revisionItems(lesson: Lesson, due: DueItem[], saved: Position | null): RevisionItem[] {
  const own = new Set(lesson.items.map((i) => i.item_key));
  const found = new Map<string, RevisionItem>();
  const add = (r: RevisionItem | undefined) => {
    if (r && !own.has(r.item.item_key)) found.set(`${r.template_id}.${r.item.id}`, r);
  };
  for (const ref of saved?.quiz ?? []) {
    const dot = ref.lastIndexOf('.');
    if (dot < 0) continue;
    const from = LESSONS.find((l) => l.template_id === ref.slice(0, dot));
    const item = from?.items.find((i) => i.id === ref.slice(dot + 1));
    add(from && item && { template_id: from.template_id, item });
  }
  for (const d of due) {
    for (const l of LESSONS) {
      const item = l.items.find((i) => i.item_key === d.item_key && i.target_lang === d.lang);
      if (item) {
        add({ template_id: l.template_id, item });
        break;
      }
    }
  }
  return [...found.values()];
}

function parseStop(raw: string | undefined): DueItem[] {
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as LessonStop).revision ?? [];
  } catch {
    return [];
  }
}

function load(template: string, childId: string, stop: string | undefined): LessonPlayerProps | null {
  const lesson = LESSONS.find((l) => l.template_id === template);
  const db = liveDb();
  const child = childId ? getChild(db, childId) : null;
  if (!lesson || !child) return null;
  const saved = loadPosition(db, child.id, lesson.template_id, lesson.version);
  const start = saved && !isFinished(lesson, saved) ? saved : null;
  // GURU-29 opens the session when the child taps their face; a lesson opened another way gets one
  const sessionId = openSession(db, child.id) ?? startSession(db, child.id, now());
  return {
    lesson,
    childId: child.id,
    sessionId,
    styleLevel: child.style_level,
    revision: revisionItems(lesson, parseStop(stop), start),
    start,
  };
}

export default function LessonRoute() {
  const { template, child, stop } = useLocalSearchParams<{ template: string; child: string; stop?: string }>();
  const [props] = useState(() => load(template, child, stop));
  if (!props) return <Redirect href="/" />;
  return <LessonPlayer {...props} />;
}
