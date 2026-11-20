// Active time for the session cap (PRD Learning model): paused spans and silence
// past SILENCE_MS do not count. Pure; the caller passes times in ms.

/** A silence counts up to this long; the rest is idle. */
export const SILENCE_MS = 20_000;

export type ActiveClock = {
  start(at: number): void;
  pause(at: number): void;
  resume(at: number): void;
  /** Tutor speech, child speech or a touch. */
  activity(at: number): void;
  activeMs(at: number): number;
};

export function createActiveClock(): ActiveClock {
  let running = false;
  let last = 0; // time of the last activity, start or resume
  let banked = 0; // active ms up to `last`

  const since = (at: number) => (running ? Math.min(Math.max(at - last, 0), SILENCE_MS) : 0);
  const mark = (at: number) => {
    banked += since(at);
    last = at;
  };
  const run = (at: number) => {
    running = true;
    last = at;
  };

  return {
    start: run,
    resume: run,
    pause(at) {
      mark(at);
      running = false;
    },
    activity: mark,
    activeMs: (at) => banked + since(at),
  };
}
