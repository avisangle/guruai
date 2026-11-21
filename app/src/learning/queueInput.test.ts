// Integration of level 3: readQueueInput (GURU-29) meets GURU-21's positions and GURU-20's enrolment.
import type { Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, getChild, updateChild } from '../data/profiles';
import { createTestDb } from '../data/testDb';
import lessonsJson from '../content/generated/lessons.json';
import { newPosition } from '../lesson/engine';
import type { Lesson } from '../lesson/types';
import { ensureEnrolment } from './enrol';
import { savePosition } from './positions';
import { readQueueInput } from './queueInput';

jest.mock('expo-crypto', () => {
  const nodeCrypto = jest.requireActual('crypto');
  let calls = 0;
  return {
    randomUUID: jest.fn(() => `uuid-${++calls}`),
    getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
  };
});

const TODAY = '2026-11-21';
const lesson = (id: string) => (lessonsJson as unknown as Lesson[]).find((l) => l.template_id === id)!;
const started = (id: string) => ({ ...newPosition(lesson(id)), flow: 1 });

function setup() {
  const db: Db = createTestDb();
  migrate(db);
  const child = createChild(db, { nickname: 'Ira', picture: 'squirrel', class: 'UKG', medium: 'mr' });
  return { db, child };
}

const read = (db: Db, childId: string) => readQueueInput(db, getChild(db, childId)!, TODAY, () => true);

describe('readQueueInput', () => {
  it('counts as in progress only a resumable position: current version and not finished', () => {
    const { db, child } = setup();
    const finished = lesson('tpl_kg_mr_swar_1');
    savePosition(db, child.id, finished.template_id, { ...newPosition(finished), flow: finished.flow.length });
    savePosition(db, child.id, 'tpl_kg_mr_swar_2', { ...started('tpl_kg_mr_swar_2'), version: -1 }); // an older version
    savePosition(db, child.id, 'tpl_kg_en_letters_1', started('tpl_kg_en_letters_1'));
    expect(read(db, child.id).inProgress).toEqual(['tpl_kg_en_letters_1']);
  });

  it('lists the class path first, also after a class change re-enrols it', () => {
    const { db, child } = setup();
    ensureEnrolment(db, updateChild(db, child.id, { goals: ['mr_letters'] })!);
    ensureEnrolment(db, updateChild(db, child.id, { class: 'LKG' })!);
    const board = getChild(db, child.id)!.board;
    expect(read(db, child.id).paths.map((p) => p.path_id)).toEqual([`class_${board}_LKG`, 'skill_mr_letters']);
  });
});
