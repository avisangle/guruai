// GURU-22: style level between sessions (PRD Language design 3; D-GURU-22-style-level-rule).
// Tables from migrations.ts (GURU-4):
//   child_profile: ... medium, style_level ('mr_led' | 'en_led', NOT NULL), style_locked (0/1, default 0) ...
//   event:         id, child_id, session_id, at, type, payload (JSON text), created_at, updated_at; append-only
//   session:       id, child_id, started_at, ended_at, end_reason, parent_helps, active_ms, ...
// Answer events come from GURU-12 (events.ts, `recordAnswer`): `type: 'answer'`, payload per TDD 2.3.
// Rule under test: first-try rate on counted word answers over the last 2 sessions with answers,
// at least 8 counted answers; >= 0.8 moves mr_led -> en_led, <= 0.4 moves en_led -> mr_led.
import type { Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, getChild, updateChild } from '../data/profiles';
import { createTestDb } from '../data/testDb';
import type { StyleLevel } from '../data/types';
import * as config from './config';
import { recordAnswer, type AnswerEvent } from './events';
import { startSession } from './session';
import { applyStyleLevelAtSessionStart, nextStyleLevel } from './styleLevel';

// Row ids and child codes come from expo-crypto; keep them native-free.
jest.mock('expo-crypto', () => {
  const nodeCrypto = jest.requireActual('crypto');
  let calls = 0;
  return {
    randomUUID: jest.fn(() => `uuid-${++calls}`),
    getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
  };
});

// What nextStyleLevel reads: a stored answer event with the session it belongs to.
type StyleAnswer = AnswerEvent & { session_id: string; at: string };

// A counted word answer: first try, right, judged by Shekru.
const word = (over: Partial<AnswerEvent> = {}): AnswerEvent => ({
  template_id: 'en_words_1',
  item_key: 'en:cat',
  item_kind: 'word',
  target_lang: 'en',
  phase: 'quiz',
  heard_kind: 'correct',
  decided_by: 'shekru',
  attempt: 1,
  unsure: false,
  style_level: 'mr_led',
  counts: true,
  ...over,
});

const right = (over: Partial<AnswerEvent> = {}) => word(over);
const miss = (over: Partial<AnswerEvent> = {}) => word({ heard_kind: 'wrong', ...over });
const times = <T>(n: number, make: () => T): T[] => Array.from({ length: n }, make);

// Events are in time order; each call moves the clock one second on.
let tick = 0;
const nextAt = () => new Date(2026, 10, 1, 8, 0, tick++).toISOString();

const session = (sessionId: string, events: AnswerEvent[]): StyleAnswer[] =>
  events.map((e) => ({ ...e, session_id: sessionId, at: nextAt() }));

// `right` first-try answers and `wrong` misses in one session, or split over two.
const mix = (correct: number, wrong: number) => [...times(correct, () => right()), ...times(wrong, () => miss())];
const twoSessions = (a: AnswerEvent[], b: AnswerEvent[]) => [...session('s1', a), ...session('s2', b)];

function freshDb(): Db {
  const db = createTestDb();
  migrate(db);
  return db;
}

const addChild = (db: Db, medium: 'mr' | 'en' = 'mr') =>
  createChild(db, { nickname: 'Ira', picture: 'squirrel', class: 'UKG', medium }).id;

const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

const styleChanges = (db: Db, childId: string) =>
  db
    .all<{ child_id: string; type: string; payload: string }>(
      `SELECT child_id, type, payload FROM event WHERE child_id = ? AND type = 'style_change' ORDER BY rowid`,
      [childId],
    )
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) }));

// One sitting: opens a session at `at` and records the answers a minute apart.
function sitting(db: Db, childId: string, day: number, hour: number, answers: AnswerEvent[]): string {
  const sessionId = startSession(db, childId, local(day, hour));
  answers.forEach((a, i) => recordAnswer(db, { childId, sessionId, at: local(day, hour, i + 1) }, a));
  return sessionId;
}

describe('nextStyleLevel', () => {
  it('moves mr_led up at a first-try rate of 0.8 or more and en_led down at 0.4 or less; between, the level stays', () => {
    // The provisional numbers from D-GURU-22-style-level-rule, all in one file.
    expect(config).toMatchObject({
      STYLE_UP_RATE: 0.8,
      STYLE_DOWN_RATE: 0.4,
      STYLE_WINDOW_SESSIONS: 2,
      STYLE_MIN_ANSWERS: 8,
    });

    // Exactly on the thresholds.
    expect(nextStyleLevel(twoSessions(mix(4, 1), mix(4, 1)), 'mr_led', false)).toBe('en_led'); // 8/10
    expect(nextStyleLevel(twoSessions(mix(2, 3), mix(2, 3)), 'en_led', false)).toBe('mr_led'); // 4/10
    // Just inside them.
    expect(nextStyleLevel(twoSessions(mix(4, 1), mix(3, 2)), 'mr_led', false)).toBe('mr_led'); // 7/10
    expect(nextStyleLevel(twoSessions(mix(3, 2), mix(2, 3)), 'en_led', false)).toBe('en_led'); // 5/10
    // There is no level above en_led or below mr_led.
    expect(nextStyleLevel(twoSessions(mix(5, 0), mix(5, 0)), 'en_led', false)).toBe('en_led');
    expect(nextStyleLevel(twoSessions(mix(0, 5), mix(0, 5)), 'mr_led', false)).toBe('mr_led');
  });

  it('returns the current level when locked, or with fewer than 8 counted word answers', () => {
    // A parent kept this style (wireframe decision 6): no history moves it.
    expect(nextStyleLevel(twoSessions(mix(5, 0), mix(5, 0)), 'mr_led', true)).toBe('mr_led');
    expect(nextStyleLevel(twoSessions(mix(0, 5), mix(0, 5)), 'en_led', true)).toBe('en_led');

    // 7 counted answers, all right first try: not enough to judge.
    expect(nextStyleLevel(twoSessions(mix(4, 0), mix(3, 0)), 'mr_led', false)).toBe('mr_led');
    expect(nextStyleLevel(twoSessions(mix(0, 4), mix(0, 3)), 'en_led', false)).toBe('en_led');
    // 8 is enough.
    expect(nextStyleLevel(twoSessions(mix(4, 0), mix(4, 0)), 'mr_led', false)).toBe('en_led');
    // No history at all.
    expect(nextStyleLevel([], 'mr_led', false)).toBe('mr_led');
    expect(nextStyleLevel([], 'en_led', false)).toBe('en_led');
  });

  it('reads only the last 2 sessions', () => {
    // An old session of misses is outside the window: 8/8 in the last two moves up.
    const oldMisses = [...session('s0', mix(0, 10)), ...session('s1', mix(4, 0)), ...session('s2', mix(4, 0))];
    expect(nextStyleLevel(oldMisses, 'mr_led', false)).toBe('en_led');

    // Plenty of answers overall, but only 7 in the last two sessions: no change.
    const thinWindow = [...session('s0', mix(10, 0)), ...session('s1', mix(4, 0)), ...session('s2', mix(3, 0))];
    expect(nextStyleLevel(thinWindow, 'mr_led', false)).toBe('mr_led');
  });

  it('counts word answers in quiz, retry and revision that are not silent, tap answers and gated misses included; first try is attempt 1 and correct', () => {
    // Each block below would flip the result if its rule were broken.

    // Silent (unclear or unsure), letter items, teach and follow-up turns never count:
    // 8/10 moves up, and counting any of these misses would pull it under 0.8.
    const noise = [
      miss({ heard_kind: 'silent', unsure: true }),
      miss({ heard_kind: 'silent' }),
      miss({ item_kind: 'letter', item_key: 'mr:a', target_lang: 'mr' }),
      miss({ phase: 'teach', counts: false }),
      miss({ phase: 'followup', counts: false }),
    ];
    expect(nextStyleLevel(twoSessions([...mix(4, 1), ...noise], mix(4, 1)), 'mr_led', false)).toBe('en_led');

    // A parent's tap and a gated word miss (counts: false while WORD_ITEMS_GATED) both count:
    // 8/12 stays; dropping either pair would make it 8/10 and move up.
    const tapAndGated = [
      miss({ decided_by: 'tap' }),
      miss({ decided_by: 'tap' }),
      miss({ counts: false }),
      miss({ counts: false }),
    ];
    expect(nextStyleLevel(twoSessions(mix(4, 0), [...mix(4, 0), ...tapAndGated]), 'mr_led', false)).toBe('mr_led');
    // A parent's tap on a right answer counts as a first try.
    const tapRight = times(5, () => right({ decided_by: 'tap' }));
    expect(nextStyleLevel(twoSessions(tapRight, tapRight), 'mr_led', false)).toBe('en_led');

    // Misses in retry and revision count: 4/10 moves down; ignoring them would leave 4/4.
    const laterMisses = [...times(3, () => miss({ phase: 'retry' })), ...times(3, () => miss({ phase: 'revision' }))];
    expect(nextStyleLevel(twoSessions(mix(2, 0), [...mix(2, 0), ...laterMisses]), 'en_led', false)).toBe('mr_led');

    // Right on the second try is not a first try, and a right meaning in another language
    // is not the target word: 2 first tries out of 11 answers moves down; counting either
    // kind as a first try would give 5/11 and keep en_led.
    const secondTries = [
      ...times(3, () => miss()),
      ...times(3, () => right({ attempt: 2 })),
      ...times(3, () => right({ heard_kind: 'meaning', matched_lang: 'mr' })),
    ];
    expect(nextStyleLevel(twoSessions(mix(1, 0), [...mix(1, 0), ...secondTries]), 'en_led', false)).toBe('mr_led');
  });
});

describe('applyStyleLevelAtSessionStart', () => {
  it('updates child_profile.style_level and appends one style_change event when the level changes; locked or unchanged writes nothing', () => {
    const db = freshDb();
    const kid = addChild(db, 'mr');
    expect(getChild(db, kid)!.style_level).toBe('mr_led');

    sitting(db, kid, 18, 10, mix(4, 1));
    sitting(db, kid, 19, 10, mix(4, 1));

    expect(applyStyleLevelAtSessionStart(db, kid)).toBe('en_led');
    expect(getChild(db, kid)!.style_level).toBe('en_led');
    expect(styleChanges(db, kid)).toEqual([
      expect.objectContaining({ child_id: kid, type: 'style_change', payload: expect.objectContaining({ from: 'mr_led', to: 'en_led' }) }),
    ]);

    // Same history again: nothing more to change, nothing appended.
    expect(applyStyleLevelAtSessionStart(db, kid)).toBe('en_led');
    expect(styleChanges(db, kid)).toHaveLength(1);

    // A locked child with the same history keeps the level, and no event is written.
    const locked = addChild(db, 'mr');
    updateChild(db, locked, { style_locked: true });
    sitting(db, locked, 18, 11, mix(5, 0));
    sitting(db, locked, 19, 11, mix(5, 0));
    expect(applyStyleLevelAtSessionStart(db, locked)).toBe('mr_led');
    expect(getChild(db, locked)!.style_level).toBe('mr_led');
    expect(styleChanges(db, locked)).toEqual([]);

    // A new child with no answers keeps the level from the school medium.
    const fresh = addChild(db, 'en');
    expect(applyStyleLevelAtSessionStart(db, fresh)).toBe('en_led');
    expect(styleChanges(db, fresh)).toEqual([]);
  });

  it('runs at each session start, judged on the sessions before the one just opened', () => {
    const db = freshDb();
    const kid = addChild(db, 'mr');

    // 5 counted answers per sitting: the second start sees only 5, so no change yet.
    sitting(db, kid, 18, 10, mix(4, 1));
    sitting(db, kid, 19, 10, mix(4, 1));
    expect(getChild(db, kid)!.style_level).toBe('mr_led');
    expect(styleChanges(db, kid)).toEqual([]);

    // The third start sees both earlier sittings (8/10). The new, empty session must not
    // take a window slot, or only 5 answers would be in view.
    startSession(db, kid, local(20, 10));
    expect(getChild(db, kid)!.style_level).toBe('en_led');
    expect(styleChanges(db, kid)).toHaveLength(1);
  });
});

// Consumed by GURU-36 (Settings and child profile form): style lock and level.
describe('contract for dependents (GURU-36)', () => {
  it('exports nextStyleLevel(events, current, locked), applyStyleLevelAtSessionStart(db, childId) and the config constants', () => {
    expect(typeof nextStyleLevel).toBe('function');
    expect(nextStyleLevel).toHaveLength(3);
    const level: StyleLevel = nextStyleLevel([], 'mr_led', false);
    expect(['mr_led', 'en_led']).toContain(level);

    expect(typeof applyStyleLevelAtSessionStart).toBe('function');
    expect(applyStyleLevelAtSessionStart).toHaveLength(2);
    const db = freshDb();
    const kid = addChild(db);
    expect(['mr_led', 'en_led']).toContain(applyStyleLevelAtSessionStart(db, kid));

    for (const name of ['STYLE_UP_RATE', 'STYLE_DOWN_RATE', 'STYLE_WINDOW_SESSIONS', 'STYLE_MIN_ANSWERS'] as const) {
      expect(typeof (config as Record<string, unknown>)[name]).toBe('number');
    }
  });
});
