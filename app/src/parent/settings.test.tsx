// GURU-36: Settings and the child profile form. Spec: issue GURU-36, PRD Happy Path (first run),
// wireframes pm-settings, pm-settings-2, pm-profile, pm-profile-2, pm-profile-3, decisions 6 (keep this
// style), 7 (lessons per day, cap chips), 16 (class names, board in the form), 19 (Latin digits),
// D-GURU-13-parent-gate (lock mode change), D-GURU-22-style-level-rule (keep-this-style lock).
// Lives outside src/app/ (the Handoff path): Expo Router turns every .tsx file there into a route.
//
// Inputs from merged issues:
//   GURU-13  createGate: mode(), deviceLockAvailable(), setPin(pin); the PIN record is the secure-store
//            key 'guru.parent_pin'. Switching back to the phone's lock must remove that record.
//   GURU-51  switching back asks for the old PIN or strong biometrics first (liveSwitchToDeviceLock(proof),
//            D-GURU-51-switch-back-asks-pin); the PIN is checked once per attempt.
//   GURU-20  ensureEnrolment(db, child) (learning/enrol.ts): class_<board>_<class> + skill_<goal>.
//   GURU-22  child_profile.style_level / style_locked.
//   GURU-30  setupRows(child, device) (parent/setup.ts); SETUP_SECTIONS goals_style, lessons_per_day, board.
//   GURU-15  rerunSpeedCheck() (asr/speedCheck.ts).
// Real schema (app/src/data/migrations.ts):
//   device(device_id, parent_lang, consent_clips, consent_summaries, consent_answered_at, judge_check,
//          judge_p90_ms, mic_last_granted_at, ...)
//   child_profile(nickname, picture, class, board, medium, goals JSON, style_level, style_locked,
//                 lessons_per_day DEFAULT 3, active_cap_min, child_code, setup_done JSON, archived, ...)
//   parent_gate(mode 'device'|'pin', failed, lockout_until, ...)
//   path_enrollment(child_id, path_id, source 'class'|'skill', ...)
// Style samples are the shared lines sample_mr_led_1 and sample_en_led_1 (content/prompts/mr.json),
// played from LINE_AUDIO (content/generated/audio.ts) with expo-audio.
//
// Contract pinned for /implement (testIDs; visible text comes from the string tables):
//   /parent/settings      app/parent/settings.tsx, default export.
//     settings-lang-mr, settings-lang-en      parent language; writes device.parent_lang
//     settings-child-<childId>                opens /parent/child/<childId>
//     settings-add-child                      opens /parent/child/new
//     settings-consent-clips, settings-consent-summaries
//                                             switches; a change writes the device flag at once
//     settings-lock-device, settings-lock-pin parent lock mode choices (chosen = checked/selected)
//     pin-new, pin-again, pin-mismatch, pin-forgot-warning
//                                             the onboarding set-and-confirm rows; optional pin-save
//                                             button if the PIN is not saved as soon as both match
//     settings-change-pin                     shown only in PIN mode
//     pin-old                                 GURU-51: the old-PIN field, for Change PIN and for switching
//                                             back from the PIN to the phone's lock; "Use fingerprint"
//                                             (pinFingerprintKey) and Cancel (cancel) are found by text
//     settings-mic, settings-mic-action       status; the action (prompt) only when not granted
//     settings-judge-speed, settings-judge-rerun
//                                             status and re-run (rerunSpeedCheck)
//     settings-downloads                      the Downloads row
//     settings-uploads-wifi                   fixed status, no switch
//     settings-device-code                    shows device.device_id
//   /parent/child/[id]    app/parent/child/[id].tsx, default export; id 'new' is the add form.
//   ProfileForm           src/parent/ProfileForm.tsx, named export ProfileForm.
//     profile-nickname (TextInput), picture-<id> (PicturePicker; siblings' pictures disabled),
//     class-<Nursery|LKG|UKG|Class1|Class2>, board-msb, board-cbse, medium-en, medium-mr,
//     goal-<mr_letters|en_letters|en_words|numbers> (tick boxes), style-mr_led, style-en_led,
//     style-sample-mr_led, style-sample-en_led, style-keep (tick box), style-letters-note,
//     lessons-per-day-<1..5>, cap-20, cap-30, cap-45, cap-none, profile-save.
import { createElement as h } from 'react';
import { router } from 'expo-router';
import { Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';

import { openDb, type Db } from '../data/db';
import { answerConsent, getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import { createChild, getChild, listChildren, updateChild } from '../data/profiles';
import type { ChildProfile } from '../data/types';
import { ensureEnrolment } from '../learning/enrol';
import { setupRows, SETUP_SECTIONS } from './setup';
import { mr } from '../ui/strings/mr';

// ---- native fakes (as in src/__tests__/onboarding.test.tsx) ----

type Raw = { exec(sql: string): void; prepare(sql: string): { run(p: unknown[]): unknown; all(p: unknown[]): unknown[]; get(p: unknown[]): unknown }; transaction<T>(fn: () => T): () => T };
let mockRawDb: Raw | null = null;
function mockRaw(): Raw {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mockRawDb ??= new (require('better-sqlite3'))(':memory:') as Raw;
  return mockRawDb;
}
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

const mockAuth = { level: 1, success: true }; // SECRET: the phone has a screen lock; success: the prompt's result
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(async () => mockAuth.level),
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => mockAuth.level >= 2),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => (mockAuth.success ? { success: true } : { success: false, error: 'user_cancel' })),
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

// Mic permission, and players that record which source was playing at each play().
const mockMic = { granted: true, canAskAgain: true };
const mockPlayed: unknown[] = [];
jest.mock('expo-audio', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const make = (src: unknown) => {
    const p = {
      src,
      playing: false,
      currentTime: 0,
      duration: 0,
      replace(s: unknown) {
        p.src = s;
      },
      play() {
        mockPlayed.push(p.src);
      },
      pause() {},
      remove() {},
      release() {},
      seekTo: async () => undefined,
      addListener: () => ({ remove() {} }),
    };
    return p;
  };
  return {
    requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' })),
    getRecordingPermissionsAsync: jest.fn(async () => ({
      granted: mockMic.granted,
      canAskAgain: mockMic.canAskAgain,
      status: mockMic.granted ? 'granted' : 'denied',
      expires: 'never',
    })),
    setAudioModeAsync: jest.fn(async () => undefined),
    createAudioPlayer: jest.fn((src: unknown) => make(src ?? null)),
    useAudioPlayer: (src: unknown) => {
      const ref = React.useRef(null);
      ref.current ??= make(src ?? null);
      if (src != null && ref.current.src !== src) ref.current.src = src; // a new source replaces the player's
      return ref.current;
    },
    useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0, didJustFinish: false, isLoaded: true }),
  };
});

const SAMPLE_MR = 9001;
const SAMPLE_EN = 9002;
jest.mock('../content/generated/audio', () => ({
  LINE_AUDIO: { ...jest.requireActual('../content/generated/audio').LINE_AUDIO, sample_mr_led_1: 9001, sample_en_led_1: 9002 },
}));

jest.mock('../asr/speedCheck', () => ({
  SLOW_P90_MS: 1000,
  judgeReadiness: jest.fn(() => 'ready'),
  runSpeedCheck: jest.fn(async () => 'ready'),
  rerunSpeedCheck: jest.fn(async () => 'slow'),
  subscribeJudgeCheck: jest.fn(() => () => undefined),
}));

const mockStatus = { waitingForWifi: false, plan: null, items: [] }; // stable snapshot for useSyncExternalStore
jest.mock('../downloads/downloader', () => ({
  startInitialDownloads: jest.fn(async () => undefined),
  queuePacks: jest.fn(async () => undefined),
  queueChildPacks: jest.fn(async () => undefined),
  isLessonInstalled: jest.fn(() => true),
  downloadStatus: jest.fn(() => mockStatus),
  subscribeDownloads: jest.fn(() => () => undefined),
}));

// GURU-38: the live upload queue. virtual: the module does not exist until /implement.
jest.mock(
  '../upload/uploadQueue',
  () => ({
    requestDeletion: jest.fn(async () => undefined),
    consentChanged: jest.fn(),
    sessionEnded: jest.fn(async () => undefined), // the root layout's start effect
    runUploads: jest.fn(async () => undefined),
  }),
  { virtual: true },
);

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
const rerun = () => require('../asr/speedCheck').rerunSpeedCheck as jest.Mock;
const liveUploads = () => require('../upload/uploadQueue') as { requestDeletion: jest.Mock; consentChanged: jest.Mock };

// Route files load lazily, so a missing one fails its own test with "Cannot find module".
const ChildPickerStub = () => h(Text, null, 'child-picker');
function routes() {
  return {
    _layout: require('../app/_layout').default,
    index: ChildPickerStub,
    'parent/index': require('../app/parent/index').default,
    'parent/settings': require('../app/parent/settings').default,
    'parent/child/[id]': require('../app/parent/child/[id]').default,
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;

const PIN_KEY = 'guru.parent_pin';
const DEVANAGARI_DIGIT = /[०-९]/;

/** Chosen = selected or checked (accessibilityState / aria-*), or a Switch that is on. */
function isChosen(testID: string): boolean {
  const p = screen.getByTestId(testID).props;
  return Boolean(
    p.accessibilityState?.selected ||
      p.accessibilityState?.checked === true ||
      p['aria-selected'] ||
      p['aria-checked'] === true ||
      p.value === true,
  );
}

/** Switches take valueChange; tick boxes and chips take a press. */
function toggle(testID: string, on: boolean) {
  const el = screen.getByTestId(testID);
  if (typeof el.props.onValueChange === 'function') fireEvent(el, 'valueChange', on);
  else if (isChosen(testID) !== on) fireEvent.press(el);
}

const gateMode = () => db.get<{ mode: string }>('SELECT mode FROM parent_gate LIMIT 1')?.mode ?? 'device';
const gateFailed = () => db.get<{ failed: number }>('SELECT failed FROM parent_gate LIMIT 1')?.failed;
const authenticate = () => require('expo-local-authentication').authenticateAsync as jest.Mock; // eslint-disable-line @typescript-eslint/no-require-imports
const enrolments = (childId: string) =>
  db
    .all<{ path_id: string; source: string }>('SELECT path_id, source FROM path_enrollment WHERE child_id = ? ORDER BY path_id', [childId])
    .map((r) => `${r.path_id}:${r.source}`);

/** A child as onboarding leaves it: defaults, class goals, enrolled, no setup section reviewed. */
function addChild(nickname: string, picture: string, over: Partial<ChildProfile> = {}): ChildProfile {
  const created = createChild(db, { nickname, picture, class: 'UKG', medium: 'mr' });
  const child = updateChild(db, created.id, { goals: ['mr_letters', 'en_letters'], ...over })!;
  ensureEnrolment(db, child);
  return child;
}

async function settle() {
  await act(async () => undefined);
}

async function openSettings() {
  const router = await renderRouter(routes(), { initialUrl: '/parent/settings' });
  await screen.findByTestId('settings-device-code');
  await settle(); // gate mode and mic permission reads
  return router;
}

async function openForm(id: string) {
  const router = await renderRouter(routes(), { initialUrl: `/parent/child/${id}` });
  await screen.findByTestId('profile-save');
  return router;
}

async function enterPins(first: string, second: string) {
  fireEvent.changeText(await screen.findByTestId('pin-new'), first);
  fireEvent.changeText(screen.getByTestId('pin-again'), second);
  const save = screen.queryByTestId('pin-save');
  if (save) fireEvent.press(save);
  await settle();
}

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) {
    if (name === 'device') {
      db.run(
        "UPDATE device SET parent_lang = 'mr', mic_last_granted_at = NULL, consent_clips = NULL, consent_summaries = NULL, consent_answered_at = NULL",
      );
    } else if (name === 'parent_gate') db.run("UPDATE parent_gate SET mode = 'device', failed = 0, lockout_until = NULL");
    else db.run(`DELETE FROM "${name}"`);
  }
  getDevice(db);
  mockSecure.clear();
  mockAuth.level = 1;
  mockAuth.success = true;
  mockMic.granted = true;
  mockMic.canAskAgain = true;
  mockPlayed.length = 0;
  jest.clearAllMocks();
});

// ---- behaviour ----

describe('GURU-36 Settings', () => {
  test('rows: language switch, child rows open the edit and add forms, mic and judge status, fixed upload status, device code', async () => {
    const chinu = addChild('Chinu', 'peacock');
    const manu = addChild('Manu', 'elephant');
    const archived = addChild('Old', 'tiger', { archived: true });
    mockMic.granted = false;

    const app = await openSettings();

    // Language: writes the device row through the app's language provider.
    fireEvent.press(screen.getByTestId('settings-lang-en'));
    await waitFor(() => expect(getDevice(db).parent_lang).toBe('en'));

    // Children: one row each, archived ones hidden.
    expect(screen.getByTestId(`settings-child-${chinu.id}`)).toHaveTextContent(/Chinu/);
    expect(screen.getByTestId(`settings-child-${manu.id}`)).toHaveTextContent(/Manu/);
    expect(screen.queryByTestId(`settings-child-${archived.id}`)).toBeNull();

    // Mic not granted: the row links to the permission prompt.
    fireEvent.press(await screen.findByTestId('settings-mic-action'));
    await waitFor(() => expect(micRequest()).toHaveBeenCalledTimes(1));

    // Judge speed: status plus a re-run.
    expect(screen.getByTestId('settings-judge-speed')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-judge-rerun'));
    await waitFor(() => expect(rerun()).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId('settings-downloads')).toBeTruthy();
    // Uploads always wait for Wi-Fi: a status, never a switch.
    const uploads = screen.getByTestId('settings-uploads-wifi');
    expect(within(uploads).queryByRole('switch')).toBeNull();
    // The device code is the id uploads and deletion requests carry.
    expect(screen.getByTestId('settings-device-code')).toHaveTextContent(new RegExp(getDevice(db).device_id));

    fireEvent.press(screen.getByTestId(`settings-child-${chinu.id}`));
    await waitFor(() => expect(app.getPathname()).toBe(`/parent/child/${chinu.id}`));
    act(() => router.back());
    fireEvent.press(await screen.findByTestId('settings-add-child'));
    await waitFor(() => expect(app.getPathname()).toBe('/parent/child/new'));
  });

  test('mic granted: no prompt action', async () => {
    addChild('Chinu', 'peacock');
    await openSettings();
    expect(screen.getByTestId('settings-mic')).toBeTruthy();
    expect(screen.queryByTestId('settings-mic-action')).toBeNull();
  });

  test('turning a consent off writes the device flag at once, without a save', async () => {
    addChild('Chinu', 'peacock');
    answerConsent(db, { clips: true, summaries: true });
    await openSettings();

    expect(isChosen('settings-consent-clips')).toBe(true);
    expect(isChosen('settings-consent-summaries')).toBe(true);

    toggle('settings-consent-clips', false);
    await waitFor(() => expect(getDevice(db).consent_clips).toBe(false));
    expect(getDevice(db).consent_summaries).toBe(true); // separate switches

    toggle('settings-consent-summaries', false);
    await waitFor(() => expect(getDevice(db).consent_summaries).toBe(false));
  });

  test('lock mode: switching to PIN requires matching PINs; Change PIN only in PIN mode; switching back asks for the old PIN, then removes the app PIN', async () => {
    addChild('Chinu', 'peacock');
    await openSettings();

    await waitFor(() => expect(isChosen('settings-lock-device')).toBe(true));
    expect(screen.queryByTestId('settings-change-pin')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-lock-pin'));
    expect(await screen.findByTestId('pin-forgot-warning')).toBeTruthy();

    // Two different PINs: an error, nothing stored, still the phone's lock.
    await enterPins('1234', '5678');
    expect(await screen.findByTestId('pin-mismatch')).toBeTruthy();
    expect(gateMode()).toBe('device');
    expect(mockSecure.has(PIN_KEY)).toBe(false);

    await enterPins('1234', '1234');
    await waitFor(() => expect(gateMode()).toBe('pin'));
    expect(mockSecure.has(PIN_KEY)).toBe(true);
    expect(await screen.findByTestId('settings-change-pin')).toBeTruthy();

    // GURU-51: switching back opens the old-PIN step and changes nothing yet.
    fireEvent.press(screen.getByTestId('settings-lock-device'));
    expect(await screen.findByTestId('pin-old')).toBeTruthy();
    await settle();
    expect(gateMode()).toBe('pin');
    expect(mockSecure.has(PIN_KEY)).toBe(true);
    expect(screen.queryByText(mr.pinFingerprintKey)).toBeNull(); // no strong biometrics on this phone

    // A wrong PIN: pinWrong, still the PIN, counted once (the switch checks it, Settings does not first).
    fireEvent.changeText(screen.getByTestId('pin-old'), '0000');
    expect(await screen.findByText(mr.pinWrong)).toBeTruthy();
    expect(gateMode()).toBe('pin');
    expect(mockSecure.has(PIN_KEY)).toBe(true);
    expect(gateFailed()).toBe(1);

    // The right PIN switches back and removes the app PIN.
    fireEvent.changeText(screen.getByTestId('pin-old'), '1234');
    await waitFor(() => expect(gateMode()).toBe('device'));
    await waitFor(() => expect(mockSecure.has(PIN_KEY)).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('settings-change-pin')).toBeNull());
    expect(screen.queryByTestId('pin-old')).toBeNull();
    expect(isChosen('settings-lock-device')).toBe(true);
    expect(authenticate()).not.toHaveBeenCalled(); // the phone's own lock is never asked
  });

  test('switching back: Cancel closes the old-PIN step and keeps the GuruAI PIN', async () => {
    addChild('Chinu', 'peacock');
    db.run("UPDATE parent_gate SET mode = 'pin'");
    mockSecure.set(PIN_KEY, 'record');
    await openSettings();

    await waitFor(() => expect(isChosen('settings-lock-pin')).toBe(true));
    fireEvent.press(screen.getByTestId('settings-lock-device'));
    expect(await screen.findByTestId('pin-old')).toBeTruthy();

    fireEvent.press(screen.getByText(mr.cancel));
    await waitFor(() => expect(screen.queryByTestId('pin-old')).toBeNull());
    await settle();
    expect(gateMode()).toBe('pin');
    expect(mockSecure.get(PIN_KEY)).toBe('record');
    expect(isChosen('settings-lock-pin')).toBe(true);
    expect(await screen.findByTestId('settings-change-pin')).toBeTruthy();
  });

  test('switching back during a PIN wait: the PIN shows pinWaitTitle; strong fingerprint still switches; a cancelled prompt changes nothing', async () => {
    addChild('Chinu', 'peacock');
    db.run("UPDATE parent_gate SET mode = 'pin', failed = 3, lockout_until = ?", [new Date(Date.now() + 10 * 60 * 1000).toISOString()]);
    mockSecure.set(PIN_KEY, 'record');
    mockAuth.level = 3; // BIOMETRIC_STRONG
    await openSettings();

    await waitFor(() => expect(isChosen('settings-lock-pin')).toBe(true));
    fireEvent.press(screen.getByTestId('settings-lock-device'));
    fireEvent.changeText(await screen.findByTestId('pin-old'), '1234');
    expect(await screen.findByText(mr.pinWaitTitle)).toBeTruthy();
    expect(gateMode()).toBe('pin');
    expect(gateFailed()).toBe(3); // refused during the wait, not counted

    // A cancelled fingerprint prompt: nothing changes, the step stays open.
    mockAuth.success = false;
    fireEvent.press(await screen.findByText(mr.pinFingerprintKey));
    await waitFor(() => expect(authenticate()).toHaveBeenCalledTimes(1));
    await settle();
    expect(authenticate()).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: mr.unlockPrompt, disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }),
    );
    expect(gateMode()).toBe('pin');
    expect(mockSecure.has(PIN_KEY)).toBe(true);
    expect(screen.getByTestId('pin-old')).toBeTruthy();

    // A strong fingerprint switches back, wait or not.
    mockAuth.success = true;
    fireEvent.press(screen.getByText(mr.pinFingerprintKey));
    await waitFor(() => expect(gateMode()).toBe('device'));
    await waitFor(() => expect(mockSecure.has(PIN_KEY)).toBe(false));
    await waitFor(() => expect(screen.queryByTestId('pin-old')).toBeNull());
    expect(screen.queryByTestId('settings-change-pin')).toBeNull();
  });

  test('a phone with no screen lock cannot switch back from the GuruAI PIN', async () => {
    addChild('Chinu', 'peacock');
    db.run("UPDATE parent_gate SET mode = 'pin'");
    mockSecure.set(PIN_KEY, 'record');
    mockAuth.level = 0;
    await openSettings();

    await waitFor(() => expect(isChosen('settings-lock-pin')).toBe(true));
    expect(screen.getByTestId('settings-lock-device')).toBeDisabled();
    fireEvent.press(screen.getByTestId('settings-lock-device'));
    await settle();
    expect(gateMode()).toBe('pin');
    expect(mockSecure.has(PIN_KEY)).toBe(true);
  });
});

// GURU-38 (wireframe pm-settings, decision 15): testID settings-delete-sent; the live queue's
// requestDeletion() and consentChanged() from src/upload/uploadQueue.ts.
describe('GURU-38 Settings: deletion request and consent withdrawal', () => {
  test('"Ask to delete sent recordings" shows the device code and sends requestDeletion(), also after consent is off; a consent change tells the live queue at once', async () => {
    addChild('Chinu', 'peacock');
    answerConsent(db, { clips: true, summaries: true });
    await openSettings();
    const deviceId = getDevice(db).device_id;

    // Marathi by default.
    const row = await screen.findByTestId('settings-delete-sent');
    expect(row).toHaveTextContent(/पाठवलेली रेकॉर्डिंग पुसायला सांगा/);
    expect(row).toHaveTextContent(new RegExp(deviceId));

    // Withdrawal reaches the queue, so an upload in flight is aborted rather than finished. The queue
    // reads the flags, so they must be written before it is told.
    const seen: [boolean | null, boolean | null][] = [];
    liveUploads().consentChanged.mockImplementation(() => {
      const d = getDevice(db);
      seen.push([d.consent_clips, d.consent_summaries]);
    });
    toggle('settings-consent-clips', false);
    await waitFor(() => expect(liveUploads().consentChanged).toHaveBeenCalledTimes(1));
    toggle('settings-consent-summaries', false);
    await waitFor(() => expect(liveUploads().consentChanged).toHaveBeenCalledTimes(2));
    expect(seen).toEqual([
      [false, true],
      [false, false],
    ]);

    // Deleting what was already sent is still possible with both consents off.
    expect(liveUploads().requestDeletion).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('settings-delete-sent'));
    await waitFor(() => expect(liveUploads().requestDeletion).toHaveBeenCalledTimes(1));

    // English string too.
    fireEvent.press(screen.getByTestId('settings-lang-en'));
    await waitFor(() => expect(screen.getByTestId('settings-delete-sent')).toHaveTextContent(/Ask to delete sent recordings/));
  });
});

describe('GURU-36 child profile form', () => {
  test('edit: save stores lessons per day, cap, kept style; marks setup sections so the setup row disappears; Latin digits', async () => {
    const chinu = addChild('Chinu', 'peacock');
    expect(setupRows(chinu, getDevice(db)).some((r) => r.kind === 'profile')).toBe(true);

    await openForm(chinu.id);
    expect(screen.getByTestId('profile-nickname').props.value).toBe('Chinu');

    // Lessons per day: chips 1 to 5 only.
    for (const n of [1, 2, 3, 4, 5]) expect(screen.getByTestId(`lessons-per-day-${n}`)).toBeTruthy();
    expect(screen.queryByTestId('lessons-per-day-0')).toBeNull();
    expect(screen.queryByTestId('lessons-per-day-6')).toBeNull();
    // Decision 19: Latin digits in Marathi parent text.
    expect(JSON.stringify(screen.toJSON())).not.toMatch(DEVANAGARI_DIGIT);

    // Styles: a sample per style, the letter-lesson note, and the lock.
    expect(screen.getByTestId('style-letters-note')).toBeTruthy();
    fireEvent.press(screen.getByTestId('style-sample-mr_led'));
    await waitFor(() => expect(mockPlayed).toContain(SAMPLE_MR));
    fireEvent.press(screen.getByTestId('style-sample-en_led'));
    await waitFor(() => expect(mockPlayed[mockPlayed.length - 1]).toBe(SAMPLE_EN));

    fireEvent.press(screen.getByTestId('lessons-per-day-5'));
    fireEvent.press(screen.getByTestId('cap-none'));
    fireEvent.press(screen.getByTestId('style-en_led'));
    toggle('style-keep', true);
    fireEvent.press(screen.getByTestId('profile-save'));

    await waitFor(() => expect(getChild(db, chinu.id)!.lessons_per_day).toBe(5));
    const saved = getChild(db, chinu.id)!;
    expect(saved.active_cap_min).toBeNull();
    expect(saved.style_level).toBe('en_led');
    expect(saved.style_locked).toBe(true);
    expect(saved.setup_done).toEqual(expect.arrayContaining([...SETUP_SECTIONS]));
    expect(setupRows(saved, getDevice(db)).some((r) => r.kind === 'profile')).toBe(false);
  });

  test.each([
    ['cap-20', 20],
    ['cap-30', 30],
    ['cap-45', 45],
    ['cap-none', null],
  ])('cap chip %s saves active_cap_min %p', async (chip, minutes) => {
    const chinu = addChild('Chinu', 'peacock', { active_cap_min: chip === 'cap-30' ? null : 30 });
    await openForm(chinu.id);
    fireEvent.press(screen.getByTestId(chip));
    fireEvent.press(screen.getByTestId('profile-save'));
    await waitFor(() => expect(getChild(db, chinu.id)!.active_cap_min).toBe(minutes));
  });

  test('class, board or goal change re-enrols; an emptied nickname is not saved', async () => {
    const chinu = addChild('Chinu', 'peacock');
    expect(enrolments(chinu.id)).toEqual(['class_msb_UKG:class', 'skill_en_letters:skill', 'skill_mr_letters:skill']);

    await openForm(chinu.id);
    expect(isChosen('goal-mr_letters')).toBe(true);
    expect(isChosen('goal-en_letters')).toBe(true);
    expect(isChosen('board-msb')).toBe(true);

    // Failure case: a blank nickname does not save.
    fireEvent.changeText(screen.getByTestId('profile-nickname'), '   ');
    fireEvent.press(screen.getByTestId('class-Class1'));
    fireEvent.press(screen.getByTestId('profile-save'));
    await settle();
    expect(getChild(db, chinu.id)!.nickname).toBe('Chinu');
    expect(getChild(db, chinu.id)!.class).toBe('UKG');

    fireEvent.changeText(screen.getByTestId('profile-nickname'), 'Chinu');
    fireEvent.press(screen.getByTestId('board-cbse'));
    toggle('goal-en_letters', false);
    toggle('goal-numbers', true);
    fireEvent.press(screen.getByTestId('profile-save'));

    await waitFor(() => expect(getChild(db, chinu.id)!.class).toBe('Class1'));
    const saved = getChild(db, chinu.id)!;
    expect(saved.board).toBe('cbse');
    expect([...saved.goals].sort()).toEqual(['mr_letters', 'numbers']);
    expect(enrolments(chinu.id)).toEqual(['class_cbse_Class1:class', 'skill_mr_letters:skill', 'skill_numbers:skill']);
  });

  test("add a child: /parent/child/new starts empty, disables a sibling's picture, saves, enrols and marks setup", async () => {
    addChild('Chinu', 'peacock');
    await openForm('new');

    expect(screen.getByTestId('profile-nickname').props.value ?? '').toBe('');
    expect(screen.getByTestId('picture-peacock')).toBeDisabled();

    fireEvent.press(screen.getByTestId('profile-save')); // nothing filled: no child
    await settle();
    expect(listChildren(db)).toHaveLength(1);

    fireEvent.changeText(screen.getByTestId('profile-nickname'), 'Manu');
    fireEvent.press(screen.getByTestId('picture-elephant'));
    fireEvent.press(screen.getByTestId('class-LKG'));
    fireEvent.press(screen.getByTestId('medium-en'));
    fireEvent.press(screen.getByTestId('profile-save'));

    await waitFor(() => expect(listChildren(db)).toHaveLength(2));
    const manu = listChildren(db).find((c) => c.nickname === 'Manu')!;
    expect(manu).toMatchObject({ picture: 'elephant', class: 'LKG', board: 'msb', medium: 'en' });
    expect(manu.style_level).toBe('en_led'); // starting style from the school medium
    expect(enrolments(manu.id)).toContain('class_msb_LKG:class');
    expect(manu.setup_done).toEqual(expect.arrayContaining([...SETUP_SECTIONS]));
  });
});

// ---- contract for dependents ----

describe('GURU-36 contract: routes /parent/settings, /parent/child/[id] (edit), /parent/child/new (add)', () => {
  test('route modules default-export screens; ProfileForm is a named export; each route renders its screen', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    expect(typeof require('../app/parent/settings').default).toBe('function');
    expect(typeof require('../app/parent/child/[id]').default).toBe('function');
    expect(typeof require('./ProfileForm').ProfileForm).toBe('function');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const chinu = addChild('Chinu', 'peacock');

    await openSettings();
    expect(screen.getByTestId('settings-add-child')).toBeTruthy();

    await openForm(chinu.id);
    expect(screen.getByTestId('profile-nickname').props.value).toBe('Chinu');

    await openForm('new');
    expect(screen.getByTestId('profile-nickname').props.value ?? '').toBe('');
  });
});
