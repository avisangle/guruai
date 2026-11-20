// Build check for content/lessons (TDD 2.1). Pure: build-content.mjs runs it under
// Node's type stripping, so only erasable syntax and .ts import paths.
import { normalise } from '../asr/normalise.ts';
import type { Item, Lang, Lesson, Prompts } from '../lesson/types.ts';

const REQUIRED_LINES: Record<Item['kind'], string[]> = {
  letter: ['teach', 'hint', 'correct'],
  word: ['teach_mr_led', 'teach_en_led', 'ask', 'hint', 'correct', 'ack_meaning', 'model_mr'],
};
const TARGET_LANGS = ['mr', 'en'];

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

// tokens: the `tokens` map of app/src/asr/generated/mr-tokens.json (answer text -> token ids).
// prompts: shared lines; their checks (pool sizes) arrive with the shared pools.
export function validateContent(lessons: Lesson[], prompts: Prompts, tokens: Record<string, number[]>): string[] {
  const errors: string[] = [];
  for (const lesson of lessons) {
    const displays = new Set(lesson.items.map((i) => i.display));
    for (const display of lesson.flow.flatMap((entry) => ('order' in entry ? entry.order : []))) {
      if (!displays.has(display)) errors.push(`${lesson.template_id}: flow order names "${display}", which is no item's display`);
    }
    for (const item of lesson.items) errors.push(...checkItem(`${lesson.template_id}.${item.id}`, item, tokens));
  }
  return errors;
}
