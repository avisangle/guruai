// Shapes of content/lessons/<template>.json and content/prompts/<lang>.json.
export type Anchor = { word: string; picture: string };

export type Item = {
  id: string;
  item_key: string;
  display: string;
  anchor: Anchor;
  // also_correct: answers that count as right without being this item's answer (vowel-length partner)
  assessment: { mode: string; expected: string[]; accepted_variants: string[]; also_correct?: string[] };
  lines: { teach: string; hint: string; correct: string };
};

export type FlowEntry =
  | { play: string; state: string }
  | { phase: 'teach' | 'quiz'; order: string[]; step?: string }
  | { phase: 'retry'; step?: string };

export type Lesson = {
  template_id: string;
  title: string; // home screen menu
  version: number;
  lines: Record<string, string>;
  items: Item[];
  flow: FlowEntry[];
};

export type Prompts = { lines: Record<string, string> };

export type Answer = 'correct' | 'wrong' | 'silent';
// teach: repeat after the tutor, any speech passes. quiz: name the letter.
export type ListenKind = 'teach' | 'quiz';

export type Say = {
  type: 'say';
  line: string; // audio id
  text: string;
  state: string; // Shekru state
  item: Item | null; // letter on the card
  showAnchor: boolean; // anchor picture under the letter
};
export type Listen = { type: 'listen'; item: Item; kind: ListenKind; showAnchor: boolean };
export type Step = Say | Listen | { type: 'done' };

// Where the child is in one lesson. Saved after every answer.
export type Position = {
  version: number;
  flow: number; // index into lesson.flow; flow.length when finished
  index: number; // item index inside the current phase
  attempts: number; // wrong attempts on the current quiz item
  silences: number; // silences since the last counted attempt
  repeats?: number; // wrong repeats in the current teach turn (absent in older saves)
  reveal: boolean; // answer was revealed, the child still has to repeat it
  retry: string[]; // item ids missed in the quiz
  last: Record<string, string>; // last variant used per family (ok, ask, wrong)
};

// Per child, shared by all lessons. Keyed by item_key.
export type Mastery = Record<string, { mastered: boolean }>;

export type Progress = { position: Position; mastery: Mastery };
