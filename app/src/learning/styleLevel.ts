// Style level between sessions (PRD Language design 3; D-GURU-22-style-level-rule).
import { now, type Db } from '../data/db';
import { getChild, updateChild } from '../data/profiles';
import type { StyleLevel } from '../data/types';
import { STYLE_DOWN_RATE, STYLE_MIN_ANSWERS, STYLE_UP_RATE, STYLE_WINDOW_SESSIONS } from './config';
import { appendEvent, type AnswerEvent } from './events';

/** A stored answer event with the session it belongs to. */
export type StoredAnswer = AnswerEvent & { session_id: string | null; at: string };

const COUNTED_PHASES: readonly AnswerEvent['phase'][] = ['quiz', 'retry', 'revision'];

// `counts` is ignored on purpose: gated word misses still say how the style is going.
const counted = (e: AnswerEvent) =>
  e.item_kind === 'word' && COUNTED_PHASES.includes(e.phase) && e.heard_kind !== 'silent';

/**
 * The level for the next session, from answer events in time order.
 * Reads counted word answers in the last STYLE_WINDOW_SESSIONS sessions that have any.
 */
export function nextStyleLevel(events: StoredAnswer[], current: StyleLevel, locked: boolean): StyleLevel {
  if (locked) return current;

  const answers = events.filter(counted);
  const window = new Set<string | null>();
  for (let i = answers.length - 1; i >= 0 && window.size < STYLE_WINDOW_SESSIONS; i--) window.add(answers[i].session_id);
  const inWindow = answers.filter((e) => window.has(e.session_id));
  if (inWindow.length < STYLE_MIN_ANSWERS) return current;

  const rate = inWindow.filter((e) => e.attempt === 1 && e.heard_kind === 'correct').length / inWindow.length;
  if (current === 'mr_led' && rate >= STYLE_UP_RATE) return 'en_led';
  if (current === 'en_led' && rate <= STYLE_DOWN_RATE) return 'mr_led';
  return current;
}

/**
 * Call once per session start, before the new session exists. Stores the child's next level,
 * appends a `style_change` event if it changed, and returns the level.
 */
export function applyStyleLevelAtSessionStart(db: Db, childId: string): StyleLevel {
  const child = getChild(db, childId);
  if (!child) throw new Error(`Unknown child ${childId}`);
  if (child.style_locked) return child.style_level;

  const events = db
    .all<{ session_id: string | null; at: string; payload: string }>(
      `SELECT session_id, at, payload FROM event WHERE child_id = ? AND type = 'answer' ORDER BY at, rowid`,
      [childId],
    )
    .map((r): StoredAnswer => ({ ...JSON.parse(r.payload), session_id: r.session_id, at: r.at }));

  const from = child.style_level;
  const to = nextStyleLevel(events, from, false);
  if (to !== from) {
    db.transaction(() => {
      const stamp = now();
      updateChild(db, childId, { style_level: to });
      appendEvent(db, { childId, sessionId: null, at: stamp }, 'style_change', { from, to }, stamp);
    });
  }
  return to;
}
