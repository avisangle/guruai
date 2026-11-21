// /lesson/<template>?child=<id>&stop=<LessonStop JSON>: one lesson for a child, inside their
// open session. Resumes at the saved answer; a finished lesson starts over.
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import lessonsJson from '../../content/generated/lessons.json';
import { now } from '../../data/db';
import { liveDb } from '../../data/liveDb';
import { getChild } from '../../data/profiles';
import { resumePosition } from '../../learning/positions';
import type { DueItem, LessonStop } from '../../learning/queue';
import { ensureSession } from '../../learning/session';
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
  const start = resumePosition(db, child.id, lesson);
  const sessionId = ensureSession(db, child.id, now());
  return {
    lesson,
    childId: child.id,
    sessionId,
    // Re-read: a session started just now settles the style level first (D-GURU-22).
    styleLevel: getChild(db, child.id)!.style_level,
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
