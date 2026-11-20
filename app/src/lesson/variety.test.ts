// GURU-8: tutor variety as pure functions with an injected rng (wired into the engine by GURU-19).
// Contract: TDD 2.4 in the Epic GURU-1; PRD "Tutor variety"; confusable pairs from content/README.md.
//
// Shapes pinned here (the names are the contract for GURU-11 and GURU-19):
// - lines.ts:     FAMILIES: Record<family, minimum pool size>;
//                 pickLine(family, available, history, rng) -> { id, history }, history oldest first, at most 5.
// - praise.ts:    praiseFamily({ attempt, streak, previousMissed }) -> family; endFamily(missedAny) -> family.
// - quizOrder.ts: CONFUSABLE: [a, b][]; shuffleQuiz(displays, rng) -> displays;
//                 interleaveRevision(newIds, revisionIds, rng) -> ids.
// Real input read, not assumed: quiz `order` lists are the flow entries with phase 'quiz' in
// content/generated/lessons.json, naming items by `display` ('इ', 'B', ...).
import lessonsJson from '../content/generated/lessons.json';
import { FAMILIES, pickLine } from './lines';
import { endFamily, praiseFamily } from './praise';
import { CONFUSABLE, interleaveRevision, shuffleQuiz } from './quizOrder';

type Rng = () => number;

// Deterministic rng in [0, 1).
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (family: string, n: number) => Array.from({ length: n }, (_, i) => `${family}_${i + 1}`);
const sorted = (xs: readonly string[]) => [...xs].sort();

const quizOrders: string[][] = (lessonsJson as unknown as { flow: { phase?: string; order?: string[] }[] }[]).map(
  (l) => l.flow.find((f) => f.phase === 'quiz')!.order!,
);

// Brute-force reference for "an order with no confusable pair adjacent exists".
const confusable = (a: string, b: string) =>
  CONFUSABLE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const adjacentConfusable = (p: readonly string[]) => p.some((d, i) => i > 0 && confusable(p[i - 1], d));
function permutations(xs: string[]): string[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}
const solvable = (xs: string[]) => permutations(xs).some((p) => !adjacentConfusable(p));

describe('FAMILIES (TDD 2.4 minimum pool sizes)', () => {
  const min = FAMILIES as Record<string, number>;
  it('names every shared family with its minimum size; praise families total 15 or more', () => {
    const exact: Record<string, number> = {
      praise_first: 4,
      praise_hint: 4,
      praise_streak: 4,
      praise_comeback: 4,
      tryagain: 8,
      nohear: 8,
      ask: 8,
      intro: 3,
      bye: 3,
    };
    for (const [family, size] of Object.entries(exact)) expect([family, min[family]]).toEqual([family, size]);

    // Listed in TDD 2.4 with no number: the family must exist (at least one line).
    const present = ['end_all', 'end_misses', 'again', 'moveon', 'retry_intro', 'meaning_hi_ack', 'ask_mr',
      'surprise_line', 'ready', 'ask_grownup_model', 'ask_grownup_mic', 'ask_grownup_weak'];
    for (const family of present) {
      expect([family, Number.isInteger(min[family]) && min[family] >= 1]).toEqual([family, true]);
    }

    const praiseTotal = ['praise_first', 'praise_hint', 'praise_streak', 'praise_comeback']
      .reduce((sum, f) => sum + min[f], 0);
    expect(praiseTotal).toBeGreaterThanOrEqual(15);
  });
});

describe('pickLine', () => {
  it('never repeats an id within 5 picks over 1,000 seeded calls on a 15-line pool, keeping at most 5 in history', () => {
    const available = ids('praise_first', 15);
    for (const seed of [1, 2, 3]) {
      const rng = seeded(seed);
      const picks: string[] = [];
      let history: string[] = [];
      for (let n = 0; n < 1000; n++) {
        const res = pickLine('praise_first', available, history, rng);
        expect(available).toContain(res.id);
        expect(picks.slice(-5)).not.toContain(res.id);
        expect(res.history.length).toBeLessThanOrEqual(5);
        expect(res.history.at(-1)).toBe(res.id); // newest last
        picks.push(res.id);
        history = res.history;
      }
      expect(history).toEqual(picks.slice(-5));
    }
  });

  it('draws uniformly from the pool minus only the last 5 of a longer history, using the injected rng', () => {
    const available = ids('tryagain', 15);
    const history = available.slice(0, 7); // last 5 are tryagain_3 .. tryagain_7
    const seen = new Set<string>();
    const rng = seeded(42);
    for (let n = 0; n < 2000; n++) {
      const res = pickLine('tryagain', available, history, rng);
      seen.add(res.id);
      expect(res.history).toEqual([...history.slice(-4), res.id]);
    }
    expect(sorted([...seen])).toEqual(sorted([...available.slice(0, 2), ...available.slice(7)]));

    // Same seed, same picks.
    const run = (seed: number) => {
      const r = seeded(seed);
      return Array.from({ length: 20 }, () => pickLine('tryagain', available, [], r).id);
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it('excludes only the last pick when the pool has 5 or fewer lines, and returns the only line of a 1-line pool', () => {
    const available = ['bye_1', 'bye_2', 'bye_3'];
    const seen = new Set<string>();
    const rng = seeded(9);
    for (let n = 0; n < 500; n++) {
      const res = pickLine('bye', available, ['bye_1', 'bye_2'], rng);
      expect(res.id).not.toBe('bye_2');
      seen.add(res.id);
    }
    expect(sorted([...seen])).toEqual(['bye_1', 'bye_3']);

    const five = ids('intro', 5);
    const rng5 = seeded(10);
    let history: string[] = [];
    let prev: string | undefined;
    for (let n = 0; n < 500; n++) {
      const res = pickLine('intro', five, history, rng5);
      expect(res.id).not.toBe(prev);
      prev = res.id;
      history = res.history;
    }

    expect(pickLine('ready', ['ready_1'], ['ready_1'], seeded(1)).id).toBe('ready_1');
  });
});

describe('praiseFamily and endFamily (PRD Tutor variety 2)', () => {
  it.each([
    // comeback > after hint > streak > first try
    [{ attempt: 1, streak: 1, previousMissed: true }, 'praise_comeback'],
    [{ attempt: 1, streak: 3, previousMissed: true }, 'praise_comeback'],
    [{ attempt: 2, streak: 3, previousMissed: true }, 'praise_hint'], // comeback needs attempt 1
    [{ attempt: 2, streak: 1, previousMissed: false }, 'praise_hint'],
    [{ attempt: 2, streak: 6, previousMissed: false }, 'praise_hint'],
    [{ attempt: 1, streak: 3, previousMissed: false }, 'praise_streak'],
    [{ attempt: 1, streak: 6, previousMissed: false }, 'praise_streak'],
    [{ attempt: 1, streak: 9, previousMissed: false }, 'praise_streak'],
    [{ attempt: 1, streak: 1, previousMissed: false }, 'praise_first'],
    [{ attempt: 1, streak: 4, previousMissed: false }, 'praise_first'],
    [{ attempt: 1, streak: 0, previousMissed: false }, 'praise_first'], // streaks are 3, 6, 9 ...; 0 is not one
  ])('%o -> %s', (moment, family) => {
    expect(praiseFamily(moment)).toBe(family);
  });

  it('picks the closing family from whether any item was missed', () => {
    expect(endFamily(true)).toBe('end_misses');
    expect(endFamily(false)).toBe('end_all');
  });
});

describe('shuffleQuiz', () => {
  it('lists exactly the content/README.md confusable pairs', () => {
    const key = ([a, b]: readonly [string, string]) => [a, b].sort().join('/');
    const expected = [['इ', 'ई'], ['उ', 'ऊ'], ['B', 'D'], ['M', 'N'], ['P', 'T'], ['ए', 'ऐ'], ['ओ', 'औ'], ['क', 'ख'],
      ['ग', 'घ']] as [string, string][];
    expect(CONFUSABLE.map(key).sort()).toEqual(expected.map(key).sort());
  });

  it('returns a permutation with no confusable pair adjacent whenever such an order exists, without mutating input', () => {
    const inputs = [...quizOrders, ['इ', 'ई', 'अ'], ['ए', 'ऐ', 'ओ', 'औ'], ['B', 'D', 'M', 'N', 'P', 'T']];
    for (const displays of inputs) {
      expect(solvable(displays)).toBe(true);
      const copy = [...displays];
      for (let seed = 1; seed <= 100; seed++) {
        const out = shuffleQuiz(displays, seeded(seed));
        expect(sorted(out)).toEqual(sorted(displays));
        expect([out.join(' '), adjacentConfusable(out)]).toEqual([out.join(' '), false]);
      }
      expect(displays).toEqual(copy);
    }

    // No valid order exists: still a permutation, no throw.
    expect(sorted(shuffleQuiz(['B', 'D'], seeded(1)))).toEqual(['B', 'D']);
  });

  it('gives different orders for two different seeds of a 5-item lesson in at least 95 of 100 seed pairs', () => {
    const five = quizOrders.find((o) => o.length === 5 && o.includes('F'))!; // tpl_kg_en_letters_2
    expect(five).toHaveLength(5);
    let different = 0;
    for (let i = 0; i < 100; i++) {
      const a = shuffleQuiz(five, seeded(1000 + 2 * i)).join(' ');
      const b = shuffleQuiz(five, seeded(1001 + 2 * i)).join(' ');
      if (a !== b) different++;
    }
    expect(different).toBeGreaterThanOrEqual(95);
    expect(shuffleQuiz(five, seeded(5))).toEqual(shuffleQuiz(five, seeded(5)));
  });
});

describe('interleaveRevision', () => {
  const isRev = (id: string) => id.startsWith('r');

  // Not first; no two revision items adjacent while new items remain after them.
  function checkPlacement(out: string[]) {
    expect(isRev(out[0])).toBe(false);
    out.forEach((id, i) => {
      if (i > 0 && isRev(id) && isRev(out[i - 1])) {
        expect([out.join(' '), out.slice(i + 1).some((x) => !isRev(x))]).toEqual([out.join(' '), false]);
      }
    });
  }

  it('places revision items between new items, keeps every item and the order of new items, and varies with the rng', () => {
    const cases: [string[], string[]][] = [
      [['n1', 'n2', 'n3', 'n4', 'n5'], ['r1', 'r2']],
      [['n1', 'n2', 'n3'], ['r1', 'r2']],
      [['n1', 'n2'], ['r1', 'r2', 'r3', 'r4']],
      [['n1', 'n2', 'n3'], []],
    ];
    for (const [newIds, revisionIds] of cases) {
      for (let seed = 1; seed <= 50; seed++) {
        const out = interleaveRevision(newIds, revisionIds, seeded(seed));
        expect(sorted(out)).toEqual(sorted([...newIds, ...revisionIds]));
        expect(out.filter((x) => !isRev(x))).toEqual(newIds); // shuffleQuiz's order survives
        checkPlacement(out);
        // Enough gaps between new items: every revision item sits between two of them.
        if (revisionIds.length > 0 && revisionIds.length < newIds.length) expect(isRev(out.at(-1)!)).toBe(false);
      }
    }

    const placements = new Set(
      Array.from({ length: 50 }, (_, s) => interleaveRevision(cases[0][0], cases[0][1], seeded(s + 1)).join(' ')),
    );
    expect(placements.size).toBeGreaterThan(1);

    // Only revision due: all kept.
    expect(sorted(interleaveRevision([], ['r1', 'r2'], seeded(1)))).toEqual(['r1', 'r2']);
  });
});

describe('contract for dependents (GURU-11, GURU-19)', () => {
  it('exports FAMILIES, pickLine, praiseFamily, shuffleQuiz and interleaveRevision with the promised shapes', () => {
    // GURU-11 (content validator): family name -> minimum size.
    expect(typeof FAMILIES).toBe('object');
    expect(Object.keys(FAMILIES).length).toBeGreaterThan(0);
    for (const v of Object.values(FAMILIES)) expect(typeof v).toBe('number');

    // GURU-19 (engine wiring).
    expect(typeof pickLine).toBe('function');
    expect(pickLine).toHaveLength(4);
    const picked = pickLine('ask', ['ask_1', 'ask_2'], [], () => 0);
    expect(typeof picked.id).toBe('string');
    expect(Array.isArray(picked.history)).toBe(true);

    expect(typeof praiseFamily).toBe('function');
    expect(praiseFamily).toHaveLength(1);
    expect(typeof praiseFamily({ attempt: 1, streak: 1, previousMissed: false })).toBe('string');

    expect(typeof shuffleQuiz).toBe('function');
    expect(shuffleQuiz).toHaveLength(2);
    expect(Array.isArray(shuffleQuiz(['A', 'C'], () => 0))).toBe(true);

    expect(typeof interleaveRevision).toBe('function');
    expect(interleaveRevision).toHaveLength(3);
    expect(Array.isArray(interleaveRevision(['n1'], ['r1'], () => 0))).toBe(true);
  });
});
