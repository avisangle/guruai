// One active clock per open session, shared by the screens of that sitting (lesson, queue,
// goodbye). In memory only: a killed app loses it, as closeOpenSessions expects.
import { createActiveClock, type ActiveClock } from './activeClock';

const clocks = new Map<string, ActiveClock>();

/** The session's clock, started at `at` (ms) on first use. */
export function sessionClock(sessionId: string, at = Date.now()): ActiveClock {
  let clock = clocks.get(sessionId);
  if (!clock) {
    clock = createActiveClock();
    clock.start(at);
    clocks.set(sessionId, clock);
  }
  return clock;
}

/** Forgets an ended session's clock. */
export function dropSessionClock(sessionId: string): void {
  clocks.delete(sessionId);
}
