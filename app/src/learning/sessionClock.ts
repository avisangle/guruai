// One active clock per open session, shared by the screens of that sitting (lesson, queue,
// goodbye). In memory only: a killed app loses it, as closeOpenSessions expects.
import { now, type Db } from '../data/db';
import { createActiveClock, type ActiveClock } from './activeClock';
import { endSession, type EndReason } from './session';

const clocks = new Map<string, ActiveClock>();

/** The session's clock, started on first use. */
export function sessionClock(sessionId: string): ActiveClock {
  let clock = clocks.get(sessionId);
  if (!clock) {
    clock = createActiveClock();
    clock.start(Date.now());
    clocks.set(sessionId, clock);
  }
  return clock;
}

/** Ends the session now with its active time, and forgets its clock. */
export function endSessionNow(db: Db, sessionId: string, reason: Exclude<EndReason, 'closed'>, parentHelps: boolean): void {
  const at = now();
  endSession(db, sessionId, reason, { at, activeMs: sessionClock(sessionId).activeMs(Date.parse(at)), parentHelps });
  clocks.delete(sessionId);
}
