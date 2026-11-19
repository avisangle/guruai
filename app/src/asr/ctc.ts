// CTC helpers over a (frames x V) row-major log-prob matrix, blank in the last column.
// Same results as torch: greedy decode and F.ctc_loss (negated) in providers/indicconformer.py.
export type LogProbs = { data: Float32Array; frames: number; vocab: number };

export const blankOf = (lp: LogProbs) => lp.vocab - 1;

export function greedy(lp: LogProbs): number[] {
  const { data, frames, vocab } = lp;
  const blank = blankOf(lp);
  const ids: number[] = [];
  let prev = -1;
  for (let t = 0; t < frames; t++) {
    let best = 0;
    for (let k = 1; k < vocab; k++) if (data[t * vocab + k] > data[t * vocab + best]) best = k;
    if (best !== prev && best !== blank) ids.push(best);
    prev = best;
  }
  return ids;
}

const logAdd = (a: number, b: number) => {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log1p(Math.exp(-Math.abs(a - b)));
};

/** Total log-likelihood of one token sequence over all CTC alignments (forward algorithm). */
export function ctcLogLikelihood(lp: LogProbs, ids: number[]): number {
  return ctcRepeatLogLikelihoods(lp, ids, 1)[0];
}

/**
 * Log-likelihoods of ids said 1..times in a row, from one forward pass over ids repeated `times`:
 * the forward value where repeat k ends is exactly the likelihood of ids repeated k times.
 */
export function ctcRepeatLogLikelihoods(lp: LogProbs, ids: number[], times: number): number[] {
  const { data, frames, vocab } = lp;
  const blank = blankOf(lp);
  const ext = [blank];
  for (let k = 0; k < times; k++) for (const id of ids) ext.push(id, blank);
  const S = ext.length;
  let alpha = new Float64Array(S).fill(-Infinity);
  let next = new Float64Array(S);
  alpha[0] = data[blank];
  if (S > 1) alpha[1] = data[ext[1]];
  for (let t = 1; t < frames; t++) {
    const row = t * vocab;
    for (let s = 0; s < S; s++) {
      let a = alpha[s];
      if (s >= 1) a = logAdd(a, alpha[s - 1]);
      if (s >= 2 && ext[s] !== blank && ext[s] !== ext[s - 2]) a = logAdd(a, alpha[s - 2]);
      next[s] = a === -Infinity ? a : a + data[row + ext[s]];
    }
    [alpha, next] = [next, alpha];
  }
  if (!ids.length) return Array(times).fill(alpha[0]);
  return Array.from({ length: times }, (_, k) => logAdd(alpha[2 * ids.length * (k + 1)], alpha[2 * ids.length * (k + 1) - 1]));
}

/** sentencepiece decode: join pieces, drop the text's leading "▁", other "▁" are spaces, <unk> is " ⁇ ". */
export function decode(ids: number[], pieces: string[]): string {
  return ids
    .map((k) => (pieces[k] === '<unk>' ? ' ⁇ ' : pieces[k]))
    .join('')
    .replace(/^▁/, '')
    .replace(/▁/g, ' ');
}
