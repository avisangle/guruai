// GURU-18: candidates carry language tags, decide() reports the matched text, classify() turns a judgement
// into Heard (TDD 2.2), and quiz listens drop the words Shekru just said.
import golden from './__fixtures__/golden.json';
import lessonsJson from '../content/generated/lessons.json';
import type { Item, Lesson, Listen } from '../lesson/types';
import type { LogProbs } from './ctc';
import { decide, type Candidate, type Judgement } from './judge';
import { classify, judgeClip, lessonCandidates } from './lessonJudge';

jest.mock('../../modules/guru-asr', () => ({}));
jest.mock('./model', () => ({}));
// judgeClip reads a silent 16 kHz mono WAV, so the model never runs and decide() sees the candidates.
jest.mock('expo-file-system', () => ({
  File: class {
    async arrayBuffer() {
      const n = 1600;
      const b = new DataView(new ArrayBuffer(44 + n * 2));
      const put = (o: number, s: string) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
      put(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); put(8, 'WAVE');
      put(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
      b.setUint32(24, 16000, true); b.setUint32(28, 32000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
      put(36, 'data'); b.setUint32(40, n * 2, true);
      return b.buffer;
    }
  },
}));
jest.mock('./judge', () => ({ ...jest.requireActual('./judge'), decide: jest.fn() }));

const realDecide = jest.requireActual<typeof import('./judge')>('./judge').decide;
const decideMock = decide as jest.MockedFunction<typeof decide>;

const lessons = lessonsJson as unknown as Lesson[];
const byId = (template: string) => lessons.find((l) => l.template_id === template)!;
const swar1 = byId('tpl_kg_mr_swar_1'); // अ to ऊ
const swar2 = byId('tpl_kg_mr_swar_2'); // ए to अं
const english = byId('tpl_kg_en_letters_1'); // A to E
const mr = (id: string) => swar1.items.find((i) => i.id === id)!;
const en = (id: string) => english.items.find((i) => i.id === id)!;

// Word items (none in the shipped lessons yet). Answer texts are ones mr-tokens.json already has.
const wordLines = {
  teach_mr_led: '', teach_en_led: '', ask: '', hint: '', correct: '', ack_meaning: '', model_mr: '',
};
const word = (over: Partial<Item> & { assessment: Item['assessment'] }): Item =>
  ({ id: 'spoon', item_key: 'mr:word:चमचा', display: 'चमचा', kind: 'word', target_lang: 'mr',
    anchor: { word: 'चमचा', picture: '' }, lines: wordLines, ...over }) as Item;
const spoon = word({ assessment: { mode: 'say_word', expected: ['चमचा'], accepted_variants: ['चम्मच'], langs: { 'चम्मच': ['hi'] } } });
const mango = word({
  id: 'mango', item_key: 'en:word:mango', display: 'Mango', target_lang: 'en',
  assessment: { mode: 'say_word', expected: ['मँगो'], accepted_variants: ['आंबा'], langs: { 'आंबा': ['mr'] } },
});

// A full Judgement as decide() returns it; classify gets unsure both inside it and as its own argument.
const judged = (choice: string, text?: string, unsure = false): Judgement =>
  ({ choice, text, scores: {}, free: '', note: '', unsure }) as Judgement;
const heard = (item: Item, choice: string, text?: string, unsure = false) => classify(item, judged(choice, text, unsure), unsure);

const listen = (item: Item, kind: Listen['kind'], prompt: string): Listen => ({ type: 'listen', item, kind, showAnchor: false, prompt });
const candidateTexts = () => decideMock.mock.calls.at(-1)![2].map((c) => c.text);

beforeEach(() => {
  decideMock.mockReset();
  decideMock.mockReturnValue(judged('nothing'));
});

test.each(lessons.map((l) => [l.template_id, l] as const))(
  'every answer of %s has tokens (else rerun tools/stt_bench/asr_tokens.py)',
  (_id, l) => {
    const cands = lessonCandidates(l.items);
    expect(cands.length).toBeGreaterThan(l.items.length);
    for (const c of cands) expect(c.ids.length).toBeGreaterThan(0);
  },
);

test('candidates: each text once with every item and language tag, never also_correct', () => {
  const texts = lessonCandidates(swar1.items).map((c) => c.text);
  expect(new Set(texts).size).toBe(texts.length);
  expect(texts).not.toContain(undefined);
  expect(lessonCandidates(swar1.items).find((c) => c.text === 'अ अननसाचा')!.tags).toEqual([{ item_id: 'a', display: 'अ', lang: 'mr' }]);
  // an answer not listed in langs is tagged with the item's target language
  expect(lessonCandidates(english.items).find((c) => c.text === 'बी फॉर बॉल')!.tags).toEqual([{ item_id: 'b', display: 'B', lang: 'en' }]);

  // one text, two items in two languages (Marathi ए, English A): one candidate, both tags, lesson order
  const mixed = lessonCandidates([...swar2.items, ...english.items]).filter((c) => c.text === 'ए');
  expect(mixed).toHaveLength(1);
  expect(mixed[0].tags).toEqual([
    { item_id: 'e', display: 'ए', lang: 'mr' },
    { item_id: 'a', display: 'A', lang: 'en' },
  ]);

  // one text, one item, two languages
  const both = word({ assessment: { mode: 'say_word', expected: ['चमचा'], accepted_variants: [], langs: { 'चमचा': ['mr', 'hi'] } } });
  expect(lessonCandidates([both]).find((c) => c.text === 'चमचा')!.tags).toEqual([
    { item_id: 'spoon', display: 'चमचा', lang: 'mr' },
    { item_id: 'spoon', display: 'चमचा', lang: 'hi' },
  ]);
  expect(lessonCandidates([spoon]).find((c) => c.text === 'चम्मच')!.tags).toEqual([{ item_id: 'spoon', display: 'चमचा', lang: 'hi' }]);
});

describe('decide() also reports the chosen candidate text (goldens)', () => {
  const sine = (level: number) => Float32Array.from({ length: 16000 }, (_, i) => level * Math.sin((2 * Math.PI * 220 * i) / 16000));
  const cands = golden.candidates as Candidate[];
  it.each(golden.cases)('$label', (c) => {
    const lp: LogProbs = { data: Float32Array.from(c.logp), frames: c.frames, vocab: 257 };
    const j = realDecide(lp, sine(c.level), cands, golden.pieces);
    expect(j.choice).toBe(c.choice);
    if (c.choice === 'other' || c.choice === 'nothing') expect(j.text).toBeUndefined();
    else expect(cands.filter((k) => k.display === c.choice).map((k) => k.text)).toContain(j.text);
  });
});

test('classify: nothing is silent; the target language, also_correct and the card letter are correct; the rest is wrong', () => {
  expect(heard(mr('a'), 'nothing')).toEqual({ kind: 'silent', by: 'shekru' });
  expect(heard(mr('a'), 'अ', 'अ अननसाचा')).toEqual({ kind: 'correct', by: 'shekru', text: 'अ अननसाचा', lang: 'mr' });
  expect(heard(mr('i'), 'ई', 'ई')).toEqual({ kind: 'correct', by: 'shekru', text: 'ई', lang: 'mr' }); // D-STT-lenient-vowel-length
  // English: the card shows "B", the answers are "बी", "बी फॉर बॉल"
  expect(heard(en('b'), 'B', 'बी फॉर बॉल')).toEqual({ kind: 'correct', by: 'shekru', text: 'बी फॉर बॉल', lang: 'en' });
  expect(heard(en('b'), 'B')).toMatchObject({ kind: 'correct', by: 'shekru' });
  expect(heard(mr('a'), 'आ', 'आ')).toEqual({ kind: 'wrong', by: 'shekru', text: 'आ' });
  expect(heard(en('a'), 'E', 'ई फॉर एलिफंट')).toEqual({ kind: 'wrong', by: 'shekru', text: 'ई फॉर एलिफंट' });
  expect(heard(mr('a'), 'other')).toEqual({ kind: 'wrong', by: 'shekru' });
});

test('classify: the asked item in another language is a meaning with that language, even though the card matches', () => {
  // decide() reports the item's own display for every one of its answers, so the language decides here
  expect(heard(spoon, 'चमचा', 'चम्मच')).toEqual({ kind: 'meaning', by: 'shekru', text: 'चम्मच', lang: 'hi' });
  expect(heard(spoon, 'चमचा', 'चमचा')).toEqual({ kind: 'correct', by: 'shekru', text: 'चमचा', lang: 'mr' });
  expect(heard(mango, 'Mango', 'आंबा')).toEqual({ kind: 'meaning', by: 'shekru', text: 'आंबा', lang: 'mr' });
  expect(heard(mango, 'Mango', 'मँगो')).toEqual({ kind: 'correct', by: 'shekru', text: 'मँगो', lang: 'en' });
  expect(heard(mango, 'चमचा', 'चमचा')).toEqual({ kind: 'wrong', by: 'shekru', text: 'चमचा' });
});

test('classify, model unsure (faint audio): anything but correct is silent and unsure, a right answer still counts', () => {
  const silentUnsure = { kind: 'silent', by: 'shekru', unsure: true };
  expect(heard(mr('a'), 'आ', 'आ', true)).toEqual(silentUnsure);
  expect(heard(mr('a'), 'other', undefined, true)).toEqual(silentUnsure);
  expect(heard(spoon, 'चमचा', 'चम्मच', true)).toEqual(silentUnsure);
  expect(heard(mr('a'), 'nothing', undefined, true)).toMatchObject({ kind: 'silent', by: 'shekru' });
  expect(heard(mr('a'), 'अ', 'अ', true)).toEqual({ kind: 'correct', by: 'shekru', text: 'अ', lang: 'mr' });
});

describe('judgeClip drops the words Shekru just said, in quiz listens only', () => {
  const hintA = en('a').lines.hint; // "हे अक्षर ॲपलचं आहे. ॲपल! आता तू सांग!"

  test('quiz after the hint: "ॲपल" is gone, "ए फॉर ॲपल" and the other answers stay', async () => {
    await judgeClip('file:///cache/rec-1.wav', listen(en('a'), 'quiz', hintA), english.items);
    const texts = candidateTexts();
    expect(texts).not.toContain('ॲपल');
    expect(texts).toEqual(expect.arrayContaining(['ए', 'ए फॉर ॲपल', 'ए ॲपल', 'बी', 'बॉल']));
    expect(texts).toHaveLength(lessonCandidates(english.items).length - 1);
  });

  test('whole words only: "अ" stays though "अक्षर" and "अननसाचं" start with it; "अननस" goes', async () => {
    await judgeClip('file:///cache/rec-1.wav', listen(mr('a'), 'quiz', mr('a').lines.hint), swar1.items);
    const texts = candidateTexts();
    expect(texts).not.toContain('अननस');
    expect(texts).toEqual(expect.arrayContaining(['अ', 'अ अननसाचा', 'आ']));
  });

  test('teach (repeat after me) keeps every candidate', async () => {
    const r = await judgeClip('file:///cache/rec-1.wav', listen(en('a'), 'teach', (en('a').lines as { teach: string }).teach), english.items);
    expect(candidateTexts()).toEqual(lessonCandidates(english.items).map((c) => c.text));
    expect(r.heard).toEqual({ kind: 'silent', by: 'shekru' }); // the stand-in judge heard nothing
  });

  test('the child echoes the hint word "ॲपल": not a candidate, so not praised', async () => {
    // a stand-in judge that hears "ॲपल": it picks that candidate if it is offered, else "other"
    decideMock.mockImplementation((_lp, _wav, cands) => {
      const c = cands.find((k) => k.text === 'ॲपल');
      return c ? judged(c.tags[0].display, c.text) : judged('other');
    });
    const r = await judgeClip('file:///cache/rec-1.wav', listen(en('a'), 'quiz', hintA), english.items);
    expect(r.error).toBeUndefined();
    expect(r.heard).toEqual({ kind: 'wrong', by: 'shekru' });
  });
});

// Shape only: what GURU-27 (bench mirrors classify and prompt exclusion) and GURU-28 (player takes the judge's Heard) rely on.
test('contract for GURU-27 and GURU-28: lessonCandidates tags, classify -> Heard, judgeClip(uri, listen, items) -> heard', async () => {
  const [c] = lessonCandidates(english.items);
  expect(c).toEqual(expect.objectContaining({ text: expect.any(String), ids: expect.any(Array), tags: expect.any(Array) }));
  expect(c.tags[0]).toEqual({ item_id: expect.any(String), display: expect.any(String), lang: expect.any(String) });

  expect(typeof classify).toBe('function');
  expect(classify(en('a'), judged('A', 'ए'), false)).toEqual(expect.objectContaining({ kind: expect.any(String), by: expect.any(String) }));

  expect(typeof judgeClip).toBe('function');
  expect(judgeClip).toHaveLength(3);
  const r = await judgeClip('file:///cache/rec-1.wav', listen(en('a'), 'quiz', ''), english.items);
  expect(r).toEqual(expect.objectContaining({ heard: expect.objectContaining({ kind: expect.any(String), by: expect.any(String) }) }));
});
