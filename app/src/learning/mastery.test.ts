// GURU-12: answer events, mastery per item and language, spaced revision.
// Event payload: TDD 2.3 (Epic GURU-1). Tables from migrations.ts (GURU-4):
//   event:        id, child_id, session_id, at, type, payload (JSON text), created_at, updated_at
//   item_mastery: id, child_id, item_key, lang, state, streak, interval_days, next_due,
//                 last_result, created_at, updated_at; UNIQUE (child_id, item_key, lang)
// Dates (`today`, `next_due`, dueRevision's date) are local calendar days, 'YYYY-MM-DD'.
import * as fs from 'fs';
import * as path from 'path';

import type { Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createTestDb } from '../data/testDb';
import { WORD_ITEMS_GATED } from './config';
import { recordAnswer } from './events';
import { applyAnswer, dueRevision, rebuildMastery } from './mastery';

// Row ids may come from expo-crypto; keep them deterministic and native-free.
jest.mock('expo-crypto', () => {
  let calls = 0;
  return { randomUUID: jest.fn(() => `uuid-${++calls}`) };
});

// TDD 2.3. Declared here so this story does not wait on GURU-10's engine types.
type AnswerEvent = {
  template_id: string;
  item_key: string;
  item_kind: 'letter' | 'word';
  target_lang: 'mr' | 'en';
  phase: 'teach' | 'quiz' | 'retry' | 'revision' | 'followup';
  heard_kind: 'correct' | 'meaning' | 'wrong' | 'silent';
  matched_text?: string;
  matched_lang?: 'mr' | 'en' | 'hi';
  decided_by: 'shekru' | 'tap';
  attempt: number;
  unsure: boolean;
  style_level: 'mr_led' | 'en_led';
  counts: boolean;
};

type MasteryRow = {
  child_id: string;
  item_key: string;
  lang: string;
  state: 'learning' | 'mastered';
  streak: number;
  interval_days: number;
  next_due: string | null;
  last_result: string | null;
};

const answer = (over: Partial<AnswerEvent> = {}): AnswerEvent => ({
  template_id: 'mr_swar_1',
  item_key: 'mr:a',
  item_kind: 'letter',
  target_lang: 'mr',
  phase: 'quiz',
  heard_kind: 'correct',
  decided_by: 'shekru',
  attempt: 1,
  unsure: false,
  style_level: 'mr_led',
  counts: true,
  ...over,
});

const mastery = (over: Partial<MasteryRow> = {}): MasteryRow => ({
  child_id: 'child-1',
  item_key: 'mr:a',
  lang: 'mr',
  state: 'mastered',
  streak: 1,
  interval_days: 1,
  next_due: '2026-11-21',
  last_result: 'correct',
  ...over,
});

function freshDb(): Db {
  const db = createTestDb();
  migrate(db);
  return db;
}

const MASTERY_COLS = 'child_id, item_key, lang, state, streak, interval_days, next_due, last_result';
const masteryRows = (db: Db) =>
  db.all<MasteryRow>(`SELECT ${MASTERY_COLS} FROM item_mastery ORDER BY child_id, item_key, lang`);

// Local calendar day of a Date, as the phone sees it.
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('applyAnswer (pure)', () => {
  it('quiz/retry: a counted correct or counted meaning masters with a 1-day revision, a counted miss is learning, counts:false changes nothing', () => {
    const today = '2026-11-30';

    for (const phase of ['quiz', 'retry'] as const) {
      expect(applyAnswer(undefined, answer({ phase }), today)).toMatchObject({
        item_key: 'mr:a',
        lang: 'mr',
        state: 'mastered',
        interval_days: 1,
        next_due: '2026-12-01',
      });
      expect(applyAnswer(mastery({ state: 'learning', next_due: null }), answer({ phase }), today)).toMatchObject({
        state: 'mastered',
        interval_days: 1,
        next_due: '2026-12-01',
      });
      expect(applyAnswer(undefined, answer({ phase, heard_kind: 'wrong' }), today)).toMatchObject({
        state: 'learning',
      });
    }

    // Hindi meaning on a Marathi item, counted by the engine as correct; keyed by target_lang.
    const meaning = answer({ heard_kind: 'meaning', matched_text: 'अ', matched_lang: 'hi' });
    expect(applyAnswer(undefined, meaning, today)).toMatchObject({ lang: 'mr', state: 'mastered', next_due: '2026-12-01' });

    // Parent taps update mastery like the judge.
    expect(applyAnswer(undefined, answer({ decided_by: 'tap' }), today)).toMatchObject({ state: 'mastered' });

    // Teach turns, Hindi follow-up, bridge step: counts false.
    const row = mastery({ state: 'learning', next_due: null });
    for (const ev of [
      answer({ phase: 'teach', counts: false }),
      answer({ phase: 'followup', counts: false }),
      answer({ heard_kind: 'meaning', target_lang: 'en', item_key: 'en:apple', counts: false }),
      answer({ heard_kind: 'wrong', counts: false }),
    ]) {
      expect(applyAnswer(row, ev, today)).toEqual(row);
      expect(applyAnswer(undefined, ev, today)).toBeUndefined();
    }
  });

  it('revision: a correct moves the interval 1 -> 3 -> 7 -> 14 -> 30 -> 30; a miss resets to 1 day and stays mastered', () => {
    const steps: [string, number, string][] = [
      ['2026-11-21', 3, '2026-11-24'],
      ['2026-11-24', 7, '2026-12-01'],
      ['2026-12-01', 14, '2026-12-15'],
      ['2026-12-15', 30, '2027-01-14'],
      ['2027-01-14', 30, '2027-02-13'],
    ];
    let row: MasteryRow = mastery({ interval_days: 1, next_due: '2026-11-21' });
    for (const [today, interval, due] of steps) {
      row = applyAnswer(row, answer({ phase: 'revision' }), today) as MasteryRow;
      expect(row).toMatchObject({ state: 'mastered', interval_days: interval, next_due: due });
    }

    for (const heard_kind of ['wrong', 'silent'] as const) {
      const missed = applyAnswer(row, answer({ phase: 'revision', heard_kind }), '2027-02-13');
      expect(missed).toMatchObject({ state: 'mastered', interval_days: 1, next_due: '2027-02-14' });
    }
  });

  it('word items are practice only: with WORD_ITEMS_GATED a counted wrong never changes the row; letters still count; the flag is the one switch', () => {
    expect(WORD_ITEMS_GATED).toBe(true);
    const today = '2026-11-20';
    const word = (over: Partial<AnswerEvent>) =>
      answer({ item_key: 'en:apple', item_kind: 'word', target_lang: 'en', ...over });
    const wordRow = (over: Partial<MasteryRow>) => mastery({ item_key: 'en:apple', lang: 'en', ...over });

    const learning = wordRow({ state: 'learning', next_due: null });
    const revising = wordRow({ state: 'mastered', interval_days: 7, next_due: '2026-11-20' });
    expect(applyAnswer(undefined, word({ heard_kind: 'wrong' }), today)).toBeUndefined();
    expect(applyAnswer(learning, word({ heard_kind: 'wrong' }), today)).toEqual(learning);
    expect(applyAnswer(revising, word({ phase: 'revision', heard_kind: 'wrong' }), today)).toEqual(revising);

    // A correct word answer still masters it.
    expect(applyAnswer(undefined, word({}), today)).toMatchObject({ state: 'mastered', next_due: '2026-11-21' });
    // A letter wrong still counts.
    expect(
      applyAnswer(mastery({ interval_days: 7, next_due: today }), answer({ phase: 'revision', heard_kind: 'wrong' }), today),
    ).toMatchObject({ interval_days: 1, next_due: '2026-11-21' });

    // Turning the switch off makes word wrongs count like letters.
    jest.isolateModules(() => {
      jest.doMock('./config', () => ({ WORD_ITEMS_GATED: false }));
      const ungated = require('./mastery') as typeof import('./mastery');
      expect(ungated.applyAnswer(revising, word({ phase: 'revision', heard_kind: 'wrong' }), today)).toMatchObject({
        state: 'mastered',
        interval_days: 1,
        next_due: '2026-11-21',
      });
      expect(ungated.applyAnswer(undefined, word({ heard_kind: 'wrong' }), today)).toMatchObject({ state: 'learning' });
    });
    jest.dontMock('./config');
  });
});

describe('recordAnswer', () => {
  it('appends one answer event and keys mastery by (child, item_key, target_lang) on the local calendar day of `at`', () => {
    const db = freshDb();
    // 00:30 local on 21 Nov: in any zone east of UTC the UTC date is still 20 Nov.
    const afterMidnight = new Date(2026, 10, 21, 0, 30);
    // 23:30 local on 20 Nov: in any zone west of UTC the UTC date is already 21 Nov.
    const beforeMidnight = new Date(2026, 10, 20, 23, 30);
    const ev = answer({ matched_text: 'अ', matched_lang: 'mr' });

    recordAnswer(db, { childId: 'child-1', sessionId: 'sess-1', at: afterMidnight.toISOString(), ms: 840, margin: 0.31 }, ev);
    recordAnswer(
      db,
      { childId: 'child-1', sessionId: 'sess-1', at: beforeMidnight.toISOString() },
      answer({ target_lang: 'en', heard_kind: 'wrong' }),
    );
    recordAnswer(db, { childId: 'child-2', sessionId: 'sess-2', at: beforeMidnight.toISOString() }, answer());

    const events = db.all<{ child_id: string; session_id: string; at: string; type: string; payload: string }>(
      'SELECT child_id, session_id, at, type, payload FROM event ORDER BY rowid',
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ child_id: 'child-1', session_id: 'sess-1', at: afterMidnight.toISOString(), type: 'answer' });
    expect(JSON.parse(events[0].payload)).toMatchObject({ ...ev, ms: 840, margin: 0.31 });

    // Same item_key in two languages is two rows; another child is a third.
    expect(masteryRows(db)).toEqual([
      expect.objectContaining({ child_id: 'child-1', item_key: 'mr:a', lang: 'en', state: 'learning' }),
      expect.objectContaining({
        child_id: 'child-1',
        item_key: 'mr:a',
        lang: 'mr',
        state: 'mastered',
        interval_days: 1,
        next_due: localDay(new Date(2026, 10, 22)),
      }),
      expect.objectContaining({ child_id: 'child-2', item_key: 'mr:a', lang: 'mr', next_due: localDay(new Date(2026, 10, 21)) }),
    ]);

    // Not counted: an event row, no mastery change.
    recordAnswer(db, { childId: 'child-3', sessionId: 'sess-3', at: afterMidnight.toISOString() }, answer({ phase: 'teach', counts: false }));
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM event')!.n).toBe(4);
    expect(masteryRows(db).filter((r) => r.child_id === 'child-3')).toEqual([]);

    // Append-only (D-GURU-4): learning code never rewrites events.
    const dir = __dirname;
    for (const file of fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(src).not.toMatch(/\bUPDATE\s+event\b/i);
      expect(src).not.toMatch(/\bDELETE\s+FROM\s+event\b/i);
    }
  });

  it('writes the event and the mastery update in one transaction; a failed mastery write leaves no event', () => {
    const inner = freshDb();
    let depth = 0;
    let transactions = 0;
    const outside: string[] = [];
    const db: Db = {
      ...inner,
      exec(sql) {
        if (depth === 0) outside.push(sql);
        inner.exec(sql);
      },
      run(sql, params) {
        if (depth === 0) outside.push(sql);
        inner.run(sql, params);
      },
      transaction(fn) {
        transactions++;
        depth++;
        try {
          return inner.transaction(fn);
        } finally {
          depth--;
        }
      },
    };

    recordAnswer(db, { childId: 'child-1', sessionId: 'sess-1', at: '2026-11-20T06:00:00.000Z' }, answer());
    expect(transactions).toBe(1);
    expect(outside).toEqual([]);
    expect(inner.get<{ n: number }>('SELECT COUNT(*) AS n FROM event')!.n).toBe(1);
    expect(masteryRows(inner)).toHaveLength(1);

    inner.exec('DROP TABLE item_mastery');
    expect(() =>
      recordAnswer(inner, { childId: 'child-1', sessionId: 'sess-1', at: '2026-11-20T07:00:00.000Z' }, answer({ item_key: 'mr:aa' })),
    ).toThrow();
    expect(inner.get<{ n: number }>('SELECT COUNT(*) AS n FROM event')!.n).toBe(1);
  });
});

describe('dueRevision', () => {
  it('returns only the child’s mastered rows with next_due on or before the date', () => {
    const db = freshDb();
    const seed = (over: Partial<MasteryRow>) => {
      const r = mastery(over);
      db.run(
        `INSERT INTO item_mastery (id, ${MASTERY_COLS}, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${r.child_id}/${r.item_key}/${r.lang}`, r.child_id, r.item_key, r.lang, r.state, r.streak, r.interval_days, r.next_due, r.last_result, 'x', 'x'],
      );
    };
    seed({ item_key: 'mr:a', next_due: '2026-11-19' }); // overdue
    seed({ item_key: 'mr:aa', next_due: '2026-11-20' }); // due today
    seed({ item_key: 'mr:aa', lang: 'en', next_due: '2026-11-21' }); // same key, other language, not due
    seed({ item_key: 'mr:i', next_due: '2026-11-21' }); // tomorrow
    seed({ item_key: 'mr:ii', state: 'learning', next_due: '2026-11-01' }); // not mastered
    seed({ item_key: 'mr:u', state: 'learning', next_due: null });
    seed({ child_id: 'child-2', item_key: 'mr:e', next_due: '2026-11-01' }); // another child

    const due = dueRevision(db, 'child-1', '2026-11-20');
    expect(due.map((r) => `${r.item_key}/${r.lang}`).sort()).toEqual(['mr:a/mr', 'mr:aa/mr']);
    expect(due.every((r) => r.child_id === 'child-1' && r.state === 'mastered')).toBe(true);
    expect(dueRevision(db, 'child-1', '2026-11-18')).toEqual([]);
  });
});

describe('rebuildMastery', () => {
  it('rebuilding from the stored event rows gives the same rows as incremental recordAnswer', () => {
    // mulberry32: a fixed seed keeps the generated sequence reproducible.
    let seed = 1212;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

    const items = [
      { item_key: 'mr:a', item_kind: 'letter' },
      { item_key: 'mr:aa', item_kind: 'letter' },
      { item_key: 'en:b', item_kind: 'letter' },
      { item_key: 'en:apple', item_kind: 'word' },
    ] as const;
    const db = freshDb();
    const mastered = new Set<string>();
    let at = new Date(2026, 10, 1, 9, 0).getTime();

    for (let i = 0; i < 300; i++) {
      at += Math.floor(1 + rand() * 30) * 3_600_000;
      const childId = pick(['child-1', 'child-2']);
      const item = pick(items);
      const target_lang = pick(['mr', 'en'] as const);
      const key = `${childId}/${item.item_key}/${target_lang}`;
      const phase = mastered.has(key) && rand() < 0.5 ? 'revision' : pick(['teach', 'quiz', 'retry', 'followup'] as const);
      const heard_kind = pick(['correct', 'correct', 'meaning', 'wrong', 'silent'] as const);
      const counts = phase !== 'teach' && phase !== 'followup' && rand() < 0.85;
      if (counts && phase !== 'revision' && (heard_kind === 'correct' || heard_kind === 'meaning')) mastered.add(key);
      recordAnswer(
        db,
        { childId, sessionId: `sess-${Math.floor(i / 10)}`, at: new Date(at).toISOString(), ms: 500 + i, margin: rand() },
        answer({ ...item, target_lang, phase, heard_kind, counts, attempt: 1 + Math.floor(rand() * 2) }),
      );
    }
    // A fresh key whose only counted answer is a miss stays learning.
    recordAnswer(
      db,
      { childId: 'child-1', sessionId: 'sess-tail', at: new Date(at + 500).toISOString() },
      answer({ item_key: 'mr:ka', heard_kind: 'wrong' }),
    );
    // Non-answer events are ignored by the rebuild.
    db.run(
      'INSERT INTO event (id, child_id, session_id, at, type, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['ls-1', 'child-1', 'sess-0', new Date(at + 1000).toISOString(), 'lesson_start', '{}', 'x', 'x'],
    );

    const incremental = masteryRows(db);
    const eventRows = db.all<Record<string, unknown>>('SELECT * FROM event ORDER BY rowid');
    const project = (r: MasteryRow) => ({
      child_id: r.child_id,
      item_key: r.item_key,
      lang: r.lang,
      state: r.state,
      streak: r.streak,
      interval_days: r.interval_days,
      next_due: r.next_due,
      last_result: r.last_result,
    });
    const order = (a: MasteryRow, b: MasteryRow) =>
      `${a.child_id}/${a.item_key}/${a.lang}`.localeCompare(`${b.child_id}/${b.item_key}/${b.lang}`);
    const rebuilt = (rebuildMastery(eventRows as never) as MasteryRow[]).map(project).sort(order);

    // The generated sequence must exercise every branch to mean anything.
    expect(incremental.length).toBeGreaterThan(8);
    expect(incremental.some((r) => r.state === 'learning')).toBe(true);
    expect(incremental.some((r) => r.state === 'mastered' && r.interval_days >= 7)).toBe(true);
    expect(rebuilt).toEqual([...incremental].map(project).sort(order));
  });
});

// Promised to GURU-20 (queue), GURU-21 (sessions), GURU-22 (style level),
// GURU-37 (report), GURU-39 (pilot metrics). Shape only.
describe('contract for dependents (GURU-20, GURU-21, GURU-22, GURU-37, GURU-39)', () => {
  it('exports recordAnswer, applyAnswer, dueRevision, rebuildMastery and WORD_ITEMS_GATED with the promised shapes', () => {
    expect(typeof WORD_ITEMS_GATED).toBe('boolean');
    expect(typeof recordAnswer).toBe('function');
    expect(recordAnswer).toHaveLength(3);
    expect(typeof applyAnswer).toBe('function');
    expect(applyAnswer).toHaveLength(3);
    expect(typeof dueRevision).toBe('function');
    expect(dueRevision).toHaveLength(3);
    expect(typeof rebuildMastery).toBe('function');
    expect(rebuildMastery).toHaveLength(1);

    const rowShape = {
      item_key: expect.any(String),
      lang: expect.any(String),
      state: expect.any(String),
      streak: expect.any(Number),
      interval_days: expect.any(Number),
    };
    const applied = applyAnswer(undefined, answer(), '2026-11-20');
    expect(applied).toMatchObject(rowShape);
    expect(applied).toHaveProperty('next_due');
    expect(applied).toHaveProperty('last_result');

    const db = freshDb();
    recordAnswer(db, { childId: 'child-1', sessionId: 'sess-1', at: '2026-11-20T06:00:00.000Z', ms: 1, margin: 0.1 }, answer());
    const stored = db.get<{ type: string; payload: string }>('SELECT type, payload FROM event')!;
    expect(stored.type).toBe('answer');
    expect(JSON.parse(stored.payload)).toMatchObject({
      template_id: expect.any(String),
      item_key: expect.any(String),
      item_kind: expect.any(String),
      target_lang: expect.any(String),
      phase: expect.any(String),
      heard_kind: expect.any(String),
      decided_by: expect.any(String),
      attempt: expect.any(Number),
      unsure: expect.any(Boolean),
      style_level: expect.any(String),
      counts: expect.any(Boolean),
      ms: expect.any(Number),
      margin: expect.any(Number),
    });

    const due = dueRevision(db, 'child-1', '2026-12-31');
    expect(Array.isArray(due)).toBe(true);
    expect(due[0]).toMatchObject({ child_id: expect.any(String), ...rowShape, next_due: expect.any(String) });

    const rebuilt = rebuildMastery(db.all('SELECT * FROM event') as never);
    expect(Array.isArray(rebuilt)).toBe(true);
    expect(rebuilt[0]).toMatchObject({ child_id: expect.any(String), ...rowShape });
  });
});
