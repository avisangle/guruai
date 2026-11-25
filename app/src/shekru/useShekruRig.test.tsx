// GURU-44: useShekruRig pauses its frame callback off screen and steps the rig through the frame gate.
//
// Facts read, not assumed:
// - reanimated 4.7.1: useFrameCallback(callback, autostart = true) returns a stable
//   { setActive(isActive), isActive, callbackId }; timeSincePreviousFrame is null on the first frame
//   after activation.
// - expo-router 58 exports useFocusEffect(effect) and useIsFocused().
// - @react-native/jest-preset mocks AppState with currentState = jest.fn(), so it is set to 'active' here.
// - useShekruRig.ts builds its rig with makeEngine().createRig(rigJson, animJson, { seed }) inside
//   scheduleOnUI and steps it with rig.update(clock, { speechTime }).
//
// What is replaced, and why:
//   react-native-reanimated  shared values are plain objects; useFrameCallback hands the callback and
//                            a setActive spy to the test, which then plays the display frames itself
//   react-native-worklets    scheduleOnUI / scheduleOnRN run the function at once on this thread
//   ./generated/engine       a rig that records the clock of every update()
//   expo-router              focus is a switch the test flips; useFocusEffect and useIsFocused both
//                            follow it, so either can be used. Other focus APIs are not provided.
//   AppState                 'change' listeners are kept so a test can send the app to the background
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import { useShekruRig } from './useShekruRig';

type FrameInfo = { timestamp: number; timeSincePreviousFrame: number | null; timeSinceFirstFrame: number };

const mockFrame = {
  callback: null as ((info: FrameInfo) => void) | null,
  active: true,
  setActive: jest.fn((on: boolean) => {
    mockFrame.active = on;
  }),
};
jest.mock('react-native-reanimated', () => ({
  makeMutable: (v: unknown) => ({ value: v }),
  useSharedValue: (v: unknown) => ({ value: v }),
  useFrameCallback: (callback: (info: FrameInfo) => void, autostart = true) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const handle = require('react').useRef(null);
    if (!handle.current) {
      mockFrame.active = autostart;
      handle.current = {
        setActive: mockFrame.setActive,
        get isActive() {
          return mockFrame.active;
        },
        callbackId: 1,
      };
    }
    mockFrame.callback = callback;
    return handle.current;
  },
}));

jest.mock('react-native-worklets', () => {
  const now = (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => fn(...args);
  const later = (fn: (...a: unknown[]) => unknown) => (...args: unknown[]) => fn(...args);
  return { scheduleOnUI: now, scheduleOnRN: now, runOnUI: later, runOnJS: later };
});

const mockUpdate = jest.fn((clock: number, opts?: { speechTime?: number }) => {
  void clock;
  void opts;
  return { order: [] as string[], parts: {}, state: 'idle' };
});
jest.mock('./generated/engine', () => ({
  makeEngine: () => ({
    createRig: () => ({
      update: (clock: number, opts?: { speechTime?: number }) => mockUpdate(clock, opts),
      setState: jest.fn(),
      setSpeech: jest.fn(),
      setReducedMotion: jest.fn(),
    }),
  }),
}));

const mockFocus = { focused: true, listeners: new Set<() => void>() };
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const subscribe = (fn: () => void) => {
    mockFocus.listeners.add(fn);
    return () => mockFocus.listeners.delete(fn);
  };
  const useIsFocused = () => React.useSyncExternalStore(subscribe, () => mockFocus.focused);
  return {
    useIsFocused,
    // Runs the effect while focused and its cleanup on blur, like the real one.
    useFocusEffect: (effect: () => void | (() => void)) => {
      const focused = useIsFocused();
      React.useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
  };
});

function setFocused(focused: boolean) {
  act(() => {
    mockFocus.focused = focused;
    for (const fn of [...mockFocus.listeners]) fn();
  });
}

const appStateListeners = new Set<(state: AppStateStatus) => void>();
// jest.replaceProperty refuses a jest.fn(), so the preset's value is swapped by hand.
const appState = AppState as { currentState: unknown };
const presetCurrentState = appState.currentState;
let addListener: jest.SpiedFunction<typeof AppState.addEventListener>;
function emitAppState(state: AppStateStatus) {
  act(() => {
    appState.currentState = state;
    for (const fn of [...appStateListeners]) fn(state);
  });
}

const FRAME_MS = 16.7;
// One display frame, as reanimated reports it to the frame callback.
function frame(ms: number | null) {
  mockFrame.callback?.({ timestamp: 0, timeSincePreviousFrame: ms, timeSinceFirstFrame: 0 });
}
const clocks = () => mockUpdate.mock.calls.map(([clock]) => clock);
const lastClock = () => clocks().at(-1) ?? 0;

beforeEach(() => {
  mockFrame.callback = null;
  mockFrame.active = true;
  mockFrame.setActive.mockClear();
  mockUpdate.mockClear();
  mockFocus.focused = true;
  mockFocus.listeners.clear();
  appStateListeners.clear();
  appState.currentState = 'active';
  addListener = jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') appStateListeners.add(listener as (state: AppStateStatus) => void);
    return {
      remove: () => {
        appStateListeners.delete(listener as (state: AppStateStatus) => void);
      },
    } as NativeEventSubscription;
  });
});

afterEach(() => {
  appState.currentState = presetCurrentState;
  addListener.mockRestore();
});

describe('GURU-44 useShekruRig pauses off screen', () => {
  test('blurring the screen calls setActive(false) on the frame callback, focusing calls setActive(true)', () => {
    renderHook(() => useShekruRig());
    expect(mockFrame.active).toBe(true); // focused and in the foreground: running

    setFocused(false);
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(false);
    expect(mockFrame.active).toBe(false);

    setFocused(true);
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(true);
    expect(mockFrame.active).toBe(true);
  });

  test('AppState background calls setActive(false), active calls setActive(true); inactive also pauses', () => {
    renderHook(() => useShekruRig());

    emitAppState('background');
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(false);
    expect(mockFrame.active).toBe(false);

    emitAppState('active');
    expect(mockFrame.setActive).toHaveBeenLastCalledWith(true);
    expect(mockFrame.active).toBe(true);

    emitAppState('inactive');
    expect(mockFrame.active).toBe(false);
    emitAppState('active');
    expect(mockFrame.active).toBe(true);
  });

  test('a blurred screen stays paused when the app comes back to the foreground', () => {
    // child home under an open lesson: the app returning must not restart its rig
    renderHook(() => useShekruRig());
    setFocused(false);

    emitAppState('background');
    emitAppState('active');
    expect(mockFrame.active).toBe(false);

    setFocused(true);
    expect(mockFrame.active).toBe(true);

    // and a focused screen stays paused while the app is in the background
    emitAppState('background');
    setFocused(false);
    setFocused(true);
    expect(mockFrame.active).toBe(false);
    emitAppState('active');
    expect(mockFrame.active).toBe(true);
  });
});

describe('GURU-44 useShekruRig steps the rig through the frame gate', () => {
  test('60 display frames step the rig 20 to 30 times at real speed; a step after a pause is at most 0.1 s', () => {
    const { result } = renderHook(() => useShekruRig());
    expect(mockFrame.callback).not.toBeNull();

    frame(null); // first frame after activation
    const start = clocks().length;
    for (let i = 0; i < 60; i++) frame(FRAME_MS);
    const steps = clocks().length - start;
    const real = (60 * FRAME_MS) / 1000;

    // SHEKRU_FPS is 20 to 30, plus or minus 1; stepping on every display frame gives 60
    expect(steps).toBeGreaterThanOrEqual(19);
    expect(steps).toBeLessThanOrEqual(31);
    // the rig clock still runs at real speed: animation timing is unchanged
    expect(Math.abs(lastClock() - real)).toBeLessThanOrEqual(FRAME_MS / 1000 + 1e-9);

    // lip-sync: the audio position still reaches the rig on the next step
    act(() => result.current.syncSpeech(true, 1.5));
    for (let i = 0; i < 6; i++) frame(FRAME_MS);
    const speechTime = mockUpdate.mock.calls.at(-1)?.[1]?.speechTime;
    expect(speechTime).toBeGreaterThanOrEqual(1.5);
    expect(speechTime).toBeLessThanOrEqual(1.8);

    // pause, then resume with the worst case: a frame that reports a 5 s gap
    setFocused(false);
    setFocused(true);
    const beforePause = lastClock();
    frame(null);
    frame(5000);
    for (let i = 0; i < 60; i++) frame(FRAME_MS);

    const all = clocks();
    expect(lastClock()).toBeGreaterThan(beforePause); // it resumed
    for (let i = 1; i < all.length; i++) {
      expect(all[i] - all[i - 1]).toBeGreaterThanOrEqual(0);
      expect(all[i] - all[i - 1]).toBeLessThanOrEqual(0.1 + 1e-9);
    }
    // the 5 s gap is not replayed afterwards
    expect(lastClock() - beforePause).toBeLessThanOrEqual(0.1 + real + FRAME_MS / 1000 + 1e-9);
  });
});

// No issue depends on GURU-44 yet ("Needed by: none"). The consumers are the hosts of the hook:
// child home, LessonPlayer, LessonScreen, goodbye and demo. Shape only.
describe('GURU-44 contract for dependents (hosts of useShekruRig)', () => {
  test('frameGate.ts exports SHEKRU_FPS and frameGate(state, dtSeconds, fps?); useShekruRig still returns { values, setState, setSpeech, syncSpeech }', () => {
    const gate = jest.requireActual('./frameGate') as Record<string, unknown>;
    expect(typeof gate.SHEKRU_FPS).toBe('number');
    expect(typeof gate.frameGate).toBe('function');
    const frameGate = gate.frameGate as (state: { sinceStep: number }, dt: number, fps?: number) => number | null;
    const state = { sinceStep: 0 };
    expect(frameGate(state, 0.001, 20)).toBeNull();
    expect(typeof frameGate(state, 0.06, 20)).toBe('number');
    expect(typeof frameGate({ sinceStep: 0 }, 0.06)).toBe('number');
    expect(typeof state.sinceStep).toBe('number');

    const { result } = renderHook(() => useShekruRig(jest.fn()));
    expect(Object.keys(result.current).sort()).toEqual(['setSpeech', 'setState', 'syncSpeech', 'values']);
    expect(typeof result.current.setState).toBe('function');
    expect(typeof result.current.setSpeech).toBe('function');
    expect(typeof result.current.syncSpeech).toBe('function');
    const parts = Object.values(result.current.values);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) expect(part).toHaveProperty('value');
  });
});
