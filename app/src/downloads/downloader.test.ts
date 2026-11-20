// GURU-14: download manager. Manifest format and install layout: TDD 2.7 (Epic GURU-1).
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   pack_install(id, pack_id, version, status, bytes_done, bytes_total, sha256, path, created_at, updated_at)
//   device(..., allow_mobile_data INTEGER NOT NULL DEFAULT 0, ...)
// The model is a pack_install row too, keyed by the manifest's model id.
//
// Everything the downloader touches is injected through createDownloader(deps):
//   db       the Db interface (better-sqlite3 here)
//   fetch    (url, { headers }) -> streaming response; resume sends `Range: bytes=<n>-`
//   fs       sync string-path port, mirroring expo-file-system's sync File API
//   network  expo-network's shape: getNetworkStateAsync(), addNetworkStateListener()
//   sha256   () => incremental hasher, @noble/hashes' sha256.create() shape
//   clock    now() and sleep(ms), so retries never wait in real time
//   content  bundled lessons (starter pack) and the packs a child needs (GURU-16 data)
import * as fs from 'fs';
import * as nodeCrypto from 'crypto';
import * as path from 'path';
import { zipSync } from 'fflate';

import { migrate } from '../data/migrations';
import { createTestDb } from '../data/testDb';
import type { Db } from '../data/db';
import type { ChildProfile } from '../data/types';

import {
  createDownloader,
  downloadStatus,
  isLessonInstalled,
  queueChildPacks,
  queuePacks,
  startInitialDownloads,
  type DownloaderDeps,
} from './downloader';
import { parseManifest } from './manifest';
import { storagePlan } from './plan';
import { useDownloads } from './useDownloads';

// The default (live) instance must not reach native modules at import time.
jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn() }));
jest.mock(
  'expo-network',
  () => ({
    NetworkStateType: { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR', WIFI: 'WIFI' },
    getNetworkStateAsync: jest.fn(async () => ({ type: 'NONE', isConnected: false })),
    addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  }),
  { virtual: true },
);
jest.mock('../../modules/guru-asr', () => ({ __esModule: true, default: null }));

const CDN = 'https://cdn.example.test';
const MANIFEST_URL = `${CDN}/guru/v1/manifest.json`;
const MODEL_PATH = 'mem://doc/models/mr_ctc_wav.int8.onnx';
const PACKS = 'mem://doc/packs';
const MB = 1_000_000; // TDD 2.7 counts sizes in decimal MB (137 MB = 137000000 bytes)
const RESERVE = 200 * MB;

const sha256Hex = (b: Uint8Array) => nodeCrypto.createHash('sha256').update(b).digest('hex');

/** Content check by hash: jest's toEqual on a multi-MB array takes seconds. */
const hashOf = (b: Uint8Array | null) => (b ? sha256Hex(b) : null);

function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const MODEL = bytesOf(6 * MB, 7);
const PACK_ZIP = zipSync({
  'line_a.mp3': bytesOf(4000, 1),
  'clips.json': new TextEncoder().encode('{"line_a":{"ms":900,"visemes":[]}}'),
});

function manifestJson(over: { modelVersion?: number } = {}) {
  return {
    format: 1,
    published_at: '2026-12-01T00:00:00Z',
    model: {
      id: 'mr_ctc_wav.int8',
      version: over.modelVersion ?? 1,
      url: 'models/mr_ctc_wav.int8.v1.onnx',
      sha256: sha256Hex(MODEL),
      bytes: MODEL.length,
    },
    packs: [
      {
        id: 'shekru.kg-en-letters',
        tutor: 'shekru',
        version: 3,
        url: 'packs/shekru/kg-en-letters.v3.zip',
        sha256: sha256Hex(PACK_ZIP),
        bytes: PACK_ZIP.length,
        lessons: ['tpl_kg_en_letters_1'],
      },
    ],
  };
}

const MODEL_URL = `${CDN}/guru/v1/models/mr_ctc_wav.int8.v1.onnx`;
const PACK_URL = `${CDN}/guru/v1/packs/shekru/kg-en-letters.v3.zip`;

// ---------- fakes ----------

type Req = { url: string; range: string | null };

/** A CDN serving the manifest and files, honouring Range, with scripted faults. */
function fakeServer(files: Record<string, Uint8Array>, manifest: unknown = manifestJson()) {
  const requests: Req[] = [];
  const servedBytes: Record<string, number> = {};
  let offline = false;
  /** Per URL: bytes to deliver before the connection drops, once. */
  const dropAfter: Record<string, number> = {};
  /** Per URL: how many full responses to corrupt (one byte flipped). */
  const corrupt: Record<string, number> = {};

  const fetch = jest.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {};
    const rangeKey = Object.keys(headers).find((k) => k.toLowerCase() === 'range');
    const range = rangeKey ? headers[rangeKey] : null;
    requests.push({ url, range });
    if (offline) throw new TypeError('Network request failed');

    if (url === MANIFEST_URL) return response(200, {}, new TextEncoder().encode(JSON.stringify(manifest)));
    const file = files[url];
    if (!file) return response(404, {}, new Uint8Array());

    let start = 0;
    if (range) {
      const m = /^bytes=(\d+)-$/.exec(range);
      if (!m) throw new Error(`unexpected Range header ${range}`);
      start = Number(m[1]);
    }
    let body = file.slice(start);
    if (start === 0 && (corrupt[url] ?? 0) > 0) {
      corrupt[url]--;
      body = body.slice();
      body[body.length - 1] ^= 0xff;
    }
    const cut = dropAfter[url];
    if (cut !== undefined) delete dropAfter[url];
    const status = start > 0 ? 206 : 200;
    const h: Record<string, string> = { 'content-length': String(body.length) };
    if (start > 0) h['content-range'] = `bytes ${start}-${file.length - 1}/${file.length}`;
    return response(status, h, body, cut, (n) => (servedBytes[url] = (servedBytes[url] ?? 0) + n));
  });

  return {
    fetch,
    requests,
    servedBytes,
    fileRequests: (url: string) => requests.filter((r) => r.url === url),
    setOffline: (v: boolean) => (offline = v),
    dropAfter,
    corrupt,
  };
}

/** Minimal streaming Response: body.getReader() and async iteration, 64 KB chunks. */
function response(
  status: number,
  headers: Record<string, string>,
  bytes: Uint8Array,
  dropAfter?: number,
  onServe?: (n: number) => void,
) {
  const CHUNK = 64 * 1024;
  const makeReader = () => {
    let pos = 0;
    return {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (dropAfter !== undefined && pos >= dropAfter) throw new TypeError('Network request failed');
        if (pos >= bytes.length) return { done: true, value: undefined };
        const end = Math.min(bytes.length, pos + CHUNK, dropAfter ?? Infinity);
        const value = bytes.slice(pos, end);
        pos = end;
        onServe?.(value.length);
        return { done: false, value };
      },
      releaseLock() {},
      async cancel() {},
    };
  };
  const body = {
    getReader: makeReader,
    async *[Symbol.asyncIterator]() {
      const r = makeReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) return;
        yield value!;
      }
    },
  };
  const text = () => new TextDecoder().decode(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body,
    json: async () => JSON.parse(text()),
    text: async () => text(),
  } as unknown as Awaited<ReturnType<DownloaderDeps['fetch']>>;
}

/** In-memory file system keyed by path string. */
function fakeFs(freeBytes = 10_000 * MB) {
  const files = new Map<string, { buf: Uint8Array; len: number }>();
  const api = {
    size: (p: string) => (files.has(p) ? files.get(p)!.len : null),
    append(p: string, bytes: Uint8Array) {
      const f = files.get(p) ?? { buf: new Uint8Array(1024), len: 0 };
      if (f.len + bytes.length > f.buf.length) {
        const grown = new Uint8Array(Math.max(f.buf.length * 2, f.len + bytes.length));
        grown.set(f.buf.subarray(0, f.len));
        f.buf = grown;
      }
      f.buf.set(bytes, f.len);
      f.len += bytes.length;
      files.set(p, f);
    },
    read: (p: string, offset: number, length: number) => {
      const f = files.get(p);
      if (!f) throw new Error(`no such file ${p}`);
      return f.buf.slice(offset, Math.min(f.len, offset + length));
    },
    write(p: string, bytes: Uint8Array) {
      files.set(p, { buf: bytes.slice(), len: bytes.length });
    },
    move(from: string, to: string) {
      const f = files.get(from);
      if (!f) throw new Error(`no such file ${from}`);
      files.delete(from);
      files.set(to, f);
    },
    delete(p: string) {
      const base = p.replace(/\/$/, '');
      for (const k of [...files.keys()]) if (k === base || k.startsWith(base + '/')) files.delete(k);
    },
    freeBytes: () => freeBytes,
  };
  const contents = (p: string) => (files.has(p) ? files.get(p)!.buf.slice(0, files.get(p)!.len) : null);
  const lengths = () => [...files.values()].map((f) => f.len);
  return { api, contents, lengths, files };
}

function fakeNetwork(type: 'WIFI' | 'CELLULAR' | 'NONE') {
  let state = { type, isConnected: type !== 'NONE', isInternetReachable: type !== 'NONE' };
  const listeners = new Set<(s: typeof state) => void>();
  return {
    api: {
      getNetworkStateAsync: jest.fn(async () => state),
      addNetworkStateListener: jest.fn((cb: (s: typeof state) => void) => {
        listeners.add(cb);
        return { remove: () => listeners.delete(cb) };
      }),
    },
    switchTo(t: 'WIFI' | 'CELLULAR' | 'NONE') {
      state = { type: t, isConnected: t !== 'NONE', isInternetReachable: t !== 'NONE' };
      listeners.forEach((cb) => cb(state));
    },
  };
}

/** Records every chunk fed to the hasher. */
function fakeSha256() {
  const updates: number[] = [];
  const create = () => {
    const h = nodeCrypto.createHash('sha256');
    const hasher = {
      update(chunk: Uint8Array) {
        updates.push(chunk.length);
        h.update(chunk);
        return hasher;
      },
      digest: () => new Uint8Array(h.digest()),
    };
    return hasher;
  };
  return { create, updates };
}

type Rig = ReturnType<typeof rig>;

function rig(
  opts: {
    db?: Db;
    fsys?: ReturnType<typeof fakeFs>;
    server?: ReturnType<typeof fakeServer>;
    net?: 'WIFI' | 'CELLULAR' | 'NONE';
    allowMobileData?: boolean;
    bundledLessons?: string[];
    packsForChild?: (child: ChildProfile) => string[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  let db = opts.db;
  if (!db) {
    db = createTestDb();
    migrate(db);
    db.run(
      `INSERT INTO device (id, device_id, allow_mobile_data, created_at, updated_at)
       VALUES ('dev', 'dev-1', ?, '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')`,
      [opts.allowMobileData ? 1 : 0],
    );
  }
  const fsys = opts.fsys ?? fakeFs();
  const server = opts.server ?? fakeServer({ [MODEL_URL]: MODEL, [PACK_URL]: PACK_ZIP });
  const net = fakeNetwork(opts.net ?? 'WIFI');
  const hash = fakeSha256();
  const sleeps: number[] = [];
  let t = Date.parse('2026-11-20T10:00:00Z');
  const deps: DownloaderDeps = {
    db,
    fetch: server.fetch as unknown as DownloaderDeps['fetch'],
    fs: fsys.api,
    network: net.api,
    sha256: hash.create,
    clock: {
      now: () => new Date((t += 1000)),
      // Retries never wait in real time, but still yield a macrotask turn.
      sleep: async (ms: number) => {
        sleeps.push(ms);
        await (opts.sleep ?? (() => new Promise<void>((res) => setImmediate(res))))(ms);
      },
    },
    cdnBase: CDN,
    paths: { model: MODEL_PATH, packs: PACKS },
    content: {
      bundledLessons: opts.bundledLessons ?? ['tpl_kg_mr_swar_1'],
      packsForChild: opts.packsForChild ?? (() => []),
    },
  };
  const dl = createDownloader(deps);
  return { db, fsys, server, net, hash, sleeps, deps, dl };
}

/** Polls with real macrotask turns until cond holds; the downloader may run in the background. */
async function until(cond: () => boolean, label: string, turns = 2000) {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Starts background work without depending on when its promise settles. */
function run(p: Promise<unknown> | undefined) {
  p?.catch(() => undefined);
}

/** Lets any background work run, for asserting that nothing happened. */
async function settle() {
  for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
}

type InstallRow = {
  pack_id: string;
  version: number;
  status: string;
  bytes_done: number;
  bytes_total: number | null;
  sha256: string | null;
  path: string | null;
};
const installRow = (db: Db, packId: string) =>
  db.get<InstallRow>('SELECT * FROM pack_install WHERE pack_id = ?', [packId]);

const modelInstalled = (r: Rig) => installRow(r.db, 'mr_ctc_wav.int8')?.status === 'installed';

// ---------- behaviour ----------

describe('parseManifest (TDD 2.7)', () => {
  it('accepts the TDD 2.7 format and rejects missing fields, a non-https URL, or a format other than 1', () => {
    const ok = manifestJson();
    const parsed = parseManifest(ok);
    expect(parsed.format).toBe(1);
    expect(parsed.model).toMatchObject({ id: 'mr_ctc_wav.int8', version: 1, bytes: MODEL.length });
    expect(parsed.packs[0]).toMatchObject({ id: 'shekru.kg-en-letters', tutor: 'shekru', version: 3 });
    expect(parsed.packs[0].lessons).toEqual(['tpl_kg_en_letters_1']);

    // An absolute https URL is as valid as a path relative to the manifest.
    const abs = manifestJson();
    abs.model.url = 'https://cdn.example.test/guru/v1/models/m.onnx';
    expect(() => parseManifest(abs)).not.toThrow();

    const broken: ((m: any) => void)[] = [
      (m) => delete m.model.sha256,
      (m) => delete m.model.bytes,
      (m) => delete m.packs[0].lessons,
      (m) => delete m.packs[0].version,
      (m) => delete m.packs,
      (m) => (m.model.url = 'http://cdn.example.test/guru/v1/models/m.onnx'),
      (m) => (m.packs[0].url = 'http://cdn.example.test/p.zip'),
      (m) => (m.format = 2),
      (m) => delete m.format,
    ];
    for (const breakIt of broken) {
      const m = manifestJson();
      breakIt(m);
      expect(() => parseManifest(m)).toThrow();
    }
  });
});

describe('storagePlan', () => {
  it('starts when free space covers the files plus 200 MB, else offers the packs that fit', () => {
    const files = [
      { id: 'a', bytes: 100 * MB },
      { id: 'b', bytes: 50 * MB },
      { id: 'c', bytes: 300 * MB },
    ];
    const total = 450 * MB;

    expect(storagePlan(files, total + RESERVE)).toEqual({ kind: 'start' });
    expect(storagePlan(files, total + RESERVE + 1)).toEqual({ kind: 'start' });

    // 400 MB free: room for 200 MB after the reserve, so a and b fit, c does not.
    expect(storagePlan(files, 400 * MB)).toEqual({
      kind: 'needs_choice',
      needed: total + RESERVE,
      free: 400 * MB,
      fits: ['a', 'b'],
    });

    // Short by one byte is still short.
    expect(storagePlan(files, total + RESERVE - 1)).toMatchObject({ kind: 'needs_choice', fits: ['a', 'b'] });
    // Nothing fits under the reserve.
    expect(storagePlan(files, 150 * MB)).toMatchObject({ kind: 'needs_choice', fits: [] });
  });
});

describe('downloader', () => {
  it('on first open downloads the model to modelFile(), hashing it in chunks, and records it in pack_install; a later start skips it', async () => {
    const r = rig();
    run(r.dl.startInitialDownloads());
    await until(() => modelInstalled(r), 'model installed');

    expect(r.server.requests[0].url).toBe(MANIFEST_URL);
    expect(r.server.fileRequests(MODEL_URL)).toHaveLength(1);
    expect(hashOf(r.fsys.contents(MODEL_PATH))).toBe(sha256Hex(MODEL));
    expect(installRow(r.db, 'mr_ctc_wav.int8')).toMatchObject({
      version: 1,
      status: 'installed',
      bytes_done: MODEL.length,
      bytes_total: MODEL.length,
      sha256: sha256Hex(MODEL),
      path: MODEL_PATH,
    });
    expect(r.dl.downloadStatus().items.find((i) => i.kind === 'model')).toMatchObject({
      id: 'mr_ctc_wav.int8',
      status: 'installed',
    });

    // Chunked hashing: the whole file is never handed to the hasher at once.
    expect(r.hash.updates.length).toBeGreaterThan(1);
    expect(Math.max(...r.hash.updates)).toBeLessThan(MODEL.length);
    expect(r.hash.updates.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(MODEL.length);

    // App restart with the model installed at the manifest's version: nothing to fetch.
    const again = rig({ db: r.db, fsys: r.fsys, server: r.server });
    const before = r.server.requests.length;
    run(again.dl.startInitialDownloads());
    await settle();
    expect(r.server.requests.slice(before).filter((q) => q.url !== MANIFEST_URL)).toEqual([]);
    expect(hashOf(r.fsys.contents(MODEL_PATH))).toBe(sha256Hex(MODEL));
  });

  it('a newer model version in the manifest is downloaded again', async () => {
    const r = rig();
    run(r.dl.startInitialDownloads());
    await until(() => modelInstalled(r), 'v1 installed');

    const v2 = fakeServer({ [MODEL_URL]: MODEL }, manifestJson({ modelVersion: 2 }));
    const next = rig({ db: r.db, fsys: r.fsys, server: v2 });
    run(next.dl.startInitialDownloads());
    await until(() => installRow(r.db, 'mr_ctc_wav.int8')?.version === 2 && modelInstalled(next), 'v2 installed');
    expect(v2.fileRequests(MODEL_URL).length).toBeGreaterThanOrEqual(1);
  });

  it('resumes after a network drop and an app restart from the bytes already on disk (HTTP Range)', async () => {
    // First run: the connection drops partway through the model, and the app is then killed
    // (its network goes away and its retry sleeps never return).
    const cut = 2 * MB + 12_345;
    const dropping = fakeServer({ [MODEL_URL]: MODEL, [PACK_URL]: PACK_ZIP });
    dropping.dropAfter[MODEL_URL] = cut;
    const realFetch = dropping.fetch.getMockImplementation()!;
    let first: Rig;
    dropping.fetch.mockImplementation(async (url, init) => {
      const res = await realFetch(url, init);
      if (url === MODEL_URL) {
        dropping.setOffline(true);
        first.net.switchTo('NONE');
      }
      return res;
    });
    first = rig({ server: dropping, sleep: () => new Promise<void>(() => {}) });
    run(first.dl.startInitialDownloads());
    await settle();

    const mid = installRow(first.db, 'mr_ctc_wav.int8');
    expect(mid).not.toBeNull(); // state survives the restart in pack_install
    expect(mid!.status).not.toBe('installed');
    expect(mid!.status).not.toBe('failed');
    expect(first.server.fileRequests(MODEL_URL)[0].range ?? 'bytes=0-').toBe('bytes=0-');

    // Restart: a new downloader over the same database and disk; the network is back.
    const server = fakeServer({ [MODEL_URL]: MODEL, [PACK_URL]: PACK_ZIP });
    const second = rig({ db: first.db, fsys: first.fsys, server });
    run(second.dl.startInitialDownloads());
    await until(() => modelInstalled(second), 'model installed after resume');

    const modelReqs = server.fileRequests(MODEL_URL);
    expect(modelReqs.length).toBeGreaterThanOrEqual(1);
    const from = Number(/^bytes=(\d+)-$/.exec(modelReqs[0].range ?? '')?.[1] ?? 0);
    expect(from).toBeGreaterThan(0);
    expect(from).toBeLessThanOrEqual(cut);
    // Not downloaded again from the start.
    expect(server.servedBytes[MODEL_URL]).toBeLessThan(MODEL.length);
    expect(hashOf(first.fsys.contents(MODEL_PATH))).toBe(sha256Hex(MODEL));
    expect(installRow(first.db, 'mr_ctc_wav.int8')!.sha256).toBe(sha256Hex(MODEL));
  });

  it('a checksum mismatch deletes the file and downloads it again, up to 3 times, then marks it failed', async () => {
    // Corrupt once: the second full download is good.
    const once = fakeServer({ [MODEL_URL]: MODEL, [PACK_URL]: PACK_ZIP });
    once.corrupt[MODEL_URL] = 1;
    const r1 = rig({ server: once });
    run(r1.dl.startInitialDownloads());
    await until(() => modelInstalled(r1), 'model installed after one bad copy');
    const reqs1 = once.fileRequests(MODEL_URL);
    expect(reqs1).toHaveLength(2);
    // The bad copy was deleted, so the retry starts from byte 0.
    expect(reqs1[1].range === null || reqs1[1].range === 'bytes=0-').toBe(true);
    expect(hashOf(r1.fsys.contents(MODEL_PATH))).toBe(sha256Hex(MODEL));

    // Always corrupt: first download plus 3 re-downloads, then failed.
    const always = fakeServer({ [MODEL_URL]: MODEL, [PACK_URL]: PACK_ZIP });
    always.corrupt[MODEL_URL] = 99;
    const r2 = rig({ server: always });
    run(r2.dl.startInitialDownloads());
    await until(() => installRow(r2.db, 'mr_ctc_wav.int8')?.status === 'failed', 'model marked failed');
    await settle();
    expect(always.fileRequests(MODEL_URL)).toHaveLength(4);
    expect(r2.fsys.api.size(MODEL_PATH)).toBeNull();
    expect(r2.fsys.lengths()).not.toContain(MODEL.length); // no corrupt copy left anywhere
    expect(r2.dl.downloadStatus().items.find((i) => i.kind === 'model')?.status).toBe('failed');
  });

  it('waits for Wi-Fi unless the parent allows mobile data, and a switch to Wi-Fi resumes', async () => {
    const r = rig({ net: 'CELLULAR' });
    run(r.dl.startInitialDownloads());
    await settle();
    expect(r.server.requests.filter((q) => q.url !== MANIFEST_URL)).toEqual([]);
    expect(r.dl.downloadStatus().waitingForWifi).toBe(true);
    expect(modelInstalled(r)).toBe(false);

    r.net.switchTo('WIFI');
    await until(() => modelInstalled(r), 'model installed after Wi-Fi');
    expect(r.dl.downloadStatus().waitingForWifi).toBe(false);

    // Parent allows mobile data: downloads on cellular.
    const m = rig({ net: 'CELLULAR', allowMobileData: true });
    run(m.dl.startInitialDownloads());
    await until(() => modelInstalled(m), 'model installed on mobile data');
    expect(m.dl.downloadStatus().waitingForWifi).toBe(false);
  });

  it('does not start by itself when free space is short; the plan says what is needed', async () => {
    const r = rig({ fsys: fakeFs(MODEL.length + RESERVE - 1) });
    run(r.dl.startInitialDownloads());
    await settle();
    expect(r.server.fileRequests(MODEL_URL)).toEqual([]);
    expect(modelInstalled(r)).toBe(false);
    expect(r.dl.downloadStatus().plan).toMatchObject({
      kind: 'needs_choice',
      needed: MODEL.length + RESERVE,
      free: MODEL.length + RESERVE - 1,
    });

    const roomy = rig({ fsys: fakeFs(MODEL.length + RESERVE) });
    run(roomy.dl.startInitialDownloads());
    await until(() => modelInstalled(roomy), 'model installed with exactly enough space');
  });

  it('installs packs under packs/<pack id>/v<version>/; isLessonInstalled covers bundled and installed packs, offline after restart too', async () => {
    const child = { id: 'c1', tutor: 'shekru', class: 'jr_kg', goals: ['kg-en-letters'] } as unknown as ChildProfile;
    const packsForChild = jest.fn(() => ['shekru.kg-en-letters']);
    const r = rig({ packsForChild });

    expect(r.dl.isLessonInstalled('tpl_kg_mr_swar_1')).toBe(true); // bundled starter pack
    expect(r.dl.isLessonInstalled('tpl_kg_en_letters_1')).toBe(false);
    expect(r.dl.isLessonInstalled('tpl_unknown')).toBe(false);

    run(r.dl.queueChildPacks(child));
    const packInstalled = () => installRow(r.db, 'shekru.kg-en-letters')?.status === 'installed';
    await until(packInstalled, 'pack installed');
    expect(packsForChild).toHaveBeenCalledWith(child);

    const dir = `${PACKS}/shekru.kg-en-letters/v3`;
    expect(r.fsys.contents(`${dir}/line_a.mp3`)).toEqual(bytesOf(4000, 1));
    expect(new TextDecoder().decode(r.fsys.contents(`${dir}/clips.json`)!)).toContain('line_a');
    const row = installRow(r.db, 'shekru.kg-en-letters')!;
    expect(row).toMatchObject({ version: 3, sha256: sha256Hex(PACK_ZIP) });
    expect(row.path!.replace(/\/$/, '')).toBe(dir);
    expect(r.dl.isLessonInstalled('tpl_kg_en_letters_1')).toBe(true);
    expect(r.dl.isLessonInstalled('tpl_unknown')).toBe(false);

    // queuePacks on an installed pack fetches nothing.
    const before = r.server.fileRequests(PACK_URL).length;
    run(r.dl.queuePacks(['shekru.kg-en-letters']));
    await settle();
    expect(r.server.fileRequests(PACK_URL)).toHaveLength(before);

    // Restart with no network: installed lessons stay installed.
    // Airplane mode; retries park instead of spinning past the end of the test.
    r.server.setOffline(true);
    const offline = rig({
      db: r.db,
      fsys: r.fsys,
      server: r.server,
      net: 'NONE',
      sleep: () => new Promise<void>(() => {}),
    });
    run(offline.dl.startInitialDownloads());
    await settle();
    expect(offline.dl.isLessonInstalled('tpl_kg_en_letters_1')).toBe(true);
    expect(offline.dl.isLessonInstalled('tpl_kg_mr_swar_1')).toBe(true);
  });

  it('live wiring: the root layout starts initial downloads; the default instance uses modelFile() and EXPO_PUBLIC_CDN_BASE', () => {
    // Source scan: the layout and default deps need native modules to render or run.
    const layout = fs.readFileSync(path.join(__dirname, '../app/_layout.tsx'), 'utf8');
    expect(layout).toMatch(/import\s*\{[^}]*\bstartInitialDownloads\b[^}]*\}\s*from\s*['"][^'"]*downloads\/downloader['"]/);
    expect(layout).toMatch(/\bstartInitialDownloads\(\)/);

    const dir = __dirname;
    const src = fs
      .readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(src).toMatch(/\bmodelFile\(\)/);
    expect(src).toMatch(/process\.env\.EXPO_PUBLIC_CDN_BASE/);
    expect(src).toMatch(/\/guru\/v1\/manifest\.json/);
  });
});

// ---------- contract for dependents ----------

describe('contract: GURU-24, GURU-26, GURU-29, GURU-30, GURU-31, GURU-35', () => {
  it('exports startInitialDownloads, queuePacks, queueChildPacks, isLessonInstalled, downloadStatus, useDownloads, storagePlan, parseManifest with the promised shapes', async () => {
    // Exact names and arity.
    expect(typeof startInitialDownloads).toBe('function'); // GURU-1 root layout
    expect(startInitialDownloads.length).toBe(0);
    expect(typeof queuePacks).toBe('function'); // GURU-35
    expect(queuePacks.length).toBe(1);
    expect(typeof queueChildPacks).toBe('function'); // GURU-24
    expect(queueChildPacks.length).toBe(1);
    expect(typeof isLessonInstalled).toBe('function'); // GURU-35, today's queue
    expect(isLessonInstalled.length).toBe(1);
    expect(typeof downloadStatus).toBe('function'); // GURU-29, GURU-30, GURU-31
    expect(downloadStatus.length).toBe(0);
    expect(typeof useDownloads).toBe('function'); // GURU-29, GURU-30, GURU-31
    expect(typeof storagePlan).toBe('function'); // GURU-31
    expect(storagePlan.length).toBe(2);
    expect(typeof parseManifest).toBe('function');
    expect(typeof createDownloader).toBe('function');

    // Shapes, not values.
    const plan = storagePlan([{ id: 'p', bytes: 10 }], 0);
    expect(plan.kind).toBe('needs_choice');
    if (plan.kind === 'needs_choice') {
      expect(typeof plan.needed).toBe('number');
      expect(typeof plan.free).toBe('number');
      expect(Array.isArray(plan.fits)).toBe(true);
    }
    expect(storagePlan([], Number.MAX_SAFE_INTEGER)).toEqual({ kind: 'start' });

    const m = parseManifest(manifestJson());
    expect(Object.keys(m.model).sort()).toEqual(expect.arrayContaining(['bytes', 'id', 'sha256', 'url', 'version']));
    expect(Object.keys(m.packs[0]).sort()).toEqual(
      expect.arrayContaining(['bytes', 'id', 'lessons', 'sha256', 'tutor', 'url', 'version']),
    );

    const r = rig();
    const started = r.dl.startInitialDownloads();
    expect(typeof started?.then).toBe('function');
    run(started);
    const queued = r.dl.queuePacks([]);
    expect(typeof queued?.then).toBe('function');
    run(queued);
    expect(typeof r.dl.isLessonInstalled('tpl_x')).toBe('boolean');

    await until(() => r.dl.downloadStatus().items.length > 0, 'status lists the model');
    const status = r.dl.downloadStatus();
    expect(typeof status.waitingForWifi).toBe('boolean');
    expect(status.plan === null || typeof status.plan === 'object').toBe(true);
    const item = status.items[0];
    expect(typeof item.id).toBe('string');
    expect(['model', 'pack']).toContain(item.kind);
    expect(typeof item.version).toBe('number');
    expect(typeof item.status).toBe('string');
    expect(typeof item.bytesDone).toBe('number');
    expect(typeof item.bytesTotal).toBe('number');
    await until(() => modelInstalled(r), 'background download done');
  });
});
