// GURU-4: local SQLite foundation. Schema source: TDD 2.6 in Epic GURU-1
// (no migrations exist yet; these tests define them). Every table has
// `id TEXT PRIMARY KEY`, `created_at`, `updated_at`; child and session
// references are `child_id` and `session_id` (TDD 2.3, index spec).
import * as fs from 'fs';
import * as path from 'path';

import { openDb, type Db } from './db';
import { createChild, getChild, listChildren, updateChild } from './profiles';
import { getDevice } from './device';
import { migrate } from './migrations';
import { createTestDb } from './testDb';

// Default id generator is expo-crypto (not installed yet, hence virtual).
jest.mock(
  'expo-crypto',
  () => {
    const nodeCrypto = jest.requireActual('crypto');
    let calls = 0;
    return {
      randomUUID: jest.fn(() => `uuid-from-expo-crypto-${++calls}`),
      getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
      getRandomValues: <T extends ArrayBufferView>(a: T) => nodeCrypto.webcrypto.getRandomValues(a),
    };
  },
  { virtual: true },
);

// openDb() must wrap expo-sqlite; the fake records what it was opened with.
const mockExpoDb = {
  execSync: jest.fn(),
  runSync: jest.fn(),
  getAllSync: jest.fn(() => []),
  getFirstSync: jest.fn(() => null),
  withTransactionSync: jest.fn((fn: () => void) => fn()),
};
jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn(() => mockExpoDb) }));

const TABLES: Record<string, string[]> = {
  device: [
    'device_id',
    'parent_lang',
    'allow_mobile_data',
    'consent_clips',
    'consent_summaries',
    'consent_answered_at',
    'judge_check',
    'judge_p90_ms',
    'mic_last_granted_at',
  ],
  child_profile: [
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
    'child_code',
    'setup_done',
    'archived',
  ],
  parent_gate: ['mode', 'failed', 'lockout_until', 'lockout_stage'],
  learning_path: [],
  path_unit: [],
  path_enrollment: ['child_id', 'path_id', 'source'],
  assignment: ['child_id', 'template_id', 'for_date', 'done_at'],
  lesson_position: ['child_id', 'template_id', 'version', 'position'],
  session: ['child_id', 'started_at', 'ended_at', 'end_reason', 'parent_helps', 'active_ms'],
  event: ['child_id', 'session_id', 'at', 'type', 'payload'],
  item_mastery: [
    'child_id',
    'item_key',
    'lang',
    'state',
    'streak',
    'interval_days',
    'next_due',
    'last_result',
  ],
  pack_install: ['pack_id', 'version', 'status', 'bytes_done', 'bytes_total', 'sha256', 'path'],
  upload_item: ['kind', 'path', 'session_id', 'status', 'attempts'],
};

const CHILD_CODE = /^[A-HJ-NP-Z2-9]{4}$/; // A-Z and 2-9, without O and I

type Col = { name: string; type: string; pk: number };

function userVersion(db: Db): number {
  return db.get<{ user_version: number }>('PRAGMA user_version', [])!.user_version;
}

function tableNames(db: Db): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'", [])
    .map((r) => r.name);
}

function indexedColumnLists(db: Db, table: string): string[][] {
  return db.all<{ name: string }>(`PRAGMA index_list(${table})`, []).map((ix) =>
    db
      .all<{ seqno: number; name: string }>(`PRAGMA index_info(${ix.name})`, [])
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name),
  );
}

function freshDb(): Db {
  const db = createTestDb();
  migrate(db);
  return db;
}

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe('migrate', () => {
  test('creates every TDD 2.6 table, column and index, and records the version', () => {
    const db = freshDb();

    expect(userVersion(db)).toBeGreaterThan(0);
    expect(tableNames(db)).toEqual(expect.arrayContaining(Object.keys(TABLES)));

    for (const [table, columns] of Object.entries(TABLES)) {
      const cols = db.all<Col>(`PRAGMA table_info(${table})`, []);
      const names = cols.map((c) => c.name);
      expect({ table, names }).toEqual({
        table,
        names: expect.arrayContaining(['id', 'created_at', 'updated_at', ...columns]),
      });
      const pk = cols.filter((c) => c.pk > 0);
      expect({ table, pk: pk.map((c) => [c.name, c.type.toUpperCase()]) }).toEqual({
        table,
        pk: [['id', 'TEXT']],
      });
    }

    expect(indexedColumnLists(db, 'event')).toContainEqual(['child_id', 'at']);
    expect(indexedColumnLists(db, 'item_mastery')).toContainEqual(['child_id', 'next_due']);
    expect(indexedColumnLists(db, 'assignment')).toContainEqual(['child_id', 'for_date']);
  });

  test('is a no-op when run again, and skips migrations at or below user_version', () => {
    const db = freshDb();
    const version = userVersion(db);
    const child = createChild(db, { nickname: 'Ira', picture: 'squirrel', class: 'UKG', medium: 'en' });

    expect(() => migrate(db)).not.toThrow();
    expect(userVersion(db)).toBe(version);
    expect(getChild(db, child.id)).toEqual(child);

    // A database already past every known migration is left untouched.
    const ahead = createTestDb();
    ahead.exec('PRAGMA user_version = 999');
    migrate(ahead);
    expect(userVersion(ahead)).toBe(999);
    expect(tableNames(ahead)).not.toContain('device');
  });
});

describe('Db adapter', () => {
  test('transaction returns the callback result and rolls back everything when it throws', () => {
    const db = createTestDb();
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

    const result = db.transaction(() => {
      db.run('INSERT INTO t (id) VALUES (?)', ['a']);
      return 'done';
    });
    expect(result).toBe('done');
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (id) VALUES (?)', ['b']);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.all<{ id: string }>('SELECT id FROM t ORDER BY id', [])).toEqual([{ id: 'a' }]);
  });
});

describe('device', () => {
  test('getDevice creates the single row on first call and returns the same row after', () => {
    const db = freshDb();
    const first = getDevice(db, { uuid: counter('dev') });

    expect(first.device_id).toMatch(/^dev-\d+$/);
    expect(first.parent_lang).toBe('mr');
    expect(getDevice(db, { uuid: counter('other') })).toEqual(first);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device', [])!.n).toBe(1);

    // Without an injected generator the id comes from expo-crypto randomUUID.
    const other = freshDb();
    expect(getDevice(other).device_id).toMatch(/^uuid-from-expo-crypto-\d+$/);
  });
});

describe('child profiles', () => {
  test('createChild stores the form fields and fills defaults by medium', () => {
    const db = freshDb();
    const en = createChild(db, { nickname: 'Ira', picture: 'squirrel', class: 'UKG', medium: 'en' });
    const mr = createChild(db, { nickname: 'Aarav', picture: 'elephant', class: 'Class 1', medium: 'mr' });

    expect(en).toMatchObject({
      nickname: 'Ira',
      picture: 'squirrel',
      class: 'UKG',
      medium: 'en',
      board: 'msb',
      goals: [],
      style_level: 'en_led',
      lessons_per_day: 3,
      active_cap_min: 30,
      tutor: 'shekru',
    });
    expect(mr).toMatchObject({ medium: 'mr', style_level: 'mr_led', board: 'msb', lessons_per_day: 3 });
    expect(en.child_code).toMatch(CHILD_CODE);
    expect(mr.child_code).toMatch(CHILD_CODE);
    expect(en.id).not.toBe(mr.id);
    expect(getChild(db, en.id)).toEqual(en);
  });

  test('child_code is redrawn until it is unique on the device', () => {
    const db = freshDb();
    const codes = ['K7PX', 'K7PX', 'K7PX', 'M3RT'];
    const ids = { uuid: counter('child'), childCode: () => codes.shift()! };

    const a = createChild(db, { nickname: 'A', picture: 'squirrel', class: 'UKG', medium: 'en' }, ids);
    const b = createChild(db, { nickname: 'B', picture: 'elephant', class: 'UKG', medium: 'en' }, ids);

    expect(a.child_code).toBe('K7PX');
    expect(b.child_code).toBe('M3RT');
  });

  test('updateChild changes fields, listChildren hides archived children, getChild of an unknown id is null', () => {
    const db = freshDb();
    const a = createChild(db, { nickname: 'A', picture: 'squirrel', class: 'UKG', medium: 'en' });
    const b = createChild(db, { nickname: 'B', picture: 'elephant', class: 'LKG', medium: 'mr' });

    updateChild(db, a.id, { nickname: 'Anu', lessons_per_day: 5 });
    expect(getChild(db, a.id)).toMatchObject({ nickname: 'Anu', lessons_per_day: 5, picture: 'squirrel' });

    updateChild(db, b.id, { archived: true });
    expect(listChildren(db).map((c) => c.id)).toEqual([a.id]);
    expect(getChild(db, b.id)?.archived).toBeTruthy();

    expect(getChild(db, 'no-such-child')).toBeNull();
  });
});

describe('event log', () => {
  test('the data layer never updates or deletes event rows', () => {
    const dir = __dirname;
    const sources = fs
      .readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

    expect(sources).toEqual(expect.arrayContaining(['db.ts', 'migrations.ts', 'profiles.ts']));
    for (const file of sources) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect({ file, update: /\bUPDATE\s+event\b/i.test(text) }).toEqual({ file, update: false });
      expect({ file, del: /\bDELETE\s+FROM\s+event\b/i.test(text) }).toEqual({ file, del: false });
    }
  });
});

// Contract for GURU-12, GURU-13, GURU-14, GURU-15, GURU-24: shapes only.
describe('contract: app/src/data exports for dependents', () => {
  test('Db, openDb, migrate, createTestDb and the device and profile repos keep their names and shapes', () => {
    const sqlite = jest.requireMock<{ openDatabaseSync: jest.Mock }>('expo-sqlite');

    expect(typeof openDb).toBe('function');
    const opened = openDb();
    expect(sqlite.openDatabaseSync).toHaveBeenCalledWith('guru.db');

    const testDb = createTestDb();
    for (const db of [opened, testDb]) {
      for (const method of ['exec', 'run', 'all', 'get', 'transaction'] as const) {
        expect(typeof db[method]).toBe('function');
      }
    }

    expect(typeof migrate).toBe('function');
    migrate(testDb);

    const device = getDevice(testDb);
    expect(device).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        device_id: expect.any(String),
        parent_lang: expect.any(String),
        created_at: expect.anything(),
        updated_at: expect.anything(),
      }),
    );
    expect(device).toHaveProperty('allow_mobile_data');
    expect(device).toHaveProperty('judge_check');
    expect(device).toHaveProperty('judge_p90_ms');

    const child = createChild(testDb, { nickname: 'C', picture: 'squirrel', class: 'UKG', medium: 'en' });
    expect(child).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        nickname: expect.any(String),
        child_code: expect.any(String),
        goals: expect.any(Array),
        style_level: expect.any(String),
      }),
    );
    expect(typeof updateChild).toBe('function');
    expect(Array.isArray(listChildren(testDb))).toBe(true);
    expect(getChild(testDb, child.id)).toEqual(expect.objectContaining({ id: child.id }));
  });
});
