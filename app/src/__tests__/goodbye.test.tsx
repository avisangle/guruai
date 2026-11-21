// GURU-33: goodbye screen and consent prompt. Spec: issue GURU-33, PRD Happy Path (consents) and
// Acceptance Criteria (consents off by default), wireframes l-goodbye, pm-consent, decisions 8
// (done means done for the day) and 12 (consent after the first lesson, not in onboarding).
// Lives outside src/app/: Expo Router turns every .tsx file there into a route and bundles it.
//
// The real `/goodbye`, `/parent/_layout`, `/parent/unlock` and `/parent/consent` routes (and the
// real picker `/` and queue `/child/[id]` in the picker test) render through expo-router's
// renderRouter. Parent home is a stub that can end parent mode. Faked:
//   expo-sqlite              one in-memory better-sqlite3 database behind openDatabaseSync,
//                            so liveDb()/openDb() anywhere in the app reads and writes it
//   expo-crypto              node crypto
//   expo-audio               mic granted; every other export a no-op
//   expo-local-authentication, expo-secure-store   never reached: the gate is injected
//   asr/speedCheck, downloads/downloader           judge ready, model installed, every lesson installed
//   screens/useLinePlayer    records the line ids Shekru plays
//   shekru/*, reanimated     Shekru draws nothing
//   the parent gate          a fake in PIN mode (PIN 2580) given to ParentModeProvider, as in
//                            src/parent/parentShell.test.tsx
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   device(id, device_id, parent_lang, allow_mobile_data, consent_clips INTEGER, consent_summaries INTEGER,
//          consent_answered_at TEXT, judge_check, judge_p90_ms, mic_last_granted_at, created_at, updated_at)
//          getDevice() maps consent_* 0/1 to booleans and NULL to null ("not asked yet").
//   session(id, child_id, started_at, ended_at, end_reason 'goodbye'|'stop'|'closed', active_ms, parent_helps, ...)
//   event(id, child_id, session_id, at, type 'lesson_end' | ..., payload JSON { template_id }, ...)
//   assignment(id, child_id, template_id, for_date, done_at, ...)
//
// Inputs from merged issues:
//   GURU-28  the lesson end goes to /goodbye with param `child` (lesson/LessonPlayer.tsx).
//   GURU-29  the queue screen redirects to /goodbye when queue.goalMet (app/child/[id].tsx); today
//            without the child id, which /goodbye needs (see the picker test).
//   GURU-25  ParentModeProvider({ gate }), enter() replaces to /parent, exit() dismisses to /;
//            /parent/unlock keypad digits are buttons named "0".."9".
//   GURU-30  the setup card's consent row links to /parent/consent (parent/setup.ts).
//
// Contract pinned for /implement (and GURU-38):
//   app/src/app/goodbye.tsx   default export. Param `child` (child id), as GURU-28 sends it.
//     line       on open Shekru plays one `bye_<n>` line through useLinePlayer (screens/useLinePlayer).
//     session    on open, the child's open session ends with end_reason 'goodbye' (ended_at set).
//     trail      `stop-<template_id>` for each lesson the child finished today (lesson_end today),
//                each holding `stop-tick`; then `stop-<id>` for each stop buildTodayQueue still has
//                for today (an active-time cap ended the day early), labelled "उद्या" (parent
//                language), without `stop-tick`.
//     no start   no `queue-start`, no button (role button) and nothing else pressable outside the
//                consent strip and the parent lock.
//     strip      `consent-strip`, only while device.consent_answered_at is null and at least one
//                lesson_end exists on the device; text "पालकांसाठी: शेकरूला सुधारायला मदत कराल?"
//                (parent language). A press goes to /parent/unlock, nothing else.
//   app/src/app/parent/consent.tsx   default export, behind the parent lock like every /parent route.
//     switches   React Native Switch elements `consent-clips` (Share recordings) and
//                `consent-summaries` (Share session summaries), off by default.
//     sent       `consent-what-is-sent`: no names, only the phone's code number and the child's code.
//     buttons    "जतन करा" (Save) writes both switches; "आत्ता नको" (Not now) writes both false.
//                Both set consent_answered_at (ISO) and then go to /parent.
//   app/src/app/parent/_layout.tsx   once per parent-mode visit (unlock to exit), while
//                consent_answered_at is null, the first /parent screen is /parent/consent.
//   picker       a tap on a child whose goal is met ends on /goodbye for that child.
import * as fs from 'fs';
import * as path from 'path';
import { createElement as h, type ReactNode } from 'react';
import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { openDb, type Db } from '../data/db';
import { getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import { createChild, updateChild } from '../data/profiles';
import type { ChildProfile } from '../data/types';
import { assignLesson } from '../learning/assignments';
import { localDay } from '../learning/mastery';
import { lessonEnded, startSession } from '../learning/session';
import type { Gate, PinResult } from '../parent/gate';
import { LanguageProvider, type UiLang } from '../ui/i18n';

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

jest.mock('expo-audio', () => {
  const thing = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : key === 'remove' ? () => undefined : thing()),
      apply: () => thing(),
    });
  const permission = async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' });
  const known: Record<string, unknown> = {
    __esModule: true,
    getRecordingPermissionsAsync: jest.fn(permission),
    requestRecordingPermissionsAsync: jest.fn(permission),
  };
  return new Proxy(known, { get: (t, k) => (k in t ? t[k as string] : thing()) });
});

// The injected gate is used; the live one must never reach native code.
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(async () => 0),
  authenticateAsync: jest.fn(async () => ({ success: false, error: 'not_available' })),
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));

jest.mock('../asr/speedCheck', () => ({
  SLOW_P90_MS: 1000,
  judgeReadiness: jest.fn(() => 'ready'),
  runSpeedCheck: jest.fn(async () => 'ready'),
  rerunSpeedCheck: jest.fn(async () => 'ready'),
}));

const mockDownloadStatus = {
  waitingForWifi: false,
  plan: null,
  items: [{ id: 'mr_ctc_wav.int8', kind: 'model', version: 1, status: 'installed', bytesDone: 100, bytesTotal: 100 }],
};
jest.mock('../downloads/downloader', () => ({
  startInitialDownloads: jest.fn(async () => undefined),
  queuePacks: jest.fn(async () => undefined),
  queueChildPacks: jest.fn(async () => undefined),
  isLessonInstalled: jest.fn(() => true),
  downloadStatus: jest.fn(() => mockDownloadStatus),
  subscribeDownloads: jest.fn(() => () => undefined),
}));

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

// ---- the parent gate: PIN mode, one right PIN ----

const PIN = '2580';

function fakeGate() {
  return {
    mode: jest.fn(async () => 'pin' as const),
    deviceLockAvailable: jest.fn(async () => true),
    state: jest.fn(async () => 'pin' as const),
    unlockWithDevice: jest.fn(async (_message?: string) => false),
    setPin: jest.fn(async (_pin: string) => undefined),
    verifyPin: jest.fn(async (pin: string): Promise<PinResult> => ({ ok: pin === PIN })),
    recoverWithBiometrics: jest.fn(async (_message?: string) => false),
  };
}

// ---- routes ----

/* eslint-disable @typescript-eslint/no-require-imports */
type Mod = { default: () => ReactNode };
const route = (p: string) => (require(p) as Mod).default;

function testRoot(gate: Gate, lang: UiLang) {
  return function TestRoot() {
    const { Stack } = require('expo-router');
    const { ParentModeProvider } = require('../parent/ParentModeProvider');
    return h(
      SafeAreaProvider,
      null,
      h(
        LanguageProvider,
        { initial: lang, onChange: () => undefined },
        h(ParentModeProvider, { gate }, h(Stack, { screenOptions: { headerShown: false } })),
      ),
    );
  };
}

const ChildHomeStub = () => h(Text, null, 'child-home');
/** Parent home; its button ends parent mode, as the real "hand to child" does. */
function ParentHomeStub() {
  const { exit } = require('../parent/ParentModeProvider').useParentMode();
  return h(Pressable, { testID: 'stub-exit', onPress: exit }, h(Text, { testID: 'parent-home' }, 'parent-home'));
}

type Options = { lang?: UiLang; picker?: boolean };

/** Route files load lazily, so a missing one fails its own test with "Cannot find module". */
async function open(initialUrl: string, { lang = 'mr', picker = false }: Options = {}) {
  const gate = fakeGate();
  const routes: Record<string, unknown> = {
    _layout: testRoot(gate as unknown as Gate, lang),
    index: picker ? route('../app/index') : ChildHomeStub,
    goodbye: route('../app/goodbye'),
    'parent/_layout': route('../app/parent/_layout'),
    'parent/unlock': route('../app/parent/unlock'),
    'parent/index': ParentHomeStub,
    'parent/consent': route('../app/parent/consent'),
  };
  if (picker) routes['child/[id]'] = route('../app/child/[id]');
  const result = await renderRouter(routes as Parameters<typeof renderRouter>[0], { initialUrl });
  await settle();
  return { result, gate };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;

const A = 'tpl_kg_mr_swar_1';
const B = 'tpl_kg_en_letters_1';
const C = 'tpl_kg_mr_vyanjan_1';
const STRIP_MR = 'पालकांसाठी: शेकरूला सुधारायला मदत कराल?';
const STRIP_EN = /For parents: help improve Shekru\?/i;
const SAVE = 'जतन करा';
const NOT_NOW = 'आत्ता नको';

const today = () => localDay(new Date().toISOString());

function addChild(over: Partial<ChildProfile> = {}): ChildProfile {
  const child = createChild(db, { nickname: 'Chinu', picture: 'peacock', class: 'UKG', medium: 'mr' });
  return Object.keys(over).length ? updateChild(db, child.id, over)! : child;
}

function finished(childId: string, templateId: string, sessionId = 'earlier-session', at = new Date().toISOString()) {
  lessonEnded(db, { childId, sessionId, at }, templateId);
}

const sessionRow = (id: string) =>
  db.get<{ ended_at: string | null; end_reason: string | null }>('SELECT ended_at, end_reason FROM session WHERE id = ?', [id])!;

const setAnswered = (at: string | null) => db.run('UPDATE device SET consent_answered_at = ?', [at]);

/** Lets pending promises (gate, mic reads) resolve and their updates render. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function typePin(digits: string) {
  for (const d of digits) fireEvent.press(screen.getByRole('button', { name: d }));
  await settle();
}

/** Host elements that take a press, outside the given testIDs' subtrees. */
function pressables(except: string[]) {
  type Node = { type: unknown; props: Record<string, unknown>; parent: Node | null };
  const inside = (n: Node | null): boolean => !!n && (except.includes(n.props.testID as string) || inside(n.parent));
  return (screen.UNSAFE_root.findAll(
    (n: Node) => typeof n.type === 'string' && (typeof n.props.onClick === 'function' || typeof n.props.onResponderRelease === 'function'),
  ) as Node[]).filter((n) => !inside(n));
}

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) db.run(`DELETE FROM "${name}"`);
  getDevice(db); // fresh device row: both consents and consent_answered_at null
  mockLines.length = 0;
  jest.clearAllMocks();
});

// ---- behaviour ----

describe('GURU-33 goodbye screen', () => {
  test('cap reached: a bye line, the session ends as goodbye, ticks on today\'s lessons and "उद्या" on the rest, no start or replay', async () => {
    const child = addChild({ lessons_per_day: 3, active_cap_min: 30 });
    const session = startSession(db, child.id, new Date().toISOString());
    finished(child.id, A, session);
    assignLesson(db, child.id, B, today());
    assignLesson(db, child.id, C, today());
    setAnswered(new Date().toISOString()); // no strip: only Shekru's screen is checked here

    await open(`/goodbye?child=${child.id}`);
    expect(screen).toHavePathname('/goodbye');

    await waitFor(() => expect(mockLines.some((id) => /^bye_\d+$/.test(id))).toBe(true));
    await waitFor(() => expect(sessionRow(session)).toMatchObject({ end_reason: 'goodbye', ended_at: expect.any(String) }));

    const done = screen.getByTestId(`stop-${A}`);
    expect(within(done).getByTestId('stop-tick')).toBeTruthy();
    for (const id of [B, C]) {
      const stop = screen.getByTestId(`stop-${id}`);
      expect(within(stop).queryByTestId('stop-tick')).toBeNull();
      expect(stop).toHaveTextContent(/उद्या/);
    }

    // Decision 8: done means done for the day.
    expect(screen.queryByTestId('queue-start')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(pressables(['parent-lock'])).toHaveLength(0);
  });

  test.each<[string, { answered: boolean; lessonEnded: boolean; lang: UiLang }, string | RegExp | null]>([
    ['unanswered after a lesson: shown, in the parent language (mr)', { answered: false, lessonEnded: true, lang: 'mr' }, STRIP_MR],
    ['unanswered after a lesson: shown, in the parent language (en)', { answered: false, lessonEnded: true, lang: 'en' }, STRIP_EN],
    ['answered: hidden', { answered: true, lessonEnded: true, lang: 'mr' }, null],
    ['no lesson has ever ended on the phone: hidden', { answered: false, lessonEnded: false, lang: 'mr' }, null],
  ])('consent strip: %s', async (_name, state, text) => {
    const child = addChild({ lessons_per_day: 1 });
    // Another child's lesson counts too: the strip is about the phone, not the child.
    if (state.lessonEnded) finished(addChild().id, A);
    if (state.answered) setAnswered(new Date().toISOString());
    startSession(db, child.id, new Date().toISOString());

    await open(`/goodbye?child=${child.id}`, { lang: state.lang });
    await waitFor(() => expect(mockLines.length).toBeGreaterThan(0)); // the screen is up

    const strip = screen.queryByTestId('consent-strip');
    if (text === null) expect(strip).toBeNull();
    else expect(strip).toHaveTextContent(text);
  });
});

describe('GURU-33 consent behind the parent gate', () => {
  test('a child who taps the strip only reaches the lock; /parent/consent is locked too; the right PIN opens the consent screen', async () => {
    const child = addChild({ lessons_per_day: 1 });
    finished(child.id, A);
    startSession(db, child.id, new Date().toISOString());

    await open(`/goodbye?child=${child.id}`);
    fireEvent.press(await screen.findByTestId('consent-strip'));
    await settle();
    expect(screen).toHavePathname('/parent/unlock');
    expect(screen.queryByTestId('consent-clips')).toBeNull();

    // Going straight to the consent route without unlocking lands on the lock as well.
    await act(async () => router.push('/parent/consent'));
    await settle();
    expect(screen).toHavePathname('/parent/unlock');
    expect(screen.queryByTestId('consent-clips')).toBeNull();
    expect(getDevice(db).consent_answered_at).toBeNull();

    await typePin(PIN);
    await waitFor(() => expect(screen).toHavePathname('/parent/consent'));
    expect(screen.getByTestId('consent-clips')).toBeTruthy();
  });

  test.each<[string, { clips: boolean; summaries: boolean }, string, { clips: boolean; summaries: boolean }]>([
    ['Not now leaves both off and counts as answered', { clips: false, summaries: false }, NOT_NOW, { clips: false, summaries: false }],
    ['Save with both off leaves both off and counts as answered', { clips: false, summaries: false }, SAVE, { clips: false, summaries: false }],
    ['Not now ignores switches turned on', { clips: true, summaries: true }, NOT_NOW, { clips: false, summaries: false }],
    ['Save stores each switch on its own', { clips: true, summaries: false }, SAVE, { clips: true, summaries: false }],
  ])('consent screen: %s; the question is gone afterwards', async (_name, toggles, press, stored) => {
    const child = addChild({ lessons_per_day: 1 });
    finished(child.id, A);

    await open('/parent/unlock');
    await typePin(PIN);
    await waitFor(() => expect(screen).toHavePathname('/parent/consent'));

    const clips = screen.getByTestId('consent-clips');
    const summaries = screen.getByTestId('consent-summaries');
    expect(clips).not.toBeChecked();
    expect(summaries).not.toBeChecked();
    const sent = screen.getByTestId('consent-what-is-sent');
    expect(sent).toHaveTextContent(/नाव/); // no names
    expect(sent).toHaveTextContent(/कोड/); // the child's code

    if (toggles.clips) fireEvent(clips, 'valueChange', true);
    if (toggles.summaries) fireEvent(summaries, 'valueChange', true);
    if (toggles.clips) expect(screen.getByTestId('consent-clips')).toBeChecked();

    fireEvent.press(screen.getByText(press));
    await settle();
    await waitFor(() => expect(screen).toHavePathname('/parent'));

    const device = getDevice(db);
    expect(device.consent_clips).toBe(stored.clips);
    expect(device.consent_summaries).toBe(stored.summaries);
    expect(device.consent_answered_at).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(device.consent_answered_at!))).toBe(false);

    // Answered: the next parent-mode visit opens on parent home, and the goodbye has no strip.
    fireEvent.press(screen.getByTestId('stub-exit'));
    await settle();
    await act(async () => router.push('/parent/unlock'));
    await settle();
    await typePin(PIN);
    await waitFor(() => expect(screen).toHavePathname('/parent'));
    expect(screen.getByTestId('parent-home')).toBeTruthy();
  });

  test('opening parent mode while unanswered shows the consent screen first, once per visit, and again on the next visit', async () => {
    const child = addChild({ lessons_per_day: 1 });
    finished(child.id, A);

    await open('/parent/unlock');
    await typePin(PIN);
    await waitFor(() => expect(screen).toHavePathname('/parent/consent'));

    // The parent leaves without answering: the rest of this visit is not interrupted again.
    await act(async () => router.replace('/parent'));
    await settle();
    expect(screen).toHavePathname('/parent');
    expect(screen.getByTestId('parent-home')).toBeTruthy();
    expect(getDevice(db).consent_answered_at).toBeNull();

    // Next visit: still unanswered, so the question comes first again.
    fireEvent.press(screen.getByTestId('stub-exit'));
    await settle();
    expect(screen).toHavePathname('/');
    await act(async () => router.push('/parent/unlock'));
    await settle();
    await typePin(PIN);
    await waitFor(() => expect(screen).toHavePathname('/parent/consent'));
  });
});

describe('GURU-33 picker', () => {
  test('a tap on a child whose goal is met goes to that child\'s goodbye, which ends the new session as goodbye', async () => {
    const child = addChild({ lessons_per_day: 1 });
    finished(child.id, A);

    await open('/', { picker: true });
    fireEvent.press(await screen.findByTestId(`child-tile-${child.id}`));
    await settle();

    await waitFor(() => expect(screen).toHavePathname('/goodbye'));
    // The picker opened a session; goodbye knows the child, ends it, and shows its finished lesson.
    const opened = db.get<{ id: string }>('SELECT id FROM session WHERE child_id = ?', [child.id])!;
    await waitFor(() => expect(sessionRow(opened.id)).toMatchObject({ end_reason: 'goodbye', ended_at: expect.any(String) }));
    expect(within(screen.getByTestId(`stop-${A}`)).getByTestId('stop-tick')).toBeTruthy();
  });
});

describe('GURU-33 repo rules', () => {
  test('goodbye and consent sources hold no colour literals and no Marathi text (copy comes from the mr/en string tables)', () => {
    const APP = path.resolve(__dirname, '../..');
    const HEX = /#[0-9a-fA-F]{3,8}\b/;
    const RGB = /rgba?\(/;
    const DEVANAGARI = /[ऀ-ॿ]/;
    for (const file of ['src/app/goodbye.tsx', 'src/app/parent/consent.tsx', 'src/app/parent/_layout.tsx']) {
      const source = fs.readFileSync(path.join(APP, file), 'utf8');
      expect({ file, colour: HEX.test(source) || RGB.test(source) }).toEqual({ file, colour: false });
      expect({ file, marathi: DEVANAGARI.test(source) }).toEqual({ file, marathi: false });
    }
  });
});

// ---- contract for dependents ----

// GURU-38 (consented clip and session-summary uploads) reads the consent flags and answered state.
describe('GURU-33 contract for GURU-38', () => {
  test('the /goodbye and /parent/consent routes exist; an answer writes device.consent_clips, consent_summaries (booleans) and consent_answered_at (string)', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    expect(typeof (require('../app/goodbye') as Mod).default).toBe('function');
    expect(typeof (require('../app/parent/consent') as Mod).default).toBe('function');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const before = getDevice(db);
    expect(before).toHaveProperty('consent_clips', null);
    expect(before).toHaveProperty('consent_summaries', null);
    expect(before).toHaveProperty('consent_answered_at', null);

    await open('/parent/unlock');
    await typePin(PIN);
    await waitFor(() => expect(screen).toHavePathname('/parent/consent'));
    fireEvent.press(screen.getByText(SAVE));
    await settle();

    const after = getDevice(db);
    expect(typeof after.consent_clips).toBe('boolean');
    expect(typeof after.consent_summaries).toBe('boolean');
    expect(typeof after.consent_answered_at).toBe('string');
  });
});
