// The live adapter's packsForChild meets GURU-16's catalogue: the child's paths (enrolment rule),
// their lessons' `lessonPack`, minus lessons whose audio ships in the app.
import type { ChildProfile } from '../data/types';
import { packsForChild } from './live';

const child = (cls: string, goals: string[] = []) => ({ board: 'cbse', class: cls, goals }) as unknown as ChildProfile;
const STARTER = ['tpl_kg_mr_swar_1', 'tpl_kg_en_letters_1'];

describe('packsForChild', () => {
  it('queues nothing while every generated lesson is bundled', () => {
    expect(packsForChild(child('UKG', ['en_letters']))).toEqual([]);
  });

  it("names each pack of the child's not-bundled lessons once", () => {
    expect(packsForChild(child('UKG', ['en_letters']), STARTER)).toEqual(['kg']);
  });

  it('skips a skill path the catalogue lacks and a class path with no lessons yet', () => {
    expect(packsForChild(child('Class1', ['nope']), STARTER)).toEqual([]);
  });

  it('includes skill path lessons outside the class path', () => {
    expect(packsForChild(child('Class1', ['en_letters']), STARTER)).toEqual(['kg']);
  });
});
