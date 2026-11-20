// The TypeScript judge must match the Python bench judge (golden data from tools/stt_bench/phone_golden.py).
import { readFileSync } from 'fs';
import { join } from 'path';

import golden from './__fixtures__/golden.json';
import lessonsJson from '../content/generated/lessons.json';
import type { Item, Lesson } from '../lesson/types';
import { ctcLogLikelihood, ctcRepeatLogLikelihoods, decode, greedy, type LogProbs } from './ctc';
import tokensJson from './generated/mr-tokens.json';
import { childSwaps, decide, type Judgement } from './judge';
import { classify, lessonCandidates } from './lessonJudge';
import { normalise } from './normalise';
import { parseWav } from './wav';

jest.mock('../../modules/guru-asr', () => ({}));
jest.mock('./model', () => ({}));
jest.mock('expo-file-system', () => ({}));
// GURU-3 golden format: golden.json `tokens` maps every text the Python judge scored (lesson answers and their
// swaps) to its ids; `candidates` stay the lesson answers; each case has `text` (chosen text, or null).
// The golden lesson's texts are not all real lesson answers, so their ids are added; real lesson ids win.
jest.mock('./generated/mr-tokens.json', () => {
  const real = jest.requireActual('./generated/mr-tokens.json');
  const { tokens = {} } = jest.requireActual('./__fixtures__/golden.json');
  return { ...real, tokens: { ...tokens, ...real.tokens } };
});

const sine = (level: number) => Float32Array.from({ length: 16000 }, (_, i) => level * Math.sin((2 * Math.PI * 220 * i) / 16000));
const REAL_TOKENS = jest.requireActual<typeof tokensJson>('./generated/mr-tokens.json').tokens as Record<string, number[]>;

type GoldenCase = (typeof golden.cases)[number] & { text?: string | null };
const goldenCases = golden.cases as GoldenCase[];
// The golden lesson as the app builds it: one item per Python candidate, in Python's order.
const goldenItems = golden.candidates.map(
  (c) => ({ id: c.item_id, display: c.display, kind: 'letter', target_lang: 'mr',
    assessment: { mode: 'say_letter', expected: [c.text], accepted_variants: [] } }) as unknown as Item,
);

const lessons = lessonsJson as unknown as Lesson[];
const swar1 = lessons.find((l) => l.template_id === 'tpl_kg_mr_swar_1')!; // अ to ऊ
const mr = (id: string) => swar1.items.find((i) => i.id === id)!;
const answersOf = (it: Item) => [...it.assessment.expected, ...it.assessment.accepted_variants];

describe('port of the Python judge', () => {
  it.each(golden.normalise)('normalise($in)', ({ in: input, out }) => {
    expect(normalise(input)).toBe(out);
  });

  it.each(golden.decode)('decodes $ids like sentencepiece', ({ ids, text }) => {
    expect(decode(ids, golden.pieces)).toBe(text);
  });

  // Candidates come from lessonCandidates(), so the app's swaps are checked against the bench's (swaps on).
  describe.each(goldenCases)('$label', (c) => {
    const lp: LogProbs = { data: Float32Array.from(c.logp), frames: c.frames, vocab: 257 };
    const cands = () => lessonCandidates(goldenItems);

    it('scores every candidate the bench scored, like torch ctc_loss', () => {
      const { scores } = decide(lp, sine(c.level), cands(), golden.pieces);
      expect(Object.keys(scores).sort()).toEqual(Object.keys(c.scores).sort());
      for (const [text, score] of Object.entries(c.scores)) expect(scores[text]).toBeCloseTo(score, 2);
    });

    it('makes the same choice, text and free decode', () => {
      const j = decide(lp, sine(c.level), cands(), golden.pieces);
      expect(c).toHaveProperty('text');
      expect(j.choice).toBe(c.choice);
      expect(j.text ?? null).toBe(c.text ?? null);
      expect(j.unsure).toBe(c.unsure);
      if (c.choice !== 'nothing') expect(j.free).toBe(c.free);
    });
  });

  it('goldens include a case whose choice is a child sound swap, not a lesson answer', () => {
    const lessonTexts = new Set(golden.candidates.map((c) => c.text));
    expect(goldenCases.some((c) => typeof c.text === 'string' && !lessonTexts.has(c.text))).toBe(true);
  });

  it('scores an answer said 1, 2 and 3 times in one pass, as three separate passes', () => {
    const c = golden.cases[0];
    const lp: LogProbs = { data: Float32Array.from(c.logp), frames: c.frames, vocab: 257 };
    for (const ids of [[5], [5, 5], [5, 9, 12]]) {
      const one = ctcRepeatLogLikelihoods(lp, ids, 3);
      [1, 2, 3].forEach((k, i) => expect(one[i]).toBeCloseTo(ctcLogLikelihood(lp, Array(k).fill(ids).flat()), 6));
    }
  });

  it('greedy collapses repeats and drops blanks', () => {
    const frames = [5, 5, 256, 5, 7, 7, 256];
    const data = new Float32Array(frames.length * 257).fill(-10);
    frames.forEach((k, t) => (data[t * 257 + k] = 0));
    expect(greedy({ data, frames: frames.length, vocab: 257 })).toEqual([5, 5, 7]);
  });
});

// GURU-3 (D-GURU-3-child-sound-swaps): a 4-year-old says "उंदराचा" as "उनलासा" (र to ल, word-final चा to सा).
describe('childSwaps', () => {
  const cand = (item_id: string, text: string) => ({ item_id, display: item_id, text, tags: [{ item_id, display: item_id, lang: 'mr' as const }] });

  it('adds the चा to सा, र to ल and both forms of each answer, same item, originals first', () => {
    const out = childSwaps([cand('उ', 'उंदराचा'), cand('अ', 'अ')]);
    expect(out.slice(0, 2).map((c) => c.text)).toEqual(['उंदराचा', 'अ']);
    expect(out.slice(2).map((c) => c.text).sort()).toEqual(['उंदलाचा', 'उंदरासा', 'उंदलासा'].sort());
    // every other field (item, display, language tags) is the original's
    for (const c of out.slice(2)) expect(c).toEqual({ ...cand('उ', 'उंदराचा'), text: c.text });
  });

  it('चा becomes सा only at the end of a word; an answer with neither sound adds nothing', () => {
    expect(childSwaps([cand('च', 'चाचा मामाचा')]).map((c) => c.text)).toEqual(['चाचा मामाचा', 'चासा मामासा']);
    expect(childSwaps([cand('च', 'चार')]).map((c) => c.text)).toEqual(['चार', 'चाल']);
    expect(childSwaps([cand('अ', 'अ'), cand('आ', 'आ')]).map((c) => c.text)).toEqual(['अ', 'आ']);
  });

  it('each text once: a swap equal to another answer keeps that answer and its item', () => {
    const out = childSwaps([cand('र', 'र'), cand('ल', 'ल'), cand('x', 'रर'), cand('y', 'लल')]);
    expect(out.map((c) => c.text)).toEqual(['र', 'ल', 'रर', 'लल']);
    expect(out.find((c) => c.text === 'ल')!.item_id).toBe('ल');
    expect(out.find((c) => c.text === 'लल')!.item_id).toBe('y');
  });
});

describe('lessonCandidates with child sound swaps', () => {
  it('offers every swap of every answer as the same item, with its own token ids, after the answers', () => {
    const cands = lessonCandidates(swar1.items);
    const own = [...new Set(swar1.items.flatMap(answersOf))];
    expect(cands.slice(0, own.length).map((c) => c.text)).toEqual(own);
    for (const text of ['उ उंदलाचा', 'उ उंदरासा', 'उ उंदलासा', 'उंदील']) {
      const c = cands.find((k) => k.text === text);
      expect(c).toEqual(expect.objectContaining({ item_id: 'u', display: 'उ' }));
      expect(c!.ids).toEqual(REAL_TOKENS[text]); // from asr_tokens.py, not the original answer's ids
    }
  });

  it.each(lessons.map((l) => [l.template_id, l] as const))('%s: every swap has tokens from asr_tokens.py', (_id, l) => {
    const texts = new Set(lessonCandidates(l.items).map((c) => c.text));
    const swaps = childSwaps(l.items.flatMap((it) => answersOf(it).map((text) => ({ item_id: it.id, display: it.display, text }))));
    for (const s of swaps) {
      expect(texts).toContain(s.text);
      expect(REAL_TOKENS[s.text]?.length).toBeGreaterThan(0);
    }
  });

  // A clip whose free decode is exactly the swapped answer "उ उंदलासा" (each token, blanks between).
  const clipSaying = (ids: number[]): LogProbs => {
    const seq = [256, ...ids.flatMap((k) => [k, 256])];
    const frames = seq.length * 2;
    const data = new Float32Array(frames * 257).fill(-20);
    for (let f = 0; f < frames; f++) data[f * 257 + seq[Math.floor(f / 2)]] = 0;
    return { data, frames, vocab: 257 };
  };

  it('a child saying "उ उंदलासा" is judged the उ answer: correct when उ is asked, wrong when अ is', () => {
    const ids = REAL_TOKENS['उ उंदलासा'];
    expect(ids).toBeDefined();
    const j = decide(clipSaying(ids), sine(0.3), lessonCandidates(swar1.items), tokensJson.pieces);
    expect(j).toEqual(expect.objectContaining({ choice: 'उ', text: 'उ उंदलासा' }));
    expect(classify(mr('u'), j, j.unsure)).toEqual(expect.objectContaining({ kind: 'correct', lang: 'mr' }));
    expect(classify(mr('a'), j, j.unsure).kind).toBe('wrong');
  });

  it('a swapped answer keeps its language: a Marathi meaning of an English word stays a meaning', () => {
    const orange = {
      id: 'orange', item_key: 'en:word:orange', display: 'Orange', kind: 'word', target_lang: 'en',
      anchor: { word: 'ऑरेंज', picture: '' }, lines: {},
      assessment: { mode: 'say_word', expected: ['ऑरेंज'], accepted_variants: ['संत्रे'], langs: { 'संत्रे': ['mr'] } },
    } as unknown as Item;
    const judged = (text: string): Judgement => ({ choice: 'Orange', text, scores: {}, free: '', note: '', unsure: false });
    expect(classify(orange, judged('संत्ले'), false)).toEqual(expect.objectContaining({ kind: 'meaning', lang: 'mr' }));
    expect(classify(orange, judged('ऑलेंज'), false)).toEqual(expect.objectContaining({ kind: 'correct', lang: 'en' }));
  });
});

// Shape only: the promise in GURU-3's output_for_dependents (childSwaps() used by the app's closed-set
// candidates; bench swaps on by default; regenerated goldens and tokens). No issue consumes it yet.
it('contract (GURU-3 output): childSwaps export, swapped candidates, golden format, bench default', () => {
  expect(typeof childSwaps).toBe('function');
  expect(childSwaps).toHaveLength(1);
  const [, swapped] = childSwaps([{ item_id: 'u', display: 'उ', text: 'उंदराचा' }]);
  expect(swapped).toEqual(expect.objectContaining({ item_id: expect.any(String), display: expect.any(String), text: expect.any(String) }));

  const c = lessonCandidates(swar1.items).find((k) => k.text === 'उ उंदलासा');
  expect(c).toEqual(expect.objectContaining({ ids: expect.any(Array), tags: expect.any(Array) }));

  expect(golden).toHaveProperty('tokens');
  for (const k of goldenCases) expect(k).toHaveProperty('text');

  // Python side: only a source scan reaches it from here (the bench has no test runner).
  const bench = join(__dirname, '../../../tools/stt_bench');
  expect(readFileSync(join(bench, 'providers/indicconformer.py'), 'utf8')).toMatch(/["']STT_BENCH_IC_CHILD_SWAPS["']\s*,\s*["']1["']/);
  expect(readFileSync(join(bench, 'README.md'), 'utf8')).toContain('STT_BENCH_IC_CHILD_SWAPS=0');
});

describe('parseWav', () => {
  const wav = (rate: number, samples: number[]) => {
    const b = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const put = (o: number, s: string) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
    put(0, 'RIFF'); b.setUint32(4, 36 + samples.length * 2, true); put(8, 'WAVE');
    put(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
    put(36, 'data'); b.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => b.setInt16(44 + i * 2, s, true));
    return new Uint8Array(b.buffer);
  };

  it('reads 16 kHz mono PCM16', () => {
    const { pcm, samples } = parseWav(wav(16000, [0, 16384, -32768]));
    expect(pcm.length).toBe(6);
    expect(Array.from(samples)).toEqual([0, 0.5, -1]);
  });

  it('rejects other formats', () => {
    expect(() => parseWav(wav(44100, [0]))).toThrow('16 kHz');
  });
});
