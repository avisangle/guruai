// The live adapter's packsForChild meets GURU-16's catalogue: the child's paths (enrolment rule),
// their lessons' `lessonPack`, minus lessons whose audio ships in the app.
import { packId } from '../content/packs';
import type { ChildProfile } from '../data/types';
import { packsForChild } from './live';

const child = (cls: string, goals: string[] = []) => ({ board: 'cbse', class: cls, goals, tutor: 'shekru' }) as unknown as ChildProfile;
// The manifest's id for the kg pack, which packJobs() matches against.
const KG = packId('shekru', 'kg');
const STARTER = ['tpl_kg_mr_swar_1', 'tpl_kg_en_letters_1'];

describe('packsForChild', () => {
  it('queues nothing for a child whose path lessons are all in the starter pack', () => {
    expect(packsForChild(child('Class1'))).toEqual([]);
  });

  it('queues the kg pack for a UKG child with en_letters', () => {
    expect(packsForChild(child('UKG', ['en_letters']))).toEqual([KG]);
  });

  it("names each pack of the child's not-bundled lessons once", () => {
    expect(packsForChild(child('UKG', ['en_letters']), STARTER)).toEqual([KG]);
  });

  it('skips a skill path the catalogue lacks and a class path with no lessons yet', () => {
    expect(packsForChild(child('Class1', ['nope']), STARTER)).toEqual([]);
  });

  it('includes skill path lessons outside the class path', () => {
    expect(packsForChild(child('Class1', ['en_letters']), STARTER)).toEqual([KG]);
  });
});
