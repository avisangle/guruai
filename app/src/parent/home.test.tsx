// GURU-30: parent home. Spec: issue GURU-30, PRD Happy Path (parent mode 2) and Edge Cases (model
// missing, mic denied, "Only this time", phone too weak), wireframes pm-home, pm-home-2, pm-attention,
// decisions 10, 23 (section order), 26 (mic banner).
// Lives outside src/app/: Expo Router turns every .tsx file there into a route and bundles it.
//
// Inputs from merged issues:
//   GURU-20  buildTodayQueue(input) -> { stops, goal, done, goalMet, waitingForDownload } (learning/queue.ts)
//   GURU-15  judgeReadiness() -> 'ready' | 'missing' | 'slow' | 'oom' (asr/speedCheck.ts)
//   GURU-14  startInitialDownloads() queues the model again, which resumes it (downloads/downloader.ts)
//   GURU-24  device.mic_last_granted_at; the mic request is expo-audio's requestRecordingPermissionsAsync
// Real schema (app/src/data/migrations.ts):
//   device(..., consent_answered_at TEXT, judge_check, judge_p90_ms, mic_last_granted_at TEXT, ...)
//   child_profile(id, nickname, picture, class, board, medium, goals, style_level, style_locked,
//                 lessons_per_day DEFAULT 3, active_cap_min, tutor, child_code,
//                 setup_done TEXT NOT NULL DEFAULT '[]', archived, created_at, updated_at)
//   event(child_id, type 'lesson_end', payload { template_id }, at)  written by lessonEnded()
//
// Contract pinned for /implement:
//   parent/home.ts       homeSections({ queue, inProgress, assignments, finished, due }) -> HomeSection[]
//                        ids in decision 23 order: upNext, waiting (only when a pack is missing),
//                        pending, revision, completed ({ collapsed: true }).
//                        upNext = the queue's lesson stops; waiting = queue.waitingForDownload;
//                        pending = started or assigned, unfinished lessons in neither of those.
//   parent/attention.ts  attentionBanner({ readiness, mic: { granted, canAskAgain }, micLastGrantedAt })
//                        -> null | { kind: 'model', action: 'resumeDownload' }
//                               | { kind: 'mic', action: 'requestPermission' | 'openSettings', chooseWhileUsing }
//                               | { kind: 'weak', action: null }
//                        priority model > mic > weak; chooseWhileUsing = mic was granted before.
//   parent/setup.ts      SETUP_SECTIONS = ['goals_style', 'lessons_per_day', 'board'] (child.setup_done values);
//                        setupRows(child, device) -> [{ kind: 'profile', sections, href: '/parent/child/<id>' }?,
//                                                     { kind: 'consent', href: '/parent/consent' }?]
//   app/parent/index.tsx default export. testIDs: child-tab-<childId> (picture + nickname), today-progress
//                        (lessons done today and the goal), attention-banner, attention-action, setup-card,
//                        setup-row-profile, setup-row-consent, home-section-<id>, lesson-row-<templateId>.
//                        Mic state from expo-audio getRecordingPermissionsAsync().
import { createElement as h } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';

import { openDb, type Db } from '../data/db';
import { getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import { createChild, updateChild } from '../data/profiles';
import type { ChildProfile, Device } from '../data/types';
import type { DownloadStatus } from '../downloads/downloader';
import { lessonEnded, startSession } from '../learning/session';
import { buildTodayQueue, type DueItem, type TodayQueue } from '../learning/queue';
import { CHILD_PICTURES } from '../ui/PicturePicker';

// ---- native fakes (as in src/__tests__/onboarding.test.tsx) ----

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

const mockMic = { granted: true, canAskAgain: true };
jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' })),
  getRecordingPermissionsAsync: jest.fn(async () => ({
    granted: mockMic.granted,
    canAskAgain: mockMic.canAskAgain,
    status: mockMic.granted ? 'granted' : 'denied',
    expires: 'never',
  })),
}));

const mockReadiness = { value: 'ready' };
jest.mock('../asr/speedCheck', () => ({
  SLOW_P90_MS: 1000,
  judgeReadiness: jest.fn(() => mockReadiness.value),
  runSpeedCheck: jest.fn(async () => mockReadiness.value),
  rerunSpeedCheck: jest.fn(async () => mockReadiness.value),
}));

const mockStatus: DownloadStatus = { waitingForWifi: false, plan: null, items: [] }; // one object: useSyncExternalStore needs a stable snapshot
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

type HomeSection =
  | { id: 'upNext' | 'waiting' | 'pending'; lessons: string[] }
  | { id: 'revision'; items: DueItem[] }
  | { id: 'completed'; lessons: string[]; collapsed: boolean };
type HomeInput = {
  queue: TodayQueue;
  inProgress: string[];
  assignments: { template_id: string; for_date: string; done_at: string | null }[];
  finished: string[];
  due: DueItem[];
};
type MicState = { granted: boolean; canAskAgain: boolean };
type AttentionInput = { readiness: 'ready' | 'missing' | 'slow' | 'oom'; mic: MicState; micLastGrantedAt: string | null };
type Banner =
  | { kind: 'model'; action: 'resumeDownload' }
  | { kind: 'mic'; action: 'requestPermission' | 'openSettings'; chooseWhileUsing: boolean }
  | { kind: 'weak'; action: null };
type SetupRow = { kind: 'profile'; sections: string[]; href: string } | { kind: 'consent'; href: string };

/* eslint-disable @typescript-eslint/no-require-imports */
const homeMod = () => require('./home') as { homeSections(input: HomeInput): HomeSection[] };
const attentionMod = () => require('./attention') as { attentionBanner(input: AttentionInput): Banner | null };
const setupMod = () =>
  require('./setup') as { SETUP_SECTIONS: readonly string[]; setupRows(child: ChildProfile, device: Device): SetupRow[] };

const startDownloads = () => require('../downloads/downloader').startInitialDownloads as jest.Mock;
const micRequest = () => require('expo-audio').requestRecordingPermissionsAsync as jest.Mock;

const ChildPickerStub = () => h(Text, null, 'child-picker');
function routes() {
  return {
    _layout: require('../app/_layout').default,
    index: ChildPickerStub,
    'parent/index': require('../app/parent/index').default,
    'parent/downloads': () => h(Text, { testID: 'downloads-screen' }, 'downloads'),
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;

const TODAY = '2026-11-20';
const due = (item_key: string, lang = 'mr'): DueItem => ({ item_key, lang });
const lesson = (template_id: string, revision: DueItem[] = []) => ({ kind: 'lesson' as const, template_id, revision });
const queueOf = (over: Partial<TodayQueue> = {}): TodayQueue => ({
  stops: [],
  goal: 3,
  done: 0,
  goalMet: false,
  waitingForDownload: [],
  ...over,
});

const ALL_SECTIONS = ['goals_style', 'lessons_per_day', 'board'];

function addChild(nickname: string, picture: string, over: Partial<ChildProfile> = {}): ChildProfile {
  const child = createChild(db, { nickname, picture, class: 'UKG', medium: 'mr' });
  return Object.keys(over).length ? updateChild(db, child.id, over)! : child;
}

function setConsentAnswered(at: string | null) {
  db.run('UPDATE device SET consent_answered_at = ?', [at]);
}

async function openHome() {
  const router = await renderRouter(routes(), { initialUrl: '/parent' });
  await screen.findByTestId('today-progress');
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
  mockReadiness.value = 'ready';
  mockMic.granted = true;
  mockMic.canAskAgain = true;
  mockStatus.plan = null;
  jest.clearAllMocks();
});

// ---- behaviour ----

describe('GURU-30 homeSections: decision 23 order', () => {
  test('Up next, waiting for download, Pending, Revision due, Completed (collapsed)', () => {
    const queue = buildTodayQueue({
      today: TODAY,
      goal: 2,
      doneToday: 0,
      inProgress: ['tpl_a', 'tpl_b', 'tpl_p'],
      assignments: [],
      paths: [{ path_id: 'class_msb_UKG', units: [{ unit_id: 'u1', lessons: ['tpl_f', 'tpl_w'] }] }],
      finished: ['tpl_f'],
      due: [due('a'), due('i'), due('u'), due('k'), due('kh')],
      lessonLang: { tpl_a: 'mr', tpl_b: 'mr', tpl_p: 'mr', tpl_w: 'mr' },
      isInstalled: (id) => id !== 'tpl_w',
    });
    // Room for two: a and b are up next, p is left over, w waits for its pack.
    const sections = homeMod().homeSections({
      queue,
      inProgress: ['tpl_a', 'tpl_b', 'tpl_p'],
      assignments: [],
      finished: ['tpl_f'],
      due: [due('a'), due('i'), due('u'), due('k'), due('kh')],
    });

    expect(sections.map((s) => s.id)).toEqual(['upNext', 'waiting', 'pending', 'revision', 'completed']);
    expect(sections[0]).toEqual({ id: 'upNext', lessons: ['tpl_a', 'tpl_b'] }); // revision stops are not lessons
    expect(sections[1]).toEqual({ id: 'waiting', lessons: ['tpl_w'] });
    expect(sections[2]).toEqual({ id: 'pending', lessons: ['tpl_p'] });
    expect(sections[3]).toEqual({ id: 'revision', items: [due('a'), due('i'), due('u'), due('k'), due('kh')] });
    expect(sections[4]).toEqual({ id: 'completed', lessons: ['tpl_f'], collapsed: true });
  });

  test('no waiting section without a missing pack; an assigned lesson shows once, finished ones never in Pending', () => {
    const queue = queueOf({ stops: [lesson('tpl_a'), { kind: 'revision', items: [due('k')] }, lesson('tpl_b')] });
    const sections = homeMod().homeSections({
      queue,
      inProgress: ['tpl_c'],
      assignments: [
        { template_id: 'tpl_a', for_date: TODAY, done_at: null }, // already up next
        { template_id: 'tpl_d', for_date: '2026-11-19', done_at: null }, // carried over, did not fit
        { template_id: 'tpl_f', for_date: '2026-11-18', done_at: '2026-11-18T10:00:00.000Z' }, // done
      ],
      finished: ['tpl_f'],
      due: [due('k')],
    });

    expect(sections.map((s) => s.id)).toEqual(['upNext', 'pending', 'revision', 'completed']);
    expect(sections.find((s) => s.id === 'upNext')).toEqual({ id: 'upNext', lessons: ['tpl_a', 'tpl_b'] });
    const pending = sections.find((s) => s.id === 'pending') as { lessons: string[] };
    expect([...pending.lessons].sort()).toEqual(['tpl_c', 'tpl_d']);
  });
});

describe('GURU-30 attentionBanner: one banner by priority', () => {
  const ok: AttentionInput = { readiness: 'ready', mic: { granted: true, canAskAgain: true }, micLastGrantedAt: null };
  const noMic = { granted: false, canAskAgain: true };

  test.each<[string, AttentionInput, Banner['kind'] | null]>([
    ['all fine', ok, null],
    ['model missing beats mic and weak', { ...ok, readiness: 'missing', mic: noMic }, 'model'],
    ['mic beats a slow phone', { ...ok, readiness: 'slow', mic: noMic }, 'mic'],
    ['mic beats out of memory', { ...ok, readiness: 'oom', mic: noMic }, 'mic'],
    ['slow phone alone', { ...ok, readiness: 'slow' }, 'weak'],
    ['out of memory alone', { ...ok, readiness: 'oom' }, 'weak'],
  ])('%s', (_name, input, kind) => {
    const banner = attentionMod().attentionBanner(input);
    expect(banner?.kind ?? null).toBe(kind);
  });

  test('actions: resume the download, ask for the mic or open app settings, none for a weak phone', () => {
    const { attentionBanner } = attentionMod();
    expect(attentionBanner({ ...ok, readiness: 'missing' })).toEqual({ kind: 'model', action: 'resumeDownload' });
    expect(attentionBanner({ ...ok, readiness: 'oom' })).toEqual({ kind: 'weak', action: null });

    // Never granted: ask again, no "While using the app" hint.
    expect(attentionBanner({ ...ok, mic: noMic })).toEqual({ kind: 'mic', action: 'requestPermission', chooseWhileUsing: false });
    // Android will not show the dialog again: the app's page in the phone's settings.
    expect(attentionBanner({ ...ok, mic: { granted: false, canAskAgain: false } })).toMatchObject({
      kind: 'mic',
      action: 'openSettings',
    });
    // Granted before ("Only this time" expired): the banner says to choose "While using the app".
    expect(attentionBanner({ ...ok, mic: noMic, micLastGrantedAt: '2026-11-19T09:00:00.000Z' })).toEqual({
      kind: 'mic',
      action: 'requestPermission',
      chooseWhileUsing: true,
    });
  });
});

describe('GURU-30 setupRows: Finish setting up card', () => {
  test('rows appear for unsaved profile sections and the unanswered consent, and leave once saved', () => {
    const { setupRows } = setupMod();
    const fresh = addChild('Chinu', 'peacock');
    const device = getDevice(db);
    expect(device.consent_answered_at).toBeNull();

    expect(setupRows(fresh, device)).toEqual([
      { kind: 'profile', sections: ALL_SECTIONS, href: `/parent/child/${fresh.id}` },
      { kind: 'consent', href: '/parent/consent' },
    ]);

    const someSaved = updateChild(db, fresh.id, { setup_done: ['board'] })!;
    expect(setupRows(someSaved, device)[0]).toEqual({
      kind: 'profile',
      sections: ['goals_style', 'lessons_per_day'],
      href: `/parent/child/${fresh.id}`,
    });

    const allSaved = updateChild(db, fresh.id, { setup_done: [...ALL_SECTIONS] })!;
    expect(setupRows(allSaved, device)).toEqual([{ kind: 'consent', href: '/parent/consent' }]);

    setConsentAnswered('2026-11-20T08:00:00.000Z');
    expect(setupRows(allSaved, getDevice(db))).toEqual([]);
  });
});

describe('GURU-30 /parent home screen', () => {
  test('one tab per child with its picture; the first card shows lessons done today against the goal', async () => {
    const chinu = addChild('Chinu', 'peacock', { lessons_per_day: 4 });
    const manu = addChild('Manu', 'elephant', { lessons_per_day: 2 });
    const session = startSession(db, chinu.id, new Date().toISOString());
    lessonEnded(db, { childId: chinu.id, sessionId: session, at: new Date().toISOString() }, 'tpl_kg_mr_swar_1');

    await openHome();
    const chinuTab = screen.getByTestId(`child-tab-${chinu.id}`);
    const manuTab = screen.getByTestId(`child-tab-${manu.id}`);
    expect(chinuTab).toHaveTextContent(new RegExp(CHILD_PICTURES.peacock));
    expect(chinuTab).toHaveTextContent(/Chinu/);
    expect(manuTab).toHaveTextContent(new RegExp(CHILD_PICTURES.elephant));

    // First child is shown first: 1 of 4 (Marathi puts the goal first: "4 पैकी 1").
    expect(screen.getByTestId('today-progress')).toHaveTextContent(/\b1\D+4\b|\b4\D+1\b/);
    fireEvent.press(manuTab);
    await waitFor(() => expect(screen.getByTestId('today-progress')).toHaveTextContent(/\b0\D+2\b|\b2\D+0\b/));
  });

  test('Completed is collapsed until the parent opens it', async () => {
    const chinu = addChild('Chinu', 'peacock');
    const session = startSession(db, chinu.id, new Date().toISOString());
    lessonEnded(db, { childId: chinu.id, sessionId: session, at: new Date().toISOString() }, 'tpl_kg_mr_swar_1');

    await openHome();
    const header = await screen.findByTestId('home-section-completed');
    expect(screen.queryByTestId('lesson-row-tpl_kg_mr_swar_1')).toBeNull();
    fireEvent.press(header);
    expect(await screen.findByTestId('lesson-row-tpl_kg_mr_swar_1')).toBeTruthy();
  });

  test('a banner says why Shekru cannot listen, with the fix one tap away', async () => {
    addChild('Chinu', 'peacock');

    mockReadiness.value = 'missing';
    const first = await openHome();
    const banner = await screen.findByTestId('attention-banner');
    startDownloads().mockClear(); // the root layout starts downloads on mount
    fireEvent.press(within(banner).getByTestId('attention-action'));
    await waitFor(() => expect(startDownloads()).toHaveBeenCalledTimes(1));
    first.unmount();

    mockReadiness.value = 'ready';
    mockMic.granted = false;
    const second = await openHome();
    const micBanner = await screen.findByTestId('attention-banner');
    fireEvent.press(within(micBanner).getByTestId('attention-action'));
    await waitFor(() => expect(micRequest()).toHaveBeenCalledTimes(1));
    second.unmount();

    mockMic.granted = true;
    await openHome();
    await act(async () => undefined); // let the permission read settle
    expect(screen.queryByTestId('attention-banner')).toBeNull();
  });

  test('short of space, the model banner opens the downloads screen and its storage prompt', async () => {
    addChild('Chinu', 'peacock');
    mockReadiness.value = 'missing';
    mockStatus.plan = { kind: 'needs_choice', needed: 200e6, free: 100e6, fits: [] };
    const router = await openHome();
    startDownloads().mockClear(); // the root layout starts downloads on mount
    fireEvent.press(within(await screen.findByTestId('attention-banner')).getByTestId('attention-action'));
    expect(await screen.findByTestId('downloads-screen')).toBeTruthy();
    expect(router).toHavePathname('/parent/downloads');
    expect(startDownloads()).not.toHaveBeenCalled(); // it would plan the same choice and queue nothing
  });

  test('the Finish setting up card shows its rows and hides when empty', async () => {
    const chinu = addChild('Chinu', 'peacock');
    const first = await openHome();
    const card = await screen.findByTestId('setup-card');
    expect(within(card).getByTestId('setup-row-profile')).toBeTruthy();
    expect(within(card).getByTestId('setup-row-consent')).toBeTruthy();
    first.unmount();

    updateChild(db, chinu.id, { setup_done: [...ALL_SECTIONS] });
    setConsentAnswered('2026-11-20T08:00:00.000Z');
    await openHome();
    expect(screen.queryByTestId('setup-card')).toBeNull();
  });
});

// ---- contract for dependents ----

// GURU-33 (consent row), GURU-34 (switch hosted on parent home), GURU-35 (assign from parent home),
// GURU-36 (setup rows link to the profile form and mark SETUP_SECTIONS), GURU-37 (parent shell).
describe('GURU-30 contract for GURU-33, GURU-34, GURU-35, GURU-36, GURU-37', () => {
  test('exports attentionBanner(), setupRows(child, device), homeSections(), SETUP_SECTIONS and the /parent home route', () => {
    const { attentionBanner } = attentionMod();
    expect(typeof attentionBanner).toBe('function');
    expect(attentionBanner.length).toBe(1);
    const banner = attentionBanner({ readiness: 'missing', mic: { granted: true, canAskAgain: true }, micLastGrantedAt: null });
    expect(banner).toEqual(expect.objectContaining({ kind: expect.any(String), action: expect.any(String) }));

    const { setupRows, SETUP_SECTIONS } = setupMod();
    expect(typeof setupRows).toBe('function');
    expect(setupRows.length).toBe(2);
    expect([...SETUP_SECTIONS]).toEqual(ALL_SECTIONS);
    const rows = setupRows(addChild('Chinu', 'peacock'), getDevice(db));
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) expect(row).toEqual(expect.objectContaining({ kind: expect.any(String), href: expect.any(String) }));

    const { homeSections } = homeMod();
    expect(typeof homeSections).toBe('function');
    expect(homeSections.length).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(typeof require('../app/parent/index').default).toBe('function');
  });
});
