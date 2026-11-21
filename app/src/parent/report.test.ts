// GURU-37: simple report. Spec: issue GURU-37, PRD Learning model (session and lesson, what counts
// toward the goal, mastery and revision), Edge Cases (child presses Home mid-lesson), wireframe
// pm-report, wireframe decision 22, D-GURU-12-word-items-practice-only.
// Lives outside src/app/: Expo Router turns every file there into a route.
//
// Real schema (app/src/data/migrations.ts):
//   event(id, child_id, session_id, at, type, payload JSON, created_at, updated_at), append-only.
//     'lesson_start' { template_id }                                   lessonStarted()
//     'lesson_end'   { template_id }                                   lessonEnded()
//     'lesson_left'  { template_id, items_done, items_total }          lessonLeft()
//     'answer'       AnswerEvent + { ms, margin }                      recordAnswer()
//       revision answers ride inside another lesson's run: phase 'revision', template_id of
//       the lesson the item came from (lesson/revision.ts).
//   session(id, child_id, started_at, ended_at, end_reason, parent_helps 0/1, active_ms, ...)
//   item_mastery(child_id, item_key, lang, state 'learning'|'mastered', streak, interval_days,
//                next_due, last_result); item_key is '<lang>:<kind>:<text>', e.g. 'mr:letter:अ'.
//
// Contract pinned for /implement:
//   parent/report.ts  buildReport(events: EventRow[], sessions: ReportSession[], mastery: MasteryRow[],
//                                 profile: ChildProfile, today: 'YYYY-MM-DD') -> Report (pure)
//     days             the 7 local days ending `today`, oldest first: { date, done, goal, met }.
//                      done = lesson_end events that day (repeats count); goal = profile.lessons_per_day.
//     lessons          the 10 most recent lessons, newest first: { template_id, at, finished, done,
//                      total, practiceOnly, parentChecked }. `at` is the lesson_end/lesson_left time.
//                      A left lesson is listed until the same lesson is resumed and finished; then
//                      only the finished entry remains. practiceOnly: a word lesson. parentChecked:
//                      its session had parent_helps.
//     lettersMastered  mastered letter rows (word rows excluded).
//     nextDayRevision  { correct, total } over counted revision answers given at a 1-day interval.
//     needsPractice    item_keys of the newest counted misses (wrong or silent), distinct, at most 5.
//   app/parent/report/[child].tsx  default export; testIDs report-week, report-lessons.
import { createElement as h } from 'react';
import { Text } from 'react-native';
import { renderRouter, screen } from 'expo-router/testing-library';

import { openDb, type Db } from '../data/db';
import { getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import { createChild, getChild, updateChild } from '../data/profiles';
import type { ChildProfile } from '../data/types';
import { recordAnswer, type AnswerEvent, type EventRow } from '../learning/events';
import { localDay, rebuildMastery, type MasteryRow } from '../learning/mastery';
import { endSession, lessonEnded, lessonLeft, lessonStarted, startSession } from '../learning/session';

// ---- native fakes (as in parent/home.test.tsx) ----

type Raw = { exec(sql: string): void; prepare(sql: string): { run(p: unknown[]): unknown; all(p: unknown[]): unknown[]; get(p: unknown[]): unknown }; transaction<T>(fn: () => T): () => T };
let mockRawDb: Raw | null = null;
function mockRaw(): Raw {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mockRawDb ??= new (require('better-sqlite3'))(':memory:') as Raw;
  return mockRawDb;
}
const mockBind = (params: unknown[] = []) => params.map((p) => (typeof p === 'boolean' ? Number(p) : p));

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => {
    const raw = mockRaw();
    return {
      execSync: (sql: string) => raw.exec(sql),
      runSync: (sql: string, params: unknown[] = []) => raw.prepare(sql).run(mockBind(params)),
      getAllSync: (sql: string, params: unknown[] = []) => raw.prepare(sql).all(mockBind(params)),
      getFirstSync: (sql: string, params: unknown[] = []) => raw.prepare(sql).get(mockBind(params)) ?? null,
      withTransactionSync: (fn: () => void) => raw.transaction(fn)(),
    };
  }),
}));

jest.mock('expo-crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const c = require('crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    randomUUID: () => c.randomUUID(),
    getRandomBytes: (n: number) => new Uint8Array(c.randomBytes(n)),
    getRandomBytesAsync: async (n: number) => new Uint8Array(c.randomBytes(n)),
  };
});

jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(async () => 1),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));

jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' })),
  getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' })),
}));

jest.mock('../asr/speedCheck', () => ({
  SLOW_P90_MS: 1000,
  judgeReadiness: jest.fn(() => 'ready'),
  runSpeedCheck: jest.fn(async () => 'ready'),
  rerunSpeedCheck: jest.fn(async () => 'ready'),
}));

const mockStatus = { waitingForWifi: false, plan: null, items: [] }; // stable snapshot for useSyncExternalStore
jest.mock('../downloads/downloader', () => ({
  startInitialDownloads: jest.fn(async () => undefined),
  queuePacks: jest.fn(async () => undefined),
  queueChildPacks: jest.fn(async () => undefined),
  isLessonInstalled: jest.fn(() => true),
  downloadStatus: jest.fn(() => mockStatus),
  subscribeDownloads: jest.fn(() => () => undefined),
}));

jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true, loadAsync: async () => undefined }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
  hide: jest.fn(),
  setOptions: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// ---- the module under test, loaded lazily so a missing one fails its own test ----

type ReportSession = {
  id: string;
  child_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  parent_helps: boolean;
  active_ms: number;
};
type ReportDay = { date: string; done: number; goal: number; met: boolean };
type ReportLesson = {
  template_id: string;
  at: string;
  finished: boolean;
  done: number;
  total: number;
  practiceOnly: boolean;
  parentChecked: boolean;
};
type Report = {
  days: ReportDay[];
  lessons: ReportLesson[];
  lettersMastered: number;
  nextDayRevision: { correct: number; total: number };
  needsPractice: string[];
};
type BuildReport = (
  events: EventRow[],
  sessions: ReportSession[],
  mastery: MasteryRow[],
  profile: ChildProfile,
  today: string,
) => Report;

/* eslint-disable @typescript-eslint/no-require-imports */
const reportMod = () => require('./report') as { buildReport: BuildReport };

const ChildPickerStub = () => h(Text, null, 'child-picker');
function routes() {
  return {
    _layout: require('../app/_layout').default,
    index: ChildPickerStub,
    'parent/report/[child]': require('../app/parent/report/[child]').default,
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;

// ISO timestamp of a wall-clock time on the phone, November 2026.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

type Ans = { item_key: string; heard: AnswerEvent['heard_kind'] } & Partial<AnswerEvent>;

function answerEvent(templateId: string, a: Ans): AnswerEvent {
  const { item_key, heard, ...over } = a;
  return {
    template_id: templateId,
    item_key,
    item_kind: item_key.includes(':word:') ? 'word' : 'letter',
    target_lang: item_key.startsWith('en:') ? 'en' : 'mr',
    phase: 'quiz',
    heard_kind: heard,
    decided_by: 'shekru',
    attempt: 1,
    unsure: false,
    style_level: 'mr_led',
    counts: true,
    ...over,
  };
}

/**
 * One lesson run: lesson_start at `start`, one answer a minute, then lesson_end, or lesson_left
 * with the given items done and total.
 */
function run(
  childId: string,
  sessionId: string,
  start: Date,
  templateId: string,
  answers: Ans[],
  end: 'end' | { left: [number, number] } = 'end',
  decidedBy: AnswerEvent['decided_by'] = 'shekru',
) {
  const at = (min: number) => new Date(start.getTime() + min * 60_000).toISOString();
  lessonStarted(db, { childId, sessionId, at: at(0) }, templateId);
  answers.forEach((a, i) =>
    recordAnswer(db, { childId, sessionId, at: at(i + 1) }, answerEvent(templateId, { decided_by: decidedBy, ...a })),
  );
  const ctx = { childId, sessionId, at: at(answers.length + 1) };
  if (end === 'end') lessonEnded(db, ctx, templateId);
  else lessonLeft(db, ctx, templateId, { done: end.left[0], total: end.left[1] });
}

const d = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
const ok = (item_key: string, over: Partial<AnswerEvent> = {}): Ans => ({ item_key, heard: 'correct', ...over });
const miss = (item_key: string, over: Partial<AnswerEvent> = {}): Ans => ({ item_key, heard: 'wrong', ...over });
const rev = (item_key: string, heard: AnswerEvent['heard_kind']): Ans => ({
  item_key,
  heard,
  phase: 'revision',
  template_id: SWAR_1, // revision items keep the template they came from
});

const SWAR_1 = 'tpl_kg_mr_swar_1';
const SWAR_2 = 'tpl_kg_mr_swar_2';
const VYANJAN_1 = 'tpl_kg_mr_vyanjan_1';
const EN_1 = 'tpl_kg_en_letters_1';
const WORDS = 'tpl_test_en_words_1'; // a word lesson; not in the starter catalogue

/**
 * Fixed history, today = Friday 2026-11-20, goal 3:
 *   Fri 13  vyanjan_1 finished                                   (outside the week)
 *   Sat 14  vyanjan_1 finished four times (repeats); ख wrong in the last run
 *   Mon 16  swar_1 finished, swar_1 repeated; en_1 left after 6 of 10 (C wrong)
 *   Tue 17  en_1 resumed and finished (next-day revision inside: अ right, आ wrong, इ right);
 *           swar_2 finished (ई wrong, ऊ silent)
 *   Wed 18  parent-helps session: word lesson (dog wrong, not counted), swar_2 (ओ teach silence,
 *           not counted), vyanjan_1
 *   Fri 20  en_1 again, left after 2 of 10 (इ revised at a 3-day interval, B wrong); session open
 */
function buildHistory(): string {
  const child = createChild(db, { nickname: 'Ira', picture: 'squirrel', class: 'UKG', medium: 'mr' });
  updateChild(db, child.id, { lessons_per_day: 3 });
  const id = child.id;
  const close = (s: string, at: string, parentHelps = false) =>
    endSession(db, s, 'goodbye', { at, activeMs: 600_000, parentHelps });

  const s13 = startSession(db, id, local(13, 8, 59));
  run(id, s13, d(13, 9), VYANJAN_1, [ok('mr:letter:क')]);
  close(s13, local(13, 9, 30));

  const s14 = startSession(db, id, local(14, 8, 59));
  for (let i = 0; i < 3; i++) run(id, s14, d(14, 9, i * 10), VYANJAN_1, [ok('mr:letter:क'), ok('mr:letter:ग')]);
  run(id, s14, d(14, 9, 30), VYANJAN_1, [ok('mr:letter:क'), ok('mr:letter:ग'), miss('mr:letter:ख')]);
  close(s14, local(14, 10));

  const s16 = startSession(db, id, local(16, 8, 59));
  run(id, s16, d(16, 9), SWAR_1, [ok('mr:letter:अ'), ok('mr:letter:आ'), ok('mr:letter:इ')]);
  run(id, s16, d(16, 9, 20), SWAR_1, [ok('mr:letter:अ'), ok('mr:letter:आ'), ok('mr:letter:इ')]);
  run(
    id,
    s16,
    d(16, 9, 40),
    EN_1,
    [ok('en:letter:A'), ok('en:letter:B'), miss('en:letter:C'), ok('en:letter:D'), ok('en:letter:E'), ok('en:letter:F')],
    { left: [6, 10] },
  );
  close(s16, local(16, 10));

  const s17 = startSession(db, id, local(17, 8, 59));
  run(id, s17, d(17, 9), EN_1, [
    rev('mr:letter:अ', 'correct'),
    rev('mr:letter:आ', 'wrong'),
    rev('mr:letter:इ', 'correct'),
    ok('en:letter:G'),
    ok('en:letter:H'),
    ok('en:letter:I'),
    ok('en:letter:J'),
  ]);
  run(id, s17, d(17, 9, 30), SWAR_2, [miss('mr:letter:ई'), ok('mr:letter:उ'), { item_key: 'mr:letter:ऊ', heard: 'silent' }]);
  close(s17, local(17, 10));

  const s18 = startSession(db, id, local(18, 8, 59));
  run(id, s18, d(18, 9), WORDS, [ok('en:word:cat'), miss('en:word:dog', { counts: false })], 'end', 'tap');
  run(
    id,
    s18,
    d(18, 9, 20),
    SWAR_2,
    [{ item_key: 'mr:letter:ओ', heard: 'silent', phase: 'teach', counts: false }, ok('mr:letter:ए'), ok('mr:letter:ऐ')],
    'end',
    'tap',
  );
  run(id, s18, d(18, 9, 40), VYANJAN_1, [ok('mr:letter:क'), ok('mr:letter:ग')], 'end', 'tap');
  close(s18, local(18, 10), true);

  const s20 = startSession(db, id, local(20, 8, 59));
  run(id, s20, d(20, 9), EN_1, [rev('mr:letter:इ', 'correct'), ok('en:letter:A'), miss('en:letter:B')], { left: [2, 10] });
  // s20 stays open: today's sitting is not over.
  return id;
}

/** The arrays the screen reads from SQLite, optionally cut to what had happened before `before`. */
function inputs(childId: string, before?: string) {
  let events = db.all<EventRow>(
    'SELECT child_id, session_id, at, type, payload FROM event WHERE child_id = ? ORDER BY rowid',
    [childId],
  );
  let sessions = db
    .all<Omit<ReportSession, 'parent_helps'> & { parent_helps: number }>(
      'SELECT id, child_id, started_at, ended_at, end_reason, parent_helps, active_ms FROM session WHERE child_id = ? ORDER BY started_at',
      [childId],
    )
    .map((s) => ({ ...s, parent_helps: s.parent_helps === 1 }));
  let mastery = db.all<MasteryRow>(
    'SELECT child_id, item_key, lang, state, streak, interval_days, next_due, last_result FROM item_mastery WHERE child_id = ?',
    [childId],
  );
  if (before) {
    events = events.filter((e) => e.at < before);
    sessions = sessions.filter((s) => s.started_at < before);
    mastery = rebuildMastery(events);
  }
  return { events, sessions, mastery, profile: getChild(db, childId)! };
}

function report(childId: string, today = '2026-11-20', before?: string): Report {
  const { events, sessions, mastery, profile } = inputs(childId, before);
  return reportMod().buildReport(events, sessions, mastery, profile, today);
}

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    if (name === 'device') db.run("UPDATE device SET parent_lang = 'mr'");
    else if (name !== 'parent_gate') db.run(`DELETE FROM "${name}"`);
  }
  getDevice(db);
  jest.clearAllMocks();
});

// ---- behaviour ----

describe('GURU-37 buildReport: the week in lessons', () => {
  test('seven days oldest first, lessons finished against the goal; repeats count, revision and left-early lessons do not', () => {
    const { days } = report(buildHistory());
    expect(days).toEqual([
      { date: '2026-11-14', done: 4, goal: 3, met: true }, // three repeats of the same lesson count
      { date: '2026-11-15', done: 0, goal: 3, met: false },
      { date: '2026-11-16', done: 2, goal: 3, met: false }, // en_1 was left early: not counted
      { date: '2026-11-17', done: 2, goal: 3, met: false }, // en_1 resumed and finished counts here
      { date: '2026-11-18', done: 3, goal: 3, met: true },
      { date: '2026-11-19', done: 0, goal: 3, met: false },
      { date: '2026-11-20', done: 0, goal: 3, met: false }, // left early again, revision answered: 0
    ]);
  });
});

describe('GURU-37 buildReport: recent lessons', () => {
  test('a lesson left midway reads 6 of 10 until it is resumed; then one finished entry on the day it finished', () => {
    const childId = buildHistory();

    const monday = report(childId, '2026-11-16', local(17, 0));
    expect(monday.lessons[0]).toEqual(
      expect.objectContaining({ template_id: EN_1, finished: false, done: 6, total: 10 }),
    );
    expect(monday.days[6]).toEqual({ date: '2026-11-16', done: 2, goal: 3, met: false });

    const friday = report(childId);
    const en1 = friday.lessons.filter((l) => l.template_id === EN_1);
    // Today's new leave, and Tuesday's finish; Monday's leave is gone.
    expect(en1.map((l) => [localDay(l.at), l.finished, l.done, l.total])).toEqual([
      ['2026-11-20', false, 2, 10],
      ['2026-11-17', true, 10, 10],
    ]);
  });

  test('the ten newest lessons, newest first, each a lesson (not a session); finished ones are done/total complete', () => {
    const { lessons } = report(buildHistory());
    expect(lessons.map((l) => [localDay(l.at), l.template_id, l.finished])).toEqual([
      ['2026-11-20', EN_1, false],
      ['2026-11-18', VYANJAN_1, true],
      ['2026-11-18', SWAR_2, true],
      ['2026-11-18', WORDS, true],
      ['2026-11-17', SWAR_2, true],
      ['2026-11-17', EN_1, true],
      ['2026-11-16', SWAR_1, true], // the repeat
      ['2026-11-16', SWAR_1, true],
      ['2026-11-14', VYANJAN_1, true],
      ['2026-11-14', VYANJAN_1, true],
    ]);
    const times = lessons.map((l) => l.at);
    expect([...times].sort().reverse()).toEqual(times);
    for (const l of lessons.filter((x) => x.finished)) expect(l.done).toBe(l.total);
  });

  test('word lessons are practice only; lessons in a parent-helps session are marked checked by a parent', () => {
    const { lessons } = report(buildHistory());
    const flags = lessons.map((l) => [localDay(l.at), l.template_id, l.practiceOnly, l.parentChecked]);
    expect(flags).toEqual([
      ['2026-11-20', EN_1, false, false],
      ['2026-11-18', VYANJAN_1, false, true],
      ['2026-11-18', SWAR_2, false, true],
      ['2026-11-18', WORDS, true, true],
      ['2026-11-17', SWAR_2, false, false],
      ['2026-11-17', EN_1, false, false], // revision answers from swar_1 inside it change nothing
      ['2026-11-16', SWAR_1, false, false],
      ['2026-11-16', SWAR_1, false, false],
      ['2026-11-14', VYANJAN_1, false, false],
      ['2026-11-14', VYANJAN_1, false, false],
    ]);
  });
});

describe('GURU-37 buildReport: mastery and practice', () => {
  test('letters mastered excludes words; next-day revision counts only 1-day-interval checks; up to 5 newest counted misses', () => {
    const r = report(buildHistory());
    // क ग अ आ इ A B D E F G H I J उ ए ऐ; the mastered word "cat" is not a letter.
    expect(r.lettersMastered).toBe(17);
    // Tuesday: अ right, आ wrong, इ right. Friday's इ check was at a 3-day interval.
    expect(r.nextDayRevision).toEqual({ correct: 2, total: 3 });
    // Newest first, distinct; ख (oldest) falls past the cap; dog and ओ did not count.
    expect(r.needsPractice).toEqual(['en:letter:B', 'mr:letter:ऊ', 'mr:letter:ई', 'mr:letter:आ', 'en:letter:C']);
  });
});

describe('GURU-37 /parent/report/[child] screen', () => {
  // Today's local wall clock, early in the day so every event falls on today.
  const todayAt = (minute: number) => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 1, minute);
  };

  function seedToday(): string {
    const child = createChild(db, { nickname: 'Chinu', picture: 'peacock', class: 'UKG', medium: 'mr' });
    updateChild(db, child.id, { lessons_per_day: 3 });
    const a = startSession(db, child.id, todayAt(0).toISOString());
    run(child.id, a, todayAt(1), SWAR_1, [ok('mr:letter:अ')]);
    run(child.id, a, todayAt(10), EN_1, [ok('en:letter:A')], { left: [6, 10] });
    endSession(db, a, 'goodbye', { at: todayAt(20).toISOString(), activeMs: 600_000, parentHelps: false });
    const b = startSession(db, child.id, todayAt(30).toISOString());
    run(child.id, b, todayAt(31), WORDS, [ok('en:word:cat')], 'end', 'tap');
    endSession(db, b, 'goodbye', { at: todayAt(40).toISOString(), activeMs: 600_000, parentHelps: true });
    return child.id;
  }

  async function openReport(childId: string) {
    const router = await renderRouter(routes(), { initialUrl: `/parent/report/${childId}` });
    return { router, week: await screen.findByTestId('report-week'), lessons: screen.getByTestId('report-lessons') };
  }

  test('renders the week and recent lessons in Marathi, and in English when the parent picked English', async () => {
    const childId = seedToday();

    const mr = await openReport(childId);
    expect(mr.week).toHaveTextContent(/2\/3/);
    expect(mr.lessons).toHaveTextContent(/मध्येच थांबलं/);
    expect(mr.lessons).toHaveTextContent(/10 पैकी 6/);
    expect(mr.lessons).toHaveTextContent(/फक्त सराव/);
    expect(mr.lessons).toHaveTextContent(/उत्तरं पालकांनी तपासली/);
    mr.router.unmount();

    db.run("UPDATE device SET parent_lang = 'en'");
    const en = await openReport(childId);
    expect(en.week).toHaveTextContent(/2\/3/);
    expect(en.lessons).toHaveTextContent(/left early/i);
    expect(en.lessons).toHaveTextContent(/6 of 10/);
    expect(en.lessons).toHaveTextContent(/practice only/i);
    expect(en.lessons).toHaveTextContent(/answers checked by a parent/i);
  });
});

// ---- contract for dependents ----

// No issue consumes this yet (Needed by: none); the shape below is what later report work and
// /integrate rely on.
describe('GURU-37 contract: buildReport(events, sessions, mastery, profile, today) and /parent/report/[child]', () => {
  test('exports a pure five-argument buildReport returning the report shape, and the report route', () => {
    const { buildReport } = reportMod();
    expect(typeof buildReport).toBe('function');
    expect(buildReport.length).toBe(5);

    const r = report(buildHistory());
    expect(r).toEqual({
      days: expect.any(Array),
      lessons: expect.any(Array),
      lettersMastered: expect.any(Number),
      nextDayRevision: { correct: expect.any(Number), total: expect.any(Number) },
      needsPractice: expect.any(Array),
    });
    for (const day of r.days)
      expect(day).toEqual({ date: expect.any(String), done: expect.any(Number), goal: expect.any(Number), met: expect.any(Boolean) });
    for (const l of r.lessons)
      expect(l).toEqual(
        expect.objectContaining({
          template_id: expect.any(String),
          at: expect.any(String),
          finished: expect.any(Boolean),
          done: expect.any(Number),
          total: expect.any(Number),
          practiceOnly: expect.any(Boolean),
          parentChecked: expect.any(Boolean),
        }),
      );
    for (const key of r.needsPractice) expect(typeof key).toBe('string');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(typeof require('../app/parent/report/[child]').default).toBe('function');
  });
});
