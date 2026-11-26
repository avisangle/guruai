// GURU-44: the frame gate decides which display frames step Shekru's rig.
//
// Pinned here (the implementation follows these names):
// - app/src/shekru/frameGate.ts exports SHEKRU_FPS (20 to 30) and
//   frameGate(state: { sinceStep: number }, dtSeconds: number, fps?: number): number | null.
//   It returns the seconds to advance the rig clock by, or null to skip this display frame, and
//   keeps its bookkeeping in the state object it is given (one per rig).
// - A step is never longer than 0.1 s, the clamp useShekruRig.ts applies today.
//
// Facts read, not assumed:
// - reanimated 4.7.1 useFrameCallback: timeSincePreviousFrame is null on the first frame after
//   activation (the hook turns that into 0 s), then about 16.7 ms at 60 Hz and 8.3 ms at 120 Hz.
// - Under jest the worklets babel plugin still runs, so a function with the 'worklet' directive
//   carries the plugin's marker properties; a plain function carries none.
//
// The export-shape contract test is in useShekruRig.test.tsx.
import { frameGate, SHEKRU_FPS } from './frameGate';

// The gate must stay loadable as plain JS: importing either library here is a failure.
jest.mock('react-native-reanimated', () => {
  throw new Error('frameGate.ts must not import react-native-reanimated');
});
jest.mock('react-native-worklets', () => {
  throw new Error('frameGate.ts must not import react-native-worklets');
});

const FRAME = 16.7 / 1000; // one 60 Hz display frame, in seconds
const EPS = 1e-9;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const frames = (n: number, seconds: number) => Array<number>(n).fill(seconds);

// Feeds display frames to the gate; returns the elapsed time of each step it allowed.
function run(state: { sinceStep: number }, dts: number[], fps?: number) {
  const steps: number[] = [];
  for (const dt of dts) {
    const step = fps === undefined ? frameGate(state, dt) : frameGate(state, dt, fps);
    if (step !== null) steps.push(step);
  }
  return steps;
}

describe('GURU-44 frameGate', () => {
  test.each([
    ['SHEKRU_FPS by default', undefined],
    ['20 when asked', 20],
    ['30 when asked', 30],
  ])('60 display frames of 16.7 ms step the rig %s (plus or minus 1) and lose no time', (_name, fps) => {
    expect(SHEKRU_FPS).toBeGreaterThanOrEqual(20);
    expect(SHEKRU_FPS).toBeLessThanOrEqual(30);
    const want = fps ?? SHEKRU_FPS;

    const steps = run({ sinceStep: 0 }, frames(60, FRAME), fps);

    expect(steps.length).toBeGreaterThanOrEqual(want - 1);
    expect(steps.length).toBeLessThanOrEqual(want + 1);
    for (const step of steps) expect(step).toBeGreaterThan(0);
    // skipped frames are carried into the next step, not dropped
    expect(Math.abs(sum(steps) - 60 * FRAME)).toBeLessThanOrEqual(FRAME + EPS);
  });

  test('on a 120 Hz display the rig still steps at most SHEKRU_FPS times a second', () => {
    const steps = run({ sinceStep: 0 }, frames(120, 1 / 120));

    expect(steps.length).toBeLessThanOrEqual(SHEKRU_FPS + 1);
    // all but the time still waiting for the next step has been handed over
    expect(sum(steps)).toBeLessThanOrEqual(1 + EPS);
    expect(sum(steps)).toBeGreaterThanOrEqual(1 - 1 / SHEKRU_FPS - 1e-6);
  });

  test('display frames already slower than the cap all step, each by its own length', () => {
    // 73 ms is the median frame from the 2026-11-25 phone test: the cap must not slow that further
    const steps = run({ sinceStep: 0 }, frames(30, 0.073));

    expect(steps).toHaveLength(30);
    for (const step of steps) expect(step).toBeCloseTo(0.073, 6);
  });

  test('after a pause the first step advances at most 0.1 s and the gap is not replayed', () => {
    const state = { sinceStep: 0 };
    expect(frameGate(state, FRAME)).toBeNull(); // paused with a little time waiting
    // first frame after reactivation carries no elapsed time: nothing to step by
    expect(frameGate(state, 0)).toBeNull();
    expect(frameGate(state, 0)).toBeNull();

    const first = frameGate(state, 5); // a 5 s gap, should the platform ever report one
    expect(first).not.toBeNull();
    expect(first as number).toBeGreaterThan(0);
    expect(first as number).toBeLessThanOrEqual(0.1 + EPS);

    // the dropped 4.9 s does not come back on later frames
    const after = run(state, frames(60, FRAME));
    for (const step of after) expect(step).toBeLessThanOrEqual(0.1 + EPS);
    expect(Math.abs(sum(after) - 60 * FRAME)).toBeLessThanOrEqual(FRAME + EPS);
  });

  test('two rigs gate independently: all bookkeeping is in the state passed in', () => {
    // child home stays mounted under a lesson, so two gates can run in one process
    const home = { sinceStep: 0 };
    const lesson = { sinceStep: 0 };
    const homeSteps: number[] = [];
    const lessonSteps: number[] = [];
    for (let i = 0; i < 60; i++) {
      const a = frameGate(home, FRAME);
      if (a !== null) homeSteps.push(a);
      const b = frameGate(lesson, FRAME / 2);
      if (b !== null) lessonSteps.push(b);
    }

    expect(homeSteps.length).toBeGreaterThanOrEqual(SHEKRU_FPS - 1);
    expect(homeSteps.length).toBeLessThanOrEqual(SHEKRU_FPS + 1);
    expect(Math.abs(sum(homeSteps) - 60 * FRAME)).toBeLessThanOrEqual(FRAME + EPS);
    expect(sum(lessonSteps)).toBeLessThanOrEqual(30 * FRAME + EPS);
    expect(sum(lessonSteps)).toBeGreaterThanOrEqual(30 * FRAME - 1 / SHEKRU_FPS - 1e-6);
  });

  test('frameGate is a worklet, so the frame callback can call it on the UI thread', () => {
    function control() {
      'worklet';
      return 0;
    }
    const marks = Object.keys(control);
    expect(marks.length).toBeGreaterThan(0); // the plugin ran on this file
    expect(Object.keys(frameGate)).toEqual(expect.arrayContaining(marks));
  });
});
