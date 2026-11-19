// Judges one recorded answer with the on-device model, against every answer of the lesson
// (closed set, as tools/stt_bench indicconformer_closed). Lesson answers are tokenised ahead of
// time by tools/stt_bench/asr_tokens.py into generated/mr-tokens.json.
import { File } from 'expo-file-system';

import GuruAsr from '../../modules/guru-asr';
import type { Item } from '../lesson/types';
import type { LogProbs } from './ctc';
import tokensJson from './generated/mr-tokens.json';
import { decide, isSilent, type Candidate } from './judge';
import { ensureModel } from './model';
import { normalise } from './normalise';
import { parseWav } from './wav';

const TOKENS = tokensJson.tokens as Record<string, number[]>;
export const PIECES = tokensJson.pieces;
const VOCAB = 257;

export type Verdict = 'correct' | 'wrong' | 'unclear';
export type ClipJudge = { choice: string; verdict: Verdict; free: string; note: string; ms: number; error?: string };

/** Every answer of every item, in lesson order, each text once (Lesson.candidates() in the bench). */
export function lessonCandidates(items: Item[]): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const it of items) {
    for (const text of [...it.assessment.expected, ...it.assessment.accepted_variants]) {
      if (out.has(text)) continue;
      const ids = TOKENS[text];
      if (!ids) throw new Error(`no tokens for "${text}": run tools/stt_bench/asr_tokens.py`);
      out.set(text, { item_id: it.id, display: it.display, text, ids });
    }
  }
  return [...out.values()];
}

/**
 * evaluate_choice() in tools/stt_bench/evaluator.py: the chosen letter against the asked item.
 * unsure (faint audio): a wrong verdict becomes unclear, so the child is asked again, not told "wrong".
 */
export function verdictFor(item: Item, choice: string, unsure = false): Verdict {
  if (choice === 'nothing') return 'unclear';
  if (choice === item.display) return 'correct'; // English: the card shows "B", the answers are "बी", "बी फॉर बॉल"
  const verdict = choice === 'other' ? 'wrong' : judgeText(item, choice);
  return unsure && verdict === 'wrong' ? 'unclear' : verdict;
}

function judgeText(item: Item, choice: string): Verdict {
  const { expected, accepted_variants, also_correct = [] } = item.assessment;
  const accepted = new Set([...expected, ...accepted_variants, ...also_correct].map(normalise));
  const said = normalise(choice);
  return !said ? 'unclear' : accepted.has(said) ? 'correct' : 'wrong';
}

/** Judges a 16 kHz mono WAV clip; never throws (errors come back in the result). */
export async function judgeClip(uri: string, item: Item, items: Item[]): Promise<ClipJudge> {
  const t0 = Date.now();
  try {
    const { pcm, samples } = parseWav(new Uint8Array(await new File(uri).arrayBuffer()));
    const candidates = lessonCandidates(items);
    let lp: LogProbs = { data: new Float32Array(0), frames: 0, vocab: VOCAB };
    if (!isSilent(samples)) {
      await ensureModel();
      const data = new Float32Array((await GuruAsr!.run(pcm)).slice().buffer); // copy: alignment; ensureModel checked GuruAsr
      lp = { data, frames: data.length / VOCAB, vocab: VOCAB };
    }
    const j = decide(lp, samples, candidates, PIECES);
    return { choice: j.choice, verdict: verdictFor(item, j.choice, j.unsure), free: j.free, note: j.note, ms: Date.now() - t0 };
  } catch (e) {
    return { choice: '', verdict: 'unclear', free: '', note: '', ms: Date.now() - t0, error: String(e) };
  }
}
