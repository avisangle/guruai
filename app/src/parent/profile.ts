// Saving the child profile form: create or update, mark every setup section reviewed, re-enrol.
import type { Db } from '../data/db';
import { createChild, getChild, updateChild } from '../data/profiles';
import type { ChildProfile, Medium, StyleLevel } from '../data/types';
import { queueChildPacks } from '../downloads/downloader';
import { ensureEnrolment } from '../learning/enrol';
import { SETUP_SECTIONS } from './setup';

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
  const { nickname, picture, class: cls, medium, ...rest } = values;
  const childId = id ?? createChild(db, { nickname, picture, class: cls, medium }).id;
  const before = getChild(db, childId)!;
  const child = updateChild(db, childId, {
    nickname,
    picture,
    class: cls,
    medium,
    ...rest,
    setup_done: [...new Set([...before.setup_done, ...SETUP_SECTIONS])],
  })!;
  ensureEnrolment(db, child);
  queueChildPacks(child).catch(() => undefined); // background; the downloader retries on next start
  return child;
}
