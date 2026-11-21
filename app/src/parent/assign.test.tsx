// GURU-35: assign a lesson from a grouped list with search. Spec: issue GURU-35, PRD Scope M1 (assign
// from a grouped list with search) and Edge Cases (audio pack not on the phone), wireframe pm-assign,
// decision 14 (an assigned lesson that does not fit today comes first tomorrow).
// Lives outside src/app/: Expo Router turns every .tsx file there into a route and bundles it.
//
// Inputs from merged issues:
//   GURU-14  queuePacks(packIds) and isLessonInstalled(templateId) (downloads/downloader.ts); pack ids
//            are paths.json lessonPack values ('starter', 'kg').
//   GURU-20  assignLesson(db, childId, templateId, date 'YYYY-MM-DD') (learning/assignments.ts);
//            buildTodayQueue puts today's assignments first and carries the rest.
//   GURU-30  parent home /parent: child-tab-<id>, home-section-<id>, lesson-row-<templateId>.
// Real schema (app/src/data/migrations.ts):
//   assignment(id, child_id, template_id, for_date TEXT, done_at TEXT, created_at, updated_at)
//   lesson_position(id, child_id, template_id, version, position, ...)  a started lesson
//   event(child_id, type 'lesson_end', payload { template_id }, at)      a finished lesson
// Catalogue (content/generated): lessons.json Lesson[]; paths.json skill paths skill_mr_letters
//   (tpl_kg_mr_*) and skill_en_letters (tpl_kg_en_letters_*); skill_en_words, skill_numbers are empty.
//
// Contract pinned for /implement:
//   parent/searchLessons.ts  searchLessons(index: readonly Lesson[], query: string): string[]
//                            template ids of the matching lessons, in index order. Matches, case-
//                            insensitively, the title, item displays, anchor words and the Latin words
//                            in lesson and item captions; not the voice lines. A blank query returns all.
//   app/parent/assign/[child].tsx  default export, route /parent/assign/<childId>. testIDs:
//                            assign-search (text input), assign-group-<pathId> (one per skill path that
//                            has lessons, holding its rows), assign-row-<templateId>,
//                            assign-state-<templateId> (only the state word: नवीन, अपूर्ण, पूर्ण),
//                            assign-button-<templateId>, assign-note (assigned count against the lessons
//                            left in today's goal).
//   app/parent/index.tsx     home-assign: opens /parent/assign/<shown child's id>.
import { createElement as h } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';

import lessonsJson from '../content/generated/lessons.json';
import { openDb, type Db } from '../data/db';
import { getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import { createChild, updateChild } from '../data/profiles';
import type { ChildProfile } from '../data/types';
import { localDay } from '../learning/mastery';
import { savePosition } from '../learning/positions';
import { lessonEnded, startSession } from '../learning/session';
import type { Lesson, Position } from '../lesson/types';

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

const mockStatus = { waitingForWifi: false, plan: null, items: [] }; // one object: useSyncExternalStore needs a stable snapshot
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

// ---- the modules under test, loaded lazily so a missing one fails its own test ----

/* eslint-disable @typescript-eslint/no-require-imports */
const searchMod = () =>
  require('./searchLessons') as { searchLessons(index: readonly Lesson[], query: string): string[] };

const queuePacks = () => require('../downloads/downloader').queuePacks as jest.Mock;
const isInstalled = () => require('../downloads/downloader').isLessonInstalled as jest.Mock;

const ChildPickerStub = () => h(Text, null, 'child-picker');
function routes() {
  return {
    _layout: require('../app/_layout').default,
    index: ChildPickerStub,
    'parent/index': require('../app/parent/index').default,
    'parent/assign/[child]': require('../app/parent/assign/[child]').default,
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

const CATALOGUE = lessonsJson as unknown as Lesson[];
const ALL_IDS = CATALOGUE.map((l) => l.template_id);
const MR = ['tpl_kg_mr_swar_1', 'tpl_kg_mr_swar_2', 'tpl_kg_mr_vyanjan_1'];
const EN = ['tpl_kg_en_letters_1', 'tpl_kg_en_letters_2', 'tpl_kg_en_letters_3', 'tpl_kg_en_letters_4', 'tpl_kg_en_letters_5'];

let db: Db;

const today = () => localDay(new Date().toISOString());

function addChild(nickname: string, picture: string, over: Partial<ChildProfile> = {}): ChildProfile {
  const child = createChild(db, { nickname, picture, class: 'UKG', medium: 'mr' });
  return Object.keys(over).length ? updateChild(db, child.id, over)! : child;
}

function finish(child: ChildProfile, templateId: string) {
  const at = new Date().toISOString();
  lessonEnded(db, { childId: child.id, sessionId: startSession(db, child.id, at), at }, templateId);
}

const assignments = (child: ChildProfile) =>
  db.all<{ template_id: string; for_date: string; done_at: string | null }>(
    'SELECT template_id, for_date, done_at FROM assignment WHERE child_id = ? ORDER BY created_at',
    [child.id],
  );

async function openAssign(child: ChildProfile) {
  const router = await renderRouter(routes(), { initialUrl: `/parent/assign/${child.id}` });
  await screen.findByTestId('assign-search');
  return router;
}

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    if (name === 'device') db.run("UPDATE device SET parent_lang = 'mr', mic_last_granted_at = NULL, consent_answered_at = NULL");
    else if (name !== 'parent_gate') db.run(`DELETE FROM "${name}"`);
  }
  getDevice(db);
  jest.clearAllMocks();
  isInstalled().mockImplementation(() => true);
});

// ---- behaviour ----

describe('GURU-35 searchLessons(index, query)', () => {
  test('finds a lesson by a word it teaches: "apple" in Latin letters, "आगगाडी" in Devanagari; by title and letter', () => {
    const { searchLessons } = searchMod();
    // Latin word from the caption "A for Apple!", case and spaces do not matter.
    expect(searchLessons(CATALOGUE, 'apple')).toEqual(['tpl_kg_en_letters_1']);
    expect(searchLessons(CATALOGUE, 'APPLE')).toEqual(['tpl_kg_en_letters_1']);
    expect(searchLessons(CATALOGUE, '  Apple ')).toEqual(['tpl_kg_en_letters_1']);
    expect(searchLessons(CATALOGUE, 'umbrella')).toEqual(['tpl_kg_en_letters_5']);
    // Anchor word of आ in स्वर १.
    expect(searchLessons(CATALOGUE, 'आगगाडी')).toEqual(['tpl_kg_mr_swar_1']);
    // Titles.
    expect(searchLessons(CATALOGUE, 'व्यंजन')).toEqual(['tpl_kg_mr_vyanjan_1']);
    expect(searchLessons(CATALOGUE, 'स्वर')).toEqual(['tpl_kg_mr_swar_1', 'tpl_kg_mr_swar_2']);
    // Item displays.
    expect(searchLessons(CATALOGUE, 'ऐ')).toEqual(['tpl_kg_mr_swar_2']);
    expect(searchLessons(CATALOGUE, 'q')).toEqual(['tpl_kg_en_letters_4']);
  });

  test('no match gives an empty list; voice lines are not searched; a blank query lists every lesson; the given index is searched', () => {
    const { searchLessons } = searchMod();
    expect(searchLessons(CATALOGUE, 'goat')).toEqual([]);
    // "आता" and "सफरचंद" are only in what Shekru says, not in titles, letters, anchors or caption words.
    expect(searchLessons(CATALOGUE, 'आता')).toEqual([]);
    expect(searchLessons(CATALOGUE, 'सफरचंद')).toEqual([]);
    expect(searchLessons(CATALOGUE, '')).toEqual(ALL_IDS);
    expect(searchLessons(CATALOGUE, '   ')).toEqual(ALL_IDS);

    // It searches the index it is given, not a built-in catalogue.
    const goat = {
      template_id: 'tpl_test_goat',
      title: 'इंग्रजी: G',
      version: 1,
      lines: {},
      items: [
        {
          id: 'g',
          item_key: 'en:letter:G',
          display: 'G',
          kind: 'letter',
          target_lang: 'en',
          anchor: { word: 'गोट', picture: 'goat' },
          assessment: { mode: 'say_word', expected: ['जी'], accepted_variants: [] },
          lines: { teach: 'जी फॉर गोट!', hint: 'गोट!', correct: 'जी फॉर गोट!' },
          captions: { teach: 'G for Goat!' },
        },
      ],
      flow: [],
    } as unknown as Lesson;
    expect(searchLessons([goat], 'goat')).toEqual(['tpl_test_goat']);
    expect(searchLessons([goat], 'apple')).toEqual([]);
  });
});

describe('GURU-35 /parent/assign/[child] screen', () => {
  test('lessons grouped by skill path with a state word; the search box filters the list', async () => {
    const chinu = addChild('Chinu', 'peacock');
    savePosition(db, chinu.id, 'tpl_kg_mr_swar_2', { version: 1 } as unknown as Position); // started
    finish(chinu, 'tpl_kg_en_letters_1');

    await openAssign(chinu);
    const mrGroup = screen.getByTestId('assign-group-skill_mr_letters');
    const enGroup = screen.getByTestId('assign-group-skill_en_letters');
    expect(mrGroup).toHaveTextContent(/मराठी अक्षरं/);
    expect(enGroup).toHaveTextContent(/इंग्लिश अक्षरं/);
    for (const id of MR) expect(within(mrGroup).getByTestId(`assign-row-${id}`)).toBeTruthy();
    for (const id of EN) expect(within(enGroup).getByTestId(`assign-row-${id}`)).toBeTruthy();
    // Each lesson once: class paths repeat the same lessons and are not groups here.
    for (const id of ALL_IDS) expect(screen.getAllByTestId(`assign-row-${id}`)).toHaveLength(1);
    expect(screen.queryByTestId('assign-group-class_msb_UKG')).toBeNull();
    expect(screen.queryByTestId('assign-group-skill_numbers')).toBeNull(); // no lessons yet

    expect(screen.getByTestId('assign-state-tpl_kg_mr_vyanjan_1')).toHaveTextContent(/^नवीन$/);
    expect(screen.getByTestId('assign-state-tpl_kg_mr_swar_2')).toHaveTextContent(/^अपूर्ण$/);
    expect(screen.getByTestId('assign-state-tpl_kg_en_letters_1')).toHaveTextContent(/^पूर्ण$/);

    const search = screen.getByTestId('assign-search');
    fireEvent.changeText(search, 'apple');
    await waitFor(() => expect(screen.queryByTestId('assign-row-tpl_kg_mr_swar_1')).toBeNull());
    expect(screen.getByTestId('assign-row-tpl_kg_en_letters_1')).toBeTruthy();
    expect(screen.queryByTestId('assign-row-tpl_kg_en_letters_2')).toBeNull();

    fireEvent.changeText(search, 'आगगाडी');
    await waitFor(() => expect(screen.getByTestId('assign-row-tpl_kg_mr_swar_1')).toBeTruthy());
    expect(screen.queryByTestId('assign-row-tpl_kg_en_letters_1')).toBeNull();

    fireEvent.changeText(search, '');
    await waitFor(() => expect(screen.getAllByTestId(/^assign-row-/)).toHaveLength(ALL_IDS.length));
  });

  test('assigning an installed lesson assigns it for today once, without a download; the note compares with the goal', async () => {
    const chinu = addChild('Chinu', 'peacock', { lessons_per_day: 4 });
    finish(chinu, 'tpl_kg_en_letters_1'); // 1 of 4 done: 3 left today

    await openAssign(chinu);
    fireEvent.press(screen.getByTestId('assign-button-tpl_kg_mr_swar_2'));
    fireEvent.press(screen.getByTestId('assign-button-tpl_kg_mr_vyanjan_1'));
    await waitFor(() => expect(assignments(chinu)).toHaveLength(2));
    expect(assignments(chinu)).toEqual([
      { template_id: 'tpl_kg_mr_swar_2', for_date: today(), done_at: null },
      { template_id: 'tpl_kg_mr_vyanjan_1', for_date: today(), done_at: null },
    ]);
    expect(queuePacks()).not.toHaveBeenCalled();

    // A second tap does not assign it twice.
    fireEvent.press(screen.getByTestId('assign-button-tpl_kg_mr_swar_2'));
    await act(async () => undefined);
    expect(assignments(chinu)).toHaveLength(2);

    // "2 lessons assigned. 3 of today's 4 lessons are left."
    const note = screen.getByTestId('assign-note');
    await waitFor(() => expect(note).toHaveTextContent(/\b2\b/));
    expect(note).toHaveTextContent(/\b3\b/);
    expect(note).toHaveTextContent(/\b4\b/);
  });

  test('assigning a lesson whose pack is missing starts its pack download and it waits on parent home', async () => {
    const chinu = addChild('Chinu', 'peacock');
    isInstalled().mockImplementation((id: string) => id !== 'tpl_kg_en_letters_2');

    const assign = await openAssign(chinu);
    fireEvent.press(screen.getByTestId('assign-button-tpl_kg_en_letters_2'));
    await waitFor(() => expect(queuePacks()).toHaveBeenCalledWith(['kg']));
    expect(assignments(chinu)).toEqual([{ template_id: 'tpl_kg_en_letters_2', for_date: today(), done_at: null }]);
    assign.unmount();

    await renderRouter(routes(), { initialUrl: '/parent' });
    const waiting = await screen.findByTestId('home-section-waiting');
    expect(within(waiting).getByTestId('lesson-row-tpl_kg_en_letters_2')).toBeTruthy();
  });

  test('parent home opens the assign screen for the child it is showing', async () => {
    addChild('Chinu', 'peacock');
    const manu = addChild('Manu', 'elephant');

    await renderRouter(routes(), { initialUrl: '/parent' });
    await screen.findByTestId('today-progress');
    fireEvent.press(screen.getByTestId(`child-tab-${manu.id}`));
    fireEvent.press(await screen.findByTestId('home-assign'));
    await waitFor(() => expect(screen).toHavePathname(`/parent/assign/${manu.id}`));

    fireEvent.press(await screen.findByTestId('assign-button-tpl_kg_mr_swar_1'));
    await waitFor(() => expect(assignments(manu)).toHaveLength(1));
  });
});

// ---- contract for dependents ----

// Needed by: none. Pins the issue's promised outputs: the /parent/assign/[child] route and the pure
// searchLessons(index, query).
describe('GURU-35 contract: /parent/assign/[child] and searchLessons(index, query)', () => {
  test('exports searchLessons(index, query) -> string[] and the assign route', () => {
    const { searchLessons } = searchMod();
    expect(typeof searchLessons).toBe('function');
    expect(searchLessons.length).toBe(2);
    const ids = searchLessons(CATALOGUE, '');
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) expect(typeof id).toBe('string');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(typeof require('../app/parent/assign/[child]').default).toBe('function');
  });
});
