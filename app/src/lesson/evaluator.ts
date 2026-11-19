// Judges what the child said. Speech-to-text will feed transcripts here;
// the engine only ever sees the resulting Answer.
import type { Answer, Item, ListenKind } from './types';

export type Verdict = 'correct' | 'wrong' | 'unclear';

export type Evaluator = { evaluate(item: Item, transcript: string): Verdict };

const norm = (s: string) => s.normalize('NFC').replace(/[\s.,!?।]+/g, ' ').trim();

// Stub: exact match against the item's expected answers, variants and also_correct.
export const exactEvaluator: Evaluator = {
  evaluate(item, transcript) {
    const said = norm(transcript);
    if (!said) return 'unclear';
    const { expected, accepted_variants, also_correct = [] } = item.assessment;
    const accepted = [...expected, ...accepted_variants, ...also_correct].map(norm);
    return accepted.includes(said) ? 'correct' : 'wrong';
  },
};

// Unclear speech is treated like silence: the tutor asks again.
// In a teach turn any speech passes (rules.teach_response).
export function toAnswer(verdict: Verdict, kind: ListenKind): Answer {
  if (verdict === 'unclear') return 'silent';
  return kind === 'teach' ? 'correct' : verdict;
}
