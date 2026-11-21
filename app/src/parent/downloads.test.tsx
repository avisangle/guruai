// GURU-31: Downloads screen and storage prompt. Spec: issue GURU-31, PRD Edge Cases (not enough storage),
// Acceptance Criteria (downloads), wireframes pm-downloads, pm-downloads-resume, pm-storage, decision 19
// (Latin digits).
// Lives outside src/app/ (the Handoff path): Expo Router turns every .tsx file there into a route.
//
// Inputs from merged issues:
//   GURU-14  downloads/downloader.ts: downloadStatus() -> { waitingForWifi, plan, items[] },
//            items { id, kind 'model'|'pack', version, status 'queued'|'downloading'|'installed'|'failed',
//            bytesDone, bytesTotal }; queuePacks(ids) and startInitialDownloads() re-queue a failed pack or
//            the model and re-check the Wi-Fi rule (internal kick()); useDownloads() (downloads/useDownloads.ts).
//            downloads/plan.ts: storagePlan() -> { kind: 'start' } | { kind: 'needs_choice', needed, free, fits[] };
//            `needed` includes the 200 MB reserve; sizes are decimal bytes (1 MB = 1,000,000).
//   GURU-25  parent shell (app/parent/_layout.tsx guard, ParentModeProvider in the root layout).
// Real schema (app/src/data/migrations.ts):
//   device(allow_mobile_data INTEGER 0|1, parent_lang, ...): read by the downloader before each network check.
//
// Contract pinned for /implement (testIDs; visible text comes from the string tables):
//   /parent/downloads     app/parent/downloads.tsx, default export.
//     downloads-overall          overall percent of all items' bytes; says Wi-Fi when waiting for it
//     downloads-item-<id>        one row per item: percent while downloading, done (झालं / Done),
//                                queued (रांगेत / In queue)
//     downloads-resume-<id>      only on a failed item; a pack calls queuePacks([id]), the model
//                                startInitialDownloads()
//     downloads-mobile-data      Switch; writes device.allow_mobile_data, and turning it on then calls
//                                queuePacks or startInitialDownloads so waiting downloads re-check the rule
//     storage-prompt             shown only when downloadStatus().plan is needs_choice
//       storage-needed, storage-free   plan.needed and plan.free in MB
//       storage-pack-<id>              tick box per id in plan.fits
//       storage-download               queuePacks(<ticked ids>); nothing with none ticked
//   StoragePrompt         src/parent/StoragePrompt.tsx, named export StoragePrompt.
//   Settings row settings-downloads opens /parent/downloads.
import { createElement as h } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';

import { openDb, type Db } from '../data/db';
import { getDevice } from '../data/device';
import { migrate } from '../data/migrations';
import type { DownloadItem, DownloadStatus } from '../downloads/downloader';

// ---- native fakes (as in src/parent/settings.test.tsx) ----

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

jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(async () => 1),
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => false),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const c = require('crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    randomUUID: () => c.randomUUID(),
    getRandomBytes: (n: number) => new Uint8Array(c.randomBytes(n)),
    getRandomBytesAsync: async (n: number) => new Uint8Array(c.randomBytes(n)),
    digestStringAsync: async (_a: string, s: string) => c.createHash('sha256').update(s).digest('hex'),
  };
});

jest.mock('expo-audio', () => ({
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' })),
  getRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' })),
  setAudioModeAsync: jest.fn(async () => undefined),
  createAudioPlayer: jest.fn(() => ({ play() {}, pause() {}, remove() {}, release() {}, replace() {}, addListener: () => ({ remove() {} }) })),
  useAudioPlayer: () => ({ play() {}, pause() {}, remove() {}, release() {}, replace() {}, seekTo: async () => undefined }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0, didJustFinish: false, isLoaded: true }),
}));

jest.mock('../asr/speedCheck', () => ({
  SLOW_P90_MS: 1000,
  judgeReadiness: jest.fn(() => 'ready'),
  runSpeedCheck: jest.fn(async () => 'ready'),
  rerunSpeedCheck: jest.fn(async () => 'ready'),
}));

// One object, mutated per test: useSyncExternalStore needs a stable snapshot.
const mockStatus: DownloadStatus = { waitingForWifi: false, plan: null, items: [] };
jest.mock('../downloads/downloader', () => ({
  startInitialDownloads: jest.fn(async () => undefined),
  queuePacks: jest.fn(async () => undefined),
  queueChildPacks: jest.fn(async () => undefined),
  isLessonInstalled: jest.fn(() => true),
  downloadStatus: jest.fn(() => mockStatus),
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
const queuePacks = () => require('../downloads/downloader').queuePacks as jest.Mock;
const startInitial = () => require('../downloads/downloader').startInitialDownloads as jest.Mock;

// Route files load lazily, so a missing one fails its own test with "Cannot find module".
const ChildPickerStub = () => h(Text, null, 'child-picker');
function routes() {
  return {
    _layout: require('../app/_layout').default,
    index: ChildPickerStub,
    'parent/settings': require('../app/parent/settings').default,
    'parent/downloads': require('../app/parent/downloads').default,
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

// ---- helpers ----

let db: Db;

const MB = 1_000_000;
const MODEL = 'mr_ctc_wav';
const item = (id: string, status: DownloadItem['status'], done: number, total: number, kind: DownloadItem['kind'] = 'pack'): DownloadItem => ({
  id,
  kind,
  version: 1,
  status,
  bytesDone: done * MB,
  bytesTotal: total * MB,
});

function setStatus(next: Partial<DownloadStatus>) {
  Object.assign(mockStatus, { waitingForWifi: false, plan: null, items: [] }, next);
}

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

/** Switches take valueChange; tick boxes take a press. */
function toggle(testID: string, on: boolean) {
  const el = screen.getByTestId(testID);
  if (typeof el.props.onValueChange === 'function') fireEvent(el, 'valueChange', on);
  else if (isChosen(testID) !== on) fireEvent.press(el);
}

async function settle() {
  await act(async () => undefined);
}

/** Opens /parent/downloads and clears the root layout's own startInitialDownloads() call. */
async function openDownloads() {
  const router = await renderRouter(routes(), { initialUrl: '/parent/downloads' });
  await screen.findByTestId('downloads-mobile-data');
  await settle();
  startInitial().mockClear();
  queuePacks().mockClear();
  return router;
}

const allowMobileData = () => getDevice(db).allow_mobile_data;
const setAllowMobileData = (on: boolean) => db.run('UPDATE device SET allow_mobile_data = ?', [on ? 1 : 0]);
const DEVANAGARI_DIGIT = /[०-९]/;

beforeAll(() => {
  db = openDb();
  migrate(db);
});

beforeEach(() => {
  getDevice(db);
  db.run("UPDATE device SET parent_lang = 'mr', allow_mobile_data = 0");
  setStatus({});
  jest.clearAllMocks();
});

// ---- behaviour ----

describe('GURU-31 Downloads screen', () => {
  test('overall progress and a row per file: percent while downloading, done, queued (Latin digits)', async () => {
    setStatus({
      items: [item(MODEL, 'downloading', 59, 137, 'model'), item('mr_letters', 'installed', 38, 38), item('en_letters', 'queued', 0, 37)],
    });
    await openDownloads();

    // 97 of 212 MB = 45.75%.
    const overall = screen.getByTestId('downloads-overall');
    expect(overall).toHaveTextContent(/\b46\s*%/);
    expect(screen.getByTestId(`downloads-item-${MODEL}`)).toHaveTextContent(/\b43\s*%/);
    expect(screen.getByTestId('downloads-item-mr_letters')).toHaveTextContent(/झालं/);
    expect(screen.getByTestId('downloads-item-mr_letters')).not.toHaveTextContent(/%/);
    expect(screen.getByTestId('downloads-item-en_letters')).toHaveTextContent(/रांगेत/);
    expect(screen.getByTestId('downloads-item-en_letters')).not.toHaveTextContent(/%/);
    expect(overall).not.toHaveTextContent(DEVANAGARI_DIGIT);

    // Nothing failed: no resume action anywhere.
    expect(screen.queryByTestId(`downloads-resume-${MODEL}`)).toBeNull();
    expect(screen.queryByTestId('downloads-resume-en_letters')).toBeNull();
  });

  test('English strings when the parent language is English; waiting for Wi-Fi is said in the overall line', async () => {
    db.run("UPDATE device SET parent_lang = 'en'");
    setStatus({ waitingForWifi: true, items: [item('mr_letters', 'installed', 38, 38), item('en_letters', 'queued', 0, 37)] });
    await openDownloads();

    expect(screen.getByTestId('downloads-overall')).toHaveTextContent(/Wi-Fi/);
    expect(screen.getByTestId('downloads-item-mr_letters')).toHaveTextContent(/done/i);
    expect(screen.getByTestId('downloads-item-en_letters')).toHaveTextContent(/queue/i);
    expect(screen.getByTestId('downloads-item-mr_letters')).not.toHaveTextContent(/[ऀ-ॿ]/);
  });

  test('a failed file shows resume: a pack is queued again by id, the model through startInitialDownloads', async () => {
    setStatus({
      items: [item(MODEL, 'failed', 0, 137, 'model'), item('mr_letters', 'failed', 0, 38), item('en_letters', 'queued', 0, 37)],
    });
    await openDownloads();

    expect(screen.queryByTestId('downloads-resume-en_letters')).toBeNull(); // queued, not failed

    fireEvent.press(within(screen.getByTestId('downloads-item-mr_letters')).getByTestId('downloads-resume-mr_letters'));
    await settle();
    expect(queuePacks()).toHaveBeenCalledWith(['mr_letters']);
    expect(startInitial()).not.toHaveBeenCalled();

    queuePacks().mockClear();
    fireEvent.press(screen.getByTestId(`downloads-resume-${MODEL}`));
    await settle();
    expect(startInitial()).toHaveBeenCalledTimes(1);
    expect(queuePacks()).not.toHaveBeenCalledWith(expect.arrayContaining([MODEL]));
  });

  test('mobile-data switch shows and writes device.allow_mobile_data; turning it on re-checks waiting downloads after the write', async () => {
    setAllowMobileData(true);
    setStatus({ waitingForWifi: true, items: [item(MODEL, 'downloading', 59, 137, 'model')] });
    await openDownloads();
    expect(isChosen('downloads-mobile-data')).toBe(true);

    toggle('downloads-mobile-data', false);
    await waitFor(() => expect(allowMobileData()).toBe(false));

    // Record the flag as the downloader would read it at the moment it is kicked.
    const seen: boolean[] = [];
    const record = async () => {
      seen.push(allowMobileData());
    };
    startInitial().mockImplementation(record);
    queuePacks().mockImplementation(record);

    toggle('downloads-mobile-data', true);
    await waitFor(() => expect(allowMobileData()).toBe(true));
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expect(isChosen('downloads-mobile-data')).toBe(true);
  });

  test('Settings: the Downloads row opens /parent/downloads', async () => {
    await renderRouter(routes(), { initialUrl: '/parent/settings' });
    fireEvent.press(await screen.findByTestId('settings-downloads'));
    await waitFor(() => expect(screen).toHavePathname('/parent/downloads'));
    expect(await screen.findByTestId('downloads-mobile-data')).toBeTruthy();
  });
});

describe('GURU-31 Storage prompt', () => {
  const shortOfSpace = () =>
    setStatus({
      plan: { kind: 'needs_choice', needed: 412 * MB, free: 380 * MB, fits: ['mr_letters', 'en_letters'] },
      items: [item(MODEL, 'installed', 137, 137, 'model')],
    });

  test('needs_choice: shows needed and free, one tick box per pack that fits, and downloads nothing until the parent chooses', async () => {
    shortOfSpace();
    await openDownloads();

    const prompt = screen.getByTestId('storage-prompt');
    expect(within(prompt).getByTestId('storage-needed')).toHaveTextContent(/412\s*MB/);
    expect(within(prompt).getByTestId('storage-free')).toHaveTextContent(/380\s*MB/);
    expect(within(prompt).getByTestId('storage-pack-mr_letters')).toBeTruthy();
    expect(within(prompt).getByTestId('storage-pack-en_letters')).toBeTruthy();

    await settle();
    expect(queuePacks()).not.toHaveBeenCalled();
    expect(startInitial()).not.toHaveBeenCalled();

    toggle('storage-pack-mr_letters', true);
    toggle('storage-pack-en_letters', false);
    await settle();
    expect(queuePacks()).not.toHaveBeenCalled(); // ticking is not choosing

    fireEvent.press(screen.getByTestId('storage-download'));
    await settle();
    expect(queuePacks()).toHaveBeenCalledTimes(1);
    expect(queuePacks()).toHaveBeenCalledWith(['mr_letters']);
  });

  test('with no pack ticked, the download button queues nothing', async () => {
    shortOfSpace();
    await openDownloads();

    toggle('storage-pack-mr_letters', false);
    toggle('storage-pack-en_letters', false);
    fireEvent.press(screen.getByTestId('storage-download'));
    await settle();
    expect(queuePacks()).not.toHaveBeenCalled();
  });

  test('no prompt when the plan is start or there is no plan yet', async () => {
    setStatus({ plan: { kind: 'start' }, items: [item('mr_letters', 'queued', 0, 38)] });
    await openDownloads();
    expect(screen.queryByTestId('storage-prompt')).toBeNull();
    expect(screen.getByTestId('downloads-item-mr_letters')).toBeTruthy();
  });
});

// ---- contract for dependents (Output for dependents: `/parent/downloads`, the storage prompt, the mobile-data switch) ----

describe('GURU-31 contract: route, StoragePrompt export, mobile-data switch', () => {
  test('exports and the switch exist under their pinned names', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const route = require('../app/parent/downloads');
    const prompt = require('./StoragePrompt');
    /* eslint-enable @typescript-eslint/no-require-imports */
    expect(typeof route.default).toBe('function');
    expect(typeof prompt.StoragePrompt).toBe('function');

    await openDownloads();
    expect(typeof screen.getByTestId('downloads-mobile-data').props.onValueChange).toBe('function');
  });
});
