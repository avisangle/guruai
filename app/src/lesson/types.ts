// Shapes of content/lessons/<template>.json and content/prompts/<lang>.json.
export type Anchor = { word: string; picture: string };

export type Lang = 'mr' | 'en' | 'hi';
export type DecidedBy = 'shekru' | 'tap';
export type ItemKind = 'letter' | 'word';

// What the engine receives for one listening turn. The judge only classifies;
// the engine applies the language rules (TDD 2.2).
export type Heard =
  | { kind: 'correct'; by: DecidedBy; text?: string; lang?: Lang } // right answer in the target language
  | { kind: 'meaning'; by: 'shekru'; text: string; lang: Lang } // right item, not the target language
  | { kind: 'wrong'; by: DecidedBy; text?: string } // other item's answer, or "other"
  | { kind: 'silent'; by: DecidedBy; unsure?: boolean }; // nothing, unclear, unsure-wrong

// Picture reactions, on both kinds.
type ReactLines = { react_1?: string; react_2?: string };

type ItemBase = {
  id: string;
  item_key: string;
  display: string;
  target_lang: 'mr' | 'en';
  anchor: Anchor;
  assessment: {
    mode: string;
    expected: string[];
    accepted_variants: string[];
    // answers that count as right without being this item's answer (vowel-length partner)
    also_correct?: string[];
    // answer text -> its languages; an answer not listed is [target_lang]
    langs?: Record<string, Lang[]>;
  };
  // answers in different languages that the judge cannot tell apart
  ambiguous_lang?: boolean;
  // line name -> on-screen text (English in Latin letters); absent: the voice text
  captions?: Record<string, string>;
};

export type Item =
  | (ItemBase & { kind: 'letter'; lines: { teach: string; hint: string; correct: string } & ReactLines })
  | (ItemBase & {
      kind: 'word';
      ask_direction?: 'picture_to_target' | 'word_to_meaning';
      lines: {
        teach_mr_led: string;
        teach_en_led: string;
        ask: string; // the question in the target language, per ask_direction
        hint: string; // the Marathi bridge
        correct: string;
        ack_meaning: string;
        model_mr: string; // Marathi word for the Hindi follow-up
      } & ReactLines;
    });

export type FlowEntry =
  | { play: string; state: string }
  | { phase: 'teach' | 'quiz'; order: string[]; step?: string }
  | { phase: 'retry'; step?: string };

export type Lesson = {
  template_id: string;
  title: string; // home screen menu
  version: number;
  pack?: string;
  classes?: string[];
  learning_language?: string; // 'mr-IN' | 'en-IN'
  status?: string; // 'draft' | 'pilot' ...
  lines: Record<string, string>;
  captions?: Record<string, string>;
  items: Item[];
  flow: FlowEntry[];
};

export type Prompts = { lines: Record<string, string>; captions?: Record<string, string> };

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
