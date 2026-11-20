// GURU-29: child picker, today's queue screen, readiness screens. Spec: issue GURU-29, PRD Happy Path
// (daily session 1-2), Edge Cases (model not downloaded, mic denied, phone too weak), wireframes
// c-picker, c-queue, c-queue-mid, c-queue-first, c-getting-ready, c-ready, c-ask-mic, c-ask-weak;
// decisions 3 (picker even with one child), 5 (day one: empty star with 0), 17.
// Lives outside src/app/: Expo Router turns every .tsx file there into a route and bundles it.
//
// The real `/` and `/child/[id]` routes render through expo-router's renderRouter, with stub
// `/lesson/[template]` (GURU-28) and `/goodbye` (GURU-33) routes. Faked:
//   expo-sqlite              one in-memory better-sqlite3 database behind openDatabaseSync,
//                            so liveDb()/openDb() anywhere in the app reads and writes it
//   expo-crypto              node crypto
//   expo-audio               getRecordingPermissionsAsync is the mic state (as parent home reads it)
//   asr/speedCheck           judgeReadiness() / runSpeedCheck() return the test's JudgeReadiness
//   downloads/downloader     downloadStatus() / subscribeDownloads() are the test's model download
//   learning/queue           buildTodayQueue() returns the test's fixed TodayQueue
//   screens/useLinePlayer    records the line ids Shekru plays
//   shekru/*, reanimated     Shekru draws nothing
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   child_profile(id, nickname, picture, ..., lessons_per_day DEFAULT 3, archived DEFAULT 0, created_at, ...)
//   session(id, child_id, started_at, ended_at, end_reason, parent_helps, active_ms, created_at, updated_at)
//   event(id, child_id, session_id, at, type, payload JSON, created_at, updated_at)   type 'lesson_end' | ...
//   lesson_position(id, child_id, template_id, version, position JSON, created_at, updated_at)
//
// Contract pinned for /implement (and GURU-34):
//   app/src/app/index.tsx       default export, the picker: one `child-tile-<child id>` per non-archived
//                               child (oldest first), nickname inside, 148 dp wide
//                               (theme.touch.child.pickerTile); <ParentLock /> (testID parent-lock).
//                               A tap opens a session (learning/session startSession: a session row
//                               with ended_at NULL) and goes to /child/<id>.
//   app/src/app/child/[id].tsx  default export, the queue screen:
//     trail      one `stop-<template_id>` per lesson stop and `stop-revision` for the revision stop, in
//                queue order; the revision stop holds `revision-icon` (loop); the next stop (the
//                first) holds `next-ring`, no other stop does.
//     stars      `stars`, a Text with the child's all-time number of lesson_end events ('0' on day one).
//     start      `queue-start`, at least 96 dp tall (theme.touch.child.mainButton); label 'सुरू करूया'
//                at the start of the day, mr.next ('पुढे') once a lesson is in progress or one was
//                finished today (mid-day frame). It pushes /lesson/<template_id> with params
//                `child` (child id) and `stop` (JSON.stringify of the stop), as GURU-28 reads them.
//     goal met   queue.goalMet goes to /goodbye.
//     readiness  not `ready`: no start button and no answer buttons; Shekru plays one
//                `ask_grownup_model_<n>` / `ask_grownup_mic_<n>` / `ask_grownup_weak_<n>` line.
//                getting_ready turns into the queue by itself when a download status change reports
//                the model installed, and Shekru plays a `ready_<n>` line.
//   app/src/child/readiness.ts  export readiness({ model, mic, judge, parentHelps }) ->
//                'ready' | 'getting_ready' | 'ask_mic' | 'ask_weak'; pure.
//                model: the model's DownloadItem (downloads/downloader) or null; mic: { granted };
//                judge: JudgeReadiness (asr/speedCheck); parentHelps: boolean.
//
// Not tested here: applyStyleLevelAtSessionStart (GURU-22, not merged; call it when present), and
// what the start button does when the next stop is the revision stop (buildTodayQueue only puts it
// first when no lesson fits; GURU-28's route takes lesson stops).
import { createElement as h } from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { JudgeReadiness } from '../asr/speedCheck';
import { openDb, type Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, updateChild } from '../data/profiles';
import type { DownloadItem, DownloadStatus } from '../downloads/downloader';
import type { TodayQueue } from '../learning/queue';
import { lessonEnded } from '../learning/session';
import { LanguageProvider } from '../ui/i18n';
import { mr } from '../ui/strings/mr';
import { theme } from '../ui/theme';

// ---- native fakes ----

type Raw = { exec(sql: string): void; prepare(sql: string): { run(p: unknown[]): unknown; all(p: unknown[]): unknown[]; get(p: unknown[]): unknown }; transaction<T>(fn: () => T): () => T };
let mockRawDb: Raw | null = null;
function mockRaw(): Raw {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mockRawDb ??= new (require('better-sqlite3'))(':memory:') as Raw;
  return mockRawDb;
}
// better-sqlite3 rejects booleans; expo-sqlite binds them as 1/0.
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
  return { randomUUID: () => c.randomUUID(), getRandomBytes: (n: number) => new Uint8Array(c.randomBytes(n)) };
});

// Mic state; every other expo-audio export is a no-op.
const mockMic = { granted: true };
jest.mock('expo-audio', () => {
  const thing = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : key === 'remove' ? () => undefined : thing()),
      apply: () => thing(),
    });
  const permission = async () => ({
    granted: mockMic.granted,
    canAskAgain: true,
    status: mockMic.granted ? 'granted' : 'denied',
    expires: 'never',
  });
  const known: Record<string, unknown> = {
    __esModule: true,
    getRecordingPermissionsAsync: jest.fn(permission),
    requestRecordingPermissionsAsync: jest.fn(permission),
  };
  return new Proxy(known, { get: (t, k) => (k in t ? t[k as string] : thing()) });
});

const mockJudge: { value: JudgeReadiness } = { value: 'ready' };
jest.mock('../asr/speedCheck', () => ({
  SLOW_P90_MS: 1000,
  judgeReadiness: jest.fn(() => mockJudge.value),
  runSpeedCheck: jest.fn(async () => mockJudge.value),
  rerunSpeedCheck: jest.fn(async () => mockJudge.value),
}));

// One status object per state: useSyncExternalStore needs a stable snapshot.
const mockDownloads: { status: DownloadStatus; listeners: Set<() => void> } = {
  status: { waitingForWifi: false, plan: null, items: [] },
  listeners: new Set(),
};
jest.mock('../downloads/downloader', () => ({
  startInitialDownloads: jest.fn(async () => undefined),
  queuePacks: jest.fn(async () => undefined),
  queueChildPacks: jest.fn(async () => undefined),
  isLessonInstalled: jest.fn(() => true),
  downloadStatus: jest.fn(() => mockDownloads.status),
  subscribeDownloads: jest.fn((listener: () => void) => {
    mockDownloads.listeners.add(listener);
    return () => mockDownloads.listeners.delete(listener);
  }),
}));

const mockQueue: { value: TodayQueue | null } = { value: null };
jest.mock('../learning/queue', () => {
  const actual = jest.requireActual('../learning/queue');
  return { ...actual, buildTodayQueue: jest.fn((input: unknown) => mockQueue.value ?? actual.buildTodayQueue(input)) };
});

const mockLines: string[] = [];
jest.mock('../screens/useLinePlayer', () => {
  const player = {
    play: async (id: string) => void mockLines.push(id),
    stop: () => undefined,
    chime: () => undefined,
  };
  return { useLinePlayer: () => player }; // stable, as the real hook's useMemo
});

jest.mock('../shekru/useShekruRig', () => {
  const rig = { values: {}, setState: () => undefined, setSpeech: () => undefined, syncSpeech: () => undefined };
  return { useShekruRig: () => rig, FRONT_SUFFIX: '@front', SHADOW: '@shadow', SHADOW_CX: 0, SHADOW_CY: 0 };
});
jest.mock('../shekru/Shekru', () => ({ Shekru: () => null }));
// Reanimated 4's own jest mock cannot load here, and expo-router/testing-library mocks
// react-native-reanimated with it on import. Views are plain RN views, animations their end value,
// everything else a chainable no-op.
jest.mock('react-native-reanimated/mock', () => {
  const chain = (): unknown =>
    new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : chain()), apply: () => chain() });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = (name: string) => require('react-native')[name];
  const views = ['View', 'Text', 'Image', 'ScrollView', 'FlatList'];
  const Animated: Record<string, unknown> = new Proxy(
    { createAnimatedComponent: (c: unknown) => c },
    { get: (t, k) => (views.includes(k as string) ? rn(k as string) : (t as Record<string | symbol, unknown>)[k]) },
  );
  const known: Record<string, unknown> = {
    __esModule: true,
    default: Animated,
    createAnimatedComponent: (c: unknown) => c,
    useSharedValue: (v: unknown) => ({ value: v, get: () => v, set: () => undefined }),
    makeMutable: (v: unknown) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
    useAnimatedRef: () => ({ current: null }),
    useFrameCallback: () => ({ setActive: () => undefined, isActive: false }),
    useReducedMotion: () => false,
    withTiming: (v: unknown) => v,
    withSpring: (v: unknown) => v,
    withDelay: (_d: number, v: unknown) => v,
    withSequence: (...v: unknown[]) => v[v.length - 1],
    withRepeat: (v: unknown) => v,
    cancelAnimation: () => undefined,
    interpolate: () => 0,
    runOnJS: (fn: unknown) => fn,
    runOnUI: (fn: unknown) => fn,
  };
  return new Proxy(known, {
    get: (t, k) => (views.includes(k as string) ? rn(k as string) : k in t ? t[k as string] : chain()),
  });
});
jest.mock('react-native-reanimated', () => jest.requireMock('react-native-reanimated/mock'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// ---- routes ----

/* eslint-disable @typescript-eslint/no-require-imports */
function TestRoot() {
  const { Stack } = require('expo-router');
  return h(
    SafeAreaProvider,
    null,
    h(LanguageProvider, { onChange: () => undefined }, h(Stack, { screenOptions: { headerShown: false } })),
  );
}
function LessonStub() {
  const params = require('expo-router').useLocalSearchParams();
  return h(Text, { testID: 'lesson-params' }, JSON.stringify(params));
}
const GoodbyeStub = () => h(Text, null, 'goodbye');
const UnlockStub = () => h(Text, null, 'parent-unlock');

// Route files load lazily, so a missing one fails its own test with "Cannot find module".
function routes() {
  return {
    _layout: TestRoot,
    index: require('../app/index').default,
    'child/[id]': require('../app/child/[id]').default,
    'lesson/[template]': LessonStub,
    goodbye: GoodbyeStub,
    'parent/unlock': UnlockStub,
  };
}

type Readiness = 'ready' | 'getting_ready' | 'ask_mic' | 'ask_weak';
type ReadinessInput = { model: DownloadItem | null; mic: { granted: boolean; canAskAgain: boolean }; judge: JudgeReadiness; parentHelps: boolean };
const readinessFn = () => (require('../child/readiness') as { readiness: (input: ReadinessInput) => Readiness }).readiness;
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- fixtures and helpers ----

const A = 'tpl_kg_mr_swar_1';
const B = 'tpl_kg_en_letters_1';
const C = 'tpl_kg_mr_vyanjan_1';

/** c-queue: lesson, revision stop, lesson, lesson; nothing done today. */
const FIXED: TodayQueue = {
  stops: [
    { kind: 'lesson', template_id: A, revision: [{ item_key: 'mr:letter:अ', lang: 'mr' }] },
    { kind: 'revision', items: [{ item_key: 'en:letter:F', lang: 'en' }] },
    { kind: 'lesson', template_id: B, revision: [] },
    { kind: 'lesson', template_id: C, revision: [] },
  ],
  goal: 3,
  done: 0,
  goalMet: false,
  waitingForDownload: [],
};

const START = 'सुरू करूया';
const ANSWER_LABELS = ['बरोबर', 'चूक', 'शांत']; // GURU-34's parent answer buttons

const model = (status: DownloadItem['status'], bytesDone = 100): DownloadItem => ({
  id: 'mr_ctc_wav.int8',
  kind: 'model',
  version: 1,
  status,
  bytesDone,
  bytesTotal: 100,
});

function setDownloads(items: DownloadItem[]) {
  mockDownloads.status = { waitingForWifi: false, plan: null, items };
}

let db: Db;

const addChild = (nickname: string, picture: string) => createChild(db, { nickname, picture, class: 'UKG', medium: 'mr' });
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

function finishedLesson(childId: string, templateId: string, at: string) {
  lessonEnded(db, { childId, sessionId: 'earlier-session', at }, templateId);
}

function savePositionRow(childId: string, templateId: string) {
  const at = new Date().toISOString();
  db.run(
    'INSERT INTO lesson_position (id, child_id, template_id, version, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [`pos-${templateId}`, childId, templateId, 1, '{}', at, at],
  );
}

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(50);
  });
}

const tallest = (testID: string) => {
  const s = StyleSheet.flatten(screen.getByTestId(testID).props.style) ?? {};
  return Math.max(Number(s.height ?? 0), Number(s.minHeight ?? 0));
};

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) db.run(`DELETE FROM "${name}"`);
  mockMic.granted = true;
  mockJudge.value = 'ready';
  setDownloads([model('installed')]);
  mockDownloads.listeners.clear();
  mockQueue.value = FIXED;
  mockLines.length = 0;
  jest.clearAllMocks();
});

describe('GURU-29 child picker, queue and readiness', () => {
  test.each([
    ['two children', ['Chinu', 'Manu']],
    ['one child: the picker still shows (decision 3)', ['Chinu']],
  ])('picker, %s: one 148 dp tile per non-archived child and the lock; a tap starts a session and opens the queue', async (_name, names) => {
    const pictures = ['peacock', 'elephant'];
    const children = names.map((n, i) => addChild(n, pictures[i]));
    const archived = addChild('Gone', 'tiger');
    updateChild(db, archived.id, { archived: true });

    const router = await renderRouter(routes(), { initialUrl: '/' });
    const tiles = await screen.findAllByTestId(/^child-tile-/);
    expect(tiles.map((t) => t.props.testID)).toEqual(children.map((c) => `child-tile-${c.id}`));
    for (const c of children) expect(within(screen.getByTestId(`child-tile-${c.id}`)).getByText(c.nickname)).toBeTruthy();
    expect(screen.queryByText('Gone')).toBeNull();
    expect(screen.getByTestId('parent-lock')).toBeTruthy();
    for (const t of tiles) {
      const s = StyleSheet.flatten(t.props.style) ?? {};
      expect(s.width ?? s.minWidth).toBe(theme.touch.child.pickerTile);
    }

    // No session and no navigation until a face is tapped, even with one child.
    await settle();
    expect(router.getPathname()).toBe('/');
    expect(db.all('SELECT id FROM session')).toHaveLength(0);

    const chosen = children[children.length - 1];
    fireEvent.press(screen.getByTestId(`child-tile-${chosen.id}`));
    await waitFor(() => expect(router.getPathname()).toBe(`/child/${chosen.id}`));
    expect(db.all('SELECT child_id, ended_at FROM session')).toEqual([{ child_id: chosen.id, ended_at: null }]);
  });

  test('queue from a fixed queue (c-queue): trail in order with the loop icon on revision, next stop ringed, all-time stars, 96 dp start opens the lesson route', async () => {
    const child = addChild('Chinu', 'peacock');
    const other = addChild('Manu', 'elephant');
    finishedLesson(child.id, A, daysAgo(1));
    finishedLesson(child.id, B, daysAgo(1));
    finishedLesson(child.id, A, daysAgo(3)); // a repeat still earned its star
    finishedLesson(other.id, A, daysAgo(1)); // another child's star

    const router = await renderRouter(routes(), { initialUrl: `/child/${child.id}` });
    const start = await screen.findByTestId('queue-start');

    expect(screen.getAllByTestId(/^stop-/).map((s) => s.props.testID)).toEqual([`stop-${A}`, 'stop-revision', `stop-${B}`, `stop-${C}`]);
    expect(within(screen.getByTestId('stop-revision')).getByTestId('revision-icon')).toBeTruthy();
    for (const id of [A, B, C]) expect(within(screen.getByTestId(`stop-${id}`)).queryByTestId('revision-icon')).toBeNull();
    expect(screen.getAllByTestId('next-ring')).toHaveLength(1);
    expect(within(screen.getByTestId(`stop-${A}`)).getByTestId('next-ring')).toBeTruthy();

    expect(within(screen.getByTestId('stars')).getByText('3')).toBeTruthy();

    expect(within(start).getByText(START)).toBeTruthy();
    expect(tallest('queue-start')).toBeGreaterThanOrEqual(theme.touch.child.mainButton);
    for (const label of ANSWER_LABELS) expect(screen.queryByText(label)).toBeNull();

    fireEvent.press(start);
    await waitFor(() => expect(router.getPathname()).toBe(`/lesson/${A}`));
    const params = JSON.parse(String((await screen.findByTestId('lesson-params')).props.children));
    expect(params.child).toBe(child.id);
    expect(JSON.parse(params.stop)).toEqual(FIXED.stops[0]);
  });

  test.each([
    ['day one (c-queue-first): an empty star with 0', 'first', '0', START],
    ['a lesson in progress (c-queue-mid)', 'inProgress', '0', mr.next],
    ['a lesson finished today (c-queue-mid)', 'doneToday', '1', mr.next],
    ['goal met: goes to /goodbye', 'goalMet', null, null],
  ] as const)('frame: %s', async (_name, state, stars, label) => {
    const child = addChild('Chinu', 'peacock');
    if (state === 'inProgress') savePositionRow(child.id, A);
    if (state === 'doneToday') {
      finishedLesson(child.id, A, new Date().toISOString());
      mockQueue.value = { ...FIXED, stops: FIXED.stops.slice(2), done: 1 };
    }
    if (state === 'goalMet') {
      for (const id of [A, B, C]) finishedLesson(child.id, id, new Date().toISOString());
      mockQueue.value = { ...FIXED, stops: [], done: 3, goalMet: true };
    }

    const router = await renderRouter(routes(), { initialUrl: `/child/${child.id}` });
    if (state === 'goalMet') {
      await waitFor(() => expect(router.getPathname()).toBe('/goodbye'));
      expect(screen.queryByTestId('queue-start')).toBeNull();
      return;
    }
    const start = await screen.findByTestId('queue-start');
    expect(within(start).getByText(label!)).toBeTruthy();
    expect(within(start).queryByText(label === START ? mr.next : START)).toBeNull();
    expect(within(screen.getByTestId('stars')).getByText(stars!)).toBeTruthy();
  });

  test('readiness(): getting_ready (model missing, failed or downloading), then ask_mic, then ask_weak; ready otherwise and whenever parentHelps', () => {
    const readiness = readinessFn();
    const granted = { granted: true, canAskAgain: true };
    const denied = { granted: false, canAskAgain: true };
    const rows: [ReadinessInput, Readiness][] = [
      [{ model: model('installed'), mic: granted, judge: 'ready', parentHelps: false }, 'ready'],
      [{ model: null, mic: granted, judge: 'missing', parentHelps: false }, 'getting_ready'],
      [{ model: model('downloading', 46), mic: denied, judge: 'missing', parentHelps: false }, 'getting_ready'],
      [{ model: model('queued', 0), mic: granted, judge: 'missing', parentHelps: false }, 'getting_ready'],
      [{ model: model('failed', 10), mic: denied, judge: 'missing', parentHelps: false }, 'getting_ready'],
      [{ model: model('installed'), mic: denied, judge: 'slow', parentHelps: false }, 'ask_mic'],
      [{ model: model('installed'), mic: denied, judge: 'ready', parentHelps: false }, 'ask_mic'],
      [{ model: model('installed'), mic: granted, judge: 'slow', parentHelps: false }, 'ask_weak'],
      [{ model: model('installed'), mic: granted, judge: 'oom', parentHelps: false }, 'ask_weak'],
    ];
    for (const [input, expected] of rows) expect([input, readiness(input)]).toEqual([input, expected]);
    // The parent switch (GURU-34) bypasses every waiting screen.
    for (const [row] of rows) {
      const input = { ...row, parentHelps: true };
      expect([input, readiness(input)]).toEqual([input, 'ready']);
    }
  });

  test.each([
    ['model missing (c-getting-ready)', 'model', /^ask_grownup_model_\d+$/],
    ['mic denied (c-ask-mic)', 'mic', /^ask_grownup_mic_\d+$/],
    ['phone too weak (c-ask-weak)', 'weak', /^ask_grownup_weak_\d+$/],
  ] as const)('ask a grown-up, %s: no start or answer buttons, Shekru says the matching line', async (_name, why, line) => {
    const child = addChild('Chinu', 'peacock');
    if (why === 'model') {
      mockJudge.value = 'missing';
      setDownloads([model('downloading', 46)]);
    }
    if (why === 'mic') mockMic.granted = false;
    if (why === 'weak') mockJudge.value = 'slow';

    await renderRouter(routes(), { initialUrl: `/child/${child.id}` });
    await waitFor(() => expect(mockLines.some((id) => line.test(id))).toBe(true));
    await settle();
    expect(screen.queryByTestId('queue-start')).toBeNull();
    for (const label of ANSWER_LABELS) expect(screen.queryByText(label)).toBeNull();
    expect(mockLines.filter((id) => /^ask_grownup_/.test(id) && !line.test(id))).toEqual([]);
    expect(mockLines.some((id) => /^ready_\d+$/.test(id))).toBe(false);
    expect(screen.getByTestId('parent-lock')).toBeTruthy();
  });

  test('getting ready turns into the queue by itself when the model download finishes (c-ready), and Shekru says he is ready', async () => {
    const child = addChild('Chinu', 'peacock');
    mockJudge.value = 'missing';
    setDownloads([model('downloading', 46)]);

    await renderRouter(routes(), { initialUrl: `/child/${child.id}` });
    await waitFor(() => expect(mockLines.some((id) => /^ask_grownup_model_\d+$/.test(id))).toBe(true));
    await settle();
    expect(screen.queryByTestId('queue-start')).toBeNull();
    expect(mockLines.some((id) => /^ready_\d+$/.test(id))).toBe(false);
    expect(mockDownloads.listeners.size).toBeGreaterThan(0);

    // The download finishes; no tap.
    await act(async () => {
      mockJudge.value = 'ready';
      setDownloads([model('installed')]);
      mockDownloads.listeners.forEach((l) => l());
    });

    expect(await screen.findByTestId('queue-start')).toBeTruthy();
    await waitFor(() => expect(mockLines.some((id) => /^ready_\d+$/.test(id))).toBe(true));
    expect(screen.getAllByTestId(/^stop-/).map((s) => s.props.testID)).toEqual([`stop-${A}`, 'stop-revision', `stop-${B}`, `stop-${C}`]);
  });

  // Contract for GURU-34 (parent helps: readiness() bypass) and GURU-28 (the queue opens its route).
  // Shape only.
  test('contract: `/` and `/child/[id]` default exports; readiness({ model, mic, judge, parentHelps }) returns one of four states', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    expect(typeof require('../app/index').default).toBe('function');
    expect(typeof require('../app/child/[id]').default).toBe('function');
    const mod = require('../child/readiness');
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(typeof mod.readiness).toBe('function');
    const out = mod.readiness({ model: null, mic: { granted: true, canAskAgain: true }, judge: 'ready', parentHelps: true } satisfies ReadinessInput);
    expect(typeof out).toBe('string');
    expect(['ready', 'getting_ready', 'ask_mic', 'ask_weak']).toContain(out);
  });
});
