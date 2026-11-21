// GURU-28: lesson player v2. Spec: issue GURU-28, PRD Acceptance Criteria (resume at the same
// answer), PRD Edge Cases (Home or a call pauses), wireframes l-talking, l-listening, l-word-*,
// l-paused; D-STT-auto-stop, D-STT-unsure-not-wrong, D-GURU-7-tutor-state-contract.
// Lives outside src/app/: Expo Router turns every .tsx file there into a route and bundles it.
//
// The real route renders through expo-router's renderRouter, with stub `/child/[id]` (queue,
// GURU-29) and `/goodbye` (GURU-33) routes. Faked:
//   expo-sqlite              one in-memory better-sqlite3 database behind openDatabaseSync,
//                            so liveDb()/openDb() anywhere in the app reads and writes it
//   expo-crypto              node crypto
//   expo-audio               any export; the tests never reach real audio
//   screens/useLinePlayer    the default line player; the tests inject theirs through
//                            LessonPlayerDeps and fail if this one is used
//   screens/useRecording     as with no mic or model: listen turns go to the source it wraps
//   shekru/useShekruRig      records setState (the tutor state); Shekru draws nothing
//   react-native-reanimated  plain views and values (its own jest mock cannot load here)
//   Math.random              0: a fresh run always gets its surprise, before the 2nd teach item
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   session(id, child_id, started_at, ended_at, end_reason, active_ms, parent_helps, ...)
//   event(id, child_id, session_id, at, type, payload JSON, ...)   type 'answer' | 'lesson_end' | ...
//   lesson_position(id, child_id, template_id, version, position JSON, ...)
//   child_profile(..., style_level, lessons_per_day DEFAULT 3, active_cap_min DEFAULT 30, ...)
//
// Contract pinned for /implement (and GURU-29, GURU-32, GURU-33, GURU-34):
//   route         app/src/app/lesson/[template].tsx, default export; params `child` (child id) and
//                 `stop` (optional, JSON.stringify of the queue's LessonStop: its `revision` items are
//                 mixed into the quiz). The lesson starts by itself; no start button.
//   session       answers and lesson events go to the child's open session (ended_at IS NULL);
//                 GURU-29 opens it when the child taps their face.
//   LessonPlayer  app/src/lesson/LessonPlayer.tsx: named exports `LessonPlayer` and
//                 `LessonPlayerDeps`, a React context of { answerSource?: AnswerSource;
//                 linePlayer?: LinePlayer }; a missing entry falls back to useRecording /
//                 useLinePlayer. LinePlayer = useLinePlayer's shape: play(id, text) -> Promise<void>
//                 (resolves when the line ends or is stopped), stop(), chime().
//   loop          app/src/lesson/usePlayerLoop.ts: named exports `usePlayerLoop` and `onLessonEnd`.
//   lesson data   app/src/content/generated/lessons.json (the word-lesson test appends a fixture).
//   testIDs       card (the item's display text inside), caption, pause, paused (l-paused),
//                 continue, stop.
//   lesson end    lesson_end event, then shouldEndAfterLesson: /goodbye, else back to /child/<id>.
//   removed       app/src/progress/storage.ts and every import of it.
import * as fs from 'fs';
import * as path from 'path';
import { createElement as h, type ReactNode } from 'react';
import { AppState, Pressable, Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';

import { openDb, type Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, updateChild } from '../data/profiles';
import { loadPosition } from '../learning/positions';
import { startSession } from '../learning/session';
import type { AnswerSource } from '../lesson/answerSource';
import type { Heard, Lesson, Listen } from '../lesson/types';
import { SURPRISE_STATES } from '../shekru/contract';

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

// Any expo-audio export: hooks and factories return an object whose every method is a no-op
// (addListener returns { remove }); async functions resolve to "not granted".
jest.mock('expo-audio', () => {
  const thing = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : key === 'remove' ? () => undefined : thing()),
      apply: () => thing(),
    });
  const asyncResult = { granted: false, canAskAgain: true, status: 'undetermined', expires: 'never' };
  return new Proxy(
    { __esModule: true },
    {
      get: (target, key) => {
        if (key in target) return (target as Record<string | symbol, unknown>)[key];
        if (typeof key === 'string' && key.endsWith('Async')) return jest.fn(async () => asyncResult);
        return thing();
      },
    },
  );
});

// The default sources must not be used when LessonPlayerDeps supplies both.
const mockDefaultUsed: string[] = [];
jest.mock('../screens/useLinePlayer', () => {
  const player = {
    play: async (id: string) => void mockDefaultUsed.push(`line:${id}`),
    stop: () => undefined,
    chime: () => undefined,
  };
  return { useLinePlayer: () => player }; // stable, as the real hook's useMemo
});
// As the real hook behaves with no mic or model: listen turns go to the inner source it wraps.
jest.mock('../screens/useRecording', () => ({
  useRecording: (_templateId: string, _items: unknown[], inner?: { listen(l: unknown): Promise<unknown>; cancel(): void }) =>
    // stable per inner source, as the real hook's useMemo
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useMemo(() => {
    const source = {
      listen: (l: unknown) => {
        if (inner?.listen) return inner.listen(l);
        mockDefaultUsed.push('listen');
        return new Promise(() => undefined);
      },
      cancel: () => inner?.cancel?.(),
    };
    return {
      on: false, settings: { child: '', age: '' }, update: () => undefined, setOn: async () => undefined,
      tap: false, setTap: () => undefined, mic: 'unknown', active: false, count: 0, error: null,
      source, prepare: async () => undefined, exportAll: async () => undefined, deleteAll: () => undefined, judged: null,
    };
    }, [inner]),
}));

// Tutor state: every setState lands in the shared log.
const mockLog: string[] = [];
jest.mock('../shekru/useShekruRig', () => {
  const rig = {
    values: {},
    setState: (s: string) => void mockLog.push(`state:${s}`),
    setSpeech: () => undefined,
    syncSpeech: () => undefined,
  };
  return { useShekruRig: () => rig, FRONT_SUFFIX: '@front', SHADOW: '@shadow', SHADOW_CX: 0, SHADOW_CY: 0 };
});
jest.mock('../shekru/Shekru', () => ({ Shekru: () => null }));
// Reanimated 4's own jest mock (react-native-reanimated/mock) cannot load here, and
// expo-router/testing-library, on import, mocks react-native-reanimated with it. So that path is
// faked: views are plain RN views, shared values plain objects, animations their end value,
// everything else a chainable no-op.
jest.mock('react-native-reanimated/mock', () => {
  const chain = (): unknown =>
    new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : chain()), apply: () => chain() });
  // Read lazily: requiring react-native inside this factory would load it mid-cycle.
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

// The word lesson fixture rides along with the generated lessons.
jest.mock('../content/generated/lessons.json', () => [
  ...jest.requireActual('../content/generated/lessons.json'),
  jest.requireActual('../lesson/__fixtures__/word-lesson.json'),
]);

/* eslint-disable @typescript-eslint/no-require-imports */
const LESSONS = require('../content/generated/lessons.json') as Lesson[];
const EN = LESSONS.find((l) => l.template_id === 'tpl_kg_en_letters_1')!;
const WORDS = LESSONS.find((l) => l.template_id === 'tpl_test_words')!;

// ---- scripted sources ----

type Pending = { listen: Listen; resolve: (h: Heard) => void };

/** Answers every listen turn with `answer` unless `hold` is set; then the test answers. */
function scriptedSource() {
  const state = {
    hold: false,
    answer: { kind: 'correct', by: 'tap' } as Heard,
    pending: null as Pending | null,
    listens: [] as Listen[],
    cancels: 0,
  };
  const source: AnswerSource = {
    listen(listen) {
      state.listens.push(listen);
      mockLog.push(`listen:${listen.item.item_key}:${listen.kind}`);
      if (!state.hold) return Promise.resolve(state.answer);
      return new Promise<Heard>((resolve) => {
        state.pending = { listen, resolve };
      });
    },
    cancel() {
      state.cancels++;
      state.pending = null;
      mockLog.push('cancel');
    },
  };
  return { source, state };
}

/** Lines end at once unless `hold(id)`; a held line ends on release() or stop(). */
function fakeLines() {
  const state = {
    hold: (_id: string) => false,
    held: null as { id: string; text: string; end: () => void } | null,
    plays: [] as { id: string; text: string }[],
    stops: 0,
    chimes: 0,
  };
  const player = {
    play(id: string, text: string) {
      state.plays.push({ id, text });
      mockLog.push(`play:${id}`);
      if (!state.hold(id)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        state.held = { id, text, end: resolve };
      });
    },
    stop() {
      state.stops++;
      mockLog.push('linestop');
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

// ---- routes ----

const QueueStub = () => {
  const { useLocalSearchParams, useRouter } = require('expo-router');
  const { id, lesson } = useLocalSearchParams() as { id: string; lesson?: string };
  const router = useRouter();
  return h(
    Pressable,
    { testID: 'open-lesson', onPress: () => router.push(lesson as string) },
    h(Text, null, `queue-${id}`),
  );
};
const GoodbyeStub = () => h(Text, null, 'goodbye');

function routes() {
  return {
    'lesson/[template]': require('../app/lesson/[template]').default,
    'child/[id]': QueueStub,
    goodbye: GoodbyeStub,
  };
}

/** Opens `url` from the queue stub, as GURU-29's start button will, so going back lands on the queue. */
async function openLesson(url: string, deps: { answerSource: AnswerSource; linePlayer: ReturnType<typeof fakeLines>['player'] }) {
  const { LessonPlayerDeps } = require('../lesson/LessonPlayer');
  const wrapper = ({ children }: { children: ReactNode }) => h(LessonPlayerDeps.Provider, { value: deps }, children);
  const router = await renderRouter(routes(), { initialUrl: `/child/${childId}?lesson=${encodeURIComponent(url)}`, wrapper });
  fireEvent.press(await screen.findByTestId('open-lesson'));
  await until(() => router.getPathname().startsWith('/lesson/'), 'the lesson route');
  return router;
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;
let childId: string;
let sessionId: string;

const lessonUrl = (template: string, extra = '') => `/lesson/${template}?child=${childId}${extra}`;

/** Advances fake time in small steps until `cond` holds. */
async function until(cond: () => boolean, what: string, maxMs = 600_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (cond()) return;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Payload = { item_key: string; phase: string; heard_kind: string; decided_by: string; template_id?: string };
const events = (type: string) =>
  db
    .all<{ session_id: string; payload: string }>('SELECT session_id, payload FROM event WHERE type = ? ORDER BY rowid', [type])
    .map((r) => ({ session_id: r.session_id, ...(JSON.parse(r.payload) as Payload) }));

const position = (template: Lesson) => loadPosition(db, childId, template.template_id, template.version);

/** Answers the next listen turn correct by tap and waits for answer `n` to be recorded. */
async function answer(src: ReturnType<typeof scriptedSource>, n: number) {
  await until(() => src.state.pending !== null, `listen turn ${n}`);
  const turn = src.state.pending!;
  src.state.pending = null;
  await act(async () => turn.resolve({ kind: 'correct', by: 'tap' }));
  await until(() => events('answer').length === n, `answer ${n} recorded`);
}

const visibleText = (text: string) => screen.queryAllByText(text, { exact: false }).length > 0;

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) if (name !== 'device' && name !== 'parent_gate') db.run(`DELETE FROM "${name}"`);
  jest.useFakeTimers();
  jest.spyOn(Math, 'random').mockReturnValue(0);
  mockLog.length = 0;
  mockDefaultUsed.length = 0;
  const child = createChild(db, { nickname: 'Chinu', picture: 'any', class: 'UKG', medium: 'en' });
  childId = child.id;
  sessionId = startSession(db, childId, new Date().toISOString());
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('GURU-28 lesson player', () => {
  test('every answer is recorded as an event in the open session, then the position is saved', async () => {
    const src = scriptedSource();
    const lines = fakeLines();
    src.state.hold = true;
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    await until(() => src.state.pending !== null, 'the first listen turn');
    expect(src.state.pending!.listen.item.item_key).toBe('en:letter:A');
    expect(events('answer')).toHaveLength(0);

    for (const [n, key] of [[1, 'en:letter:A'], [2, 'en:letter:B']] as const) {
      const turn = src.state.pending!;
      expect(turn.listen.item.item_key).toBe(key);
      src.state.pending = null;
      await act(async () => turn.resolve({ kind: 'correct', by: 'tap' }));
      await until(() => events('answer').length === n, `answer ${n} recorded`);
      const recorded = events('answer')[n - 1];
      expect(recorded).toMatchObject({ session_id: sessionId, item_key: key, phase: 'teach', heard_kind: 'correct', decided_by: 'tap' });
      // saved after this answer: the teach phase (flow 1) has moved past item n-1
      expect(position(EN)).toMatchObject({ flow: 1, index: n });
      await until(() => src.state.pending !== null, `listen turn ${n + 1}`);
    }
    expect(mockDefaultUsed).toEqual([]);
  });

  test('captions show the caption with English in Latin letters, else the voice text; the card shows the letter', async () => {
    const src = scriptedSource();
    const lines = fakeLines();
    lines.state.hold = () => true;
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    // intro has no caption: the voice text is the caption
    await until(() => lines.state.held?.id === `${EN.template_id}.intro`, 'the intro line');
    expect(screen.getByTestId('caption')).toHaveTextContent(EN.lines.intro);

    lines.release();
    const teachA = `${EN.template_id}.a.teach`;
    await until(() => lines.state.held?.id === teachA, 'the teach line for A');
    const item = EN.items.find((i) => i.id === 'a')!;
    const voice = (item.lines as Record<string, string>).teach;
    expect(lines.state.held!.text).toBe(voice); // the voice text goes to the line player
    expect(screen.getByTestId('caption')).toHaveTextContent(item.captions!.teach);
    expect(visibleText(voice)).toBe(false); // the Devanagari English is never shown
    expect(within(screen.getByTestId('card')).getByText('A')).toBeTruthy();
  });

  test('word items: the teach line follows the child style level, the card shows the target word', async () => {
    const src = scriptedSource();
    const lines = fakeLines();
    lines.state.hold = (id) => id.startsWith(`${WORDS.template_id}.apple.`);
    await openLesson(lessonUrl(WORDS.template_id), { answerSource: src.source, linePlayer: lines.player });

    // Medium 'en' made the child en_led.
    await until(() => lines.state.held !== null, 'the first apple line');
    const apple = WORDS.items.find((i) => i.id === 'apple')!;
    expect(lines.state.held!.id).toBe(`${WORDS.template_id}.apple.teach_en_led`);
    expect(screen.getByTestId('caption')).toHaveTextContent(apple.captions!.teach_en_led);
    expect(visibleText((apple.lines as Record<string, string>).teach_en_led)).toBe(false);
    expect(within(screen.getByTestId('card')).getByText('Apple')).toBeTruthy();
  });

  test('pause button and the app going to background stop audio and mic, show l-paused, and resume at the same listen turn', async () => {
    const appState: ((s: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, fn: (s: string) => void) => {
      appState.push(fn);
      return { remove: () => undefined };
    }) as typeof AppState.addEventListener);
    const src = scriptedSource();
    const lines = fakeLines();
    src.state.hold = true;
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    // 1. Pause button during A's listen turn.
    await until(() => src.state.pending !== null, 'listen turn for A');
    const cancels = src.state.cancels;
    const stops = lines.state.stops;
    fireEvent.press(screen.getByTestId('pause'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByTestId('paused')).toBeTruthy();
    expect(src.state.cancels).toBeGreaterThan(cancels); // mic closed
    expect(lines.state.stops).toBeGreaterThan(stops); // audio stopped
    const listensBefore = src.state.listens.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(src.state.listens).toHaveLength(listensBefore); // nothing runs while paused

    fireEvent.press(screen.getByTestId('continue'));
    await until(() => src.state.listens.length > listensBefore && src.state.pending !== null, 'listen turn after continue');
    expect(screen.queryByTestId('paused')).toBeNull();
    const again = src.state.pending!.listen;
    expect([again.item.item_key, again.kind]).toEqual(['en:letter:A', 'teach']);
    expect(events('answer')).toHaveLength(0);
    const turn = src.state.pending!;
    src.state.pending = null;
    await act(async () => turn.resolve({ kind: 'correct', by: 'tap' }));
    await until(() => events('answer').length === 1, 'A answered');

    // 2. App to background during B's listen turn.
    await until(() => src.state.pending?.listen.item.item_key === 'en:letter:B', 'listen turn for B');
    const listensB = src.state.listens.length;
    expect(appState.length).toBeGreaterThan(0);
    await act(async () => appState.forEach((fn) => fn('background')));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByTestId('paused')).toBeTruthy();
    await act(async () => appState.forEach((fn) => fn('active')));
    fireEvent.press(screen.getByTestId('continue'));
    await until(() => src.state.listens.length > listensB && src.state.pending !== null, 'listen turn for B after continue');
    expect([src.state.pending!.listen.item.item_key, src.state.pending!.listen.kind]).toEqual(['en:letter:B', 'teach']);
    expect(events('answer')).toHaveLength(1);
  });

  test('killing the app and reopening the lesson resumes at the same answer', async () => {
    const first = scriptedSource();
    const firstLines = fakeLines();
    first.state.hold = true;
    await openLesson(lessonUrl(EN.template_id), { answerSource: first.source, linePlayer: firstLines.player });
    for (let n = 1; n <= 3; n++) await answer(first, n);
    await until(() => first.state.pending !== null, 'listen turn for D');
    expect(first.state.pending!.listen.item.item_key).toBe('en:letter:D');
    screen.unmount(); // the process dies here

    const second = scriptedSource();
    const secondLines = fakeLines();
    second.state.hold = true;
    await openLesson(lessonUrl(EN.template_id), { answerSource: second.source, linePlayer: secondLines.player });
    await until(() => second.state.pending !== null, 'the first listen turn after reopening');
    expect([second.state.pending!.listen.item.item_key, second.state.pending!.listen.kind]).toEqual(['en:letter:D', 'teach']);
    expect(second.state.listens).toHaveLength(1);
    expect(secondLines.state.plays.map((p) => p.id)).not.toContain(`${EN.template_id}.intro`);
    expect(events('answer')).toHaveLength(3);
  });

  // Level 5 integration: lesson_left counts items done as the item dots do (no turn left), so a
  // resumed run counts items finished before the resume too (the report's "6 of 10").
  test('Stop after a resume counts items done before the resume in lesson_left', async () => {
    const first = scriptedSource();
    first.state.hold = true;
    await openLesson(lessonUrl(EN.template_id), { answerSource: first.source, linePlayer: fakeLines().player });
    for (let n = 1; n <= 7; n++) await answer(first, n); // teach A to E, quiz C and A
    screen.unmount();

    const second = scriptedSource();
    second.state.hold = true;
    await openLesson(lessonUrl(EN.template_id), { answerSource: second.source, linePlayer: fakeLines().player });
    await answer(second, 8); // quiz D
    await until(() => second.state.pending !== null, 'listen turn for E');

    fireEvent.press(screen.getByTestId('pause'));
    fireEvent.press(screen.getByTestId('stop'));
    await until(() => events('lesson_left').length === 1, 'lesson_left');
    const left = events('lesson_left')[0] as unknown as { items_done: number; items_total: number };
    expect(left).toMatchObject({ items_done: 3, items_total: 5 }); // C, A, D
  });

  test('a surprise sets its tutor state and plays its line with the mic closed', async () => {
    const src = scriptedSource();
    const lines = fakeLines();
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    // Math.random 0: the surprise comes before B's teach turn.
    await until(() => src.state.listens.some((l) => l.item.item_key === 'en:letter:B'), 'listen turn for B');
    const surpriseState = mockLog.findIndex((e) => SURPRISE_STATES.some((s) => e === `state:${s}`));
    const surpriseLine = mockLog.findIndex((e) => e.startsWith('play:surprise_line'));
    const listenB = mockLog.indexOf('listen:en:letter:B:teach');
    const teachB = mockLog.indexOf(`play:${EN.template_id}.b.teach`);
    expect(surpriseState).toBeGreaterThan(-1);
    expect(surpriseLine).toBeGreaterThan(surpriseState);
    expect(teachB).toBeGreaterThan(surpriseLine);
    // no listen turn from the surprise until B's teach line has played
    expect(mockLog.slice(surpriseState, teachB).filter((e) => e.startsWith('listen:'))).toEqual([]);
    expect(listenB).toBeGreaterThan(teachB);
  });

  test('Stop ends the session with reason stop; paused time does not count as active', async () => {
    const src = scriptedSource();
    const lines = fakeLines();
    src.state.hold = true;
    const t0 = Date.now();
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });
    await until(() => src.state.pending !== null, 'the first listen turn');
    const beforePause = Date.now() - t0;

    fireEvent.press(screen.getByTestId('pause'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5 * 60_000); // a long pause
    });
    fireEvent.press(screen.getByTestId('stop'));
    await until(() => !!db.get<{ ended_at: string | null }>('SELECT ended_at FROM session WHERE id = ?', [sessionId])?.ended_at, 'session end');

    const row = db.get<{ end_reason: string; active_ms: number }>('SELECT end_reason, active_ms FROM session WHERE id = ?', [sessionId])!;
    expect(row.end_reason).toBe('stop');
    expect(row.active_ms).toBeGreaterThan(0);
    expect(row.active_ms).toBeLessThanOrEqual(beforePause + 1000);
  });

  test.each([
    ['goal met: /goodbye', 1, () => '/goodbye'],
    ['goal not met: back to the queue', 3, () => `/child/${childId}`],
  ])('at the end: lesson_end, revision from the stop was asked, then %s', async (_name, goal, expected) => {
    updateChild(db, childId, { lessons_per_day: goal });
    const src = scriptedSource();
    const lines = fakeLines();
    const stop = { kind: 'lesson', template_id: EN.template_id, revision: [{ item_key: 'en:letter:F', lang: 'en' }] };
    const url = lessonUrl(EN.template_id, `&stop=${encodeURIComponent(JSON.stringify(stop))}`);
    const router = await openLesson(url, { answerSource: src.source, linePlayer: lines.player });

    await until(() => !router.getPathname().startsWith('/lesson/'), 'leaving the lesson');
    expect(router.getPathname()).toBe(expected());
    expect(events('lesson_end').map((e) => [e.session_id, e.template_id])).toEqual([[sessionId, EN.template_id]]);
    expect(events('answer').filter((e) => e.item_key === 'en:letter:F').map((e) => e.phase)).toEqual(['revision']);
    expect(src.state.listens.filter((l) => l.kind === 'quiz').map((l) => l.item.item_key)).toContain('en:letter:F');
  });

  // Consumers: GURU-29 (opens the route), GURU-32 (moments UI in LessonPlayer), GURU-33 (lesson end
  // to /goodbye), GURU-34 (tap AnswerSource through LessonPlayerDeps). Shape only.
  test('contract: route, LessonPlayer, LessonPlayerDeps, usePlayerLoop, onLessonEnd; progress/storage removed', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const route = require('../app/lesson/[template]');
    expect(typeof route.default).toBe('function');

    const player = require('../lesson/LessonPlayer');
    expect(typeof player.LessonPlayer).toBe('function');
    expect(player.LessonPlayerDeps).toEqual(expect.objectContaining({ Provider: expect.anything() }));

    const loop = require('../lesson/usePlayerLoop');
    expect(typeof loop.usePlayerLoop).toBe('function');
    expect(typeof loop.onLessonEnd).toBe('function');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const src = path.join(__dirname, '..');
    expect(fs.existsSync(path.join(src, 'progress', 'storage.ts'))).toBe(false);
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && p !== __filename && /progress\/storage/.test(fs.readFileSync(p, 'utf8'))) importers.push(path.relative(src, p));
      }
    };
    walk(src);
    expect(importers).toEqual([]);
  });
});
