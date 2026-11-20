// Child profiles. Defaults not set here (lessons_per_day, active_cap_min, tutor,
// goals, setup_done) come from the column defaults in migrations.ts.
import { getRandomBytes, randomUUID } from 'expo-crypto';

import { now, type Db, type SqlParam } from './db';
import type { ChildProfile, ChildUpdate, Ids, NewChild } from './types';

type ChildRow = Omit<ChildProfile, 'goals' | 'setup_done' | 'style_locked' | 'archived'> & {
  goals: string;
  setup_done: string;
  style_locked: number;
  archived: number;
};

// 32 symbols (A-Z without O and I, then 2-9), so byte % 32 is unbiased.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomChildCode(): string {
  return Array.from(getRandomBytes(4), (b) => CODE_ALPHABET[b % 32]).join('');
}

// Whitelist: column names are interpolated into SQL.
const UPDATABLE = [
  'nickname',
  'picture',
  'class',
  'board',
  'medium',
  'goals',
  'style_level',
  'style_locked',
  'lessons_per_day',
  'active_cap_min',
  'tutor',
  'setup_done',
  'archived',
] as const satisfies readonly (keyof ChildUpdate)[];

function toChild(row: ChildRow): ChildProfile {
  return {
    ...row,
    goals: JSON.parse(row.goals),
    setup_done: JSON.parse(row.setup_done),
    style_locked: row.style_locked === 1,
    archived: row.archived === 1,
  };
}

export function getChild(db: Db, id: string): ChildProfile | null {
  const row = db.get<ChildRow>('SELECT * FROM child_profile WHERE id = ?', [id]);
  return row ? toChild(row) : null;
}

/** Children not archived, oldest first. */
export function listChildren(db: Db): ChildProfile[] {
  return db
    .all<ChildRow>('SELECT * FROM child_profile WHERE archived = 0 ORDER BY created_at, rowid')
    .map(toChild);
}

export function createChild(db: Db, input: NewChild, ids: Ids = {}): ChildProfile {
  const uuid = ids.uuid ?? randomUUID;
  const drawCode = ids.childCode ?? randomChildCode;

  // child_code is unique on the device, archived children included.
  let code = drawCode();
  while (db.get('SELECT 1 FROM child_profile WHERE child_code = ?', [code])) code = drawCode();

  const id = uuid();
  const at = now();
  db.run(
    `INSERT INTO child_profile
      (id, nickname, picture, class, board, medium, style_level, child_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'msb', ?, ?, ?, ?, ?)`,
    [
      id,
      input.nickname,
      input.picture,
      input.class,
      input.medium,
      input.medium === 'en' ? 'en_led' : 'mr_led',
      code,
      at,
      at,
    ],
  );
  return getChild(db, id)!;
}

/** Updates the given fields; returns the updated child, or null if the id is unknown. */
export function updateChild(db: Db, id: string, patch: ChildUpdate): ChildProfile | null {
  const columns = UPDATABLE.filter((c) => patch[c] !== undefined);
  // Array fields (goals, setup_done) are stored as JSON text.
  const values: SqlParam[] = columns.map((c) => {
    const v = patch[c];
    return Array.isArray(v) ? JSON.stringify(v) : (v as SqlParam);
  });
  const sets = [...columns.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ');
  db.run(`UPDATE child_profile SET ${sets} WHERE id = ?`, [...values, now(), id]);
  return getChild(db, id);
}
