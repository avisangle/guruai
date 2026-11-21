// GURU-34: "parent helps" switch and the बरोबर / चूक / शांत answer buttons. Spec: issue GURU-34,
// PRD Happy Path (parent mode 3), Edge Cases (model missing, mic denied, phone too weak), Acceptance
// Criteria (buttons); wireframes h-talking, h-lesson, pm-home, pm-attention; wireframe decision 9.
//
// Real routes through expo-router's renderRouter, under the real root layout (LanguageProvider,
// ParentModeProvider): /parent (home), /lesson/[template], /goodbye, and /child/[id] (the real
// queue screen in the readiness test, else a stub that opens the lesson). Faked:
//   expo-sqlite              one in-memory better-sqlite3 database behind openDatabaseSync
//   expo-crypto              node crypto
//   expo-audio               mic granted; every other export a no-op
//   expo-font, expo-splash-screen, expo-local-authentication, expo-secure-store
//   asr/speedCheck           judgeReadiness() from mockJudge
//   downloads/downloader     every lesson installed, no download running
//   config/build             IS_TEST_BUILD from mockBuild (release by default)
//   learning/queue           buildTodayQueue() returns mockQueue when set (the queue screen test)
//   screens/useLinePlayer    the default player (goodbye, queue); lessons get theirs via LessonPlayerDeps
//   screens/useRecording     mockRec.judge: model and mic ready, so a listen through its source is the
//                            mic and judge (logged as 'mic', never answers); otherwise listens go to
//                            the inner source it wraps, as the real hook does. mockRec.tap: the
//                            tester's tap mode switch (test builds), which also routes to the inner source.
//   shekru/*, reanimated     Shekru draws nothing
//   Math.random              0, as in src/__tests__/lesson.test.tsx
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   session(id, child_id, started_at, ended_at, end_reason 'goodbye'|'stop'|'closed', active_ms,
//           parent_helps INTEGER 0/1, ...)
//   event(id, child_id, session_id, at, type 'answer' | ..., payload JSON
//         { item_key, phase, heard_kind, decided_by 'shekru'|'tap', ... }, ...)
//   device(..., parent_lang 'mr'|'en', ...)
//
// Inputs from merged issues:
//   GURU-28  LessonPlayerDeps { answerSource?, linePlayer? }; the loop chimes, then listens, each turn.
//            Pause (`pause`), `continue`, `stop` testIDs. endSessionNow(db, id, reason, parentHelps).
//   GURU-29  readiness({ model, mic, judge, parentHelps }) returns 'ready' when parentHelps; the queue
//            screen shows `queue-start` only when ready.
//   GURU-30  parent home tabs `child-tab-<id>`, `attention-banner`.
//
// Contract pinned for /implement:
//   app/src/parent/parentHelps.ts
//     parentHelps.isOn(childId) -> boolean
//     parentHelps.set(childId, on) -> void            the switch; per child
//     parentHelps.end(childId) -> boolean             at the session's end (goodbye, Stop): turns it
//                                                     off and says whether the parent helped, for
//                                                     session.parent_helps
//     parentHelps.subscribe(listener) -> unsubscribe
//     useParentHelps(childId) -> boolean              React hook over the store
//     In memory only: a fresh module (a new app process) starts with every child off.
//   app/src/lesson/tapSource.ts
//     createTapSource() -> { source: AnswerSource; give(answer: 'correct'|'wrong'|'silent'): void }
//     give resolves the pending listen with { kind: answer, by: 'tap' }.
//   app/src/lesson/AnswerButtons.tsx
//     AnswerButtons({ onAnswer(answer) }): container `parent-answers` holding the strip text
//     "पालकांची मदत: मूल काय म्हणालं?" (parent language) and buttons `parent-answer-correct` (बरोबर),
//     `parent-answer-wrong` (चूक), `parent-answer-silent` (शांत), each at least 64 dp tall
//     (theme.touch.child.min).
//   app/src/app/parent/index.tsx
//     `parent-helps` card for the selected child: title "मी उत्तरं तपासेन" / "I'll check the answers"
//     and helper text in the parent language; inside it a React Native Switch `parent-helps-switch`.
//     Shown with or without an attention banner.
//   LessonPlayer  with the switch on: the buttons only while listening, the mic and judge never
//                 started; with it off: no buttons at all in release builds. The tester's tap
//                 buttons (`answer-<kind>`) only in test builds.
//
// Seam (reported): "the mic and judge are not started" is observed at useRecording's source. A
// design that keeps listening through that source and teaches the real hook to skip the mic would
// still fail here; the lesson must take its answers from the tap source instead.
import { createElement as h, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';

import type { JudgeReadiness } from '../asr/speedCheck';
import { getDevice } from '../data/device';
import { openDb, type Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild } from '../data/profiles';
import { endSession, startSession } from '../learning/session';
import type { AnswerSource } from '../lesson/answerSource';
import type { Heard, Lesson, Listen } from '../lesson/types';
import { theme } from '../ui/theme';

// ---- native fakes ----

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

jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(async () => 1),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true, loadAsync: async () => undefined }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
  hide: jest.fn(),
  setOptions: jest.fn(),
}));

const mockJudge: { value: JudgeReadiness } = { value: 'ready' };
jest.mock('../asr/speedCheck', () => ({
  SLOW_P90_MS: 1000,
  judgeReadiness: jest.fn(() => mockJudge.value),
  runSpeedCheck: jest.fn(async () => mockJudge.value),
  rerunSpeedCheck: jest.fn(async () => mockJudge.value),
}));

const mockStatus = { waitingForWifi: false, plan: null, items: [] }; // stable snapshot
jest.mock('../downloads/downloader', () => ({
  startInitialDownloads: jest.fn(async () => undefined),
  queuePacks: jest.fn(async () => undefined),
  queueChildPacks: jest.fn(async () => undefined),
  isLessonInstalled: jest.fn(() => true),
  downloadStatus: jest.fn(() => mockStatus),
  subscribeDownloads: jest.fn(() => () => undefined),
}));

// The queue screen test fixes today's queue (one lesson); null leaves the real one.
const mockQueue: { value: unknown } = { value: null };
jest.mock('../learning/queue', () => {
  const actual = jest.requireActual('../learning/queue');
  return { ...actual, buildTodayQueue: jest.fn((input: unknown) => mockQueue.value ?? actual.buildTodayQueue(input)) };
});

const mockBuild = { test: false };
jest.mock('../config/build', () => ({
  get IS_TEST_BUILD() {
    return mockBuild.test;
  },
}));

jest.mock('../screens/useLinePlayer', () => {
  const player = { play: async () => undefined, stop: () => undefined, chime: () => undefined };
  return { useLinePlayer: () => player }; // stable, as the real hook's useMemo
});

// See the header: 'mic' marks a listen turn handed to the mic and judge.
const mockRec = { judge: true, tap: false, log: [] as string[] };
jest.mock('../screens/useRecording', () => ({
  useRecording: (_templateId: string, _items: unknown[], inner?: { listen(l: unknown): Promise<unknown>; cancel(): void }) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useMemo(() => {
      const source = {
        listen: (l: unknown) => {
          if (!mockRec.tap && mockRec.judge) {
            mockRec.log.push('mic');
            return new Promise(() => undefined);
          }
          if (inner?.listen) return inner.listen(l);
          return new Promise(() => undefined);
        },
        cancel: () => inner?.cancel?.(),
      };
      return {
        on: false, settings: { child: '', age: '' }, update: () => undefined, setOn: async () => undefined,
        tap: mockRec.tap, setTap: () => undefined, mic: 'granted', active: false, count: 0, error: null,
        source, prepare: async () => undefined, exportAll: async () => undefined, deleteAll: () => undefined, judged: null,
      };
    }, [inner]),
}));

jest.mock('../shekru/useShekruRig', () => {
  const rig = { values: {}, setState: () => undefined, setSpeech: () => undefined, syncSpeech: () => undefined };
  return { useShekruRig: () => rig, FRONT_SUFFIX: '@front', SHADOW: '@shadow', SHADOW_CX: 0, SHADOW_CY: 0 };
});
jest.mock('../shekru/Shekru', () => ({ Shekru: () => null }));
// As in src/__tests__/lesson.test.tsx: reanimated's own jest mock cannot load here.
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
    useAnimatedScrollHandler: () => () => undefined,
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

// ---- the modules under test, loaded lazily so a missing one fails its own test ----

type Store = {
  isOn(childId: string): boolean;
  set(childId: string, on: boolean): void;
  end(childId: string): boolean;
  subscribe(listener: () => void): () => void;
};
type Answer = 'correct' | 'wrong' | 'silent';

/* eslint-disable @typescript-eslint/no-require-imports */
const helpsMod = () => require('./parentHelps') as { parentHelps: Store; useParentHelps(childId: string): boolean };
const store = () => helpsMod().parentHelps;
const tapMod = () => require('../lesson/tapSource') as { createTapSource(): { source: AnswerSource; give(answer: Answer): void } };
const buttonsMod = () => require('../lesson/AnswerButtons') as { AnswerButtons: unknown };
const expoRouter = () => require('expo-router') as typeof import('expo-router');

const LESSONS = require('../content/generated/lessons.json') as Lesson[];
const EN = LESSONS.find((l) => l.template_id === 'tpl_kg_en_letters_1')!;

const QueueStub = () => {
  const { useLocalSearchParams, useRouter } = require('expo-router');
  const { id, lesson } = useLocalSearchParams() as { id: string; lesson?: string };
  const router = useRouter();
  return h(Pressable, { testID: 'open-lesson', onPress: () => router.push(lesson as string) }, h(Text, null, `queue-${id}`));
};
const PickerStub = () => h(Text, null, 'child-picker');

function routes(queue: 'stub' | 'real' = 'stub') {
  return {
    _layout: require('../app/_layout').default,
    index: PickerStub,
    'child/[id]': queue === 'real' ? require('../app/child/[id]').default : QueueStub,
    'lesson/[template]': require('../app/lesson/[template]').default,
    goodbye: require('../app/goodbye').default,
    'parent/index': require('../app/parent/index').default,
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- scripted line player (lines end at once unless held) ----

function fakeLines() {
  const state = {
    hold: (_id: string) => false,
    held: null as { id: string; end: () => void } | null,
    chimes: 0,
  };
  const player = {
    play(id: string) {
      if (!state.hold(id)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        state.held = { id, end: resolve };
      });
    },
    stop() {
      state.held?.end();
      state.held = null;
    },
    chime() {
      state.chimes++;
    },
  };
  const release = () => {
    const held = state.held;
    state.held = null;
    held?.end();
  };
  return { player, state, release };
}

// ---- helpers ----

let db: Db;
let childId: string;
let sessionId: string;

/** Advances fake time in small steps until `cond` holds. */
async function until(cond: () => boolean, what: string, maxMs = 120_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (cond()) return;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(ms = 2000) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function openLesson(lines: ReturnType<typeof fakeLines>['player']) {
  const { LessonPlayerDeps } = require('../lesson/LessonPlayer'); // eslint-disable-line @typescript-eslint/no-require-imports
  // Only the line player is injected: answers come from the player's own sources.
  const wrapper = ({ children }: { children: ReactNode }) => h(LessonPlayerDeps.Provider, { value: { linePlayer: lines } }, children);
  const url = `/lesson/${EN.template_id}?child=${childId}`;
  const router = await renderRouter(routes(), { initialUrl: `/child/${childId}?lesson=${encodeURIComponent(url)}`, wrapper });
  fireEvent.press(await screen.findByTestId('open-lesson'));
  await until(() => router.getPathname().startsWith('/lesson/'), 'the lesson route');
  return router;
}

type Payload = { item_key: string; heard_kind: string; decided_by: string };
const answers = () =>
  db
    .all<{ session_id: string; payload: string }>("SELECT session_id, payload FROM event WHERE type = 'answer' ORDER BY rowid")
    .map((r) => ({ session_id: r.session_id, ...(JSON.parse(r.payload) as Payload) }));

const sessionRow = (id: string) =>
  db.get<{ ended_at: string | null; end_reason: string | null; parent_helps: number }>(
    'SELECT ended_at, end_reason, parent_helps FROM session WHERE id = ?',
    [id],
  );

const buttons = () => screen.queryByTestId('parent-answers');
const testerButtons = () => screen.queryAllByTestId(/^answer-(correct|wrong|silent)$/);

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    if (name === 'device') db.run("UPDATE device SET parent_lang = 'mr', consent_answered_at = '2026-11-20T08:00:00.000Z'");
    else if (name !== 'parent_gate') db.run(`DELETE FROM "${name}"`);
  }
  getDevice(db);
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0);
  mockJudge.value = 'ready';
  mockBuild.test = false;
  mockRec.judge = true;
  mockRec.tap = false;
  mockRec.log.length = 0;
  mockQueue.value = null;
  const child = createChild(db, { nickname: 'Chinu', picture: 'peacock', class: 'UKG', medium: 'en' });
  childId = child.id;
  sessionId = startSession(db, childId, new Date().toISOString());
});

afterEach(() => {
  // Never carry a switch into the next test (the store outlives a test's render).
  try {
    store().end(childId);
  } catch {
    // module missing in the red phase
  }
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---- behaviour ----

describe('GURU-34 "parent helps" in the lesson', () => {
  test('turned on mid-session it applies to the open session, stays on through pause and resume, and goodbye clears it', async () => {
    const lines = fakeLines();
    const router = await openLesson(lines.player);

    // Switch off: Shekru judges the first answer turn.
    await until(() => mockRec.log.length === 1, 'the first listen turn through the mic');
    expect(buttons()).toBeNull();

    // The parent opens the lock (the lesson pauses) and turns the switch on for this child.
    fireEvent.press(screen.getByTestId('pause'));
    await act(async () => store().set(childId, true));
    expect(store().isOn(childId)).toBe(true);
    fireEvent.press(screen.getByTestId('continue'));

    await until(() => buttons() !== null, 'the answer buttons after resume');
    expect(mockRec.log).toEqual(['mic']); // the mic was not started again

    // A pause and resume (or a call) keeps it on.
    fireEvent.press(screen.getByTestId('pause'));
    expect(buttons()).toBeNull();
    fireEvent.press(screen.getByTestId('continue'));
    await until(() => buttons() !== null, 'the answer buttons after a second resume');
    expect(store().isOn(childId)).toBe(true);

    fireEvent.press(screen.getByTestId('parent-answer-correct'));
    await until(() => answers().length === 1, 'the tapped answer recorded');
    expect(answers()[0]).toMatchObject({ session_id: sessionId, heard_kind: 'correct', decided_by: 'tap' });

    // Goodbye ends the session: the switch turns itself off and the session says the parent helped.
    fireEvent.press(screen.getByTestId('pause'));
    await act(async () => expoRouter().router.push({ pathname: '/goodbye', params: { child: childId } }));
    await until(() => router.getPathname() === '/goodbye' && sessionRow(sessionId)?.ended_at != null, 'goodbye ending the session');
    expect(sessionRow(sessionId)).toMatchObject({ end_reason: 'goodbye', parent_helps: 1 });
    expect(store().isOn(childId)).toBe(false);
    router.unmount();

    // The next session is judged by Shekru again.
    sessionId = startSession(db, childId, new Date().toISOString());
    mockRec.log.length = 0;
    await openLesson(fakeLines().player);
    await until(() => mockRec.log.length === 1, 'the next session listening through the mic');
    await settle();
    expect(buttons()).toBeNull();
  });

  test('the buttons show only in the answer turn, hide while Shekru speaks, and the tap decides with decided_by tap', async () => {
    const lines = fakeLines();
    lines.state.hold = () => true;
    store().set(childId, true);
    await openLesson(lines.player);

    // Shekru speaking (the intro, then the teach line): no buttons.
    await until(() => lines.state.held !== null, 'the first line');
    expect(buttons()).toBeNull();
    while (lines.state.chimes === 0) {
      expect(buttons()).toBeNull();
      lines.release();
      await until(() => lines.state.held !== null || lines.state.chimes > 0, 'the next line or the chime');
    }

    // After the chime: the strip and three 64 dp buttons, in the parent language (Marathi).
    await until(() => buttons() !== null, 'the answer buttons');
    const strip = screen.getByTestId('parent-answers');
    expect(strip).toHaveTextContent(/पालकांची मदत/);
    expect(within(strip).getByTestId('parent-answer-correct')).toHaveTextContent(/बरोबर/);
    expect(within(strip).getByTestId('parent-answer-wrong')).toHaveTextContent(/चूक/);
    expect(within(strip).getByTestId('parent-answer-silent')).toHaveTextContent(/शांत/);
    for (const kind of ['correct', 'wrong', 'silent']) {
      const style = StyleSheet.flatten(screen.getByTestId(`parent-answer-${kind}`).props.style) ?? {};
      expect(Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0))).toBeGreaterThanOrEqual(theme.touch.child.min);
    }

    fireEvent.press(screen.getByTestId('parent-answer-correct'));
    await until(() => answers().length === 1, 'the first tapped answer');
    // Shekru reacts (praise, the next teach line): the buttons are gone while he speaks.
    await until(() => lines.state.held !== null, 'Shekru reacting');
    expect(buttons()).toBeNull();

    const chimes = lines.state.chimes;
    while (lines.state.chimes === chimes) {
      expect(buttons()).toBeNull();
      lines.release();
      await until(() => lines.state.held !== null || lines.state.chimes > chimes, 'the next line or the chime');
    }
    await until(() => buttons() !== null, 'the second answer turn');
    fireEvent.press(screen.getByTestId('parent-answer-silent'));
    await until(() => answers().length === 2, 'the second tapped answer');

    expect(answers().map((a) => [a.heard_kind, a.decided_by])).toEqual([['correct', 'tap'], ['silent', 'tap']]);
    expect(mockRec.log).toEqual([]); // the mic and judge were never started
  });

  test('turned on with no open session it applies to the next one; Stop clears it; it lives in memory only', async () => {
    endSession(db, sessionId, 'stop', { at: new Date().toISOString(), activeMs: 0, parentHelps: false });
    store().set(childId, true);

    // Per child: another child is untouched.
    const manu = createChild(db, { nickname: 'Manu', picture: 'elephant', class: 'UKG', medium: 'mr' });
    expect(store().isOn(manu.id)).toBe(false);

    // A new app process (a fresh module) starts with the switch off for everyone.
    let fresh: boolean | null = null;
    jest.isolateModules(() => {
      fresh = (require('./parentHelps') as { parentHelps: Store }).parentHelps.isOn(childId); // eslint-disable-line @typescript-eslint/no-require-imports
    });
    expect(fresh).toBe(false);

    // The next session started in this app run gets the buttons.
    sessionId = startSession(db, childId, new Date().toISOString());
    const router = await openLesson(fakeLines().player);
    await until(() => buttons() !== null, 'the answer buttons in the next session');
    expect(mockRec.log).toEqual([]);

    fireEvent.press(screen.getByTestId('pause'));
    fireEvent.press(screen.getByTestId('stop'));
    await until(() => sessionRow(sessionId)?.ended_at != null, 'Stop ending the session');
    expect(sessionRow(sessionId)).toMatchObject({ end_reason: 'stop', parent_helps: 1 });
    expect(store().isOn(childId)).toBe(false);
    router.unmount();
  });

  test('switch off: no buttons ever in a release build, whatever readiness says; tester tap mode only in test builds', async () => {
    // Release build, no model or mic (the judge cannot run), switch off.
    mockRec.judge = false;
    const lines = fakeLines();
    const first = await openLesson(lines.player);
    await until(() => lines.state.chimes > 0, 'the answer turn');
    await settle();
    expect(buttons()).toBeNull();
    expect(testerButtons()).toHaveLength(0);
    expect(answers()).toHaveLength(0);
    first.unmount();

    // Release build with the tester's tap switch somehow on: still nothing.
    mockRec.tap = true;
    const tapLines = fakeLines();
    const second = await openLesson(tapLines.player);
    await until(() => tapLines.state.chimes > 0, 'the answer turn');
    await settle();
    expect(testerButtons()).toHaveLength(0);
    expect(buttons()).toBeNull();
    second.unmount();

    // Test build, tap mode on: the tester's buttons answer, decided by tap.
    mockBuild.test = true;
    await openLesson(fakeLines().player);
    await until(() => testerButtons().length === 3, 'the tester buttons');
    expect(buttons()).toBeNull();
    fireEvent.press(screen.getByTestId('answer-correct'));
    await until(() => answers().length === 1, 'the tester answer');
    expect(answers()[0]).toMatchObject({ heard_kind: 'correct', decided_by: 'tap' });
  });
});

describe('GURU-34 the switch on parent home and the readiness callers', () => {
  test('parent home has the per-child "मी उत्तरं तपासेन" switch with helper text, also under the attention banner', async () => {
    const manu = createChild(db, { nickname: 'Manu', picture: 'elephant', class: 'UKG', medium: 'mr' });
    mockJudge.value = 'slow'; // the weak-phone banner, which points to the switch

    const first = await renderRouter(routes(), { initialUrl: '/parent' });
    await screen.findByTestId('attention-banner');
    const card = await screen.findByTestId('parent-helps');
    expect(card).toHaveTextContent(/मी उत्तरं तपासेन/);
    expect(card).toHaveTextContent(/बरोबर \/ चूक \/ शांत/);
    const toggle = within(card).getByTestId('parent-helps-switch');
    expect(toggle.props.value).toBe(false);

    // On for the selected child (the first, Chinu) only.
    await act(async () => fireEvent(toggle, 'valueChange', true));
    expect(store().isOn(childId)).toBe(true);
    expect(store().isOn(manu.id)).toBe(false);
    await waitFor(() => expect(screen.getByTestId('parent-helps-switch').props.value).toBe(true));

    fireEvent.press(screen.getByTestId(`child-tab-${manu.id}`));
    await waitFor(() => expect(screen.getByTestId('parent-helps-switch').props.value).toBe(false));
    fireEvent.press(screen.getByTestId(`child-tab-${childId}`));
    await waitFor(() => expect(screen.getByTestId('parent-helps-switch').props.value).toBe(true));
    first.unmount();

    // English parent text, no banner.
    db.run("UPDATE device SET parent_lang = 'en'");
    mockJudge.value = 'ready';
    await renderRouter(routes(), { initialUrl: '/parent' });
    const en = await screen.findByTestId('parent-helps');
    expect(en).toHaveTextContent(/I'll check the answers/);
    expect(en).toHaveTextContent(/Correct \/ Wrong \/ Silent/);
    expect(screen.queryByTestId('attention-banner')).toBeNull();
  });

  test('with the switch on the queue screen is ready even when Shekru cannot listen', async () => {
    mockQueue.value = { stops: [{ kind: 'lesson', template_id: EN.template_id, revision: [] }], goal: 3, done: 0, goalMet: false, waitingForDownload: [] };
    // Control: the queue has a lesson to start when Shekru can listen.
    const ready = await renderRouter(routes('real'), { initialUrl: `/child/${childId}` });
    expect(await screen.findByTestId('queue-start')).toBeTruthy();
    ready.unmount();

    mockJudge.value = 'missing'; // model not on the phone
    const first = await renderRouter(routes('real'), { initialUrl: `/child/${childId}` });
    await screen.findByTestId('stars');
    await act(async () => undefined); // the mic read settles
    expect(screen.queryByTestId('queue-start')).toBeNull(); // "ask a grown-up"
    first.unmount();

    store().set(childId, true);
    await renderRouter(routes('real'), { initialUrl: `/child/${childId}` });
    expect(await screen.findByTestId('queue-start')).toBeTruthy();
  });
});

// ---- contract for dependents ----

describe('GURU-34 contract (output for dependents; none named yet)', () => {
  test('parentHelps store, useParentHelps, createTapSource and AnswerButtons are exported with the promised shapes', () => {
    const helps = helpsMod();
    expect(typeof helps.parentHelps).toBe('object');
    for (const fn of ['isOn', 'set', 'end', 'subscribe'] as const) expect(typeof helps.parentHelps[fn]).toBe('function');
    expect(typeof helps.useParentHelps).toBe('function');
    expect(typeof helps.parentHelps.isOn('nobody')).toBe('boolean');
    const unsubscribe = helps.parentHelps.subscribe(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    expect(typeof helps.parentHelps.end('nobody')).toBe('boolean');

    const tap = tapMod().createTapSource();
    expect(typeof tap.source.listen).toBe('function');
    expect(typeof tap.source.cancel).toBe('function');
    expect(typeof tap.give).toBe('function');
    const listen: Listen = { type: 'listen', item: EN.items[0], kind: 'teach', showAnchor: false, prompt: '' };
    const pending = tap.source.listen(listen);
    expect(typeof (pending as Promise<Heard>).then).toBe('function');
    tap.source.cancel();

    expect(typeof buttonsMod().AnswerButtons).toBe('function');
  });
});
