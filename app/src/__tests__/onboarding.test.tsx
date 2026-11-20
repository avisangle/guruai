// GURU-24: first-run onboarding. Spec: issue GURU-24, PRD Happy Path (first run), wireframes
// p-welcome, p-lock, p-lock-pin, p-who, p-mic (decisions 3, 4, 16, 17), D-GURU-13-parent-gate.
// Lives outside src/app/: Expo Router turns every .tsx file there into a route and bundles it.
//
// The real route files render through expo-router's renderRouter. `/` is a stub child picker
// (GURU-29 owns the real one). Only native modules and the downloader are faked:
//   expo-sqlite                one in-memory better-sqlite3 database behind openDatabaseSync,
//                              so openDb() anywhere in the app reads and writes it
//   expo-local-authentication  enrolled level decides deviceLockAvailable() (SECRET 1 = screen lock)
//   expo-secure-store          in-memory map (the gate keeps the PIN record there)
//   expo-crypto                node crypto behind expo-crypto's names
//   expo-audio                 requestRecordingPermissionsAsync is the mic request (as in useRecording.ts)
//   downloads/downloader       queueChildPacks, startInitialDownloads
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   device(id, device_id, parent_lang TEXT NOT NULL DEFAULT 'mr', ..., mic_last_granted_at TEXT, ...)
//   child_profile(id, nickname, picture, class, board, medium, goals TEXT NOT NULL DEFAULT '[]',
//                 style_level, style_locked, lessons_per_day DEFAULT 3, active_cap_min, tutor DEFAULT 'shekru',
//                 child_code, setup_done, archived, created_at, updated_at)
//   parent_gate(id, mode TEXT NOT NULL DEFAULT 'device', failed, lockout_until, lockout_stage, ...)
//   path_enrollment(id, child_id, path_id, source, created_at, updated_at)
// Default goals per class: app/src/content/generated/paths.json `goals`.
//
// Contract pinned for /implement (testIDs; visible text comes from the string tables):
//   routes        /onboarding/welcome, /onboarding/lock, /onboarding/who; hand-over goes to /
//   welcome       language buttons show mr.langMr / mr.langEn; the start button shows t('getStarted')
//   lock          lock-device, lock-pin (choices; chosen = accessibilityState selected or checked),
//                 lock-next (shows t('next')), lock-no-screen-lock-note, pin-forgot-warning,
//                 pin-new, pin-again (TextInputs; the screen moves on by itself when both match),
//                 pin-mismatch (error after two different 4-digit entries; pin-again is cleared)
//   who           who-nickname (TextInput), picture-<id> (from PicturePicker),
//                 class-<Nursery|LKG|UKG|Class1|Class2>, medium-en, medium-mr, who-handover
//   PicturePicker named export; props { value?: string | null; onChange(id): void; taken?: string[] };
//                 one picture-<id> per picture, taken ones disabled
import { createElement as h } from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { openDb, type Db } from '../data/db';
import { getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import { createChild, listChildren } from '../data/profiles';
import pathsCatalogue from '../content/generated/paths.json';
import { createGate } from '../parent/gate';
import { en } from '../ui/strings/en';
import { mr } from '../ui/strings/mr';

// ---- native fakes ----

type Raw = { exec(sql: string): void; prepare(sql: string): { run(p: unknown[]): unknown; all(p: unknown[]): unknown[]; get(p: unknown[]): unknown }; transaction<T>(fn: () => T): () => T };
let mockRawDb: Raw | null = null;
function mockRaw(): Raw {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mockRawDb ??= new (require('better-sqlite3'))(':memory:') as Raw;
  return mockRawDb;
}
// better-sqlite3 rejects booleans; expo-sqlite binds them as 1/0.
const mockBind = (params: unknown[] = []) => params.map((p) => (typeof p === 'boolean' ? Number(p) : p));

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => {
    const raw = mockRaw();
    return {
      execSync: (sql: string) => raw.exec(sql),
      runSync: (sql: string, params: unknown[] = []) => raw.prepare(sql).run(mockBind(params)),
      getAllSync: (sql: string, params: unknown[] = []) => raw.prepare(sql).all(mockBind(params)),
      getFirstSync: (sql: string, params: unknown[] = []) => raw.prepare(sql).get(mockBind(params)) ?? null,
      withTransactionSync: (fn: () => void) => raw.transaction(fn)(),
    };
  }),
}));

const mockAuth = { level: 1 };
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(async () => mockAuth.level),
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => mockAuth.level >= 2),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockSecure.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockSecure.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockSecure.delete(k);
  }),
}));

jest.mock('expo-crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const c = require('crypto');
  const algo = (a: string) => a.replace('-', '').toLowerCase();
  const bytes = (d: ArrayBuffer | ArrayBufferView) =>
    ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  return {
    CryptoDigestAlgorithm: { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    randomUUID: () => c.randomUUID(),
    getRandomBytes: (n: number) => new Uint8Array(c.randomBytes(n)),
    getRandomBytesAsync: async (n: number) => new Uint8Array(c.randomBytes(n)),
    digest: async (a: string, d: ArrayBuffer | ArrayBufferView) => {
      const out: Buffer = c.createHash(algo(a)).update(bytes(d)).digest();
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },
    digestStringAsync: async (a: string, s: string, o?: { encoding?: string }) =>
      c.createHash(algo(a)).update(s).digest(o?.encoding === 'base64' ? 'base64' : 'hex'),
  };
});

jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: jest.fn(),
  getRecordingPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true, status: 'undetermined', expires: 'never' })),
}));

jest.mock('../downloads/downloader', () => ({
  startInitialDownloads: jest.fn(async () => undefined),
  queuePacks: jest.fn(async () => undefined),
  queueChildPacks: jest.fn(async () => undefined),
  isLessonInstalled: jest.fn(() => true),
  downloadStatus: jest.fn(() => ({})),
  subscribeDownloads: jest.fn(() => () => undefined),
}));

jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true, loadAsync: async () => undefined }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  hideAsync: jest.fn(async () => true),
  hide: jest.fn(),
  setOptions: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

/* eslint-disable @typescript-eslint/no-require-imports */
const micRequest = () => require('expo-audio').requestRecordingPermissionsAsync as jest.Mock;
const queueChildPacks = () => require('../downloads/downloader').queueChildPacks as jest.Mock;

// Route files load lazily, so a missing one fails its own test with "Cannot find module".
const ChildPickerStub = () => h(Text, null, 'child-picker');
function routes() {
  return {
    _layout: require('../app/_layout').default,
    index: ChildPickerStub,
    'onboarding/_layout': require('../app/onboarding/_layout').default,
    'onboarding/welcome': require('../app/onboarding/welcome').default,
    'onboarding/lock': require('../app/onboarding/lock').default,
    'onboarding/who': require('../app/onboarding/who').default,
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;

const SECRET = 1;
const NONE = 0;

/** Chosen = selected or checked, by accessibilityState or aria-*. */
function isChosen(testID: string): boolean {
  const p = screen.getByTestId(testID).props;
  return Boolean(p.accessibilityState?.selected || p.accessibilityState?.checked === true || p['aria-selected'] || p['aria-checked'] === true);
}

const gateMode = () => db.get<{ mode: string }>('SELECT mode FROM parent_gate LIMIT 1')?.mode ?? 'device';
const childCount = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM child_profile')!.n;

async function expectPath(router: { getPathname(): string }, path: string) {
  await waitFor(() => expect(router.getPathname()).toBe(path));
}

async function enterPins(first: string, second: string) {
  fireEvent.changeText(await screen.findByTestId('pin-new'), first);
  fireEvent.changeText(screen.getByTestId('pin-again'), second);
}

/** From the welcome screen to the who screen with the default parent lock. */
async function toWho(router: { getPathname(): string }) {
  fireEvent.press(await screen.findByText(mr.getStarted));
  await expectPath(router, '/onboarding/lock');
  const next = await screen.findByTestId('lock-next');
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.press(next);
  await expectPath(router, '/onboarding/who');
}

async function fillWho({ nickname = 'Chinu', cls = 'UKG', medium = 'en' } = {}) {
  fireEvent.changeText(await screen.findByTestId('who-nickname'), nickname);
  const picture = screen.getAllByTestId(/^picture-/)[0];
  fireEvent.press(picture);
  fireEvent.press(screen.getByTestId(`class-${cls}`));
  fireEvent.press(screen.getByTestId(`medium-${medium}`));
  return String(picture.props.testID).replace(/^picture-/, '');
}

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  // Wipe every table but keep the single device and parent_gate rows (the app may hold a gate
  // built over its row), reset to a fresh install's values.
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    if (name === 'device') db.run("UPDATE device SET parent_lang = 'mr', mic_last_granted_at = NULL");
    else if (name === 'parent_gate') db.run("UPDATE parent_gate SET mode = 'device', failed = 0, lockout_until = NULL");
    else db.run(`DELETE FROM "${name}"`);
  }
  mockSecure.clear();
  mockAuth.level = SECRET;
  jest.clearAllMocks();
  micRequest().mockImplementation(async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' }));
});

describe('GURU-24 onboarding', () => {
  test('no child profile opens the welcome screen in Marathi', async () => {
    const first = await renderRouter(routes(), { initialUrl: '/' });
    await expectPath(first, '/onboarding/welcome');
    expect(await screen.findByText(mr.getStarted)).toBeTruthy();
    expect(screen.getByText(mr.langMr)).toBeTruthy();
    expect(screen.getByText(mr.langEn)).toBeTruthy();
    expect(screen.queryByText('child-picker')).toBeNull();
  });

  test('with a child profile it never does', async () => {
    createChild(db, { nickname: 'Chinu', picture: 'any', class: 'UKG', medium: 'mr' });
    const second = await renderRouter(routes(), { initialUrl: '/' });
    expect(await screen.findByText('child-picker')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(50); // let any late redirect run
    });
    expect(second.getPathname()).toBe('/');
    expect(screen.queryByText(mr.getStarted)).toBeNull();
  });

  test('happy path: language switch persists, phone screen lock is the default, exactly 3 screens, hand-over saves defaults, enrols, queues packs, asks the mic once after saving, then the child picker', async () => {
    const router = await renderRouter(routes(), { initialUrl: '/' });
    const visited: string[] = [];

    // 1. Welcome: Marathi by default; English persists to device.parent_lang and later screens follow.
    await expectPath(router, '/onboarding/welcome');
    visited.push(router.getPathname());
    expect(await screen.findByText(mr.getStarted)).toBeTruthy();
    fireEvent.press(screen.getByText(mr.langEn));
    expect(await screen.findByText(en.getStarted)).toBeTruthy();
    expect(getDevice(db).parent_lang).toBe('en');

    // 2. Parent lock: the phone's screen lock is chosen; "Next" keeps it, no PIN is stored.
    fireEvent.press(screen.getByText(en.getStarted));
    await expectPath(router, '/onboarding/lock');
    visited.push(router.getPathname());
    expect(await screen.findByText(en.next)).toBeTruthy();
    expect(screen.queryByText(mr.next)).toBeNull();
    await waitFor(() => expect(isChosen('lock-device')).toBe(true));
    expect(isChosen('lock-pin')).toBe(false);
    expect(screen.queryByTestId('pin-forgot-warning')).toBeNull();
    fireEvent.press(screen.getByTestId('lock-next'));

    // 3. Who is learning: 5 classes, 2 media.
    await expectPath(router, '/onboarding/who');
    visited.push(router.getPathname());
    for (const cls of ['Nursery', 'LKG', 'UKG', 'Class1', 'Class2']) expect(screen.getByTestId(`class-${cls}`)).toBeTruthy();
    const picture = await fillWho({ nickname: 'Chinu', cls: 'UKG', medium: 'en' });

    // The mic is asked after the profile is saved (the adult still holds the phone).
    const childrenAtMicRequest: number[] = [];
    micRequest().mockImplementation(async () => {
      childrenAtMicRequest.push(childCount());
      return { granted: true, canAskAgain: true, status: 'granted', expires: 'never' };
    });
    const before = Date.now();
    fireEvent.press(screen.getByTestId('who-handover'));

    await expectPath(router, '/');
    expect(await screen.findByText('child-picker')).toBeTruthy();
    expect(visited).toEqual(['/onboarding/welcome', '/onboarding/lock', '/onboarding/who']);

    const children = listChildren(db);
    expect(children).toHaveLength(1);
    const child = children[0];
    expect(child).toMatchObject({
      nickname: 'Chinu',
      picture,
      class: 'UKG',
      medium: 'en',
      board: 'msb',
      goals: (pathsCatalogue.goals as Record<string, string[]>).UKG,
      style_level: 'en_led',
      lessons_per_day: 3,
      tutor: 'shekru',
    });
    expect(child.goals.length).toBeGreaterThan(0);

    const enrolled = db
      .all<{ path_id: string }>('SELECT path_id FROM path_enrollment WHERE child_id = ?', [child.id])
      .map((r) => r.path_id)
      .sort();
    expect(enrolled).toEqual(['class_msb_UKG', ...child.goals.map((g) => `skill_${g}`)].sort());

    expect(queueChildPacks()).toHaveBeenCalledTimes(1);
    expect(queueChildPacks().mock.calls[0][0]).toMatchObject({ id: child.id, class: 'UKG' });

    expect(micRequest()).toHaveBeenCalledTimes(1);
    expect(childrenAtMicRequest).toEqual([1]);
    const stamp = getDevice(db).mic_last_granted_at;
    expect(stamp).not.toBeNull();
    expect(Date.parse(stamp!)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(stamp!)).toBeLessThanOrEqual(Date.now() + 1000);

    expect(gateMode()).toBe('device');
    expect(mockSecure.size).toBe(0);
  });

  test('no screen lock forces the PIN: the phone-lock choice is disabled with its note, the PIN rows and warning are open, and a matching PIN is stored', async () => {
    mockAuth.level = NONE;
    const router = await renderRouter(routes(), { initialUrl: '/' });
    await expectPath(router, '/onboarding/welcome');
    fireEvent.press(await screen.findByText(mr.getStarted));
    await expectPath(router, '/onboarding/lock');

    await waitFor(() => expect(screen.getByTestId('lock-device')).toBeDisabled());
    expect(screen.getByTestId('lock-no-screen-lock-note')).toBeTruthy();
    expect(screen.getByTestId('pin-new')).toBeTruthy();
    expect(screen.getByTestId('pin-again')).toBeTruthy();
    expect(screen.getByTestId('pin-forgot-warning')).toBeTruthy();

    // No way past this screen without a PIN.
    fireEvent.press(screen.getByTestId('lock-device'));
    const next = screen.queryByTestId('lock-next');
    if (next) {
      fireEvent.press(next);
    }
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(router.getPathname()).toBe('/onboarding/lock');
    expect(screen.getByTestId('pin-new')).toBeTruthy();
    expect(gateMode()).toBe('device');

    await enterPins('4821', '4821');
    await expectPath(router, '/onboarding/who');
    await waitFor(() => expect(gateMode()).toBe('pin'));

    // The stored record is the entered PIN, checked through the real gate.
    const gate = createGate({
      db,
      /* eslint-disable @typescript-eslint/no-require-imports */
      auth: require('expo-local-authentication'),
      secureStore: require('expo-secure-store'),
      crypto: require('expo-crypto'),
      /* eslint-enable @typescript-eslint/no-require-imports */
      now: () => Date.now(),
    });
    expect((await gate.verifyPin('4821')).ok).toBe(true);
    expect((await gate.verifyPin('1111')).ok).toBe(false);
  });

  test('mismatched PINs block: the warning shows once the PIN is chosen, a mismatch clears the second row and stays, a match moves on', async () => {
    const router = await renderRouter(routes(), { initialUrl: '/' });
    await expectPath(router, '/onboarding/welcome');
    fireEvent.press(await screen.findByText(mr.getStarted));
    await expectPath(router, '/onboarding/lock');

    await waitFor(() => expect(isChosen('lock-device')).toBe(true));
    expect(screen.queryByTestId('pin-forgot-warning')).toBeNull();
    fireEvent.press(screen.getByTestId('lock-pin'));
    expect(await screen.findByTestId('pin-forgot-warning')).toBeTruthy();
    expect(isChosen('lock-pin')).toBe(true);

    await enterPins('1234', '4321');
    expect(await screen.findByTestId('pin-mismatch')).toBeTruthy();
    expect(screen.getByTestId('pin-again').props.value ?? '').toBe('');
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(router.getPathname()).toBe('/onboarding/lock');
    expect(gateMode()).toBe('device');
    expect(mockSecure.size).toBe(0);

    fireEvent.changeText(screen.getByTestId('pin-again'), '1234');
    await expectPath(router, '/onboarding/who');
    await waitFor(() => expect(gateMode()).toBe('pin'));
    expect(mockSecure.size).toBe(1);
  });

  test('hand-over: a blank nickname blocks; a refused mic still saves the child and opens the picker without a granted stamp', async () => {
    const router = await renderRouter(routes(), { initialUrl: '/' });
    await expectPath(router, '/onboarding/welcome');
    await toWho(router);

    await fillWho({ nickname: '   ', cls: 'Nursery', medium: 'mr' });
    fireEvent.press(screen.getByTestId('who-handover'));
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    expect(router.getPathname()).toBe('/onboarding/who');
    expect(childCount()).toBe(0);
    expect(micRequest()).not.toHaveBeenCalled();
    expect(queueChildPacks()).not.toHaveBeenCalled();

    micRequest().mockImplementation(async () => ({ granted: false, canAskAgain: true, status: 'denied', expires: 'never' }));
    fireEvent.changeText(screen.getByTestId('who-nickname'), 'Mau');
    fireEvent.press(screen.getByTestId('who-handover'));

    await expectPath(router, '/');
    expect(await screen.findByText('child-picker')).toBeTruthy();
    expect(micRequest()).toHaveBeenCalledTimes(1);
    expect(getDevice(db).mic_last_granted_at).toBeNull();
    const children = listChildren(db);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      nickname: 'Mau',
      class: 'Nursery',
      medium: 'mr',
      style_level: 'mr_led',
      goals: (pathsCatalogue.goals as Record<string, string[]>).Nursery,
    });
  });

  test('PicturePicker: a fixed set; a picture used by a sibling is disabled and cannot be chosen', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PicturePicker } = require('../ui/PicturePicker');
    const onChange = jest.fn();
    const view = render(h(PicturePicker, { value: null, onChange, taken: [] }));
    const ids = view.getAllByTestId(/^picture-/).map((el) => String(el.props.testID).replace(/^picture-/, ''));
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);

    const [taken, free] = ids;
    view.rerender(h(PicturePicker, { value: null, onChange, taken: [taken] }));
    expect(view.getByTestId(`picture-${taken}`)).toBeDisabled();
    expect(view.getByTestId(`picture-${free}`)).toBeEnabled();

    fireEvent.press(view.getByTestId(`picture-${taken}`));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.press(view.getByTestId(`picture-${free}`));
    expect(onChange).toHaveBeenCalledWith(free);
  });
});

// ---- contract for dependents (shape only) ----

describe('GURU-24 contract for GURU-29 (root routing, profiles) and GURU-30 (profiles, setup state)', () => {
  test('route modules under app/src/app/onboarding/ and the root layout default-export components; PicturePicker is a named export', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const modules: Record<string, { default?: unknown }> = {
      'app/_layout': require('../app/_layout'),
      'app/onboarding/_layout': require('../app/onboarding/_layout'),
      'app/onboarding/welcome': require('../app/onboarding/welcome'),
      'app/onboarding/lock': require('../app/onboarding/lock'),
      'app/onboarding/who': require('../app/onboarding/who'),
    };
    const picker = require('../ui/PicturePicker');
    /* eslint-enable @typescript-eslint/no-require-imports */
    for (const [name, mod] of Object.entries(modules)) expect([name, typeof mod.default]).toEqual([name, 'function']);
    expect(typeof picker.PicturePicker).toBe('function');
  });
});
