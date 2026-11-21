// Build check for content/lessons (TDD 2.1). Pure: build-content.mjs runs it under
// Node's type stripping, so only erasable syntax and .ts import paths.
import { normalise } from '../asr/normalise.ts';
import { FAMILIES, familyLines } from '../lesson/lines.ts';
import type { AppLang } from '../data/types.ts';
import type { Item, Lang, Lesson, Prompts } from '../lesson/types.ts';
import { TUTOR_STATES } from '../shekru/contract.ts';

const REQUIRED_LINES: Record<Item['kind'], string[]> = {
  letter: ['teach', 'hint', 'correct'],
  word: ['teach_mr_led', 'teach_en_led', 'ask', 'hint', 'correct', 'ack_meaning', 'model_mr'],
};
const TARGET_LANGS: AppLang[] = ['mr', 'en'];

function editDistance(a: number[], b: number[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

function checkItem(where: string, item: Item, tokens: Record<string, number[]>): string[] {
  const errors: string[] = [];
  if (!(item.kind in REQUIRED_LINES)) return [`${where}: kind must be "letter" or "word", not "${item.kind}"`];
  if (!TARGET_LANGS.includes(item.target_lang)) errors.push(`${where}: target_lang must be "mr" or "en", not "${item.target_lang}"`);

  const lines = item.lines as Record<string, string | undefined>;
  for (const name of REQUIRED_LINES[item.kind]) {
    if (!lines[name]) errors.push(`${where}: ${item.kind} item is missing line "${name}"`);
  }

  const { expected, accepted_variants, langs = {} } = item.assessment;
  const answers = [...new Set([...expected, ...accepted_variants])];
  for (const text of Object.keys(langs)) {
    if (!answers.includes(text)) errors.push(`${where}: assessment.langs names "${text}", which is not one of its answers`);
  }
  for (const text of answers) {
    if (!tokens[text]) errors.push(`${where}: no tokens for "${text}"; run tools/stt_bench/asr_tokens.py`);
  }

  if (item.ambiguous_lang) return errors;
  const tagsOf = (text: string): Lang[] => langs[text] ?? [item.target_lang];
  const norm = answers.map(normalise);
  for (let i = 0; i < answers.length; i++) {
    for (let j = i + 1; j < answers.length; j++) {
      const [a, b] = [answers[i], answers[j]];
      const [la, lb] = [tagsOf(a), tagsOf(b)];
      if (la.some((l) => lb.includes(l))) continue;
      if (norm[i] === norm[j] || (tokens[a] && tokens[b] && editDistance(tokens[a], tokens[b]) <= 2))
        errors.push(`${where}: "${a}" (${la}) and "${b}" (${lb}) cannot be told apart; set ambiguous_lang`);
    }
  }
  return errors;
}

// TDD 2.4: each family's pool size.
function checkPools(prompts: Prompts): string[] {
  return Object.entries(FAMILIES).flatMap(([family, min]) => {
    const n = familyLines(family, prompts.lines).length;
    return n < min ? [`prompts: family "${family}" has ${n} line(s), needs at least ${min}`] : [];
  });
}

// tokens: the `tokens` map of app/src/asr/generated/mr-tokens.json (answer text -> token ids).
// prompts: shared lines, checked against the FAMILIES pool sizes.
export function validateContent(lessons: Lesson[], prompts: Prompts, tokens: Record<string, number[]>): string[] {
  const errors = checkPools(prompts);
  for (const lesson of lessons) {
    const displays = new Set(lesson.items.map((i) => i.display));
    for (const display of lesson.flow.flatMap((entry) => ('order' in entry ? entry.order : []))) {
      if (!displays.has(display)) errors.push(`${lesson.template_id}: flow order names "${display}", which is no item's display`);
    }
    for (const entry of lesson.flow) {
      if ('state' in entry && !(TUTOR_STATES as readonly string[]).includes(entry.state))
        errors.push(`${lesson.template_id}: flow plays "${entry.play}" in state "${entry.state}", which is not a tutor state`);
    }
    for (const item of lesson.items) {
      const where = `${lesson.template_id}.${item.id}`;
      errors.push(...checkItem(where, item, tokens));
      if (lesson.status === 'pilot' && !Object.entries(item.lines).some(([name, text]) => /^react_\d+$/.test(name) && text))
        errors.push(`${where}: items in a pilot lesson need a react_* line (picture reaction)`);
    }
  }
  return errors;
}

// Learning paths (content/paths). A child's goals are skill ids.
type Title = { mr: string; en: string };
type PathUnit = { unit_id: string; title: Title; lessons: string[] };
export type LearningPath = {
  path_id: string;
  kind: 'class' | 'skill';
  title: Title;
  board?: string;
  class?: string;
  skill?: string;
  pack: string;
  units: PathUnit[];
};
export type Packs = Record<string, { title: Title; lessons: string[] }>;

const BOARDS = ['msb', 'cbse'];
const CLASSES = ['Nursery', 'LKG', 'UKG', 'Class1', 'Class2'];

/** Lessons reachable from the paths, in path order, each once. */
export function reachableLessons(paths: LearningPath[]): string[] {
  return [...new Set(paths.flatMap((p) => p.units.flatMap((u) => u.lessons)))];
}

/** Lesson to the ids of the packs that list it. */
export function packsByLesson(packs: Packs): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [id, pack] of Object.entries(packs)) {
    for (const l of pack.lessons) {
      if (!index.has(l)) index.set(l, []);
      index.get(l)!.push(id);
    }
  }
  return index;
}

export function validatePaths(paths: LearningPath[], packs: Packs, lessonIds: string[]): string[] {
  const errors: string[] = [];
  const known = new Set(lessonIds);
  for (const p of paths) {
    if (!(p.pack in packs)) errors.push(`${p.path_id}: pack "${p.pack}" is not in packs.json`);
    for (const u of p.units) {
      for (const l of u.lessons) {
        if (!known.has(l)) errors.push(`${p.path_id}.${u.unit_id}: names "${l}", which is no lesson's template_id`);
      }
    }
  }

  const packsOf = packsByLesson(packs);
  for (const [l, ids] of packsOf) if (ids.length > 1) errors.push(`${l}: in more than one pack (${ids.join(', ')})`);
  for (const l of reachableLessons(paths)) {
    if (known.has(l) && !packsOf.has(l)) errors.push(`${l}: reachable from a path but in no pack`);
  }

  for (const board of BOARDS) {
    for (const cls of CLASSES) {
      if (!paths.some((p) => p.kind === 'class' && p.board === board && p.class === cls))
        errors.push(`no class path for board "${board}" and class "${cls}"`);
    }
  }
  return errors;
}
