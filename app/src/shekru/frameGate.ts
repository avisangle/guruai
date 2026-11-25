// Decides which display frames step Shekru's rig. Pure, so jest runs it as plain JS.

// Rig steps per second: docs/decisions/D-GURU-44-shekru-frame-cap.md.
export const SHEKRU_FPS = 20;
// Longest single step, so the rig does not jump after a pause or a stall.
const MAX_STEP = 0.1;
// Frame times jitter; without slack a frame landing a hair early waits one more display frame.
const SLACK = 0.001;

// Returns the seconds to advance the rig clock by, or null to skip this display frame.
// Skipped time waits in `state` for the next step, so animation speed is unchanged.
export function frameGate(state: { sinceStep: number }, dtSeconds: number, fps: number = SHEKRU_FPS): number | null {
  'worklet';
  state.sinceStep += dtSeconds;
  if (state.sinceStep < 1 / fps - SLACK) return null;
  const step = Math.min(MAX_STEP, state.sinceStep);
  state.sinceStep = 0;
  return step;
}
