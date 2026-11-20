/// <reference types="node" />
// GURU-2: content schema v2 and the build check. Contract: TDD 2.1 and 2.2 in the Epic GURU-1.
//
// Real data shapes this file relies on (read, not assumed):
// - app/src/asr/generated/mr-tokens.json is { pieces: string[], tokens: Record<answerText, number[]> }.
//   validateContent's third argument is its `tokens` map.
// - flow `order` entries name items by `display` (content/lessons/*.json).
// - the English lessons voice letter names, anchor words and "फॉर" in Devanagari; captions write them in Latin.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import tokensJson from '../asr/generated/mr-tokens.json';
import generatedLessons from './generated/lessons.json';
import type { DecidedBy, Heard, Item, ItemKind, Lang, Lesson, Prompts } from '../lesson/types';
import { validateContent } from './validate';

const APP = path.join(__dirname, '../..');
const ROOT = path.join(APP, '..');
const TOKENS = tokensJson.tokens as Record<string, number[]>;
const NO_PROMPTS: Prompts = { lines: {} };

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const contentLessons = (): Lesson[] =>
  fs
    .readdirSync(path.join(ROOT, 'content/lessons'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(ROOT, 'content/lessons', f)));
const realPrompts = (): Prompts => readJson(path.join(ROOT, 'content/prompts/mr.json'));

// ---- a minimal valid v2 lesson: one Marathi letter item, one English word item

const letterItem: Item = {
  id: 'a',
  item_key: 'mr:letter:अ',
  display: 'अ',
  kind: 'letter',
  target_lang: 'mr',
  anchor: { word: 'अननस', picture: 'pineapple' },
  assessment: { mode: 'say_word', expected: ['अ'], accepted_variants: ['अननस'] },
  lines: { teach: 'हे बघ, अ.', hint: 'अननस!', correct: 'अ, अननसाचा!', react_1: 'वा, अननस!' },
};

const wordItem: Item = {
  id: 'apple',
  item_key: 'en:word:apple',
  display: 'Apple',
  kind: 'word',
  target_lang: 'en',
  ask_direction: 'picture_to_target',
  anchor: { word: 'ॲपल', picture: 'apple' },
  assessment: { mode: 'say_word', expected: ['ॲपल'], accepted_variants: ['सफरचंद'], langs: { 'सफरचंद': ['mr'] } },
  lines: {
    teach_mr_led: 'हे सफरचंद. इंग्लिशमध्ये ॲपल!',
    teach_en_led: 'ॲपल! म्हणजे सफरचंद.',
    ask: 'हे काय आहे? इंग्लिशमध्ये?',
    hint: 'सफरचंद, इंग्लिशमध्ये ॲपल.',
    correct: 'ॲपल!',
    ack_meaning: 'हो, सफरचंद! इंग्लिशमध्ये?',
    model_mr: 'सफरचंद',
    react_1: 'किती लाल ॲपल!',
  },
  captions: { teach_mr_led: 'हे सफरचंद. इंग्लिशमध्ये Apple!' },
};

const baseLesson = (): Lesson => ({
  template_id: 'tpl_test',
  title: 'test',
  version: 1,
  pack: 'test pack',
  classes: ['LKG'],
  learning_language: 'mr-IN',
  status: 'draft',
  lines: { intro: 'नमस्कार!' },
  captions: { intro: 'नमस्कार!' },
  items: [structuredClone(letterItem), structuredClone(wordItem)],
  flow: [
    { play: 'intro', state: 'hello' },
    { phase: 'teach', order: ['अ', 'Apple'] },
    { phase: 'quiz', order: ['Apple', 'अ'] },
    { phase: 'retry' },
  ],
});

// Every answer text of baseLesson, far apart from each other.
const baseTokens = (): Record<string, number[]> => ({
  'अ': [11],
  'अननस': [11, 15, 6],
  'ॲपल': [101, 102],
  'सफरचंद': [6, 103, 104, 105, 106],
});

const item = (lesson: Lesson, id: string) => lesson.items.find((i) => i.id === id)!;
const run = (lesson: Lesson, tokens = baseTokens()) => validateContent([lesson], NO_PROMPTS, tokens);

// ---- behaviour

test('a valid v2 lesson has no errors; a flow order entry naming no item display is reported', () => {
  expect(run(baseLesson())).toEqual([]);

  const lesson = baseLesson();
  lesson.flow[2] = { phase: 'quiz', order: ['Apple', 'अ', 'ZQX'] };
  const errors = run(lesson);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('ZQX');
});

test('required lines per kind: a word item needs all seven, a letter item needs teach, hint and correct', () => {
  const lesson = baseLesson();
  delete (item(lesson, 'apple').lines as Record<string, string>).ack_meaning;
  delete (item(lesson, 'a').lines as Record<string, string>).hint;
  const errors = run(lesson);
  expect(errors).toHaveLength(2);
  expect(errors.some((e) => e.includes('apple') && e.includes('ack_meaning'))).toBe(true);
  expect(errors.some((e) => e.includes('hint') && !e.includes('apple'))).toBe(true);

  // each word line is required, not only some of them
  for (const name of ['teach_mr_led', 'teach_en_led', 'ask', 'hint', 'correct', 'ack_meaning', 'model_mr']) {
    const one = baseLesson();
    delete (item(one, 'apple').lines as Record<string, string>)[name];
    expect(run(one).some((e) => e.includes(name))).toBe(true);
  }

  // a letter item is not held to the word lines: baseLesson's letter item has none and is clean (first test)
});

test('an assessment.langs key that is not one of the item answers is reported', () => {
  const lesson = baseLesson();
  item(lesson, 'apple').assessment.langs = { 'सफरचंद': ['mr'], 'संत्रं': ['mr'] };
  const errors = run(lesson);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('संत्रं');
});

describe('language ambiguity', () => {
  // पाणी (mr, the item's target) and पानी (hi): one token apart.
  const water = (ambiguous?: boolean, paniTokens = [5, 8, 7]) => {
    const lesson = baseLesson();
    const it = item(lesson, 'a');
    it.assessment.accepted_variants = ['अननस', 'पाणी', 'पानी'];
    it.assessment.langs = { 'पानी': ['hi'] };
    if (ambiguous !== undefined) it.ambiguous_lang = ambiguous;
    return run(lesson, { ...baseTokens(), 'पाणी': [5, 6, 7], 'पानी': paniTokens });
  };

  test('answers in different languages within token edit distance 2 fail unless ambiguous_lang is set', () => {
    const errors = water();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('पाणी');
    expect(errors[0]).toContain('पानी');
    expect(errors[0]).toContain('ambiguous_lang');

    expect(water(true)).toEqual([]);
    // distance exactly 2 still fails; 3 passes
    expect(water(undefined, [5, 9, 9])).toHaveLength(1);
    expect(water(undefined, [9, 9, 9])).toEqual([]);
  });

  test('normalised-equal answers in different languages fail even with distant tokens; same-language neighbours pass', () => {
    // हात (mr) and हाथ (hi): close tokens, fail without the flag
    const hand = baseLesson();
    const h = item(hand, 'a');
    h.assessment.accepted_variants = ['अननस', 'हात', 'हाथ'];
    h.assessment.langs = { 'हाथ': ['hi'] };
    const handTokens = { ...baseTokens(), 'हात': [14, 16, 40, 41], 'हाथ': [14, 17, 40, 41] };
    expect(run(hand, handTokens)).toHaveLength(1);
    h.ambiguous_lang = true;
    expect(run(hand, handTokens)).toEqual([]);

    // फ़ोन and फोन normalise equal (nukta dropped); their tokens are far apart
    const phone = baseLesson();
    const p = item(phone, 'apple');
    p.assessment.accepted_variants = ['सफरचंद', 'फ़ोन', 'फोन'];
    p.assessment.langs = { 'सफरचंद': ['mr'], 'फ़ोन': ['hi'] };
    const far = { ...baseTokens(), 'फ़ोन': [201, 202, 203, 204], 'फोन': [1, 2, 3, 9, 9, 9] };
    const errors = run(phone, far);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ambiguous_lang');

    // same tags (both default to target_lang en): never compared, however close
    p.assessment.langs = { 'सफरचंद': ['mr'] };
    expect(run(phone, far)).toEqual([]);
    // overlapping tag sets are not disjoint: not compared either
    p.assessment.langs = { 'सफरचंद': ['mr'], 'फ़ोन': ['en', 'hi'] };
    expect(run(phone, far)).toEqual([]);
  });

  test('an answer with no tokens is an error that points at asr_tokens.py', () => {
    const lesson = baseLesson();
    const it = item(lesson, 'a');
    it.assessment.accepted_variants = ['अननस', 'पाणी', 'पानी'];
    it.assessment.langs = { 'पानी': ['hi'] };
    const errors = run(lesson, { ...baseTokens(), 'पाणी': [5, 6, 7] });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes('पानी') && e.includes('asr_tokens.py'))).toBe(true);
  });
});

describe('the 8 migrated lessons', () => {
  const lessons = contentLessons();
  const english = lessons.filter((l) => l.learning_language === 'en-IN');

  test('validate clean with the real tokens and prompts; every item is a letter in its lesson language', () => {
    expect(lessons).toHaveLength(8);
    expect(english).toHaveLength(5);
    expect(validateContent(lessons, realPrompts(), TOKENS)).toEqual([]);
    for (const lesson of lessons) {
      const lang = ({ 'mr-IN': 'mr', 'en-IN': 'en' } as Record<string, Lang>)[lesson.learning_language!];
      expect(lang).toBeDefined();
      for (const it of lesson.items) {
        expect([lesson.template_id, it.id, it.kind]).toEqual([lesson.template_id, it.id, 'letter']);
        expect([lesson.template_id, it.id, it.target_lang]).toEqual([lesson.template_id, it.id, lang]);
      }
    }
  });

  test('English lessons caption every line that voices an English letter name or word, in Latin letters', () => {
    const words = (s: string) => s.split(/[\s,.!?।]+/).filter(Boolean);
    for (const lesson of english) {
      const names = new Set(lesson.items.flatMap((i) => i.assessment.expected));
      const voicesEnglish = (text: string, anchor?: string) =>
        words(text).some((w) => names.has(w)) || text.includes('फॉर') || (!!anchor && text.includes(anchor));
      // every word of the anchor goes Latin, so "एक्स रे" cannot become "X रे"
      const stillDevanagari = (caption: string, anchor?: string) =>
        words(caption).some((w) => names.has(w)) ||
        caption.includes('फॉर') ||
        (!!anchor && words(anchor).some((w) => caption.includes(w)));

      const checks: { where: string; lines: Record<string, string>; captions?: Record<string, string>; anchor?: string; display?: string }[] = [
        { where: lesson.template_id, lines: lesson.lines, captions: lesson.captions },
        ...lesson.items.map((i) => ({
          where: `${lesson.template_id}.${i.id}`,
          lines: i.lines as Record<string, string>,
          captions: i.captions,
          anchor: i.anchor.word,
          display: i.display,
        })),
      ];
      for (const { where, lines, captions, anchor, display } of checks) {
        for (const [name, text] of Object.entries(lines)) {
          if (!voicesEnglish(text, anchor)) continue;
          const caption = captions?.[name];
          expect([where, name, typeof caption]).toEqual([where, name, 'string']);
          expect([where, name, caption, stillDevanagari(caption!, anchor)]).toEqual([where, name, caption, false]);
        }
        // a caption never names a line that does not exist
        for (const name of Object.keys(captions ?? {})) expect([where, name, name in lines]).toEqual([where, name, true]);
        if (display) expect([where, captions?.teach?.includes(display)]).toEqual([where, true]);
      }
      // the outro lists the lesson's letters
      expect(lesson.captions?.outro).toContain(lesson.items[0].display);
    }
    // the issue's own example
    expect(english.find((l) => l.template_id === 'tpl_kg_en_letters_1')!.items[0].captions?.teach).toBe(
      'हे बघ, A. A for Apple! आता तू म्हण!',
    );
  });

  test('the committed generated lessons.json carries the v2 fields and the captions unchanged', () => {
    const generated = generatedLessons as unknown as Lesson[];
    expect(generated).toHaveLength(8);
    for (const source of lessons) {
      const out = generated.find((l) => l.template_id === source.template_id)!;
      expect(out).toBeDefined();
      expect(out.captions).toEqual(source.captions);
      expect(out.learning_language).toBe(source.learning_language);
      for (const it of source.items) {
        const g = out.items.find((i) => i.id === it.id)!;
        expect([g.kind, g.target_lang, g.captions]).toEqual([it.kind, it.target_lang, it.captions]);
      }
    }
  });
});

describe('npm run build:content', () => {
  // The build runs in a scratch copy of the repo layout it reads (content/, app/src, app/scripts), so it
  // never rewrites the committed generated files or deletes the tracked lesson audio.
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guru2-build-'));
    for (const p of ['content/lessons', 'content/prompts', 'app/src', 'app/scripts', 'app/package.json']) {
      fs.cpSync(path.join(ROOT, p), path.join(tmp, p), { recursive: true });
    }
    // GURU-16: the build reads its lesson list from content/paths
    if (fs.existsSync(path.join(ROOT, 'content/paths'))) {
      fs.cpSync(path.join(ROOT, 'content/paths'), path.join(tmp, 'content/paths'), { recursive: true });
    }
    fs.symlinkSync(fs.realpathSync(path.join(APP, 'node_modules')), path.join(tmp, 'app/node_modules'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const build = () => {
    const r = spawnSync('npm', ['run', 'build:content'], { cwd: path.join(tmp, 'app'), encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };

  test('exits 0 on the migrated lessons and writes their captions into lessons.json unchanged', () => {
    const { status, out } = build();
    expect([status, status === 0 ? '' : out]).toEqual([0, '']);
    const written = readJson(path.join(tmp, 'app/src/content/generated/lessons.json')) as Lesson[];
    for (const source of contentLessons()) {
      const w = written.find((l) => l.template_id === source.template_id)!;
      expect(w.captions).toEqual(source.captions);
      expect(w.items.map((i) => [i.kind, i.target_lang, i.captions])).toEqual(
        source.items.map((i) => [i.kind, i.target_lang, i.captions]),
      );
    }
  }, 60_000);

  test('exits non-zero and prints every error when validation fails', () => {
    const file = path.join(tmp, 'content/lessons/kg-mr-swar-1.json');
    const broken = readJson(file);
    broken.flow.find((f: { phase?: string }) => f.phase === 'quiz').order.push('ZQX');
    delete broken.items[0].lines.hint;
    fs.writeFileSync(file, JSON.stringify(broken, null, 2));

    const lessons = fs
      .readdirSync(path.join(tmp, 'content/lessons'))
      .map((f) => readJson(path.join(tmp, 'content/lessons', f)) as Lesson);
    const expected = validateContent(lessons, realPrompts(), TOKENS);
    expect(expected.length).toBeGreaterThanOrEqual(2);

    const { status, out } = build();
    expect(status).not.toBe(0);
    for (const e of expected) expect(out).toContain(e);
  }, 60_000);
});

// ---- contract for dependents (shape only)
// GURU-10, GURU-18: Lang, DecidedBy, Heard, ItemKind and the v2 Item fields in app/src/lesson/types.ts.
// GURU-11, GURU-16: validateContent(lessons, prompts, tokens) in app/src/content/validate.ts, run by build-content.mjs.
// GURU-17: v2 line names and captions in lesson files.
// The type half is enforced by `npm run typecheck`; jest strips types.
test('contract (GURU-10, GURU-11, GURU-16, GURU-17, GURU-18): exported types and validateContent shape', () => {
  const langs: Lang[] = ['mr', 'en', 'hi'];
  const deciders: DecidedBy[] = ['shekru', 'tap'];
  const kinds: ItemKind[] = ['letter', 'word'];
  const heard: Heard[] = [
    { kind: 'correct', by: 'tap' },
    { kind: 'correct', by: 'shekru', text: 'ॲपल', lang: 'en' },
    { kind: 'meaning', by: 'shekru', text: 'सफरचंद', lang: 'mr' },
    { kind: 'wrong', by: 'tap' },
    { kind: 'wrong', by: 'shekru', text: 'बॉल' },
    { kind: 'silent', by: 'shekru', unsure: true },
    { kind: 'silent', by: 'tap' },
  ];
  // @ts-expect-error a meaning answer is only ever decided by the judge
  const tapMeaning: Heard = { kind: 'meaning', by: 'tap', text: 'सफरचंद', lang: 'mr' };
  // @ts-expect-error Lang is closed: Marathi, English, Hindi
  const gujarati: Lang = 'gu';
  // v2 Item fields, on both kinds
  const word: Item = wordItem;
  const letter: Item = letterItem;
  const lineNames: (keyof Extract<Item, { kind: 'word' }>['lines'])[] = [
    'teach_mr_led', 'teach_en_led', 'ask', 'hint', 'correct', 'ack_meaning', 'model_mr', 'react_1', 'react_2',
  ];
  const letterLines: (keyof Extract<Item, { kind: 'letter' }>['lines'])[] = ['teach', 'hint', 'correct', 'react_1', 'react_2'];
  const lesson: Lesson = baseLesson();
  expect([langs, deciders, kinds, heard.length, tapMeaning.kind, gujarati]).toBeDefined();
  expect([word.kind, letter.kind, lineNames.length, letterLines.length]).toEqual(['word', 'letter', 9, 5]);
  expect(lesson.items.map((i) => [i.kind, i.target_lang])).toEqual([['letter', 'mr'], ['word', 'en']]);

  // validateContent(lessons, prompts, tokens) -> string[]
  expect(typeof validateContent).toBe('function');
  const none = validateContent([], NO_PROMPTS, {});
  expect(Array.isArray(none)).toBe(true);
  const some = validateContent([{ ...baseLesson(), flow: [{ phase: 'teach', order: ['ZQX'] }] }], NO_PROMPTS, baseTokens());
  expect(some.length).toBeGreaterThan(0);
  for (const e of some) expect(typeof e).toBe('string');
});
