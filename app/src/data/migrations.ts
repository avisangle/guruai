// Schema migrations keyed by PRAGMA user_version: migration n sets version n.
// Never edit a shipped migration; append a new one. Schema: TDD 2.6 (Epic GURU-1).
import type { Db } from './db';

// Every table: random text id plus created_at/updated_at (ISO) for M2 sync.
const table = (name: string, columns: string) =>
  `CREATE TABLE ${name} (
    id TEXT PRIMARY KEY,
    ${columns},
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`;

const MIGRATIONS: string[] = [
  [
    table(
      'device',
      `device_id TEXT NOT NULL,
      parent_lang TEXT NOT NULL DEFAULT 'mr',
      allow_mobile_data INTEGER NOT NULL DEFAULT 0,
      consent_clips INTEGER,
      consent_summaries INTEGER,
      consent_answered_at TEXT,
      judge_check TEXT,
      judge_p90_ms INTEGER,
      mic_last_granted_at TEXT`,
    ),
    table(
      'child_profile',
      `nickname TEXT NOT NULL,
      picture TEXT NOT NULL,
      class TEXT NOT NULL,
      board TEXT NOT NULL,
      medium TEXT NOT NULL,
      goals TEXT NOT NULL DEFAULT '[]',
      style_level TEXT NOT NULL,
      style_locked INTEGER NOT NULL DEFAULT 0,
      lessons_per_day INTEGER NOT NULL DEFAULT 3,
      active_cap_min INTEGER DEFAULT 30,
      tutor TEXT NOT NULL DEFAULT 'shekru',
      child_code TEXT NOT NULL UNIQUE,
      setup_done TEXT NOT NULL DEFAULT '[]',
      archived INTEGER NOT NULL DEFAULT 0`,
    ),
    table(
      'parent_gate',
      `mode TEXT NOT NULL DEFAULT 'device',
      failed INTEGER NOT NULL DEFAULT 0,
      lockout_until TEXT,
      lockout_stage INTEGER NOT NULL DEFAULT 0`,
    ),
    table('learning_path', `kind TEXT NOT NULL, title TEXT NOT NULL`),
    table('path_unit', `path_id TEXT NOT NULL, seq INTEGER NOT NULL, template_id TEXT NOT NULL`),
    table('path_enrollment', `child_id TEXT NOT NULL, path_id TEXT NOT NULL, source TEXT NOT NULL`),
    table(
      'assignment',
      `child_id TEXT NOT NULL, template_id TEXT NOT NULL, for_date TEXT NOT NULL, done_at TEXT`,
    ),
    table(
      'lesson_position',
      `child_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      position TEXT NOT NULL`,
    ),
    table(
      'session',
      `child_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      parent_helps INTEGER NOT NULL DEFAULT 0,
      active_ms INTEGER NOT NULL DEFAULT 0`,
    ),
    // Append-only: rows are inserted, never updated or deleted.
    table(
      'event',
      `child_id TEXT NOT NULL, session_id TEXT, at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL`,
    ),
    // Derived from events; can be dropped and rebuilt.
    table(
      'item_mastery',
      `child_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      lang TEXT NOT NULL,
      state TEXT NOT NULL,
      streak INTEGER NOT NULL DEFAULT 0,
      interval_days INTEGER NOT NULL DEFAULT 0,
      next_due TEXT,
      last_result TEXT`,
    ),
    table(
      'pack_install',
      `pack_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      bytes_done INTEGER NOT NULL DEFAULT 0,
      bytes_total INTEGER,
      sha256 TEXT,
      path TEXT`,
    ),
    table(
      'upload_item',
      `kind TEXT NOT NULL,
      path TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0`,
    ),
    'CREATE UNIQUE INDEX lesson_position_child_template ON lesson_position (child_id, template_id);',
    'CREATE UNIQUE INDEX item_mastery_key ON item_mastery (child_id, item_key, lang);',
    'CREATE INDEX event_child_at ON event (child_id, at);',
    'CREATE INDEX item_mastery_child_due ON item_mastery (child_id, next_due);',
    'CREATE INDEX assignment_child_date ON assignment (child_id, for_date);',
  ].join('\n'),
];

/** Applies every migration above the database's user_version, each in its own transaction. */
export function migrate(db: Db): void {
  const current = db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version - 1]);
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}
