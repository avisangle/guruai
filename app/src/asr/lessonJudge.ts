// Judges one recorded answer with the on-device model, against every answer of the lesson
// (closed set, as tools/stt_bench indicconformer_closed). Lesson answers are tokenised ahead of
// time by tools/stt_bench/asr_tokens.py into generated/mr-tokens.json.
import { File } from 'expo-file-system';

import GuruAsr from '../../modules/guru-asr';
import type { Heard, Item, Lang, Listen } from '../lesson/types';
import type { LogProbs } from './ctc';
import tokensJson from './generated/mr-tokens.json';
import { childSwaps, decide, isSilent, type Candidate, type Judgement } from './judge';
import { ensureModel } from './model';
import { normalise } from './normalise';
import { parseWav } from './wav';

const TOKENS = tokensJson.tokens as Record<string, number[]>;
export const PIECES = tokensJson.pieces;
const VOCAB = 257;

export type Verdict = 'correct' | 'wrong' | 'unclear';
// verdict: heard as the bench scores it (a meaning is one of the item's accepted answers, so correct).
export type ClipJudge = { choice: string; verdict: Verdict; heard: Heard; free: string; note: string; ms: number; error?: string };

const VERDICT: Record<Heard['kind'], Verdict> = { correct: 'correct', meaning: 'correct', wrong: 'wrong', silent: 'unclear' };

/** An answer's languages: langs[text], else the item's target language (D-GURU-2-answer-language-tags). */
const langsOf = (item: Item, text: string): Lang[] => item.assessment.langs?.[text] ?? [item.target_lang];

/**
 * Every answer of every item, in lesson order, each text once with every item and language tag; then
 * their child sound swaps (childSwaps), each with its own token ids.
 */
export function lessonCandidates(items: Item[]): Candidate[] {
  const out = new Map<string, Omit<Candidate, 'ids'>>();
  for (const it of items) {
    for (const text of new Set([...it.assessment.expected, ...it.assessment.accepted_variants])) {
      const tags = langsOf(it, text).map((lang) => ({ item_id: it.id, display: it.display, lang }));
      const seen = out.get(text);
      if (seen) seen.tags.push(...tags);
      else out.set(text, { item_id: it.id, display: it.display, text, tags });
    }
  }
  return childSwaps([...out.values()]).map((c) => {
    const ids = TOKENS[c.text];
    if (!ids) throw new Error(`no tokens for "${c.text}": run tools/stt_bench/asr_tokens.py`);
    return { ...c, ids };
  });
}

/**
 * The judge's choice against the asked item, as Heard (TDD 2.2). The judge only classifies; the engine
 * applies the language rules (D-GURU-10-language-design). unsure (faint audio): anything but correct is
 * silent, so the child is asked again, not told "wrong" (D-STT-unsure-not-wrong).
 */
export function classify(item: Item, judgement: Judgement, unsure: boolean): Heard {
  const { choice, text } = judgement;
  if (choice === 'nothing') return { kind: 'silent', by: 'shekru' };
  const heard = match(item, choice, text);
  return unsure && heard.kind !== 'correct' ? { kind: 'silent', by: 'shekru', unsure: true } : heard;
}

function match(item: Item, choice: string, text: string | undefined): Heard {
  // English: the card shows "B", the answers are "बी", "बी फॉर बॉल"
  if (!text) return { kind: choice === item.display ? 'correct' : 'wrong', by: 'shekru' };
  const { expected, accepted_variants, also_correct = [] } = item.assessment;
  const correct: Heard = { kind: 'correct', by: 'shekru', text, lang: item.target_lang };
  const said = normalise(text);
  const answers = [...expected, ...accepted_variants];
  // An answer said as itself, else with a child sound swap (D-GURU-3-child-sound-swaps).
  const own =
    answers.find((a) => normalise(a) === said) ??
    answers.find((a) => childSwaps([{ text: a }]).some((s) => normalise(s.text) === said));
  if (own) {
    const langs = langsOf(item, own);
    return langs.includes(item.target_lang) ? correct : { kind: 'meaning', by: 'shekru', text, lang: langs[0] };
  }
  if (also_correct.some((a) => normalise(a) === said) || choice === item.display) return correct; // D-STT-lenient-vowel-length
  return { kind: 'wrong', by: 'shekru', text };
}

/**
 * A quiz listen drops the candidates Shekru just said (whole words of the prompt), so a child echoing the
 * hint word is not praised. Teach listens (repeat after me) keep them all.
 */
function listenCandidates(listen: Listen, items: Item[]): Candidate[] {
  const candidates = lessonCandidates(items);
  if (listen.kind !== 'quiz') return candidates;
  const prompt = ` ${normalise(listen.prompt)} `;
  return candidates.filter((c) => !prompt.includes(` ${normalise(c.text)} `));
}

/** Judges a 16 kHz mono WAV clip; never throws (errors come back in the result). */
export async function judgeClip(uri: string, listen: Listen, items: Item[]): Promise<ClipJudge> {
  const t0 = Date.now();
  try {
    const { pcm, samples } = parseWav(new Uint8Array(await new File(uri).arrayBuffer()));
    const candidates = listenCandidates(listen, items);
    let lp: LogProbs = { data: new Float32Array(0), frames: 0, vocab: VOCAB };
    if (!isSilent(samples)) {
      await ensureModel();
      const data = new Float32Array((await GuruAsr!.run(pcm)).slice().buffer); // copy: alignment; ensureModel checked GuruAsr
      lp = { data, frames: data.length / VOCAB, vocab: VOCAB };
    }
    const j = decide(lp, samples, candidates, PIECES);
    const heard = classify(listen.item, j, j.unsure);
    return { choice: j.choice, verdict: VERDICT[heard.kind], heard, free: j.free, note: j.note, ms: Date.now() - t0 };
  } catch (e) {
    return { choice: '', verdict: 'unclear', heard: { kind: 'silent', by: 'shekru' }, free: '', note: '', ms: Date.now() - t0, error: String(e) };
  }
}
