// GURU-25: parent gate screens and parent-mode shell. Spec: issue GURU-25, PRD Happy Path
// "Parent mode" 1 and 4, Edge Cases (PIN forgotten, screen lock removed), wireframes g-longpress,
// g-unlock, g-pin, g-pin-wrong, g-pin-wait30/5/15, p-lock-pin, auto-return (decision 13).
//
// Gate API (GURU-13, app/src/parent/gate.ts, D-GURU-13-parent-gate): state(), unlockWithDevice(msg),
// verifyPin(pin) -> { ok, waitUntil? } (epoch ms), setPin(pin), recoverWithBiometrics(msg).
// The tests drive a fake gate; lockout lengths come from the real lockoutFor.
//
// Contract pinned here for /implement:
//   ParentLock.tsx          export ParentLock: no props; host element testID "parent-lock";
//                           a 2,000 ms hold pushes /parent/unlock.
//   ParentModeProvider.tsx  export ParentModeProvider({ gate?: Gate, children }); mounted in the
//                           root layout around the Stack; without `gate` it uses the live gate.
//                           Touches are seen through `touchStart` bubbling to it.
//   app/parent/_layout.tsx  default export; redirects to /parent/unlock without an unlocked session.
//   app/parent/unlock.tsx   default export; keypad digits are buttons named "0".."9", the
//                           fingerprint key is a button whose name contains "बोटा".
//   app/parent/index.tsx    default export; placeholder.
// Screen copy is the wireframes' Marathi (the default language), read from the string tables.
import * as fs from 'fs';
import * as path from 'path';
import type { ComponentType } from 'react';
import { Stack, router } from 'expo-router';
import { userEvent } from '@testing-library/react-native';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { AppState, StyleSheet, Text, View, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LanguageProvider } from '../ui/i18n';
import { theme } from '../ui/theme';
import type { Gate, GateMode, GateState, PinResult } from './gate';
import { lockoutFor } from './lockout';

type LockModule = typeof import('./ParentLock');
type ProviderModule = typeof import('./ParentModeProvider');
type RouteModule = { default: ComponentType };

// Live-gate defaults must never reach native code in tests.
jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn() }));
jest.mock(
  'expo-local-authentication',
  () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: jest.fn(async () => 0),
    authenticateAsync: jest.fn(async () => ({ success: false, error: 'not_available' })),
  }),
  { virtual: true },
);
jest.mock(
  'expo-secure-store',
  () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }),
  { virtual: true },
);
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const SEC = 1000;
const MIN = 60 * SEC;
const PIN = '2580';

const APP = path.resolve(__dirname, '../..');
const SHELL_FILES = [
  'src/parent/ParentLock.tsx',
  'src/parent/ParentModeProvider.tsx',
  'src/app/parent/_layout.tsx',
  'src/app/parent/unlock.tsx',
  'src/app/parent/index.tsx',
];

// Mirrors the real gate's lockout rules; state() follows setPin like the real one.
function fakeGate(initial: GateState) {
  let stored: string | null = initial === 'pin' ? PIN : null;
  let failed = 0;
  let until = 0;
  return {
    mode: jest.fn(async (): Promise<GateMode> => (stored ? 'pin' : 'device')),
    deviceLockAvailable: jest.fn(async () => initial !== 'needs_pin_setup'),
    state: jest.fn(async (): Promise<GateState> => (stored ? 'pin' : initial)),
    unlockWithDevice: jest.fn((_message?: string): Promise<boolean> => Promise.resolve(true)),
    setPin: jest.fn(async (pin: string) => {
      stored = pin;
    }),
    verifyPin: jest.fn(async (pin: string, at: number = Date.now()): Promise<PinResult> => {
      if (at < until) return { ok: false, waitUntil: until };
      if (pin === stored) {
        failed = 0;
        until = 0;
        return { ok: true };
      }
      failed += 1;
      const wait = lockoutFor(failed);
      if (!wait) return { ok: false };
      until = at + wait;
      return { ok: false, waitUntil: until };
    }),
    recoverWithBiometrics: jest.fn((_message?: string): Promise<boolean> => Promise.resolve(true)),
  };
}
type FakeGate = ReturnType<typeof fakeGate>;

// AppState: every 'change' listener is kept so a test can send the app to the background.
const appStateListeners = new Set<(state: AppStateStatus) => void>();
function emitAppState(state: AppStateStatus) {
  act(() => appStateListeners.forEach((listener) => listener(state)));
}

/** The app tree as the root layout should build it, with the fake gate injected. */
async function renderShell(gate: FakeGate, initialUrl = '/') {
  const { ParentLock } = require('./ParentLock') as LockModule;
  const { ParentModeProvider } = require('./ParentModeProvider') as ProviderModule;
  const route = (p: string) => (require(p) as RouteModule).default;
  const routes = {
    _layout: function TestRoot() {
      return (
        <SafeAreaProvider>
          <LanguageProvider onChange={() => undefined}>
            <ParentModeProvider gate={gate as Gate}>
              <Stack screenOptions={{ headerShown: false }} />
              <Text testID="anywhere">.</Text>
            </ParentModeProvider>
          </LanguageProvider>
        </SafeAreaProvider>
      );
    },
    index: function ChildHome() {
      return (
        <View>
          <Text>child-home</Text>
          <ParentLock />
        </View>
      );
    },
    'parent/_layout': route('../app/parent/_layout'),
    'parent/unlock': route('../app/parent/unlock'),
    'parent/index': route('../app/parent/index'),
  };
  const result = await renderRouter(routes, { initialUrl });
  await settle();
  return result;
}

/** Lets pending gate promises resolve and their state updates render. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

async function go(href: '/parent' | '/parent/unlock') {
  await act(async () => {
    router.push(href);
  });
  await settle();
}

const key = (name: string | RegExp) => screen.getByRole('button', { name });

async function enter(digits: string) {
  for (const d of digits) fireEvent.press(key(d));
  await settle();
}

/** Presses digits if the keys are shown at all; a disabled or hidden keypad must ignore them. */
async function tryEnter(digits: string) {
  for (const d of digits) {
    const k = screen.queryByRole('button', { name: d });
    if (k) fireEvent.press(k);
  }
  await settle();
}

const touchAnywhere = () => fireEvent(screen.getByTestId('anywhere'), 'touchStart', {});
const warning = () => screen.queryByText(/इथेच थांबा/);

beforeEach(() => {
  appStateListeners.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'change') appStateListeners.add(listener as (state: AppStateStatus) => void);
    return {
      remove: () => {
        appStateListeners.delete(listener as (state: AppStateStatus) => void);
      },
    } as NativeEventSubscription;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('GURU-25 parent gate screens and parent-mode shell', () => {
  test('ParentLock: 48 dp hit area; only a 2,000 ms hold opens /parent/unlock, a shorter press does nothing', async () => {
    const gate = fakeGate('pin');
    await renderShell(gate);
    expect(screen).toHavePathname('/');

    const lock = screen.getByTestId('parent-lock');
    const style = (StyleSheet.flatten(lock.props.style) ?? {}) as Record<string, unknown>;
    const slop = lock.props.hitSlop as number | { top?: number; bottom?: number; left?: number; right?: number } | undefined;
    const s = typeof slop === 'number' ? { top: slop, bottom: slop, left: slop, right: slop } : (slop ?? {});
    const width = Number(style.width ?? style.minWidth ?? 0) + (s.left ?? 0) + (s.right ?? 0);
    const height = Number(style.height ?? style.minHeight ?? 0) + (s.top ?? 0) + (s.bottom ?? 0);
    expect(width).toBeGreaterThanOrEqual(theme.touch.parentGate.hitArea);
    expect(height).toBeGreaterThanOrEqual(theme.touch.parentGate.hitArea);

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(lock);
    await user.longPress(screen.getByTestId('parent-lock'), { duration: 1500 });
    await settle();
    expect(screen).toHavePathname('/');

    await user.longPress(screen.getByTestId('parent-lock'), { duration: 2100 });
    await settle();
    expect(screen).toHavePathname('/parent/unlock');
  });

  test('device mode: /parent redirects to unlock, which shows the system prompt; cancel returns to the child side, success enters /parent', async () => {
    const gate = fakeGate('device');
    let answer!: (ok: boolean) => void;
    gate.unlockWithDevice.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));

    await renderShell(gate, '/parent');
    expect(screen).toHavePathname('/parent/unlock');
    expect(gate.unlockWithDevice).toHaveBeenCalledTimes(1);
    expect(gate.unlockWithDevice).toHaveBeenCalledWith(expect.stringMatching(/पालक विभाग उघडा/));
    expect(gate.verifyPin).not.toHaveBeenCalled();

    await act(async () => answer(false));
    await settle();
    expect(screen).toHavePathname('/');

    await go('/parent/unlock');
    expect(gate.unlockWithDevice).toHaveBeenCalledTimes(2);
    expect(screen).toHavePathname('/parent');
  });

  test('pin mode: wrong PINs show tries left, every 3rd starts a wait with an m:ss countdown and a disabled keypad; the right PIN enters /parent', async () => {
    const gate = fakeGate('pin');
    await renderShell(gate, '/parent');
    expect(screen).toHavePathname('/parent/unlock');
    expect(gate.unlockWithDevice).not.toHaveBeenCalled();

    await enter('1111');
    expect(gate.verifyPin).toHaveBeenCalledTimes(1);
    expect(gate.verifyPin.mock.calls[0][0]).toBe('1111');
    expect(screen.getByText(/अजून 2 प्रयत्न बाकी/)).toBeTruthy();
    expect(screen).toHavePathname('/parent/unlock');

    // The dots cleared: the next four digits are a fresh PIN.
    await enter('2222');
    expect(gate.verifyPin.mock.calls[1][0]).toBe('2222');
    expect(screen.getByText(/अजून 1 प्रयत्न बाकी/)).toBeTruthy();

    await enter('3333');
    expect(screen.getByText(/थोडं थांबा/)).toBeTruthy();
    expect(screen.getByText(/30 सेकंदांनी/)).toBeTruthy();
    expect(screen.getByText(/0:30/)).toBeTruthy();

    await advance(6 * SEC);
    expect(screen.getByText(/0:24/)).toBeTruthy();

    // Keypad is off during the wait: nothing reaches the gate.
    await tryEnter(PIN);
    expect(gate.verifyPin).toHaveBeenCalledTimes(3);
    expect(screen).toHavePathname('/parent/unlock');

    await advance(24 * SEC);
    expect(screen.queryByText(/थोडं थांबा/)).toBeNull();

    // Three more wrong PINs: the second stage, 5 minutes.
    await enter('1111');
    await enter('1111');
    await enter('1111');
    expect(screen.getByText(/5 मिनिटांनी/)).toBeTruthy();
    expect(screen.getByText(/5:00/)).toBeTruthy();

    await advance(5 * MIN);
    await enter(PIN);
    expect(gate.verifyPin).toHaveBeenLastCalledWith(PIN);
    expect(screen).toHavePathname('/parent');
  });

  test('needs_pin_setup: the PIN set and confirm rows show first; a mismatch clears the second row and saves nothing; a match saves and enters /parent', async () => {
    const gate = fakeGate('needs_pin_setup');
    await renderShell(gate, '/parent/unlock');
    expect(gate.unlockWithDevice).not.toHaveBeenCalled();
    expect(screen.getByText(/तोच PIN पुन्हा/)).toBeTruthy();

    await enter('1357');
    await enter('1375');
    expect(screen.getByText(/दोन्ही PIN जुळले नाहीत/)).toBeTruthy();
    expect(gate.setPin).not.toHaveBeenCalled();
    expect(screen).toHavePathname('/parent/unlock');

    // Only the second row was cleared: four more digits complete the pair.
    await enter('1357');
    expect(gate.setPin).toHaveBeenCalledTimes(1);
    expect(gate.setPin).toHaveBeenCalledWith('1357');
    expect(gate.verifyPin).not.toHaveBeenCalled();
    expect(screen).toHavePathname('/parent');
  });

  test('forgotten PIN: the fingerprint key runs biometric recovery; a refusal stays on the keypad, success leads to setting a new PIN and enters /parent', async () => {
    const gate = fakeGate('pin');
    gate.recoverWithBiometrics.mockResolvedValueOnce(false);
    await renderShell(gate, '/parent/unlock');

    fireEvent.press(key(/बोटा/));
    await settle();
    expect(gate.recoverWithBiometrics).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/तोच PIN पुन्हा/)).toBeNull();
    expect(screen).toHavePathname('/parent/unlock');

    fireEvent.press(key(/बोटा/));
    await settle();
    expect(gate.recoverWithBiometrics).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/तोच PIN पुन्हा/)).toBeTruthy();

    await enter('2468');
    await enter('2468');
    expect(gate.setPin).toHaveBeenCalledWith('2468');
    expect(gate.verifyPin).not.toHaveBeenCalled();
    expect(screen).toHavePathname('/parent');
  });

  test('auto-return: only while unlocked, 2 min without a touch shows "इथेच थांबा", a touch or the button cancels it, 10 s later it returns to / and locks', async () => {
    const gate = fakeGate('device');
    await renderShell(gate, '/');

    // Child mode never times out.
    await advance(5 * MIN);
    expect(warning()).toBeNull();
    expect(screen).toHavePathname('/');

    await go('/parent');
    expect(screen).toHavePathname('/parent');

    // A touch restarts the 2 minutes.
    await advance(110 * SEC);
    touchAnywhere();
    await advance(115 * SEC);
    expect(warning()).toBeNull();
    expect(screen).toHavePathname('/parent');
    await advance(5.5 * SEC);
    expect(warning()).not.toBeNull();

    // The button cancels the warning.
    fireEvent.press(screen.getByText(/इथेच थांबा/));
    await settle();
    expect(warning()).toBeNull();
    await advance(15 * SEC);
    expect(screen).toHavePathname('/parent');

    // Any touch during the warning cancels it too.
    await advance(105.5 * SEC);
    expect(warning()).not.toBeNull();
    touchAnywhere();
    await settle();
    expect(warning()).toBeNull();

    // Untouched: warning at 2:00, back to the child side at 2:10.
    await advance(119 * SEC);
    expect(warning()).toBeNull();
    await advance(1.5 * SEC);
    expect(warning()).not.toBeNull();
    await advance(8.5 * SEC);
    expect(screen).toHavePathname('/parent');
    await advance(1 * SEC);
    expect(screen).toHavePathname('/');
    expect(warning()).toBeNull();

    // The session ended: /parent needs the unlock again.
    gate.unlockWithDevice.mockImplementation(() => new Promise<boolean>(() => undefined));
    await go('/parent');
    expect(screen).toHavePathname('/parent/unlock');
  });

  test('auto-return: the app going to the background while unlocked returns to / at once and locks', async () => {
    const gate = fakeGate('device');
    await renderShell(gate, '/parent');
    expect(screen).toHavePathname('/parent');

    emitAppState('background');
    await settle();
    expect(screen).toHavePathname('/');

    emitAppState('active');
    await settle();
    expect(screen).toHavePathname('/');

    gate.unlockWithDevice.mockImplementation(() => new Promise<boolean>(() => undefined));
    await go('/parent');
    expect(screen).toHavePathname('/parent/unlock');
  });

  test('wiring and repo rules: root layout mounts the providers; shell sources hold no colour literals and no Marathi text', () => {
    // Parent screens read their strings through useT and their session through ParentModeProvider.
    const root = fs.readFileSync(path.join(APP, 'src/app/_layout.tsx'), 'utf8');
    expect(root).toMatch(/<ParentModeProvider[\s>]/);
    expect(root).toMatch(/<LanguageProvider[\s>]/);

    const HEX = /#[0-9a-fA-F]{3,8}\b/;
    const RGB = /rgba?\(/;
    const DEVANAGARI = /[ऀ-ॿ]/;
    for (const file of SHELL_FILES) {
      const source = fs.readFileSync(path.join(APP, file), 'utf8');
      expect({ file, colour: HEX.test(source) || RGB.test(source) }).toEqual({ file, colour: false });
      expect({ file, marathi: DEVANAGARI.test(source) }).toEqual({ file, marathi: false });
    }
  });

  // Contract for GURU-29 (<ParentLock /> on child screens), GURU-30 (parent shell and routes)
  // and GURU-31 (parent shell). Shape only.
  test('contract (GURU-29, GURU-30, GURU-31): ParentLock, ParentModeProvider and the /parent routes are exported as promised', () => {
    const lock = require('./ParentLock') as LockModule;
    expect(typeof lock.ParentLock).toBe('function');

    const provider = require('./ParentModeProvider') as ProviderModule;
    expect(typeof provider.ParentModeProvider).toBe('function');

    for (const p of ['../app/parent/_layout', '../app/parent/unlock', '../app/parent/index']) {
      expect({ route: p, type: typeof (require(p) as RouteModule).default }).toEqual({ route: p, type: 'function' });
    }
  });
});
