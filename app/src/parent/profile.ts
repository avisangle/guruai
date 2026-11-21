// The child profile's class list and goal defaults, and saving the profile form: create or update,
// mark every setup section reviewed, re-enrol.
import paths from '../content/generated/paths.json';
import type { Db } from '../data/db';
import { createChild, getChild, updateChild } from '../data/profiles';
import type { ChildProfile, Medium, StyleLevel } from '../data/types';
import { queueChildPacks } from '../downloads/downloader';
import { ensureEnrolment } from '../learning/enrol';
import { SETUP_SECTIONS } from './setup';

export const CLASSES = ['Nursery', 'LKG', 'UKG', 'Class1', 'Class2'] as const;
/** Goals a new child starts with, by class. */
export const DEFAULT_GOALS: Record<string, string[]> = paths.goals;

export type ProfileValues = {
  nickname: string;
  picture: string;
  class: string;
  board: string;
  medium: Medium;
  goals: string[];
  style_level: StyleLevel;
  style_locked: boolean;
  lessons_per_day: number;
  active_cap_min: number | null;
};

/** `id` null adds a child. The form shows every setup section, so saving it reviews them all. */
export function saveProfile(db: Db, id: string | null, values: ProfileValues): ChildProfile {
  const before = id ? getChild(db, id)! : createChild(db, values);
  const child = updateChild(db, before.id, { ...values, setup_done: [...new Set([...before.setup_done, ...SETUP_SECTIONS])] })!;
  ensureEnrolment(db, child);
  queueChildPacks(child).catch(() => undefined); // background; the downloader retries on next start
  return child;
}
