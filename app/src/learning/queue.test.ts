// GURU-20: today's queue and path enrolment (PRD Learning model; wireframes c-queue,
// c-queue-mid, c-queue-first, decision 14).
// Tables from migrations.ts (GURU-4):
//   path_enrollment: id, child_id, path_id, source ('class'|'skill'), created_at, updated_at
//   assignment:      id, child_id, template_id, for_date, done_at, created_at, updated_at
//   lesson_position: id, child_id, template_id, version, position (JSON text), created_at, updated_at
//   item_mastery:    id, child_id, item_key, lang, state, streak, interval_days, next_due,
//                    last_result, created_at, updated_at
// Path ids come from app/src/content/generated/paths.json (GURU-16): class paths are
// `class_<board>_<class>`, skill paths `skill_<goal>`. Days are local 'YYYY-MM-DD' (GURU-12).
import type { Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, getChild, updateChild } from '../data/profiles';
import { createTestDb } from '../data/testDb';
import { assignLesson } from './assignments';
import { ensureEnrolment } from './enrol';
import { buildTodayQueue } from './queue';

// Row ids and child codes come from expo-crypto; keep them native-free.
jest.mock('expo-crypto', () => {
  const nodeCrypto = jest.requireActual('crypto');
  let calls = 0;
  return {
    randomUUID: jest.fn(() => `uuid-${++calls}`),
    getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
  };
});

// The pure input this test pins. A loader that reads it from the database is the
// implementation's choice; GURU-29 and GURU-30 only rely on the output.
type Due = { item_key: string; lang: string };
type QueueInput = {
  today: string;
  goal: number; // child.lessons_per_day
  doneToday: number; // lesson_end events on `today`, repeats included
  inProgress: string[]; // template ids with a saved lesson_position
  assignments: { template_id: string; for_date: string; done_at: string | null }[];
  paths: { path_id: string; units: { unit_id: string; lessons: string[] }[] }[]; // active, enrolment order
  finished: string[]; // template ids with any lesson_end
  due: Due[]; // dueRevision(db, childId, today)
  lessonLang: Record<string, string>; // template id -> 'mr' | 'en'
  isInstalled: (templateId: string) => boolean;
};
type LessonStop = { kind: 'lesson'; template_id: string; revision: Due[] };
type RevisionStop = { kind: 'revision'; items: Due[] };
type Stop = LessonStop | RevisionStop;
type TodayQueue = { stops: Stop[]; goal: number; done: number; goalMet: boolean; waitingForDownload: string[] };

const queue = (input: QueueInput) => buildTodayQueue(input as never) as unknown as TodayQueue;

const TODAY = '2026-12-01';
const TOMORROW = '2026-12-02';

const path = (path_id: string, ...lessons: string[]) => ({ path_id, units: [{ unit_id: `${path_id}_u1`, lessons }] });

const input = (over: Partial<QueueInput> = {}): QueueInput => ({
  today: TODAY,
  goal: 3,
  doneToday: 0,
  inProgress: [],
  assignments: [],
  paths: [],
  finished: [],
  due: [],
  // Every template id in these tests names its language: tpl_en_* is English, the rest Marathi.
  lessonLang: new Proxy({}, { get: (_t, id) => (String(id).includes('_en_') ? 'en' : 'mr'), has: () => true }) as Record<
    string,
    string
  >,
  isInstalled: () => true,
  ...over,
});

const lessonIds = (q: TodayQueue) => q.stops.filter((s): s is LessonStop => s.kind === 'lesson').map((s) => s.template_id);

const dueItems = (lang: string, n: number): Due[] =>
  Array.from({ length: n }, (_, i) => ({ item_key: `${lang}:item${i + 1}`, lang }));

function freshDb(): Db {
  const db = createTestDb();
  migrate(db);
  return db;
}

const addChild = (db: Db) => createChild(db, { nickname: 'Ira', picture: 'squirrel', class: 'LKG', medium: 'mr' }).id;

const assignmentRows = (db: Db, childId: string) =>
  db.all<{ template_id: string; for_date: string; done_at: string | null }>(
    'SELECT template_id, for_date, done_at FROM assignment WHERE child_id = ? ORDER BY rowid',
    [childId],
  );

describe('buildTodayQueue: lesson order', () => {
  it('puts lessons the parent assigned for today first, ahead of path lessons, and leaves future ones out', () => {
    const q = queue(
      input({
        assignments: [
          { template_id: 'tpl_mr_assigned', for_date: TODAY, done_at: null },
          { template_id: 'tpl_mr_next_week', for_date: '2026-12-08', done_at: null },
          { template_id: 'tpl_mr_done', for_date: TODAY, done_at: '2026-12-01T05:00:00.000Z' },
        ],
        paths: [path('class_p', 'tpl_mr_p1', 'tpl_mr_p2'), path('skill_q', 'tpl_en_q1')],
      }),
    );

    expect(lessonIds(q)).toEqual(['tpl_mr_assigned', 'tpl_mr_p1', 'tpl_en_q1']);
  });

  it('then takes the next unfinished lesson of each active path in enrolment and unit order, without repeats', () => {
    const q = queue(
      input({
        paths: [
          { path_id: 'class_p', units: [{ unit_id: 'u1', lessons: ['tpl_mr_a1'] }, { unit_id: 'u2', lessons: ['tpl_mr_a2'] }] },
          path('skill_b', 'tpl_en_b1', 'tpl_en_b2'),
          path('skill_c', 'tpl_mr_c1'),
        ],
        finished: ['tpl_mr_a1'],
      }),
    );
    expect(lessonIds(q)).toEqual(['tpl_mr_a2', 'tpl_en_b1', 'tpl_mr_c1']);

    // A class path and a skill path can share lessons; a lesson is queued at most once.
    const shared = queue(input({ paths: [path('class_p', 'tpl_mr_s1', 'tpl_mr_s2'), path('skill_m', 'tpl_mr_s1', 'tpl_mr_s2')] }));
    const ids = lessonIds(shared);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('tpl_mr_s1');
  });

  it('resumes a lesson in progress first, ahead of assigned lessons, and does not queue it twice', () => {
    const q = queue(
      input({
        doneToday: 1,
        inProgress: ['tpl_mr_p2'],
        assignments: [{ template_id: 'tpl_mr_assigned', for_date: TODAY, done_at: null }],
        paths: [path('class_p', 'tpl_mr_p1', 'tpl_mr_p2')],
        finished: ['tpl_mr_p1'],
      }),
    );

    // One lesson done today, goal 3: two lesson stops left.
    expect(lessonIds(q)).toEqual(['tpl_mr_p2', 'tpl_mr_assigned']);
    expect(q.done).toBe(1);
    expect(q.goalMet).toBe(false);
  });

  it('skips a lesson whose audio pack is not installed, lists it in waitingForDownload, and fills the goal from the rest', () => {
    const q = queue(
      input({
        assignments: [{ template_id: 'tpl_mr_missing', for_date: TODAY, done_at: null }],
        paths: [path('class_p', 'tpl_mr_p1'), path('skill_q', 'tpl_en_q1'), path('skill_r', 'tpl_mr_r1')],
        isInstalled: (id) => id !== 'tpl_mr_missing',
      }),
    );

    expect(lessonIds(q)).toEqual(['tpl_mr_p1', 'tpl_en_q1', 'tpl_mr_r1']);
    expect(q.waitingForDownload).toEqual(['tpl_mr_missing']);
  });
});

describe('assignLesson and overflow to tomorrow (decision 14)', () => {
  it('queues assignments beyond the goal first tomorrow, ahead of tomorrow\'s new assignments', () => {
    const db = freshDb();
    const childId = addChild(db);
    for (const id of ['tpl_mr_a1', 'tpl_mr_a2', 'tpl_mr_a3', 'tpl_mr_a4']) assignLesson(db, childId, id, TODAY);

    expect(assignmentRows(db, childId)).toEqual(
      ['tpl_mr_a1', 'tpl_mr_a2', 'tpl_mr_a3', 'tpl_mr_a4'].map((template_id) => ({ template_id, for_date: TODAY, done_at: null })),
    );
    const paths = [path('class_p', 'tpl_mr_p1', 'tpl_mr_p2')];
    expect(lessonIds(queue(input({ assignments: assignmentRows(db, childId), paths })))).toEqual([
      'tpl_mr_a1',
      'tpl_mr_a2',
      'tpl_mr_a3',
    ]);

    // Today's three were finished; the parent assigns a new lesson for tomorrow.
    db.run(`UPDATE assignment SET done_at = ? WHERE child_id = ? AND template_id IN ('tpl_mr_a1', 'tpl_mr_a2', 'tpl_mr_a3')`, [
      '2026-12-01T06:00:00.000Z',
      childId,
    ]);
    assignLesson(db, childId, 'tpl_mr_new', TOMORROW);

    const tomorrow = queue(input({ today: TOMORROW, assignments: assignmentRows(db, childId), paths }));
    expect(lessonIds(tomorrow)).toEqual(['tpl_mr_a4', 'tpl_mr_new', 'tpl_mr_p1']);
  });
});

describe('buildTodayQueue: revision', () => {
  it('mixes due items into lessons of the same language, at most 3 each; leftovers (at most 8) form one stop after the first lesson', () => {
    const paths = [path('p_a', 'tpl_mr_a'), path('p_b', 'tpl_en_b'), path('p_c', 'tpl_mr_c')];
    const q = queue(input({ paths, due: [...dueItems('mr', 10), ...dueItems('en', 1)] }));

    expect(q.stops.map((s) => (s.kind === 'lesson' ? s.template_id : 'revision'))).toEqual([
      'tpl_mr_a',
      'revision',
      'tpl_en_b',
      'tpl_mr_c',
    ]);
    const [a, rev, b, c] = q.stops as [LessonStop, RevisionStop, LessonStop, LessonStop];
    expect(a.revision).toHaveLength(3);
    expect(c.revision).toHaveLength(3);
    expect(b.revision).toEqual([{ item_key: 'en:item1', lang: 'en' }]);
    expect([...a.revision, ...c.revision].every((d) => d.lang === 'mr')).toBe(true);
    expect(rev.items).toHaveLength(4);
    const all = [...a.revision, ...b.revision, ...c.revision, ...rev.items].map((d) => d.item_key);
    expect(new Set(all).size).toBe(11);

    // More leftovers than fit: the revision stop holds 8, the rest wait for another day.
    const many = queue(input({ paths, due: dueItems('mr', 20) }));
    const stop = many.stops.find((s): s is RevisionStop => s.kind === 'revision')!;
    expect(stop.items).toHaveLength(8);

    // Nothing left over: no revision stop (c-queue-first).
    const fits = queue(input({ paths, due: dueItems('mr', 2) }));
    expect(fits.stops.some((s) => s.kind === 'revision')).toBe(false);
  });

  it('still offers a revision stop when the goal is met, and revision never counts toward it', () => {
    const q = queue(input({ doneToday: 3, paths: [path('class_p', 'tpl_mr_p1')], due: dueItems('mr', 2) }));

    expect(q.stops).toHaveLength(1);
    expect(q.stops[0]).toMatchObject({ kind: 'revision', items: dueItems('mr', 2) });
    expect(q).toMatchObject({ goal: 3, done: 3, goalMet: true });

    const nothingDue = queue(input({ doneToday: 4, paths: [path('class_p', 'tpl_mr_p1')] }));
    expect(nothingDue.stops).toEqual([]);
    expect(nothingDue.goalMet).toBe(true);
  });
});

describe('ensureEnrolment', () => {
  it('enrols the class path for board and class plus one skill path per goal, and follows class, board and goal changes', () => {
    const db = freshDb();
    const childId = addChild(db); // LKG, board msb
    updateChild(db, childId, { goals: ['mr_letters', 'en_letters'] });
    const enrolments = () =>
      db.all<{ path_id: string; source: string }>(
        'SELECT path_id, source FROM path_enrollment WHERE child_id = ? ORDER BY path_id',
        [childId],
      );

    ensureEnrolment(db, getChild(db, childId)!);
    ensureEnrolment(db, getChild(db, childId)!); // idempotent
    expect(enrolments()).toEqual([
      { path_id: 'class_msb_LKG', source: 'class' },
      { path_id: 'skill_en_letters', source: 'skill' },
      { path_id: 'skill_mr_letters', source: 'skill' },
    ]);

    // Progress lives elsewhere and must survive a class or board change.
    db.run(
      `INSERT INTO lesson_position (id, child_id, template_id, version, position, created_at, updated_at)
       VALUES ('pos1', ?, 'tpl_kg_mr_swar_1', 1, '{}', 'x', 'x')`,
      [childId],
    );
    db.run(
      `INSERT INTO item_mastery (id, child_id, item_key, lang, state, interval_days, next_due, created_at, updated_at)
       VALUES ('m1', ?, 'mr:a', 'mr', 'mastered', 3, '2026-12-03', 'x', 'x')`,
      [childId],
    );

    updateChild(db, childId, { class: 'UKG', board: 'cbse', goals: ['en_letters'] });
    ensureEnrolment(db, getChild(db, childId)!);
    expect(enrolments()).toEqual([
      { path_id: 'class_cbse_UKG', source: 'class' },
      { path_id: 'skill_en_letters', source: 'skill' },
    ]);
    expect(db.get('SELECT template_id, position FROM lesson_position WHERE id = ?', ['pos1'])).toEqual({
      template_id: 'tpl_kg_mr_swar_1',
      position: '{}',
    });
    expect(db.get('SELECT state, interval_days, next_due FROM item_mastery WHERE id = ?', ['m1'])).toEqual({
      state: 'mastered',
      interval_days: 3,
      next_due: '2026-12-03',
    });
  });
});

// Contract for GURU-29 (queue screen: buildTodayQueue), GURU-30 (parent home: queue, assignments),
// GURU-35 (assign a lesson: assignLesson, queue) and GURU-36 (child profile: ensureEnrolment).
// Shape only, never values.
describe('contract: output for dependents', () => {
  it('exports ensureEnrolment(db, child), assignLesson(db, childId, templateId, date) and pure buildTodayQueue(input) -> {stops, goal, done, goalMet, waitingForDownload}', () => {
    expect(typeof ensureEnrolment).toBe('function');
    expect(ensureEnrolment.length).toBe(2);
    expect(typeof assignLesson).toBe('function');
    expect(assignLesson.length).toBe(4);
    expect(typeof buildTodayQueue).toBe('function');
    expect(buildTodayQueue.length).toBe(1);

    const q = queue(input({ paths: [path('class_p', 'tpl_mr_p1')], due: dueItems('mr', 5) }));
    expect(Array.isArray(q.stops)).toBe(true);
    expect(typeof q.goal).toBe('number');
    expect(typeof q.done).toBe('number');
    expect(typeof q.goalMet).toBe('boolean');
    expect(Array.isArray(q.waitingForDownload)).toBe(true);

    const lesson = q.stops.find((s) => s.kind === 'lesson') as LessonStop;
    expect(typeof lesson.template_id).toBe('string');
    expect(Array.isArray(lesson.revision)).toBe(true);
    const revision = q.stops.find((s) => s.kind === 'revision') as RevisionStop;
    expect(Array.isArray(revision.items)).toBe(true);
    expect(revision.items[0]).toEqual(expect.objectContaining({ item_key: expect.any(String), lang: expect.any(String) }));
  });
});
