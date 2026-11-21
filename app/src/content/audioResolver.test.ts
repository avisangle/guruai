// GURU-26: line audio from installed packs. Install layout: TDD 2.7, D-GURU-14-pack-install-per-version.
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   pack_install(id, pack_id, version, status, bytes_done, bytes_total, sha256, path, created_at, updated_at)
// The downloader (GURU-14) writes one row per (pack id, version); an installed pack's `path` is its
// directory `<packs>/<pack id>/v<version>`. The model is a pack_install row too, its `path` the model file.
// A pack directory holds `<line id>.mp3` (dots kept) and `clips.json` = { [line id]: { duration, events } }
// (build-packs.mjs, GURU-23).
//
// Contract pinned here:
//   createAudioResolver(deps) -> { resolveLine(id) }, deps = {
//     db       the Db interface; installed packs are pack_install rows with status 'installed'
//     fs       { size(path), read(path, offset, length) }, the FsPort subset (downloads/install.ts)
//     bundled  { audio: LINE_AUDIO-shaped map, clips: generated/clips.json-shaped map }
//   }
//   resolveLine(id) -> { source: number (bundled asset) | string (file URI), clip: { duration, events } } | null
//   resolveLine(id) (module export) is the app's instance; useLinePlayer plays through it.
// The resolver notices an install by re-reading the installed rows; each pack's clips.json is read once per install.
// Importing the module must not touch native modules (the live instance is lazy, as in downloads/downloader.ts).
import { act, renderHook } from '@testing-library/react-native';

import type { Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createTestDb } from '../data/testDb';
import type { ShekruRig, VisemeEvent } from '../shekru/useShekruRig';
import { useLinePlayer } from '../screens/useLinePlayer';

import { createAudioResolver } from './audioResolver';

jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn() }));
jest.mock(
  'expo-network',
  () => ({
    getNetworkStateAsync: jest.fn(async () => ({ type: 'NONE', isConnected: false })),
    addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  }),
  { virtual: true },
);
jest.mock('../../modules/guru-asr', () => ({ __esModule: true, default: null }));

// useLinePlayer plays whatever the module's resolveLine returns; createAudioResolver stays real.
const mockResolveLine = jest.fn();
jest.mock('./audioResolver', () => ({
  ...jest.requireActual('./audioResolver'),
  resolveLine: (id: string) => mockResolveLine(id),
}));

// The line player is useAudioPlayer(null, ...); the chime is the other one.
const mockFakePlayer = () => ({
  addListener: jest.fn(() => ({ remove: jest.fn() })),
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
});
const mockLinePlayer = mockFakePlayer();
const mockChime = mockFakePlayer();
jest.mock('expo-audio', () => ({
  useAudioPlayer: (source: unknown) => (source === null ? mockLinePlayer : mockChime),
}));

type Clip = { duration: number; events: VisemeEvent[] };

const PACKS = 'file:///data/user/0/guru/files/packs';
const MODEL = 'file:///data/user/0/guru/files/models/mr_ctc_wav.int8.onnx';
const dirOf = (pack: string, version: number) => `${PACKS}/${pack}/v${version}`;

const SWAR = 'shekru.kg-mr-swar';
const LETTERS = 'shekru.kg-en-letters';
const SWAR_LINE = 'tpl_kg_mr_swar_2.a.teach';
const LETTERS_LINE = 'tpl_kg_en_letters_1.b.hint';

const clip = (duration: number, mouth: string): Clip => ({ duration, events: [[0.1, mouth], [duration - 0.1, 'rest']] });

const BUNDLED = {
  audio: { ask_1: 101, 'tpl_kg_mr_swar_1.intro': 102 } as Record<string, number>,
  clips: { ask_1: clip(3.6, 'EE'), 'tpl_kg_mr_swar_1.intro': clip(2.2, 'AA') } as Record<string, Clip>,
};

const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

/** In-memory files by path, counting reads per path. */
function fakeFs(files: Record<string, Uint8Array>) {
  const reads: Record<string, number> = {};
  return {
    files,
    reads,
    size: (p: string) => (p in files ? files[p].length : null),
    read: (p: string, offset: number, length: number) => {
      reads[p] = (reads[p] ?? 0) + 1;
      if (!(p in files)) throw new Error(`no file ${p}`);
      return files[p].slice(offset, offset + length);
    },
  };
}

/** Writes an installed pack's files the way installPack leaves them. */
function putPack(fs: ReturnType<typeof fakeFs>, pack: string, version: number, clips: Record<string, Clip> | string) {
  const dir = dirOf(pack, version);
  fs.files[`${dir}/clips.json`] = enc(clips);
  if (typeof clips !== 'string') for (const id of Object.keys(clips)) fs.files[`${dir}/${id}.mp3`] = new Uint8Array(64);
}

let rowId = 0;
function addRow(db: Db, packId: string, version: number, status: string, path: string) {
  const at = '2026-11-21T00:00:00Z';
  db.run(
    `INSERT INTO pack_install (id, pack_id, version, status, bytes_done, bytes_total, sha256, path, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 100, NULL, ?, ?, ?)`,
    [`row-${++rowId}`, packId, version, status, path, at, at],
  );
}

let db: Db;
let fs: ReturnType<typeof fakeFs>;

beforeEach(() => {
  db = createTestDb();
  migrate(db);
  fs = fakeFs({ [MODEL]: new Uint8Array(16) });
  addRow(db, 'mr_ctc_wav.int8', 1, 'installed', MODEL);
  mockResolveLine.mockReset();
  for (const p of [mockLinePlayer, mockChime]) Object.values(p).forEach((f) => f.mockClear());
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const resolver = () => createAudioResolver({ db, fs: { size: fs.size, read: fs.read }, bundled: BUNDLED });

describe('GURU-26 resolveLine', () => {
  test('a bundled line resolves to its bundled asset and clip, even when an installed pack also holds it', () => {
    putPack(fs, SWAR, 2, { ask_1: clip(9, 'O') });
    addRow(db, SWAR, 2, 'installed', dirOf(SWAR, 2));

    expect(resolver().resolveLine('ask_1')).toEqual({ source: 101, clip: BUNDLED.clips.ask_1 });
  });

  test('a pack line resolves to the file URI in the newest installed version, with that version\'s clip', () => {
    putPack(fs, SWAR, 1, { [SWAR_LINE]: clip(1.5, 'I') });
    putPack(fs, SWAR, 2, { [SWAR_LINE]: clip(2.5, 'AA') });
    putPack(fs, SWAR, 3, { [SWAR_LINE]: clip(3.5, 'OO') });
    addRow(db, SWAR, 1, 'installed', dirOf(SWAR, 1));
    addRow(db, SWAR, 2, 'installed', dirOf(SWAR, 2));
    addRow(db, SWAR, 3, 'downloading', dirOf(SWAR, 3)); // not installed yet: ignored

    expect(resolver().resolveLine(SWAR_LINE)).toEqual({
      source: `${dirOf(SWAR, 2)}/${SWAR_LINE}.mp3`,
      clip: clip(2.5, 'AA'),
    });
  });

  test('a line in no bundled set and no installed pack resolves to null and is logged once', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    putPack(fs, SWAR, 2, { [SWAR_LINE]: clip(2.5, 'AA') });
    addRow(db, SWAR, 2, 'installed', dirOf(SWAR, 2));
    const r = resolver();

    expect(r.resolveLine('tpl_unknown.intro')).toBeNull();
    expect(r.resolveLine('tpl_unknown.intro')).toBeNull();
    expect(r.resolveLine('tpl_unknown.intro')).toBeNull();

    const mentions = [...warn.mock.calls, ...log.mock.calls].filter((args) => args.join(' ').includes('tpl_unknown.intro'));
    expect(mentions).toHaveLength(1);
  });

  test('clips.json is read once per install, and a pack installed later resolves without a restart', () => {
    putPack(fs, SWAR, 2, { [SWAR_LINE]: clip(2.5, 'AA') });
    addRow(db, SWAR, 2, 'installed', dirOf(SWAR, 2));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = resolver();

    for (let i = 0; i < 3; i++) expect(r.resolveLine(SWAR_LINE)?.source).toBe(`${dirOf(SWAR, 2)}/${SWAR_LINE}.mp3`);
    expect(r.resolveLine(LETTERS_LINE)).toBeNull();
    expect(fs.reads[`${dirOf(SWAR, 2)}/clips.json`] ?? 0).toBe(1);

    // the downloader installs letters v1
    putPack(fs, LETTERS, 1, { [LETTERS_LINE]: clip(1.2, 'EE') });
    addRow(db, LETTERS, 1, 'installed', dirOf(LETTERS, 1));
    expect(r.resolveLine(LETTERS_LINE)).toEqual({ source: `${dirOf(LETTERS, 1)}/${LETTERS_LINE}.mp3`, clip: clip(1.2, 'EE') });
    r.resolveLine(LETTERS_LINE);
    expect(fs.reads[`${dirOf(LETTERS, 1)}/clips.json`]).toBe(1);

    // the downloader replaces swar v2 with v3: v2's row and files go (downloader.ts install())
    putPack(fs, SWAR, 3, { [SWAR_LINE]: clip(3.5, 'OO') });
    db.transaction(() => {
      addRow(db, SWAR, 3, 'installed', dirOf(SWAR, 3));
      db.run('DELETE FROM pack_install WHERE pack_id = ? AND version = ?', [SWAR, 2]);
    });
    for (const p of Object.keys(fs.files)) if (p.startsWith(`${dirOf(SWAR, 2)}/`)) delete fs.files[p];
    expect(r.resolveLine(SWAR_LINE)).toEqual({ source: `${dirOf(SWAR, 3)}/${SWAR_LINE}.mp3`, clip: clip(3.5, 'OO') });
  });

  test('an installed pack with a broken or missing clips.json contributes nothing and does not throw', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    putPack(fs, SWAR, 2, '{"tpl_kg_mr_swar_2.a.teach": {"durat');
    addRow(db, SWAR, 2, 'installed', dirOf(SWAR, 2));
    addRow(db, 'shekru.kg-mr-vyanjan', 1, 'installed', dirOf('shekru.kg-mr-vyanjan', 1)); // files gone
    putPack(fs, LETTERS, 1, { [LETTERS_LINE]: clip(1.2, 'EE') });
    addRow(db, LETTERS, 1, 'installed', dirOf(LETTERS, 1));
    const r = resolver();

    expect(r.resolveLine(SWAR_LINE)).toBeNull();
    expect(r.resolveLine(LETTERS_LINE)?.source).toBe(`${dirOf(LETTERS, 1)}/${LETTERS_LINE}.mp3`);
    expect(r.resolveLine('tpl_kg_mr_swar_1.intro')?.source).toBe(102);
  });
});

describe('GURU-26 useLinePlayer', () => {
  const rig = { setSpeech: jest.fn(), syncSpeech: jest.fn() } as unknown as ShekruRig;
  const uriOf = (src: unknown) => (typeof src === 'string' ? src : (src as { uri?: string } | null)?.uri);
  const flush = () => act(async () => {});

  test('plays installed file URIs and bundled assets alike, through resolveLine, with an unchanged API', async () => {
    const fileUri = `${dirOf(SWAR, 2)}/${SWAR_LINE}.mp3`;
    mockResolveLine.mockImplementation((id: string) =>
      id === SWAR_LINE ? { source: fileUri, clip: clip(2.5, 'AA') } : id === 'ask_1' ? { source: 101, clip: clip(3.6, 'EE') } : null,
    );
    const { result } = renderHook(() => useLinePlayer(rig));
    expect(Object.keys(result.current).sort()).toEqual(['chime', 'play', 'stop']);

    void result.current.play(SWAR_LINE, 'अ अननसाचा');
    expect(mockResolveLine).toHaveBeenCalledWith(SWAR_LINE);
    expect(uriOf(mockLinePlayer.replace.mock.calls.at(-1)?.[0])).toBe(fileUri);
    expect(rig.setSpeech).toHaveBeenLastCalledWith(clip(2.5, 'AA').events);
    expect(mockLinePlayer.play).toHaveBeenCalledTimes(1);

    void result.current.play('ask_1', 'Say it with me');
    expect(mockLinePlayer.replace.mock.calls.at(-1)?.[0]).toBe(101);
    expect(rig.setSpeech).toHaveBeenLastCalledWith(clip(3.6, 'EE').events);
    expect(mockLinePlayer.play).toHaveBeenCalledTimes(2);
    result.current.stop();
  });

  test('a line resolveLine cannot find keeps the silent hold of max(1200, length * 70) ms', async () => {
    jest.useFakeTimers();
    mockResolveLine.mockReturnValue(null);
    const { result } = renderHook(() => useLinePlayer(rig));

    let ended = false;
    void result.current.play('tpl_unknown.intro', 'x'.repeat(30)).then(() => {
      ended = true;
    });
    expect(mockResolveLine).toHaveBeenCalledWith('tpl_unknown.intro');
    expect(mockLinePlayer.replace).not.toHaveBeenCalled();
    expect(mockLinePlayer.play).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30 * 70 - 1);
    await flush();
    expect(ended).toBe(false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(ended).toBe(true);

    let shortEnded = false;
    void result.current.play('tpl_unknown.outro', 'hi').then(() => {
      shortEnded = true;
    });
    jest.advanceTimersByTime(1199);
    await flush();
    expect(shortEnded).toBe(false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(shortEnded).toBe(true);
  });
});

describe('GURU-26 contract for dependents', () => {
  test('exports resolveLine(id) and createAudioResolver(deps) returning { source, clip: { duration, events } } | null', () => {
    const actual = jest.requireActual('./audioResolver') as Record<string, unknown>;
    expect(typeof actual.resolveLine).toBe('function');
    expect(typeof actual.createAudioResolver).toBe('function');

    putPack(fs, SWAR, 2, { [SWAR_LINE]: clip(2.5, 'AA') });
    addRow(db, SWAR, 2, 'installed', dirOf(SWAR, 2));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = resolver();
    expect(typeof r.resolveLine).toBe('function');

    for (const [id, sourceType] of [['ask_1', 'number'], [SWAR_LINE, 'string']] as const) {
      const line = r.resolveLine(id);
      expect(line).not.toBeNull();
      expect(Object.keys(line!).sort()).toEqual(['clip', 'source']);
      expect(typeof line!.source).toBe(sourceType);
      expect(typeof line!.clip.duration).toBe('number');
      expect(Array.isArray(line!.clip.events)).toBe(true);
    }
    expect(r.resolveLine('tpl_unknown.intro')).toBeNull();
  });
});
