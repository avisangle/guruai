// Closed-set judge: port of decide() in tools/stt_bench/providers/indicconformer.py (without the
// opt-in vowel-length feature). Picks one lesson candidate, "other" or "nothing" from CTC log-probs.
import { ctcLogLikelihood, ctcRepeatLogLikelihoods, decode, greedy, type LogProbs } from './ctc';
import type { Lang } from '../lesson/types';
import { normalise } from './normalise';

// Same constants as the Python judge (D-STT-other-margin for the margin; the rest uncalibrated, pending.md).
export const SPEECH_DBFS = -40;
export const MIN_SPEECH_S = 0.08;
export const OTHER_MARGIN_PER_TOKEN = 3.0;
// An answer said up to this many times in a row ("डी फॉर डॉग डी फॉर डॉग") counts as said once.
export const REPEATS = 3;
// The free decode scores below this per token: the model is unsure what it heard (faint audio), so a wrong
// verdict becomes unclear (D-STT-unsure-not-wrong).
export const UNSURE_PER_TOKEN = -10;
// "<letter> for <any word>" ("ए फॉर एरोप्लेन"): the letter decides, the word is ignored (D-STT-letter-for-any-word).
const FOR_WORDS = new Set(['फॉर', 'फोर', 'फर']); // how the model writes "for"

// Who an answer text belongs to and in which language. A text shared by items or languages carries every tag.
export type Tag = { item_id: string; display: string; lang: Lang };
// item_id and display are the first tag's: they decide choice, as in the Python judge.
export type Candidate = { item_id: string; display: string; text: string; ids: number[]; tags: Tag[] };
export type Judgement = {
  choice: string; // a candidate's display letter, "other" or "nothing"
  text?: string; // the chosen candidate's text; absent for "other" and "nothing"
  scores: Record<string, number>; // candidate text -> CTC log-likelihood
  free: string; // greedy decode
  note: string;
  unsure: boolean; // the model is unsure what it heard: never tell the child "wrong"
};

/** Per-frame energy in dB (25 ms window, 10 ms hop), as frame_db() in Python. */
export function frameDb(wav: Float32Array, win = 400, hop = 160): Float64Array {
  const len = Math.max(wav.length, win);
  const n = 1 + Math.floor((len - win) / hop);
  const out = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * hop; i < f * hop + win; i++) sum += i < wav.length ? wav[i] * wav[i] : 0;
    out[f] = 10 * Math.log10(sum / win + 1e-12);
  }
  return out;
}

/** Seconds of the clip louder than SPEECH_DBFS. Below MIN_SPEECH_S the model need not run. */
export function soundingSeconds(wav: Float32Array): number {
  return frameDb(wav).reduce((n, db) => n + (db > SPEECH_DBFS ? 1 : 0), 0) * 0.01;
}

export const isSilent = (wav: Float32Array) => soundingSeconds(wav) < MIN_SPEECH_S;

/** Index of the first "for" word after the first word (a piece starting "▁" begins a word), or -1. */
export function splitAtFor(ids: number[], pieces: string[]): number {
  const starts = ids.flatMap((k, i) => (pieces[k].startsWith('▁') ? [i] : []));
  starts.push(ids.length);
  for (let w = 0; w + 1 < starts.length; w++) {
    const [a, b] = [starts[w], starts[w + 1]];
    if (a > 0 && FOR_WORDS.has(ids.slice(a, b).map((k) => pieces[k]).join('').replace(/^▁+/, ''))) return a;
  }
  return -1;
}

/**
 * Best letter name followed by the free decode's own "for <word>" tail, with its margin per token of the
 * name (said once or repeated). Null when the free decode has no "for" or the lesson no "<name> फॉर" answers.
 */
function anyWord(lp: LogProbs, freeIds: number[], freeLl: number, candidates: Candidate[], pieces: string[]) {
  const k = splitAtFor(freeIds, pieces);
  const names = candidates.filter((c) => candidates.some((o) => o.item_id === c.item_id && o.text.startsWith(`${c.text} फॉर `)));
  if (k < 0 || !names.length) return null;
  const tail = freeIds.slice(k);
  let best = names[0];
  let bestLl = -Infinity;
  for (const c of names) {
    const ll = ctcLogLikelihood(lp, [...c.ids, ...tail]);
    if (ll > bestLl) [best, bestLl] = [c, ll]; // first maximum, as Python max()
  }
  let margin = Infinity;
  for (let r = 1; r <= REPEATS; r++) {
    const ids = [...Array.from({ length: r }, () => best.ids).flat(), ...tail];
    margin = Math.min(margin, (freeLl - ctcLogLikelihood(lp, ids)) / Math.max(1, best.ids.length * r));
  }
  return { best, margin };
}

export function decide(lp: LogProbs, wav: Float32Array, candidates: Candidate[], pieces: string[]): Judgement {
  const sounding = soundingSeconds(wav);
  if (sounding < MIN_SPEECH_S) return { choice: 'nothing', scores: {}, free: '', note: `sound=${sounding.toFixed(2)}s`, unsure: false };
  const tokens = new Map<string, number[]>();
  for (const c of candidates) if (!tokens.has(c.text)) tokens.set(c.text, c.ids);
  const scores: Record<string, number> = {};
  for (const [text, ids] of tokens) scores[text] = ctcLogLikelihood(lp, ids);
  const freeIds = greedy(lp);
  const free = decode(freeIds, pieces);
  const freeLl = ctcLogLikelihood(lp, freeIds);
  let best = candidates[0];
  for (const c of candidates) if (scores[c.text] > scores[best.text]) best = c; // first maximum, as Python max()
  // The closest answer, said once or repeated: whichever is nearest the free decode per token.
  const ids = tokens.get(best.text)!;
  const margin = Math.min(...ctcRepeatLogLikelihoods(lp, ids, REPEATS).map((ll, k) => (freeLl - ll) / Math.max(1, ids.length * (k + 1))));
  const unsure = freeLl / Math.max(1, freeIds.length) < UNSURE_PER_TOKEN;
  const note = `free=${JSON.stringify(free)} free_ll=${freeLl.toFixed(2)} best=${JSON.stringify(best.text)} margin/token=${margin.toFixed(2)}${unsure ? ' unsure' : ''}`;
  const byAnswer = new Map<string, Candidate>(); // later texts win, as the Python dict
  for (let k = 1; k <= REPEATS; k++) for (const c of candidates) byAnswer.set(normalise(Array(k).fill(c.text).join(' ')), c);
  const same = byAnswer.get(normalise(free));
  if (same) return { choice: same.display, text: same.text, scores, free, note, unsure };
  if (margin > OTHER_MARGIN_PER_TOKEN) {
    const hit = anyWord(lp, freeIds, freeLl, candidates, pieces);
    const tagged = hit ? `${note} any_word=${JSON.stringify(hit.best.text)}:${hit.margin.toFixed(2)}` : note;
    if (!hit || hit.margin > OTHER_MARGIN_PER_TOKEN) return { choice: freeIds.length ? 'other' : 'nothing', scores, free, note: tagged, unsure };
    return { choice: hit.best.display, text: hit.best.text, scores, free, note: tagged, unsure };
  }
  return { choice: best.display, text: best.text, scores, free, note, unsure };
}
