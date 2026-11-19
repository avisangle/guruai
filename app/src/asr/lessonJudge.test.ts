import lessonsJson from '../content/generated/lessons.json';
import type { Lesson } from '../lesson/types';
import { lessonCandidates, verdictFor } from './lessonJudge';

const lessonJson = lessonsJson[0]; // स्वर १ (अ to ऊ): the cases below are written against it

jest.mock('../../modules/guru-asr', () => ({}));
jest.mock('./model', () => ({}));

const lesson = lessonJson as unknown as Lesson;
const item = (id: string) => lesson.items.find((i) => i.id === id)!;

test.each((lessonsJson as unknown as Lesson[]).map((l) => [l.template_id, l] as const))(
  'every answer of %s has tokens (else rerun tools/stt_bench/asr_tokens.py)',
  (_id, l) => {
    const cands = lessonCandidates(l.items);
    expect(cands.length).toBeGreaterThan(l.items.length);
    for (const c of cands) expect(c.ids.length).toBeGreaterThan(0);
  },
);

test('candidates: letters and variants, each text once, never also_correct', () => {
  const texts = lessonCandidates(lesson.items).map((c) => c.text);
  expect(new Set(texts).size).toBe(texts.length);
  expect(texts).toContain('अ अननसाचा');
  const a = lessonCandidates(lesson.items).find((c) => c.text === 'अ अननसाचा')!;
  expect(a.display).toBe('अ');
});

test('verdicts follow the bench: nothing is unclear, other is wrong, the partner vowel counts', () => {
  expect(verdictFor(item('a'), 'अ')).toBe('correct');
  expect(verdictFor(item('a'), 'आ')).toBe('wrong');
  expect(verdictFor(item('a'), 'other')).toBe('wrong');
  expect(verdictFor(item('a'), 'nothing')).toBe('unclear');
  expect(verdictFor(item('i'), 'ई')).toBe('correct'); // D-STT-lenient-vowel-length
});

test('faint audio the model is unsure of: asked again instead of "wrong", a right answer still counts', () => {
  expect(verdictFor(item('a'), 'आ', true)).toBe('unclear');
  expect(verdictFor(item('a'), 'other', true)).toBe('unclear');
  expect(verdictFor(item('a'), 'अ', true)).toBe('correct');
  expect(verdictFor(item('a'), 'nothing', true)).toBe('unclear');
});

test('English letters: the judge reports the card letter, which is right for its own item only', () => {
  const english = (lessonsJson as unknown as Lesson[]).find((l) => l.template_id === 'tpl_kg_en_letters_1')!;
  const en = (id: string) => english.items.find((i) => i.id === id)!;
  const b = lessonCandidates(english.items).find((c) => c.text === 'बी फॉर बॉल')!;
  expect(b.display).toBe('B');
  expect(verdictFor(en('b'), 'B')).toBe('correct');
  expect(verdictFor(en('a'), 'A')).toBe('correct');
  expect(verdictFor(en('b'), 'D')).toBe('wrong');
  expect(verdictFor(en('a'), 'E')).toBe('wrong');
});
