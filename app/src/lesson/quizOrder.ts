// Quiz order: shuffled, confusable letters never back to back, revision mixed in.

// content/README.md: letters a child easily confuses.
export const CONFUSABLE: readonly (readonly [string, string])[] = [
  ['इ', 'ई'],
  ['उ', 'ऊ'],
  ['B', 'D'],
  ['M', 'N'],
  ['P', 'T'],
  ['ए', 'ऐ'],
  ['ओ', 'औ'],
  ['क', 'ख'],
  ['ग', 'घ'],
];

const SHUFFLE_TRIES = 50;

const isConfusable = (a: string, b: string) =>
  CONFUSABLE.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

function fisherYates<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A random permutation with no confusable pair adjacent. When none turns up in
// SHUFFLE_TRIES shuffles, builds one greedily; if no valid order exists the
// result is still a permutation.
export function shuffleQuiz(displays: string[], rng: () => number): string[] {
  for (let t = 0; t < SHUFFLE_TRIES; t++) {
    const p = fisherYates(displays, rng);
    if (!p.some((d, i) => i > 0 && isConfusable(p[i - 1], d))) return p;
  }
  const left = [...displays];
  const out: string[] = [];
  while (left.length > 0) {
    const prev = out.at(-1);
    const ok = left.filter((d) => prev === undefined || !isConfusable(prev, d));
    const from = ok.length > 0 ? ok : left;
    const pick = from[Math.floor(rng() * from.length)];
    left.splice(left.indexOf(pick), 1);
    out.push(pick);
  }
  return out;
}

// Puts each revision item in its own random gap between two new items, keeping
// both orders. Revision items beyond the gaps go at the end.
export function interleaveRevision(newIds: string[], revisionIds: string[], rng: () => number): string[] {
  const gaps = Math.max(newIds.length - 1, 0);
  const chosen = new Set(fisherYates([...Array(gaps).keys()], rng).slice(0, revisionIds.length));
  const out: string[] = [];
  let k = 0;
  newIds.forEach((id, i) => {
    out.push(id);
    if (chosen.has(i)) out.push(revisionIds[k++]);
  });
  return [...out, ...revisionIds.slice(k)];
}
