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
import { revisionFor } from '../../lesson/revision';
import type { Lesson } from '../../lesson/types';

const LESSONS = lessonsJson as unknown as Lesson[];

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
    revision: revisionFor(LESSONS, lesson, parseStop(stop), start),
    start,
  };
}

export default function LessonRoute() {
  const { template, child, stop } = useLocalSearchParams<{ template: string; child: string; stop?: string }>();
  const [props] = useState(() => load(template, child, stop));
  if (!props) return <Redirect href="/" />;
  return <LessonPlayer {...props} />;
}
