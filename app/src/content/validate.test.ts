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
import { FAMILIES } from '../lesson/lines';
import type { DecidedBy, Heard, Item, ItemKind, Lang, Lesson, Prompts } from '../lesson/types';
import { validateContent } from './validate';

const APP = path.join(__dirname, '../..');
const ROOT = path.join(APP, '..');
const TOKENS = tokensJson.tokens as Record<string, number[]>;
const NO_PROMPTS: Prompts = { lines: {} };
// GURU-11: shared pools with every family of FAMILIES at exactly its minimum, ids `<family>_<n>`.
// The lesson tests pass these so the pool-size rule stays quiet; NO_PROMPTS now fails it.
const fullPools = (): Prompts => ({
  lines: Object.fromEntries(
    Object.entries(FAMILIES).flatMap(([family, min]) =>
      Array.from({ length: min }, (_, i) => [`${family}_${i + 1}`, `${family} ${i + 1}`]),
    ),
  ),
});

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
const run = (lesson: Lesson, tokens = baseTokens()) => validateContent([lesson], fullPools(), tokens);

// ---- behaviour

test('a valid v2 lesson has no errors; a flow order entry naming no item display is reported', () => {
  expect(run(baseLesson())).toEqual([]);

  const lesson = baseLesson();
  lesson.flow[2] = { phase: 'quiz', order: ['Apple', 'अ', 'ZQX'] };
  const errors = run(lesson);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('ZQX');
});

test('a flow play entry whose state is not one of the 14 tutor states is reported (D-GURU-7)', () => {
  const lesson = baseLesson();
  lesson.flow[0] = { play: 'intro', state: 'waving' };
  const errors = run(lesson);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('"waving"');
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

// ---- GURU-11: shared line pools, style samples, picture reactions. Contract: TDD 2.4 in the Epic GURU-1.
//
// Real data read, not assumed:
// - content/prompts/mr.json before this issue: nohear, ask_1..3, ok_1..3, wrong_1..2, retry_intro, again_1, moveon_1.
// - A family's lines are `<family>_<n>` or the bare family id (the engine's rule, D-GURU-19-tutor-variety), so
//   ask_mr_1 and ask_grownup_mic_1 are not `ask` lines.
// - content/audio/visemes.json (owner's machine, not in git) is { lines: {id: text}, clips: {tutor: {id: clip}} };
//   content/audio/<tutor>/<id>.mp3 holds the voiced lines.
// - The engine opens the mic right after ask, ask_mr, meaning_hi_ack and nohear lines.

const OLD_LINES: Record<string, string> = {
  ok_1: 'छान!',
  ok_2: 'मस्त!',
  ok_3: 'वा, एकदम छान!',
  wrong_1: 'अं हं, हे वेगळं अक्षर आहे. ही घे एक मदत.',
  wrong_2: 'हम्म, नाही. थांब, ही घे एक मदत.',
  nohear: 'मला ऐकू आलं नाही, पुन्हा सांग.',
};
const RENAMED: Record<string, string> = {
  ok_1: 'praise_first_1',
  ok_2: 'praise_first_2',
  ok_3: 'praise_first_3',
  wrong_1: 'tryagain_1',
  wrong_2: 'tryagain_2',
  nohear: 'nohear_1',
};
const PRAISE = ['praise_first', 'praise_hint', 'praise_streak', 'praise_comeback'];
const SAMPLES = ['sample_mr_led', 'sample_en_led'];
const MIC_OPENING = ['ask', 'ask_mr', 'meaning_hi_ack', 'nohear'];
const PRAISE_WORDS = ['शाब्बास', 'शाबास', 'बरोबर', 'वा', 'छान', 'मस्त', 'हुशार', 'भारी', 'Great', 'Good', 'Well'];
const HINDI_WORDS = ['है', 'हैं', 'बहुत', 'अच्छा', 'अच्छी', 'बढ़िया', 'क्या', 'नहीं', 'मैं', 'तुम', 'आप', 'चलो', 'कौन', 'यह', 'वह'];
const FIRST_PERSON = ['देतो', 'देते', 'सांगतो', 'सांगते', 'दाखवतो', 'दाखवते', 'शिकवतो', 'शिकवते'];

const wordsOf = (s: string) => s.split(/[\s,.!?।"'()]+/).filter(Boolean);
const familyIds = (lines: Record<string, string>, family: string) =>
  Object.keys(lines).filter((id) => new RegExp(`^${family}(_\\d+)?$`).test(id));
// Absence scan: Hindi words and gendered verb forms (content/README.md writing rules).
const ruleBreaks = (text: string) =>
  wordsOf(text).filter(
    (w) => HINDI_WORDS.includes(w) || FIRST_PERSON.includes(w) || w.endsWith('लास') || w.endsWith('लीस'),
  );

describe('GURU-11: validator rules for shared pools and pilot reactions', () => {
  test('a family below its FAMILIES minimum, or missing, is one error naming it; at the minimum is clean', () => {
    expect(validateContent([baseLesson()], fullPools(), baseTokens())).toEqual([]);

    // every family, not only some: drop one line from a family sitting at its minimum
    for (const [family, min] of Object.entries(FAMILIES)) {
      const prompts = fullPools();
      delete prompts.lines[`${family}_${min}`];
      const errors = validateContent([baseLesson()], prompts, baseTokens());
      expect([family, errors.length]).toEqual([family, 1]);
      expect([family, errors[0].includes(family)]).toEqual([family, true]);
    }

    // a family with no lines at all
    const none = fullPools();
    for (const id of familyIds(none.lines, 'ask_grownup_mic')) delete none.lines[id];
    expect(validateContent([baseLesson()], none, baseTokens()).filter((e) => e.includes('ask_grownup_mic'))).toHaveLength(1);
  });

  test('lines of a sibling family never count toward a shorter family name (ask_mr_*, ask_grownup_* are not ask)', () => {
    const prompts = fullPools();
    delete prompts.lines.ask_8; // ask at 7, one short
    for (let n = 2; n <= 9; n++) {
      prompts.lines[`ask_mr_${n}`] = 'मराठीत काय म्हणतात? आता तू सांग!';
      prompts.lines[`ask_grownup_mic_${n}`] = 'मोठ्या माणसाला बोलाव.';
    }
    prompts.lines.askfoo_1 = 'x';
    const errors = validateContent([baseLesson()], prompts, baseTokens());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\bask\b/);
  });

  test('an item in a pilot lesson without any react_* line is an error; react_2 alone is enough; draft lessons are not held to it', () => {
    const pilot = baseLesson();
    pilot.status = 'pilot';
    expect(run(pilot)).toEqual([]); // both base items carry react_1

    delete (item(pilot, 'a').lines as Record<string, string>).react_1;
    const errors = run(pilot);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('tpl_test.a');
    expect(errors[0]).toContain('react');

    (item(pilot, 'a').lines as Record<string, string>).react_2 = 'वा, अननस!';
    expect(run(pilot)).toEqual([]);

    const draft = baseLesson();
    delete (item(draft, 'a').lines as Record<string, string>).react_1;
    delete (item(draft, 'apple').lines as Record<string, string>).react_1;
    expect(run(draft)).toEqual([]);
  });
});

describe('GURU-11: content/prompts/mr.json pools', () => {
  const prompts = realPrompts();
  const lines = prompts.lines;

  test('every family meets its FAMILIES minimum; praise 15+ in total; surprise_line 6+; both style samples exist', () => {
    for (const [family, min] of Object.entries(FAMILIES)) {
      expect([family, familyIds(lines, family).length >= min]).toEqual([family, true]);
    }
    const praise = PRAISE.reduce((sum, f) => sum + familyIds(lines, f).length, 0);
    expect(praise).toBeGreaterThanOrEqual(15);
    expect(familyIds(lines, 'surprise_line').length).toBeGreaterThanOrEqual(6);
    for (const family of SAMPLES) expect([family, familyIds(lines, family).length >= 1]).toEqual([family, true]);

    // every id belongs to a known family, so no stray old id (ok_1, wrong_1, bare nohear) survives
    const known = [...Object.keys(FAMILIES), ...SAMPLES];
    for (const id of Object.keys(lines)) {
      expect([id, known.some((f) => familyIds({ [id]: '' }, f).length === 1)]).toEqual([id, true]);
      expect([id, typeof lines[id] === 'string' && lines[id].trim().length > 0]).toEqual([id, true]);
    }
    for (const old of Object.keys(OLD_LINES)) expect([old, old in lines]).toEqual([old, false]);
  });

  test('renamed ids keep their voiced text, so the renamed audio still matches', () => {
    for (const [old, renamed] of Object.entries(RENAMED)) expect([renamed, lines[renamed]]).toEqual([renamed, OLD_LINES[old]]);
  });

  test('writing rules: Devanagari voice text, no Hindi or gendered forms, mic-opening lines end with आता तू सांग!/म्हण!, samples captioned in Latin', () => {
    const captions = prompts.captions ?? {};
    for (const [id, text] of Object.entries(lines)) {
      expect([id, /[A-Za-z]/.test(text)]).toEqual([id, false]);
      expect([id, ruleBreaks(text)]).toEqual([id, []]);
    }
    for (const family of MIC_OPENING) {
      for (const id of familyIds(lines, family)) {
        if (id === 'nohear_1') continue; // keeps the voiced text of the old nohear line
        expect([id, /आता तू (सांग|म्हण)!$/.test(lines[id].trim())]).toEqual([id, true]);
      }
    }
    // style samples voice English words: Devanagari in the voice text, Latin in the caption
    for (const family of SAMPLES) {
      for (const id of familyIds(lines, family)) {
        expect([id, typeof captions[id], /[A-Za-z]/.test(captions[id] ?? '')]).toEqual([id, 'string', true]);
      }
    }
    for (const id of Object.keys(captions)) expect([id, id in lines]).toEqual([id, true]);
  });
});

describe('GURU-11: the 8 lessons have picture reactions and praise-free correct lines', () => {
  const lessons = contentLessons();

  test('every item has its own react_1 that does not open the mic and keeps to the writing rules', () => {
    const seen = new Map<string, string>();
    for (const lesson of lessons) {
      for (const it of lesson.items) {
        const where = `${lesson.template_id}.${it.id}`;
        const react = (it.lines as Record<string, string | undefined>).react_1;
        expect([where, typeof react === 'string' && react.trim().length > 0]).toEqual([where, true]);
        expect([where, /आता तू (सांग|म्हण)!$/.test(react!.trim())]).toEqual([where, false]);
        expect([where, ruleBreaks(react!), /[A-Za-z]/.test(react!)]).toEqual([where, [], false]);
        // tied to its own picture: no reaction is shared by two items
        expect([where, seen.get(react!.trim())]).toEqual([where, undefined]);
        seen.set(react!.trim(), where);
      }
    }
    expect(seen.size).toBe(lessons.reduce((n, l) => n + l.items.length, 0));
  });

  test('every correct line, and its caption, names the answer without praise words', () => {
    const praiseLines = Object.entries(realPrompts().lines)
      .filter(([id]) => PRAISE.some((f) => familyIds({ [id]: '' }, f).length === 1))
      .map(([, text]) => text.trim());
    for (const lesson of lessons) {
      for (const it of lesson.items) {
        const where = `${lesson.template_id}.${it.id}`;
        const correct = it.lines.correct;
        expect([where, wordsOf(correct).filter((w) => PRAISE_WORDS.includes(w))]).toEqual([where, []]);
        expect([where, praiseLines.filter((p) => correct.includes(p))]).toEqual([where, []]);
        expect([where, wordsOf(correct).includes(it.assessment.expected[0])]).toEqual([where, true]);
        const caption = it.captions?.correct;
        if (caption !== undefined) {
          expect([where, wordsOf(caption).filter((w) => PRAISE_WORDS.includes(w))]).toEqual([where, []]);
          expect([where, wordsOf(caption).includes(it.display)]).toEqual([where, true]);
        }
      }
    }
    // the issue's own example
    const a = lessons.find((l) => l.template_id === 'tpl_kg_en_letters_1')!.items.find((i) => i.id === 'a')!;
    expect([a.lines.correct, a.captions?.correct]).toEqual(['ए फॉर ॲपल!', 'A for Apple!']);
  });
});

describe('GURU-11: tools/rename_line_ids.py', () => {
  // Runs on a scratch audio folder, never on content/audio.
  const SCRIPT = path.join(ROOT, 'tools/rename_line_ids.py');
  const venvPython = path.join(ROOT, 'venv/bin/python');
  const PY = fs.existsSync(venvPython) ? venvPython : 'python3';
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guru11-audio-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('renames old ids to their families in every tutor folder and in visemes.json; a second run changes nothing', () => {
    const clip = (d: number) => ({ duration: d, events: [[0.1, 'AA']] });
    const tutors = ['shekru', 'other'];
    const ids = ['ok_1', 'ok_2', 'ok_3', 'wrong_1', 'wrong_2', 'nohear', 'ask_1', 'retry_intro', 'tpl_x.a.correct'];
    for (const t of tutors) {
      fs.mkdirSync(path.join(tmp, t));
      for (const id of ids) fs.writeFileSync(path.join(tmp, t, `${id}.mp3`), `${t}:${id}`);
    }
    const visemes = {
      lines: Object.fromEntries(ids.map((id) => [id, OLD_LINES[id] ?? `text of ${id}`])),
      clips: Object.fromEntries(tutors.map((t, n) => [t, Object.fromEntries(ids.map((id, i) => [id, clip(n * 10 + i)]))])),
    };
    fs.writeFileSync(path.join(tmp, 'visemes.json'), JSON.stringify(visemes, null, 2));

    const runScript = () => spawnSync(PY, [SCRIPT, '--audio', tmp], { encoding: 'utf8' });
    const first = runScript();
    expect([first.status, first.status === 0 ? '' : `${first.stdout}\n${first.stderr}`]).toEqual([0, '']);

    const newId = (id: string) => RENAMED[id] ?? id;
    for (const t of tutors) {
      expect(fs.readdirSync(path.join(tmp, t)).sort()).toEqual(ids.map((id) => `${newId(id)}.mp3`).sort());
      // contents moved with the name, not swapped between ids
      for (const id of ids) expect(fs.readFileSync(path.join(tmp, t, `${newId(id)}.mp3`), 'utf8')).toBe(`${t}:${id}`);
    }
    const expected = {
      lines: Object.fromEntries(Object.entries(visemes.lines).map(([id, text]) => [newId(id), text])),
      clips: Object.fromEntries(
        Object.entries(visemes.clips).map(([t, c]) => [t, Object.fromEntries(Object.entries(c).map(([id, v]) => [newId(id), v]))]),
      ),
    };
    expect(readJson(path.join(tmp, 'visemes.json'))).toEqual(expected);

    const second = runScript();
    expect(second.status).toBe(0);
    for (const t of tutors) expect(fs.readdirSync(path.join(tmp, t)).sort()).toEqual(ids.map((id) => `${newId(id)}.mp3`).sort());
    expect(readJson(path.join(tmp, 'visemes.json'))).toEqual(expected);
  });
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

// ---- GURU-11 contract for dependents (shape only)
// GURU-19 (engine, PR #14), GURU-28 (lesson player): every shared family the engine picks from has lines in
// content/prompts/mr.json under `<family>_<n>` (or the bare family id), so no step carries an undefined line.
// GURU-17 (gen_voice): sample_mr_led / sample_en_led lines with captions. Owner: tools/rename_line_ids.py --audio <dir>.
test('contract (GURU-17, GURU-19, GURU-28): engine families and samples resolve to text; pool errors are strings; rename script exists', () => {
  const { lines } = realPrompts();
  const engineFamilies = [
    'praise_first', 'praise_hint', 'praise_streak', 'praise_comeback', 'end_all', 'end_misses', 'tryagain',
    'nohear', 'ask', 'ask_mr', 'again', 'moveon', 'retry_intro', 'meaning_hi_ack', 'surprise_line',
  ];
  for (const family of [...engineFamilies, ...SAMPLES]) {
    const ids = familyIds(lines, family);
    expect([family, ids.length > 0]).toEqual([family, true]);
    for (const id of ids) expect([id, typeof lines[id]]).toEqual([id, 'string']);
  }

  const errors = validateContent([], NO_PROMPTS, {});
  expect(Array.isArray(errors)).toBe(true);
  expect(errors.length).toBeGreaterThan(0); // empty pools now fail
  for (const e of errors) expect(typeof e).toBe('string');

  expect(fs.existsSync(path.join(ROOT, 'tools/rename_line_ids.py'))).toBe(true);
});
