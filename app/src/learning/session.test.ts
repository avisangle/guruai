// GURU-21: sessions, daily lesson goal, active-time cap, resume position (PRD Learning model).
// Tables from migrations.ts (GURU-4):
//   session:         id, child_id, started_at, ended_at, end_reason, parent_helps (0/1), active_ms,
//                    created_at, updated_at
//   event:           id, child_id, session_id, at, type, payload (JSON text), created_at, updated_at;
//                    append-only (GURU-12's scan in mastery.test.ts covers this folder)
//   lesson_position: id, child_id, template_id, version, position (JSON text), created_at, updated_at;
//                    UNIQUE (child_id, template_id)
//   child_profile:   ... lessons_per_day (default 3), active_cap_min (default 30, null = off)
// Conventions from GURU-12 (events.ts): `at` is an ISO timestamp, a day is the phone's local
// calendar day 'YYYY-MM-DD', the lesson context is { childId, sessionId, at }.
import type { Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, updateChild } from '../data/profiles';
import { createTestDb } from '../data/testDb';
import type { Position } from '../lesson/types';
import { createActiveClock } from './activeClock';
import { assignLesson } from './assignments';
import { recordAnswer, type AnswerEvent } from './events';
import { loadPosition, savePosition } from './positions';
import {
  closeOpenSessions,
  endSession,
  ensureSession,
  goalMetToday,
  lessonEnded,
  lessonLeft,
  lessonStarted,
  lessonsDoneToday,
  openSession,
  shouldEndAfterLesson,
  startSession,
} from './session';

// Row ids and child codes come from expo-crypto; keep them native-free.
jest.mock('expo-crypto', () => {
  const nodeCrypto = jest.requireActual('crypto');
  let calls = 0;
  return {
    randomUUID: jest.fn(() => `uuid-${++calls}`),
    getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
  };
});

function freshDb(): Db {
  const db = createTestDb();
  migrate(db);
  return db;
}

const addChild = (db: Db, nickname = 'Ira') =>
  createChild(db, { nickname, picture: 'squirrel', class: 'UKG', medium: 'en' }).id;

// ISO timestamp of a wall-clock time on the phone, November 2026.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

const MIN = 60_000;

type SessionRow = {
  child_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  parent_helps: number;
  active_ms: number;
};

const sessionRow = (db: Db, id: string) =>
  db.get<SessionRow>(
    'SELECT child_id, started_at, ended_at, end_reason, parent_helps, active_ms FROM session WHERE id = ?',
    [id],
  );

const sessionEvents = (db: Db, sessionId: string) =>
  db
    .all<{ child_id: string; session_id: string; at: string; type: string; payload: string }>(
      'SELECT child_id, session_id, at, type, payload FROM event WHERE session_id = ? ORDER BY rowid',
      [sessionId],
    )
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) }));

const answer = (): AnswerEvent => ({
  template_id: 'tpl_a',
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
});

const position = (over: Partial<Position> = {}): Position => ({
  version: 2,
  flow: 1,
  index: 3,
  attempts: 1,
  silences: 0,
  reveal: false,
  retry: ['b'],
  last: { praise_first: ['praise_first_2'] },
  ...over,
});

describe('session lifecycle', () => {
  it('startSession opens a session row with a session_start event; endSession stores ended_at, end_reason, active_ms and parent_helps', () => {
    const db = freshDb();
    const kid = addChild(db);

    const first = startSession(db, kid, local(20, 10));
    expect(typeof first).toBe('string');
    expect(sessionRow(db, first)).toEqual({
      child_id: kid,
      started_at: local(20, 10),
      ended_at: null,
      end_reason: null,
      parent_helps: 0,
      active_ms: 0,
    });
    expect(sessionEvents(db, first)).toEqual([
      expect.objectContaining({ child_id: kid, session_id: first, at: local(20, 10), type: 'session_start' }),
    ]);

    endSession(db, first, 'goodbye', { at: local(20, 10, 25), activeMs: 1_234_000, parentHelps: true });
    expect(sessionRow(db, first)).toEqual({
      child_id: kid,
      started_at: local(20, 10),
      ended_at: local(20, 10, 25),
      end_reason: 'goodbye',
      parent_helps: 1,
      active_ms: 1_234_000,
    });

    // A second sitting is a new session; Stop is the other reason a child-side end gives.
    const second = startSession(db, kid, local(20, 18));
    expect(second).not.toBe(first);
    endSession(db, second, 'stop', { at: local(20, 18, 5), activeMs: 5 * MIN, parentHelps: false });
    expect(sessionRow(db, second)).toMatchObject({ ended_at: local(20, 18, 5), end_reason: 'stop', parent_helps: 0, active_ms: 5 * MIN });
    expect(sessionRow(db, first)).toMatchObject({ ended_at: local(20, 10, 25), end_reason: 'goodbye', active_ms: 1_234_000 });
  });

  it('on app start, a session left open by an earlier run is closed as `closed` at its last event time; ended sessions are untouched', () => {
    const db = freshDb();
    const kid = addChild(db);
    const sibling = addChild(db, 'Aarav');

    const ended = startSession(db, kid, local(19, 9));
    endSession(db, ended, 'goodbye', { at: local(19, 9, 20), activeMs: 1000, parentHelps: false });

    // App killed mid-lesson: the last thing recorded was an answer, not a lesson event.
    const open = startSession(db, kid, local(20, 9));
    lessonStarted(db, { childId: kid, sessionId: open, at: local(20, 9, 1) }, 'tpl_a');
    recordAnswer(db, { childId: kid, sessionId: open, at: local(20, 9, 7) }, answer());

    // Killed straight after the child tapped their face: only session_start exists.
    const bare = startSession(db, sibling, local(20, 11));

    closeOpenSessions(db);
    expect(sessionRow(db, open)).toMatchObject({ ended_at: local(20, 9, 7), end_reason: 'closed' });
    expect(sessionRow(db, bare)).toMatchObject({ ended_at: local(20, 11), end_reason: 'closed' });
    expect(sessionRow(db, ended)).toMatchObject({ ended_at: local(19, 9, 20), end_reason: 'goodbye', active_ms: 1000 });

    // Running it again on the next start changes nothing.
    const before = db.all('SELECT * FROM session ORDER BY id');
    closeOpenSessions(db);
    expect(db.all('SELECT * FROM session ORDER BY id')).toEqual(before);
  });

  it('lessonStarted, lessonEnded and lessonLeft append lesson_start, lesson_end and lesson_left events; lesson_left carries items done and total', () => {
    const db = freshDb();
    const kid = addChild(db);
    const s = startSession(db, kid, local(20, 10));
    const at = (minute: number) => ({ childId: kid, sessionId: s, at: local(20, 10, minute) });

    lessonStarted(db, at(1), 'tpl_a');
    lessonLeft(db, at(4), 'tpl_a', { done: 6, total: 10 });
    lessonStarted(db, at(6), 'tpl_a');
    lessonEnded(db, at(9), 'tpl_a');

    const lessonEvents = sessionEvents(db, s).filter((e) => e.type !== 'session_start');
    expect(lessonEvents).toEqual([
      { child_id: kid, session_id: s, at: local(20, 10, 1), type: 'lesson_start', payload: expect.objectContaining({ template_id: 'tpl_a' }) },
      {
        child_id: kid,
        session_id: s,
        at: local(20, 10, 4),
        type: 'lesson_left',
        payload: expect.objectContaining({ template_id: 'tpl_a', items_done: 6, items_total: 10 }),
      },
      { child_id: kid, session_id: s, at: local(20, 10, 6), type: 'lesson_start', payload: expect.objectContaining({ template_id: 'tpl_a' }) },
      { child_id: kid, session_id: s, at: local(20, 10, 9), type: 'lesson_end', payload: expect.objectContaining({ template_id: 'tpl_a' }) },
    ]);
  });
});

describe('daily lesson goal', () => {
  it('lessonsDoneToday counts lesson_end events on the local day, repeats included; a lesson left yesterday and finished today counts today; goalMetToday uses lessons_per_day', () => {
    const db = freshDb();
    const kid = addChild(db);
    const sibling = addChild(db, 'Aarav');
    const ctx = (sessionId: string, day: number, hour: number, minute = 0) => ({ childId: kid, sessionId, at: local(day, hour, minute) });

    // 20th: tpl_a left early; tpl_b finished just before midnight.
    const s1 = startSession(db, kid, local(20, 18));
    lessonStarted(db, ctx(s1, 20, 18, 1), 'tpl_a');
    lessonLeft(db, ctx(s1, 20, 18, 4), 'tpl_a', { done: 3, total: 10 });
    lessonStarted(db, ctx(s1, 20, 23, 50), 'tpl_b');
    lessonEnded(db, ctx(s1, 20, 23, 55), 'tpl_b');

    // 21st: tpl_a resumed and finished just after midnight, then repeated late; tpl_c left.
    const s2 = startSession(db, kid, local(21, 0, 1));
    lessonStarted(db, ctx(s2, 21, 0, 2), 'tpl_a');
    lessonEnded(db, ctx(s2, 21, 0, 5), 'tpl_a');
    lessonStarted(db, ctx(s2, 21, 23, 40), 'tpl_a');
    lessonEnded(db, ctx(s2, 21, 23, 55), 'tpl_a');
    lessonStarted(db, ctx(s2, 21, 23, 56), 'tpl_c');
    lessonLeft(db, ctx(s2, 21, 23, 58), 'tpl_c', { done: 1, total: 8 });

    // 22nd: tpl_c finished.
    const s3 = startSession(db, kid, local(22, 0, 3));
    lessonEnded(db, ctx(s3, 22, 0, 5), 'tpl_c');

    // The sibling's lessons are theirs.
    const s4 = startSession(db, sibling, local(21, 12));
    lessonEnded(db, { childId: sibling, sessionId: s4, at: local(21, 12, 10) }, 'tpl_a');

    // Local days, not UTC dates: in any zone off UTC one of 00:05 / 23:55 falls on another UTC date.
    expect(lessonsDoneToday(db, kid, '2026-11-20')).toBe(1);
    expect(lessonsDoneToday(db, kid, '2026-11-21')).toBe(2);
    expect(lessonsDoneToday(db, kid, '2026-11-22')).toBe(1);
    expect(lessonsDoneToday(db, kid, '2026-11-23')).toBe(0);
    expect(lessonsDoneToday(db, sibling, '2026-11-21')).toBe(1);

    // Default goal is 3 a day.
    expect(goalMetToday(db, kid, '2026-11-21')).toBe(false);
    lessonEnded(db, ctx(s2, 21, 23, 59), 'tpl_b');
    expect(goalMetToday(db, kid, '2026-11-21')).toBe(true);
    updateChild(db, kid, { lessons_per_day: 4 });
    expect(goalMetToday(db, kid, '2026-11-21')).toBe(false);
    updateChild(db, kid, { lessons_per_day: 1 });
    expect(goalMetToday(db, kid, '2026-11-22')).toBe(true);
    expect(goalMetToday(db, kid, '2026-11-23')).toBe(false);
  });
});

describe('active-time cap', () => {
  it('createActiveClock leaves out paused spans and anything past 20 s without activity; shouldEndAfterLesson is true once the goal is met or the cap is reached', () => {
    const clock = createActiveClock();
    expect(clock.activeMs(0)).toBe(0);

    clock.start(1_000);
    expect(clock.activeMs(6_000)).toBe(5_000);
    clock.activity(6_000);
    expect(clock.activeMs(26_000)).toBe(25_000); // 20 s after the last activity still counts
    expect(clock.activeMs(86_000)).toBe(25_000); // a long silence counts only its first 20 s
    clock.activity(86_000); // the child speaks again
    expect(clock.activeMs(96_000)).toBe(35_000);

    clock.pause(96_000); // Home pressed, or a call
    expect(clock.activeMs(400_000)).toBe(35_000);
    clock.resume(400_000);
    expect(clock.activeMs(410_000)).toBe(45_000);

    // Tutor speech, child speech and touches each keep the clock running.
    clock.activity(415_000);
    clock.activity(430_000);
    clock.activity(445_000);
    expect(clock.activeMs(445_000)).toBe(80_000);

    // The goal ends the day once a lesson ends, repeats included.
    expect(shouldEndAfterLesson({ done: 2, goal: 3, activeMs: 10 * MIN, capMin: 30 })).toBe(false);
    expect(shouldEndAfterLesson({ done: 3, goal: 3, activeMs: 10 * MIN, capMin: 30 })).toBe(true);
    expect(shouldEndAfterLesson({ done: 4, goal: 3, activeMs: 10 * MIN, capMin: 30 })).toBe(true);
    // So does the cap, at or past it.
    expect(shouldEndAfterLesson({ done: 1, goal: 3, activeMs: 30 * MIN - 1, capMin: 30 })).toBe(false);
    expect(shouldEndAfterLesson({ done: 1, goal: 3, activeMs: 30 * MIN, capMin: 30 })).toBe(true);
    expect(shouldEndAfterLesson({ done: 1, goal: 3, activeMs: 15 * MIN, capMin: 15 })).toBe(true);
    // A cap turned off (null) never ends the day.
    expect(shouldEndAfterLesson({ done: 1, goal: 3, activeMs: 180 * MIN, capMin: null })).toBe(false);
  });
});

describe('resume position', () => {
  it('savePosition/loadPosition keep one position per child and template; a version mismatch or nothing saved returns null', () => {
    const db = freshDb();
    const kid = addChild(db);
    const sibling = addChild(db, 'Aarav');

    expect(loadPosition(db, kid, 'tpl_a', 2)).toBeNull();

    savePosition(db, kid, 'tpl_a', position());
    expect(loadPosition(db, kid, 'tpl_a', 2)).toEqual(position());

    // Saving again replaces the row.
    savePosition(db, kid, 'tpl_a', position({ index: 4, attempts: 0 }));
    expect(loadPosition(db, kid, 'tpl_a', 2)).toEqual(position({ index: 4, attempts: 0 }));
    expect(
      db.all('SELECT version FROM lesson_position WHERE child_id = ? AND template_id = ?', [kid, 'tpl_a']),
    ).toEqual([{ version: 2 }]);

    // Per child and per template.
    expect(loadPosition(db, sibling, 'tpl_a', 2)).toBeNull();
    savePosition(db, sibling, 'tpl_a', position({ index: 0 }));
    expect(loadPosition(db, kid, 'tpl_a', 2)).toEqual(position({ index: 4, attempts: 0 }));
    expect(loadPosition(db, sibling, 'tpl_a', 2)).toEqual(position({ index: 0 }));
    expect(loadPosition(db, kid, 'tpl_b', 2)).toBeNull();

    // The lesson's content changed since the save: start over.
    expect(loadPosition(db, kid, 'tpl_a', 3)).toBeNull();
  });
});

// Promised to GURU-28 (lesson player), GURU-29 (picker and queue), GURU-37 (report),
// GURU-38 (uploads). Shape only.
describe('contract for dependents (GURU-28, GURU-29, GURU-37, GURU-38)', () => {
  it('exports the session, goal, clock and position functions with the promised shapes', () => {
    const arity: [string, (...args: never[]) => unknown, number][] = [
      ['startSession', startSession, 3],
      ['endSession', endSession, 4],
      ['closeOpenSessions', closeOpenSessions, 1],
      ['lessonStarted', lessonStarted, 3],
      ['lessonEnded', lessonEnded, 3],
      ['lessonLeft', lessonLeft, 4],
      ['lessonsDoneToday', lessonsDoneToday, 3],
      ['goalMetToday', goalMetToday, 3],
      ['savePosition', savePosition, 4],
      ['loadPosition', loadPosition, 4],
      ['createActiveClock', createActiveClock, 0],
      ['shouldEndAfterLesson', shouldEndAfterLesson, 1],
    ];
    for (const [name, fn, length] of arity) {
      expect([name, typeof fn, fn.length]).toEqual([name, 'function', length]);
    }

    const db = freshDb();
    const kid = addChild(db);
    const id = startSession(db, kid, local(20, 10));
    expect(typeof id).toBe('string');
    expect(typeof lessonsDoneToday(db, kid, '2026-11-20')).toBe('number');
    expect(typeof goalMetToday(db, kid, '2026-11-20')).toBe('boolean');
    savePosition(db, kid, 'tpl_a', position());
    expect(loadPosition(db, kid, 'tpl_a', 2)).toMatchObject({ version: expect.any(Number), flow: expect.any(Number) });

    const clock = createActiveClock();
    for (const method of ['start', 'pause', 'resume', 'activity', 'activeMs'] as const) {
      expect([method, typeof clock[method]]).toEqual([method, 'function']);
    }
    clock.start(0);
    expect(typeof clock.activeMs(1)).toBe('number');
    expect(typeof shouldEndAfterLesson({ done: 0, goal: 3, activeMs: 0, capMin: 30 })).toBe('boolean');
  });
});

describe('ensureSession, and assignments completed at lesson end', () => {
  it('ensureSession reuses the open session and starts one once it has ended', () => {
    const db = freshDb();
    const child = addChild(db);
    const first = ensureSession(db, child, local(21, 9));
    expect(ensureSession(db, child, local(21, 9, 5))).toBe(first);
    endSession(db, first, 'goodbye', { at: local(21, 9, 20), activeMs: MIN, parentHelps: false });
    expect(ensureSession(db, child, local(21, 10))).not.toBe(first);
  });

  it('ensureSession closes an open session from an earlier local day and starts a new one', () => {
    const db = freshDb();
    const child = addChild(db);
    const yesterday = ensureSession(db, child, local(20, 18));
    lessonStarted(db, { childId: child, sessionId: yesterday, at: local(20, 18, 10) }, 'tpl_a');
    const today = ensureSession(db, child, local(21, 9));
    expect(today).not.toBe(yesterday);
    expect(sessionRow(db, yesterday)).toMatchObject({ ended_at: local(20, 18, 10), end_reason: 'closed' });
    expect(openSession(db, child)).toBe(today);
  });

  it('lessonEnded marks the lesson\'s open assignments done', () => {
    const db = freshDb();
    const child = addChild(db);
    assignLesson(db, child, 'tpl_a', '2026-11-21');
    assignLesson(db, child, 'tpl_b', '2026-11-21');
    const ctx = { childId: child, sessionId: startSession(db, child, local(21, 9)), at: local(21, 9, 10) };
    lessonEnded(db, ctx, 'tpl_a');
    const rows = db.all<{ template_id: string; done_at: string | null }>(
      'SELECT template_id, done_at FROM assignment WHERE child_id = ? ORDER BY template_id',
      [child],
    );
    expect(rows).toEqual([
      { template_id: 'tpl_a', done_at: ctx.at },
      { template_id: 'tpl_b', done_at: null },
    ]);
  });
});
