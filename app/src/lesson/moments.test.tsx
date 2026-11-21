// GURU-32: lesson moments UI. Spec: issue GURU-32, wireframes l-talking, l-listening, l-correct,
// l-streak, l-surprise, l-finished, l-nohear; PRD Decisions 5 (one star per finished stop) and 18
// (lock top left, 64 dp pause).
//
// Each moment is reached by driving the real engine with a scripted AnswerSource and a fake line
// player, through the real /lesson/[template] route (same harness as __tests__/lesson.test.tsx).
// A held line freezes the screen on the moment that line belongs to. Faked: expo-sqlite (one
// in-memory better-sqlite3), expo-crypto, expo-audio, useLinePlayer, useRecording, useShekruRig,
// Shekru, react-native-reanimated, safe-area insets.
//
// Real schema read here (app/src/data/migrations.ts, migration 1):
//   event(id, child_id, session_id, at, type, payload JSON, ...)   stars = COUNT of type 'lesson_end'
//
// Contract pinned for /implement (testIDs on the lesson screen):
//   item-dots            row of dots under Shekru, one per lesson item plus one per revision item;
//                        each dot has testID dot-done | dot-current | dot-left
//   mic-closed           dashed mic outline while Shekru talks (no listen turn open)
//   mic-open             open mic during a listen turn
//   mic-again            ear-and-loop badge on the mic for the listen turn reopened after "didn't hear"
//   correct-tick         tick badge inside `card`; `card` also gets borderColor color.child.success
//                        and a thicker border than its neutral one
//   reward-star          the star in the control zone on a correct answer
//   streak-ticks         three ticks in place of reward-star when the engine picks streak praise
//   surprise             Shekru centre stage for a surprise step; `card` is not rendered meanwhile
//   lesson-finished      the finished moment (from the closing end_* line on); finished-star is its
//                        star animation
//   parent-lock          the existing ParentLock, top left, on every lesson moment
//   pause                64 dp (theme.touch.child.pause); absent once the lesson is finished
// Modules: ItemDots.tsx exports ItemDots, MicIndicator.tsx exports MicIndicator, Moments.tsx
// exports the moment visuals. LessonPlayer.tsx renders them.
import * as fs from 'fs';
import * as path from 'path';
import { createElement as h, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';

import { openDb, type Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, updateChild } from '../data/profiles';
import { lessonsFinished, startSession } from '../learning/session';
import { theme } from '../ui/theme';
import type { AnswerSource } from './answerSource';
import type { Heard, Lesson, Listen } from './types';

// ---- native fakes (as in __tests__/lesson.test.tsx) ----

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
  return { randomUUID: () => c.randomUUID(), getRandomBytes: (n: number) => new Uint8Array(c.randomBytes(n)) };
});

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

jest.mock('../screens/useLinePlayer', () => {
  const player = { play: async () => undefined, stop: () => undefined, chime: () => undefined };
  return { useLinePlayer: () => player };
});
jest.mock('../screens/useRecording', () => ({
  useRecording: (_templateId: string, _items: unknown[], inner?: { listen(l: unknown): Promise<unknown>; cancel(): void }) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('react').useMemo(() => {
      const source = {
        listen: (l: unknown) => (inner?.listen ? inner.listen(l) : new Promise(() => undefined)),
        cancel: () => inner?.cancel?.(),
      };
      return {
        on: false, settings: { child: '', age: '' }, update: () => undefined, setOn: async () => undefined,
        tap: false, setTap: () => undefined, mic: 'unknown', active: false, count: 0, error: null,
        source, prepare: async () => undefined, exportAll: async () => undefined, deleteAll: () => undefined, judged: null,
      };
    }, [inner]),
}));

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

/* eslint-disable @typescript-eslint/no-require-imports */
const LESSONS = require('../content/generated/lessons.json') as Lesson[];
const EN = LESSONS.find((l) => l.template_id === 'tpl_kg_en_letters_1')!;

// ---- scripted sources ----

type Pending = { listen: Listen; resolve: (h: Heard) => void };

/** Answers each listen turn with `answer` unless `hold(listen)`; then the test answers. */
function scriptedSource() {
  const state = {
    hold: (_l: Listen) => false,
    answer: { kind: 'correct', by: 'tap' } as Heard,
    pending: null as Pending | null,
    listens: [] as Listen[],
  };
  const source: AnswerSource = {
    listen(listen) {
      state.listens.push(listen);
      if (!state.hold(listen)) return Promise.resolve(state.answer);
      return new Promise<Heard>((resolve) => {
        state.pending = { listen, resolve };
      });
    },
    cancel() {
      state.pending = null;
    },
  };
  /** Answers the open turn. */
  const give = async (heard: Heard) => {
    const turn = state.pending!;
    state.pending = null;
    await act(async () => turn.resolve(heard));
  };
  return { source, state, give };
}

/** Lines end at once unless `hold(id)`; a held line ends on release() or stop(). */
function fakeLines() {
  const state = {
    hold: (_id: string) => false,
    held: null as { id: string; end: () => void } | null,
    plays: [] as string[],
  };
  const player = {
    play(id: string) {
      state.plays.push(id);
      if (!state.hold(id)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        state.held = { id, end: resolve };
      });
    },
    stop() {
      state.held?.end();
      state.held = null;
    },
    chime: () => undefined,
  };
  const release = async () => {
    const held = state.held;
    state.held = null;
    await act(async () => held?.end());
  };
  return { player, state, release };
}

// ---- routes ----

const QueueStub = () => {
  const { useLocalSearchParams, useRouter } = require('expo-router');
  const { id, lesson } = useLocalSearchParams() as { id: string; lesson?: string };
  const router = useRouter();
  return h(Pressable, { testID: 'open-lesson', onPress: () => router.push(lesson as string) }, h(Text, null, `queue-${id}`));
};

async function openLesson(url: string, deps: { answerSource: AnswerSource; linePlayer: ReturnType<typeof fakeLines>['player'] }) {
  const { LessonPlayerDeps } = require('./LessonPlayer');
  const wrapper = ({ children }: { children: ReactNode }) => h(LessonPlayerDeps.Provider, { value: deps }, children);
  const routes = {
    'lesson/[template]': require('../app/lesson/[template]').default,
    'child/[id]': QueueStub,
    goodbye: () => h(Text, null, 'goodbye'),
  };
  const router = await renderRouter(routes, { initialUrl: `/child/${childId}?lesson=${encodeURIComponent(url)}`, wrapper });
  fireEvent.press(await screen.findByTestId('open-lesson'));
  await until(() => router.getPathname().startsWith('/lesson/'), 'the lesson route');
  return router;
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;
let childId: string;

const lessonUrl = (template: string, extra = '') => `/lesson/${template}?child=${childId}${extra}`;

async function until(cond: () => boolean, what: string, maxMs = 600_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (cond()) return;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const has = (testID: string) => screen.queryAllByTestId(testID).length > 0;
const dots = () => ({
  done: screen.queryAllByTestId('dot-done').length,
  current: screen.queryAllByTestId('dot-current').length,
  left: screen.queryAllByTestId('dot-left').length,
});
const total = (d: ReturnType<typeof dots>) => d.done + d.current + d.left;
const cardStyle = () => StyleSheet.flatten(screen.getByTestId('card').props.style) ?? {};

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) if (name !== 'device' && name !== 'parent_gate') db.run(`DELETE FROM "${name}"`);
  jest.useFakeTimers();
  // No surprise and no picture reactions unless a test asks (engine CHANCE is 0.5).
  jest.spyOn(Math, 'random').mockReturnValue(0.99);
  mockLog.length = 0;
  const child = createChild(db, { nickname: 'Chinu', picture: 'any', class: 'UKG', medium: 'en' });
  childId = child.id;
  startSession(db, childId, new Date().toISOString());
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('GURU-32 lesson moments', () => {
  test('talking, listening and "didn\'t hear": dashed mic, open mic, ear badge; dots, lock and a 64 dp pause', async () => {
    const src = scriptedSource();
    const lines = fakeLines();
    src.state.hold = () => true;
    lines.state.hold = (id) => id === `${EN.template_id}.a.teach` || id.startsWith('nohear_');
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    // l-talking: Shekru teaches A, the mic is a closed outline
    await until(() => lines.state.held?.id === `${EN.template_id}.a.teach`, 'the teach line for A');
    expect(has('mic-closed')).toBe(true);
    expect(has('mic-open')).toBe(false);
    expect(has('item-dots')).toBe(true);
    expect(total(dots())).toBe(EN.items.length);
    expect(has('parent-lock')).toBe(true);
    const pause = StyleSheet.flatten(screen.getByTestId('pause').props.style);
    expect([pause.width, pause.height]).toEqual([theme.touch.child.pause, theme.touch.child.pause]);
    expect(theme.touch.child.pause).toBe(64);

    // l-listening: open mic, first dot current, nothing done yet
    await lines.release();
    await until(() => src.state.pending !== null, 'listen turn for A');
    expect(has('mic-open')).toBe(true);
    expect(has('mic-closed')).toBe(false);
    expect(has('mic-again')).toBe(false);
    expect(dots()).toEqual({ done: 0, current: 1, left: EN.items.length - 1 });

    // l-nohear: silence; Shekru asks again with a closed mic, then the mic reopens with the badge
    await src.give({ kind: 'silent', by: 'shekru' });
    await until(() => lines.state.held?.id.startsWith('nohear_') ?? false, 'the nohear line');
    expect(has('mic-closed')).toBe(true);
    expect(has('mic-open')).toBe(false);
    await lines.release();
    await until(() => src.state.pending !== null, 'listen turn for A, again');
    expect(src.state.pending!.listen.item.item_key).toBe('en:letter:A');
    expect(has('mic-open')).toBe(true);
    expect(has('mic-again')).toBe(true);
    expect(has('correct-tick')).toBe(false); // never shown as wrong or right: the card stays neutral
    expect(cardStyle().borderColor).not.toBe(theme.color.child.success);

    // the badge is for that one reopened turn only
    await src.give({ kind: 'correct', by: 'shekru' });
    await until(() => src.state.pending?.listen.item.item_key === 'en:letter:B', 'listen turn for B');
    expect(has('mic-open')).toBe(true);
    expect(has('mic-again')).toBe(false);
  });

  test('correct: tick badge on the card, thick green edge, a star; the item\'s dot fills; all gone at the next turn', async () => {
    const src = scriptedSource();
    const lines = fakeLines();
    src.state.hold = (l) => l.kind === 'quiz';
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    await until(() => src.state.pending !== null, 'the first quiz turn');
    const neutral = cardStyle();
    const before = dots();
    expect(before.current).toBe(1);
    expect(has('correct-tick')).toBe(false);
    expect(has('reward-star')).toBe(false);

    lines.state.hold = (id) => id.startsWith('praise_');
    await src.give({ kind: 'correct', by: 'shekru' });
    await until(() => lines.state.held !== null, 'the praise line');
    expect(lines.state.held!.id).toMatch(/^praise_first_/);
    expect(within(screen.getByTestId('card')).getByTestId('correct-tick')).toBeTruthy();
    const edge = cardStyle();
    expect(edge.borderColor).toBe(theme.color.child.success);
    expect(edge.borderWidth).toBeGreaterThan(neutral.borderWidth ?? 0);
    expect(has('reward-star')).toBe(true);
    expect(has('streak-ticks')).toBe(false);
    expect(dots().done).toBeGreaterThan(before.done);

    lines.state.hold = () => false;
    await lines.release();
    await until(() => src.state.pending !== null, 'the second quiz turn');
    expect(has('correct-tick')).toBe(false);
    expect(has('reward-star')).toBe(false);
    expect(cardStyle().borderColor).not.toBe(theme.color.child.success);
  });

  test('streak: the third correct quiz answer in a row shows three ticks instead of the star; teach answers never do; stars unchanged', async () => {
    const src = scriptedSource(); // answers every turn correct at once
    const lines = fakeLines();
    lines.state.hold = (id) => id.startsWith('praise_');
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    const seen: { id: string; phase: string; ticks: boolean; star: boolean }[] = [];
    while (seen.filter((s) => s.phase === 'quiz').length < 3) {
      await until(() => lines.state.held !== null, `praise ${seen.length + 1}`);
      seen.push({
        id: lines.state.held!.id,
        phase: src.state.listens.at(-1)!.kind,
        ticks: has('streak-ticks'),
        star: has('reward-star'),
      });
      await lines.release();
    }
    const teach = seen.filter((s) => s.phase === 'teach');
    const quiz = seen.filter((s) => s.phase === 'quiz');
    expect(teach).toHaveLength(EN.items.length);
    // five correct teach answers in a row are not a streak: teach turns are not scored
    expect(teach.map((s) => s.ticks)).toEqual(teach.map(() => false));
    expect(quiz.map((s) => s.id.replace(/_\d+$/, ''))).toEqual(['praise_first', 'praise_first', 'praise_streak']);
    expect(quiz.map((s) => [s.ticks, s.star])).toEqual([[false, true], [false, true], [true, false]]);
    expect(lessonsFinished(db, childId)).toBe(0); // ticks are not stars (Decisions 5)
  });

  test('surprise: the card steps aside and Shekru takes the centre; dots stay; the mic stays closed', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // a surprise (sneeze, with a line) before B's teach turn
    const src = scriptedSource();
    const lines = fakeLines();
    lines.state.hold = (id) => id.startsWith('surprise_line') || id === `${EN.template_id}.b.teach`;
    await openLesson(lessonUrl(EN.template_id), { answerSource: src.source, linePlayer: lines.player });

    await until(() => lines.state.held?.id.startsWith('surprise_line') ?? false, 'the surprise line');
    expect(mockLog).toContain('state:sneeze');
    expect(has('surprise')).toBe(true);
    expect(has('card')).toBe(false);
    expect(total(dots())).toBe(EN.items.length);
    expect(has('mic-open')).toBe(false);
    expect(has('pause')).toBe(true); // pause still works during a surprise

    await lines.release();
    await until(() => lines.state.held?.id === `${EN.template_id}.b.teach`, 'the teach line for B');
    expect(has('surprise')).toBe(false);
    expect(within(screen.getByTestId('card')).getByText('B')).toBeTruthy();
  });

  test('finished: dots fill as the lesson goes and are all done at the end, revision included; star; no pause; lock stays', async () => {
    updateChild(db, childId, { lessons_per_day: 3 });
    const src = scriptedSource();
    const lines = fakeLines();
    src.state.hold = () => true;
    lines.state.hold = (id) => id.startsWith('end_');
    const stop = { kind: 'lesson', template_id: EN.template_id, revision: [{ item_key: 'en:letter:F', lang: 'en' }] };
    await openLesson(lessonUrl(EN.template_id, `&stop=${encodeURIComponent(JSON.stringify(stop))}`), {
      answerSource: src.source,
      linePlayer: lines.player,
    });

    const expected = EN.items.length + 1; // the revision item gets a dot too
    const samples: ReturnType<typeof dots>[] = [];
    while (!lines.state.held) {
      await until(() => src.state.pending !== null || lines.state.held !== null, 'a listen turn or the closing line');
      if (!src.state.pending) break;
      expect(has('lesson-finished')).toBe(false);
      samples.push(dots());
      await src.give({ kind: 'correct', by: 'shekru' });
    }
    expect(samples.length).toBeGreaterThan(expected); // teach and quiz turns
    for (const s of samples) {
      expect(total(s)).toBe(expected);
      expect(s.current).toBe(1);
    }
    const done = samples.map((s) => s.done);
    expect(done[0]).toBe(0);
    expect(done).toEqual([...done].sort((a, b) => a - b)); // a dot once filled stays filled
    expect(done.some((d) => d > 0 && d < expected)).toBe(true); // filled as items finish, not all at the end

    // l-finished, during the closing end_* line
    expect(lines.state.held!.id).toMatch(/^end_all_/);
    expect(has('lesson-finished')).toBe(true);
    expect(has('finished-star')).toBe(true);
    expect(dots()).toEqual({ done: expected, current: 0, left: 0 });
    expect(has('pause')).toBe(false);
    expect(has('parent-lock')).toBe(true);
    expect(has('mic-open')).toBe(false);
  });

  test('colours come from the theme: no colour literals in the lesson screen modules', () => {
    const files = ['ItemDots.tsx', 'MicIndicator.tsx', 'Moments.tsx', 'LessonPlayer.tsx'];
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|['"](white|black|red|green|yellow|blue|orange|gold|grey|gray)['"]/;
    const offenders = files.filter((f) => literal.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  // No dependent issue (needed by: none); pins the module names the issue lists. Shape only.
  test('contract: ItemDots, MicIndicator and Moments modules export their components', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    expect(typeof require('./ItemDots').ItemDots).toBe('function');
    expect(typeof require('./MicIndicator').MicIndicator).toBe('function');
    const moments = require('./Moments') as Record<string, unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(Object.values(moments).some((v) => typeof v === 'function')).toBe(true);
  });
});
