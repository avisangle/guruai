// Learning-model switches (D-GURU-12-word-items-practice-only).

/** While true, a `wrong` on a word item never changes its mastery row. */
export const WORD_ITEMS_GATED = true;

// Style level rule (D-GURU-22-style-level-rule); provisional, tuned on pilot logs.

/** First-try rate at or above which `mr_led` moves to `en_led`. */
export const STYLE_UP_RATE = 0.8;

/** First-try rate at or below which `en_led` moves to `mr_led`. */
export const STYLE_DOWN_RATE = 0.4;

/** How many of the latest sessions with counted word answers are read. */
export const STYLE_WINDOW_SESSIONS = 2;

/** Fewer counted word answers than this in the window: no change. */
export const STYLE_MIN_ANSWERS = 8;
