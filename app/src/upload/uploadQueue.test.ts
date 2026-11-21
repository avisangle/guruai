// GURU-38: consented clip and session-summary uploads. Spec: issue GURU-38, TDD 2.8 (upload Worker)
// and 2.9 (session summary) in Epic GURU-1, PRD Behavioral Flows (consented upload), Edge Cases
// (consent withdrawn), D-GURU-6-upload-auth.
//
// Real schema (app/src/data/migrations.ts, migration 1):
//   upload_item(id, kind 'clip'|'summary', path, session_id, status, attempts DEFAULT 0, created_at, updated_at)
//   device(device_id, consent_clips, consent_summaries, judge_check, judge_p90_ms, ...)
//   child_profile(nickname, picture, class, medium, style_level, child_code, ...)
//   session(child_id, started_at, ended_at, end_reason, parent_helps 0/1, active_ms, ...)
//   event(child_id, session_id, at, type, payload JSON): answer payloads are TDD 2.3 AnswerEvents
//
// Worker contract (workers/upload/src/{index,validate}.ts, GURU-6):
//   POST <url>/v1/upload-links  {device_id, child_code, session_id, files:[{name, bytes, type}]}
//     -> {expires_at, urls:[{name, url}]}; device_id and session_id are UUIDs, child_code 4 letters,
//     name [a-z0-9-]+.(wav|json), type audio/wav | application/json, at most 200 files
//   POST <url>/v1/deletion-request  {device_id} -> 202
//   Header x-guru-app = the app key on both.
//
// Contract pinned for /implement:
//   app/src/upload/uploadQueue.ts
//     createUploadQueue(deps: { db, fetch, fs, network, clock, config: {url, key}, paths: {uploads}, appVersion })
//       fs is the downloads FsPort (downloads/install.ts); network is expo-network's shape;
//       fetch(url, {method, headers, body?, signal?}) -> {ok, status, json()}; clock {now(), sleep(ms)}.
//     -> queue with:
//       keepClip(sessionId, audioUri, recordedAt): string | null
//           consent_clips on: moves the take to <uploads>/<sessionId>/c-<yyyymmdd-hhmmss>-<nnn>.wav,
//           adds an upload_item 'clip' row and returns the file name; off: null and nothing kept.
//       sessionEnded(sessionId): Promise<void>
//           consent_summaries on: writes <uploads>/<sessionId>/summary.json (TDD 2.9) and its
//           'summary' row; then runs the queue.
//       run(): Promise<void>   deletes items older than 30 days, then uploads on Wi-Fi only;
//                              without Wi-Fi it returns and runs again once Wi-Fi appears.
//       consentChanged(): void deletes the switched-off kind's pending items and aborts its upload.
//       requestDeletion(): Promise<void>  queued; sent once the phone is online.
//     requestDeletion(): Promise<void>  the live queue's, called by Settings.
//     consentChanged(): void            the live queue's, called by Settings after it writes a consent flag.
//   app/src/upload/summary.ts   buildSessionSummary(db, sessionId, { appVersion }) -> TDD 2.9 object
//   app/src/upload/client.ts    createUploadClient, uploadConfig (EXPO_PUBLIC_UPLOAD_URL, EXPO_PUBLIC_UPLOAD_KEY)
//   app/src/recording/capture.ts  createMicSource opt keep(audioUri, recordedAt) -> name | null: with no
//                                 tester context, a kept take is not discarded.
//   app/src/learning/events.ts  AnswerContext.clip: the kept clip's name, stored in the answer payload.
// The Settings row ("Ask to delete sent recordings") is tested in src/parent/settings.test.tsx.
/* eslint-disable @typescript-eslint/no-require-imports */
import * as fs from 'fs';
import * as path from 'path';

import { getDevice, answerConsent, setJudgeCheck } from '../data/device';
import type { Db } from '../data/db';
import { migrate } from '../data/migrations';
import { createChild, getChild } from '../data/profiles';
import { createTestDb } from '../data/testDb';
import type { ChildProfile } from '../data/types';
import lessonsJson from '../content/generated/lessons.json';
import type { ClipJudge } from '../asr/lessonJudge';
import type { Heard, Item, Lesson, Listen } from '../lesson/types';
import { recordAnswer, type AnswerEvent } from '../learning/events';
import { saveMastery } from '../learning/mastery';
import { endSession, lessonEnded, lessonLeft, lessonStarted, startSession } from '../learning/session';
import { createMicSource, type ClipSink, type Mic } from '../recording/capture';

// Real UUIDs: the Worker rejects any other device or session id.
jest.mock('expo-crypto', () => {
  const nodeCrypto = jest.requireActual('crypto');
  return { randomUUID: () => nodeCrypto.randomUUID(), getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)) };
});
// The live queue must not reach native modules at import time.
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

// ---- module under test, loaded per test so a missing module fails each test on its own ----

type Queue = {
  keepClip(sessionId: string, audioUri: string, recordedAt: Date): string | null;
  sessionEnded(sessionId: string): Promise<void>;
  run(): Promise<void>;
  consentChanged(): void;
  requestDeletion(): Promise<void>;
};
const uploadQueue = () =>
  require('./uploadQueue') as { createUploadQueue(deps: unknown): Queue; requestDeletion(): Promise<void>; consentChanged(): void };
const summaryModule = () =>
  require('./summary') as { buildSessionSummary(db: Db, sessionId: string, opts: { appVersion: string }): Record<string, unknown> };
const clientModule = () => require('./client') as Record<string, unknown>;

// ---- fakes ----

const UPLOADS = 'mem://doc/uploads';
const CONFIG = { url: 'https://upload.example.test', key: 'app-key-test' };
const APP_VERSION = '1.0.0';
const DAY = 86_400_000;
const T0 = new Date('2026-12-01T10:15:00Z');

const lesson = lessonsJson[0] as unknown as Lesson; // tpl_kg_mr_swar_1, 6 letter items
const [itemA, itemB] = lesson.items;

/** In-memory FsPort that logs every write. */
function fakeFs() {
  const files = new Map<string, Uint8Array>();
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const port = {
    size: (p: string) => files.get(p)?.length ?? null,
    append(p: string, bytes: Uint8Array) {
      const old = files.get(p) ?? new Uint8Array(0);
      const next = new Uint8Array(old.length + bytes.length);
      next.set(old);
      next.set(bytes, old.length);
      files.set(p, next);
      writes.push({ path: p, bytes });
    },
    read(p: string, offset: number, length: number) {
      const f = files.get(p);
      if (!f) throw new Error(`no such file ${p}`);
      return f.slice(offset, offset + length);
    },
    write(p: string, bytes: Uint8Array) {
      files.set(p, bytes.slice());
      writes.push({ path: p, bytes: bytes.slice() });
    },
    move(from: string, to: string) {
      const f = files.get(from);
      if (!f) throw new Error(`no such file ${from}`);
      files.delete(from);
      files.set(to, f);
    },
    delete(p: string) {
      const base = p.replace(/\/$/, '');
      for (const k of [...files.keys()]) if (k === base || k.startsWith(`${base}/`)) files.delete(k);
    },
    freeBytes: () => 10_000_000_000,
  };
  return { port, files, writes };
}

type NetState = { type: string; isConnected: boolean };
function fakeNetwork(initial: NetState) {
  let state = initial;
  const listeners = new Set<(s: NetState) => void>();
  return {
    port: {
      getNetworkStateAsync: async () => state,
      addNetworkStateListener(l: (s: NetState) => void) {
        listeners.add(l);
        return { remove: () => void listeners.delete(l) };
      },
    },
    set(next: NetState) {
      state = next;
      [...listeners].forEach((l) => l(next));
    },
  };
}
const WIFI: NetState = { type: 'WIFI', isConnected: true };
const CELL: NetState = { type: 'CELLULAR', isConnected: true };
const OFFLINE: NetState = { type: 'NONE', isConnected: false };

type Init = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal };
type Call = { url: string; method: string; headers: Record<string, string>; body: string | Uint8Array | undefined; signal?: AbortSignal };

/**
 * The Worker plus R2. `status(call, n)` may override the HTTP status of the n-th call to that URL;
 * `hold(call)` keeps a PUT open until its signal aborts.
 */
function fakeServer(opts: { status?: (call: Call, n: number) => number | null; hold?: (call: Call) => boolean } = {}) {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const held: Call[] = [];
  const reply = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = jest.fn(async (url: string, init: Init = {}) => {
    const call: Call = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body,
      signal: init.signal,
    };
    calls.push(call);
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    if (opts.hold?.(call)) {
      held.push(call);
      return new Promise<never>((_, reject) => {
        call.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    const forced = opts.status?.(call, n);
    if (forced) return reply(forced);
    if (url === `${CONFIG.url}/v1/upload-links`) {
      const req = JSON.parse(String(init.body)) as { session_id: string; files: { name: string }[] };
      return reply(200, {
        expires_at: new Date(T0.getTime() + 900_000).toISOString(),
        urls: req.files.map((f) => ({ name: f.name, url: `https://r2.example.test/put/${req.session_id}/${f.name}?sig=x` })),
      });
    }
    if (url === `${CONFIG.url}/v1/deletion-request`) return reply(202);
    if (url.startsWith('https://r2.example.test/put/') && call.method === 'PUT') return reply(200);
    return reply(404);
  });
  const linkCalls = () => calls.filter((c) => c.url === `${CONFIG.url}/v1/upload-links`);
  const puts = () => calls.filter((c) => c.method === 'PUT');
  const putName = (c: Call) => new URL(c.url).pathname.split('/').pop()!;
  return { fetch, calls, held, linkCalls, puts, putName };
}

function fakeClock(start = T0) {
  let t = start.getTime();
  const sleeps: number[] = [];
  return {
    port: {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
    set: (d: Date) => void (t = d.getTime()),
    sleeps,
  };
}

/** Lets fetch promises and network listeners settle; real timers. */
async function until(cond: () => boolean, tries = 300) {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
}

// ---- fixtures ----

function freshDb(): Db {
  const db = createTestDb();
  migrate(db);
  return db;
}

type Rig = {
  db: Db;
  child: ChildProfile;
  files: ReturnType<typeof fakeFs>;
  net: ReturnType<typeof fakeNetwork>;
  server: ReturnType<typeof fakeServer>;
  clock: ReturnType<typeof fakeClock>;
  queue: Queue;
  /** Puts a recorder take on the fake disk and returns its uri. */
  take(n: number): string;
};

function rig(opts: { net?: NetState; consent?: { clips: boolean; summaries: boolean }; server?: Parameters<typeof fakeServer>[0] } = {}): Rig {
  const db = freshDb();
  getDevice(db);
  answerConsent(db, opts.consent ?? { clips: true, summaries: true });
  const child = createChild(db, { nickname: 'Chinmayee', picture: 'peacock', class: 'UKG', medium: 'en' });
  const files = fakeFs();
  const net = fakeNetwork(opts.net ?? OFFLINE);
  const server = fakeServer(opts.server);
  const clock = fakeClock();
  const queue = uploadQueue().createUploadQueue({
    db,
    fetch: server.fetch,
    fs: files.port,
    network: net.port,
    clock: clock.port,
    config: CONFIG,
    paths: { uploads: UPLOADS },
    appVersion: APP_VERSION,
  });
  const take = (n: number) => {
    const uri = `file:///cache/rec-${n}.wav`;
    files.files.set(uri, new Uint8Array([82, 73, 70, 70, n & 0xff, 0, 0, 0])); // "RIFF" + junk
    return uri;
  };
  return { db, child, files, net, server, clock, queue, take };
}

type UploadRow = { kind: string; path: string; session_id: string | null; status: string; attempts: number };
const uploadRows = (db: Db) => db.all<UploadRow>('SELECT kind, path, session_id, status, attempts FROM upload_item ORDER BY created_at, rowid');

const answerEvent = (item: Item, over: Partial<AnswerEvent> = {}): AnswerEvent => ({
  template_id: lesson.template_id,
  item_key: item.item_key,
  item_kind: item.kind,
  target_lang: item.target_lang,
  phase: 'quiz',
  heard_kind: 'correct',
  matched_text: item.assessment.expected[0],
  matched_lang: item.target_lang,
  decided_by: 'shekru',
  attempt: 1,
  unsure: false,
  style_level: 'mr_led',
  counts: true,
  ...over,
});

const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();

// ---- behaviour ----

describe('GURU-38 clips', () => {
  test('consent_clips on: a judged take is kept under uploads/<session>/ and queued; off: nothing is kept; release capture keeps instead of discarding', async () => {
    const r = rig();
    const session = startSession(r.db, r.child.id, at(0));

    const first = r.queue.keepClip(session, r.take(1), T0);
    const second = r.queue.keepClip(session, r.take(2), T0); // same second: next sequence number
    expect(first).toBe('c-20261201-101500-001.wav');
    expect(second).toBe('c-20261201-101500-002.wav');
    expect(r.files.files.has('file:///cache/rec-1.wav')).toBe(false); // moved, not copied
    expect(r.files.files.has(`${UPLOADS}/${session}/${first}`)).toBe(true);
    expect(uploadRows(r.db)).toEqual([
      expect.objectContaining({ kind: 'clip', path: `${UPLOADS}/${session}/${first}`, session_id: session, attempts: 0 }),
      expect.objectContaining({ kind: 'clip', path: `${UPLOADS}/${session}/${second}`, session_id: session }),
    ]);
    expect(uploadRows(r.db).every((row) => row.status !== 'uploaded')).toBe(true);

    answerConsent(r.db, { clips: false, summaries: true });
    expect(r.queue.keepClip(session, r.take(3), T0)).toBeNull();
    expect(r.files.files.has('file:///cache/rec-3.wav')).toBe(true); // left for the caller to discard
    expect(uploadRows(r.db)).toHaveLength(2);

    // Capture with no tester context (release build): keep() decides whether the take survives.
    const discarded: string[] = [];
    const sink: ClipSink = { save: () => undefined, discard: (uri) => void discarded.push(uri) };
    let n = 0;
    let onPcm: ((pcm: Int16Array, rate: number) => void) | null = null;
    const mic: Mic = {
      prepare: async () => void n++,
      record: async (cb) => void (onPcm = cb),
      stop: async () => ({ uri: `file:///cache/take-${n}.wav`, durationMs: 1500 }),
    };
    const heard: Heard = { kind: 'correct', by: 'shekru' };
    const verdict: ClipJudge = { choice: 'अ', verdict: 'correct', heard, free: 'अ', note: '', ms: 120 };
    const kept: string[] = [];
    let keepName: string | null = 'c-20261201-101500-003.wav';
    const source = createMicSource(mic, sink, {
      startDelayMs: 0,
      judge: async () => verdict,
      context: () => null,
      keep: (uri: string, recordedAt: Date) => {
        expect(recordedAt).toBeInstanceOf(Date);
        kept.push(uri);
        return keepName;
      },
      wait: (ms) => (ms > 5000 ? new Promise<void>(() => {}) : Promise.resolve()),
    });
    const listen: Listen = { type: 'listen', item: itemA, kind: 'quiz', showAnchor: false, prompt: itemA.lines.hint };
    const talk = () => {
      onPcm?.(new Int16Array(8000).map((_, i) => (i % 2 ? 3000 : -3000)), 16000);
      onPcm?.(new Int16Array(32000), 16000);
    };

    let answer = source.listen(listen);
    await until(() => onPcm != null);
    talk();
    expect(await answer).toEqual(heard);
    expect(kept).toEqual(['file:///cache/take-1.wav']);
    expect(discarded).toEqual([]); // kept for upload

    keepName = null; // consent off: keep() refuses
    onPcm = null;
    answer = source.listen(listen);
    await until(() => onPcm != null);
    talk();
    await answer;
    expect(discarded).toEqual(['file:///cache/take-2.wav']);
  });
});

describe('GURU-38 session summary', () => {
  test('at session end with consent_summaries on, summary.json (TDD 2.9) is written and queued; off: nothing', async () => {
    const r = rig();
    setJudgeCheck(r.db, 'slow', 1200);
    const session = startSession(r.db, r.child.id, at(0));
    const ctx = (m: number) => ({ childId: r.child.id, sessionId: session, at: at(m) });

    // itemB is mastered with a 1-day revision interval before this session.
    saveMastery(
      r.db,
      { child_id: r.child.id, item_key: itemB.item_key, lang: itemB.target_lang, state: 'mastered', streak: 3, interval_days: 1, next_due: '2026-12-01', last_result: 'correct' },
      at(-DAY / 60_000),
    );

    lessonStarted(r.db, ctx(1), lesson.template_id);
    const clip = r.queue.keepClip(session, r.take(1), new Date(at(2)))!;
    recordAnswer(r.db, { ...ctx(2), ms: 410, clip }, answerEvent(itemA));
    recordAnswer(r.db, ctx(3), answerEvent(itemB, { phase: 'revision' }));
    lessonEnded(r.db, ctx(4), lesson.template_id);
    const second = (lessonsJson[1] as unknown as Lesson).template_id;
    lessonStarted(r.db, ctx(5), second);
    lessonLeft(r.db, ctx(6), second, { done: 1, total: 6 });
    endSession(r.db, session, 'goodbye', { at: at(7), activeMs: 400_000, parentHelps: true });

    await r.queue.sessionEnded(session);

    const file = r.files.files.get(`${UPLOADS}/${session}/summary.json`);
    expect(file).toBeDefined();
    const summary = JSON.parse(new TextDecoder().decode(file));
    const child = getChild(r.db, r.child.id)!;
    expect(summary).toEqual({
      format: 1,
      app_version: APP_VERSION,
      device_id: getDevice(r.db).device_id,
      child_code: child.child_code,
      session_id: session,
      started_at: at(0),
      ended_at: at(7),
      end_reason: 'goodbye',
      parent_helps: true,
      judge_check: 'slow',
      judge_p90_ms: 1200,
      class: 'UKG',
      medium: 'en',
      style_level: child.style_level,
      lessons: [
        { template_id: lesson.template_id, started_at: at(1), ended_at: at(4), finished: true, items_total: lesson.items.length, items_resolved: lesson.items.length },
        { template_id: second, started_at: at(5), ended_at: at(6), finished: false, items_total: 6, items_resolved: 1 },
      ],
      answers: [
        {
          at: at(2),
          template_id: lesson.template_id,
          item_key: itemA.item_key,
          item_kind: 'letter',
          target_lang: 'mr',
          phase: 'quiz',
          heard_kind: 'correct',
          matched_text: itemA.assessment.expected[0],
          matched_lang: 'mr',
          expected: itemA.assessment.expected,
          decided_by: 'shekru',
          attempt: 1,
          unsure: false,
          counts: true,
          clip,
        },
        {
          at: at(3),
          template_id: lesson.template_id,
          item_key: itemB.item_key,
          item_kind: 'letter',
          target_lang: 'mr',
          phase: 'revision',
          heard_kind: 'correct',
          matched_text: itemB.assessment.expected[0],
          matched_lang: 'mr',
          expected: itemB.assessment.expected,
          decided_by: 'shekru',
          attempt: 1,
          unsure: false,
          counts: true,
          revision_interval_days: 1, // the interval that came due, not the one this answer moved it to
        },
      ],
    });
    expect(uploadRows(r.db)).toContainEqual(
      expect.objectContaining({ kind: 'summary', path: `${UPLOADS}/${session}/summary.json`, session_id: session }),
    );

    // Summaries consent off: no file, no row.
    const off = rig({ consent: { clips: true, summaries: false } });
    const s2 = startSession(off.db, off.child.id, at(0));
    endSession(off.db, s2, 'stop', { at: at(1), activeMs: 1000, parentHelps: false });
    await off.queue.sessionEnded(s2);
    expect([...off.files.files.keys()].some((k) => k.endsWith('summary.json'))).toBe(false);
    expect(uploadRows(off.db)).toEqual([]);
  });
});

describe('GURU-38 upload queue', () => {
  test('uploads only on Wi-Fi; links in batches of at most 200; PUTs each file, marks it uploaded, deletes the local copy', async () => {
    const r = rig({ net: CELL });
    const session = startSession(r.db, r.child.id, at(0));
    for (let i = 0; i < 201; i++) r.queue.keepClip(session, r.take(i), new Date(T0.getTime() + i * 1000));
    endSession(r.db, session, 'goodbye', { at: at(5), activeMs: 300_000, parentHelps: false });

    await r.queue.sessionEnded(session); // summary + 201 clips queued; mobile data only: nothing sent
    expect(r.server.calls).toEqual([]);
    expect(uploadRows(r.db)).toHaveLength(202);

    r.net.set(WIFI); // the queue runs by itself once Wi-Fi appears
    await until(() => uploadRows(r.db).every((row) => row.status === 'uploaded'));

    const links = r.server.linkCalls();
    expect(links.map((c) => JSON.parse(String(c.body)).files.length).sort((a, b) => b - a)).toEqual([200, 2]);
    for (const c of links) {
      expect(c.method).toBe('POST');
      expect(c.headers['x-guru-app']).toBe(CONFIG.key);
      const body = JSON.parse(String(c.body));
      expect(Object.keys(body).sort()).toEqual(['child_code', 'device_id', 'files', 'session_id']);
      expect(body).toMatchObject({ device_id: getDevice(r.db).device_id, child_code: r.child.child_code, session_id: session });
      for (const f of body.files) {
        expect(f.name).toMatch(/^[a-z0-9-]+\.(wav|json)$/);
        expect(f.type).toBe(f.name.endsWith('.wav') ? 'audio/wav' : 'application/json');
        expect(f.bytes).toEqual(f.name === 'summary.json' ? expect.any(Number) : 8);
      }
    }

    const puts = r.server.puts();
    expect(puts).toHaveLength(202);
    expect(new Set(puts.map(r.server.putName)).size).toBe(202);
    const summaryPut = puts.find((c) => r.server.putName(c) === 'summary.json')!;
    expect(summaryPut.headers['content-type']).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(summaryPut.body as Uint8Array)).session_id).toBe(session);
    const clipPut = puts.find((c) => r.server.putName(c) === 'c-20261201-101500-001.wav')!;
    expect(clipPut.headers['content-type']).toBe('audio/wav');
    expect(Array.from(clipPut.body as Uint8Array)).toEqual([82, 73, 70, 70, 0, 0, 0, 0]);

    expect(uploadRows(r.db).every((row) => row.status === 'uploaded')).toBe(true);
    expect([...r.files.files.keys()].filter((k) => k.startsWith(UPLOADS))).toEqual([]); // local copies gone
  });

  test('failures retry with growing backoff; items not uploaded within 30 days are deleted, even offline', async () => {
    // PUT of the first clip fails three times, then succeeds.
    const flaky = rig({
      net: WIFI,
      server: { status: (c, n) => (c.method === 'PUT' && c.url.includes('-001.wav') && n <= 3 ? 500 : null) },
    });
    const s1 = startSession(flaky.db, flaky.child.id, at(0));
    flaky.queue.keepClip(s1, flaky.take(1), T0);
    await flaky.queue.run();
    await until(() => uploadRows(flaky.db).every((row) => row.status === 'uploaded'));
    expect(uploadRows(flaky.db).map((row) => row.status)).toEqual(['uploaded']);
    expect(flaky.server.puts()).toHaveLength(4);
    const waits = flaky.clock.sleeps.filter((ms) => ms > 0);
    expect(waits.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThan(waits[i - 1]);

    // The link request fails once (Worker busy), then succeeds.
    const busy = rig({ net: WIFI, server: { status: (c, n) => (c.url.endsWith('/v1/upload-links') && n === 1 ? 503 : null) } });
    const s2 = startSession(busy.db, busy.child.id, at(0));
    busy.queue.keepClip(s2, busy.take(1), T0);
    await busy.queue.run();
    await until(() => uploadRows(busy.db).every((row) => row.status === 'uploaded'));
    expect(uploadRows(busy.db).map((row) => row.status)).toEqual(['uploaded']);
    expect(busy.server.linkCalls().length).toBeGreaterThanOrEqual(2);
    expect(busy.clock.sleeps.some((ms) => ms > 0)).toBe(true);

    // Retention: offline for a month.
    const away = rig({ net: OFFLINE });
    const s3 = startSession(away.db, away.child.id, at(0));
    const old = away.queue.keepClip(s3, away.take(1), T0)!;
    away.clock.set(new Date(T0.getTime() + 20 * DAY));
    const recent = away.queue.keepClip(s3, away.take(2), new Date(T0.getTime() + 20 * DAY))!;
    away.clock.set(new Date(T0.getTime() + 31 * DAY));
    await away.queue.run();
    expect(away.server.calls).toEqual([]);
    expect(uploadRows(away.db).map((row) => row.path)).toEqual([`${UPLOADS}/${s3}/${recent}`]);
    expect(away.files.files.has(`${UPLOADS}/${s3}/${old}`)).toBe(false);
    expect(away.files.files.has(`${UPLOADS}/${s3}/${recent}`)).toBe(true);
  });

  test('turning clips consent off deletes pending clips, aborts the clip in flight, stops capture; summaries go on; later summaries link no clip', async () => {
    const r = rig({ net: WIFI, server: { hold: (c) => c.method === 'PUT' && c.url.endsWith('.wav') } });
    const s1 = startSession(r.db, r.child.id, at(0));
    const c1 = r.queue.keepClip(s1, r.take(1), T0)!;
    const c2 = r.queue.keepClip(s1, r.take(2), new Date(T0.getTime() + 1000))!;
    endSession(r.db, s1, 'goodbye', { at: at(3), activeMs: 100_000, parentHelps: false });

    const running = r.queue.sessionEnded(s1);
    await until(() => r.server.held.length > 0);
    expect(r.server.held.length).toBeGreaterThan(0);
    const inFlight = [...r.server.held];
    expect(inFlight.every((c) => c.signal)).toBe(true); // abortable

    answerConsent(r.db, { clips: false, summaries: true });
    r.queue.consentChanged();
    const putsAtWithdrawal = r.server.puts().filter((c) => c.url.endsWith('.wav')).length;

    expect(inFlight.every((c) => c.signal?.aborted)).toBe(true);
    await running;
    await until(() => uploadRows(r.db).every((row) => row.status === 'uploaded'));

    expect(r.server.puts().filter((c) => c.url.endsWith('.wav'))).toHaveLength(putsAtWithdrawal); // no clip after
    expect(uploadRows(r.db)).toEqual([expect.objectContaining({ kind: 'summary', status: 'uploaded', session_id: s1 })]);
    expect(r.files.files.has(`${UPLOADS}/${s1}/${c1}`)).toBe(false);
    expect(r.files.files.has(`${UPLOADS}/${s1}/${c2}`)).toBe(false);
    expect(r.queue.keepClip(s1, r.take(3), T0)).toBeNull(); // capture stops at once

    // A clip kept before the switch-off but not uploaded is not named in a later summary.
    const later = rig();
    const s2 = startSession(later.db, later.child.id, at(10));
    const clip = later.queue.keepClip(s2, later.take(1), new Date(at(11)))!;
    recordAnswer(later.db, { childId: later.child.id, sessionId: s2, at: at(11), clip }, answerEvent(itemA));
    answerConsent(later.db, { clips: false, summaries: true });
    later.queue.consentChanged();
    endSession(later.db, s2, 'goodbye', { at: at(12), activeMs: 60_000, parentHelps: false });
    await later.queue.sessionEnded(s2);
    const summary = JSON.parse(new TextDecoder().decode(later.files.files.get(`${UPLOADS}/${s2}/summary.json`)));
    expect(summary.answers).toHaveLength(1);
    expect(summary.answers[0]).not.toHaveProperty('clip');
    expect(uploadRows(later.db).map((row) => row.kind)).toEqual(['summary']);
  });

  test('requestDeletion() is queued until the phone is online, then sent once with the device id', async () => {
    const r = rig({ net: OFFLINE });
    await r.queue.requestDeletion(); // resolves while offline: queued, not sent
    expect(r.server.calls).toEqual([]);

    r.net.set(CELL); // any connection will do for this small request
    await until(() => r.server.calls.length > 0);
    r.net.set(WIFI);
    await until(() => false, 20);

    const sent = r.server.calls.filter((c) => c.url === `${CONFIG.url}/v1/deletion-request`);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].headers['x-guru-app']).toBe(CONFIG.key);
    expect(JSON.parse(String(sent[0].body))).toEqual({ device_id: getDevice(r.db).device_id });
  });

  test('a full upload run never carries a nickname or picture in any request or file', async () => {
    const r = rig({ net: WIFI });
    const session = startSession(r.db, r.child.id, at(0));
    const ctx = { childId: r.child.id, sessionId: session };
    lessonStarted(r.db, { ...ctx, at: at(1) }, lesson.template_id);
    for (let i = 1; i <= 3; i++) {
      const clip = r.queue.keepClip(session, r.take(i), new Date(at(1 + i)))!;
      recordAnswer(r.db, { ...ctx, at: at(1 + i), clip }, answerEvent(lesson.items[i]));
    }
    lessonEnded(r.db, { ...ctx, at: at(5) }, lesson.template_id);
    endSession(r.db, session, 'goodbye', { at: at(6), activeMs: 300_000, parentHelps: false });
    await r.queue.sessionEnded(session);
    await until(() => uploadRows(r.db).length === 4 && uploadRows(r.db).every((row) => row.status === 'uploaded'));
    await r.queue.requestDeletion();
    await until(() => r.server.calls.some((c) => c.url.endsWith('/v1/deletion-request')));

    expect(r.server.puts()).toHaveLength(4); // 3 clips + summary
    const text = (b: string | Uint8Array | undefined) => (b === undefined ? '' : typeof b === 'string' ? b : Buffer.from(b).toString('utf8'));
    const sent = [
      ...r.server.calls.map((c) => `${c.url}\n${JSON.stringify(c.headers)}\n${text(c.body)}`),
      ...r.files.writes.map((w) => `${w.path}\n${text(w.bytes)}`),
    ].join('\n');
    expect(sent).toContain(r.child.child_code);
    for (const secret of [r.child.nickname, r.child.picture, 'nickname', 'picture']) expect(sent).not.toContain(secret);
  });
});

// ---- contract for GURU-39 (pilot gate metrics and labelling sheet) ----

describe('GURU-38 contract for GURU-39: summary.json format (TDD 2.9), upload layout, exports', () => {
  test('exports, queue methods, summary shape, upload layout, env-configured client', async () => {
    const q = uploadQueue();
    expect(typeof q.createUploadQueue).toBe('function');
    expect(typeof q.requestDeletion).toBe('function');
    expect(typeof q.consentChanged).toBe('function');
    const client = clientModule();
    expect(typeof client.createUploadClient).toBe('function');
    expect(typeof client.uploadConfig).toBe('function');
    const { buildSessionSummary } = summaryModule();
    expect(typeof buildSessionSummary).toBe('function');

    const r = rig();
    for (const m of ['keepClip', 'sessionEnded', 'run', 'consentChanged', 'requestDeletion'] as const) expect(typeof r.queue[m]).toBe('function');

    const session = startSession(r.db, r.child.id, at(0));
    lessonStarted(r.db, { childId: r.child.id, sessionId: session, at: at(1) }, lesson.template_id);
    recordAnswer(r.db, { childId: r.child.id, sessionId: session, at: at(2) }, answerEvent(itemA));
    lessonEnded(r.db, { childId: r.child.id, sessionId: session, at: at(3) }, lesson.template_id);
    endSession(r.db, session, 'stop', { at: at(4), activeMs: 1, parentHelps: false });

    const s = buildSessionSummary(r.db, session, { appVersion: APP_VERSION });
    const TOP = ['answers', 'app_version', 'child_code', 'class', 'device_id', 'end_reason', 'ended_at', 'format', 'judge_check', 'judge_p90_ms', 'lessons', 'medium', 'parent_helps', 'session_id', 'started_at', 'style_level'];
    expect(Object.keys(s).sort()).toEqual(TOP);
    expect(s).toMatchObject({
      format: 1,
      app_version: expect.any(String),
      device_id: expect.any(String),
      child_code: expect.any(String),
      session_id: expect.any(String),
      started_at: expect.any(String),
      ended_at: expect.any(String),
      parent_helps: expect.any(Boolean),
      class: expect.any(String),
      medium: expect.any(String),
      style_level: expect.any(String),
      lessons: expect.any(Array),
      answers: expect.any(Array),
    });
    const [l] = s.lessons as Record<string, unknown>[];
    expect(Object.keys(l).sort()).toEqual(['ended_at', 'finished', 'items_resolved', 'items_total', 'started_at', 'template_id']);
    expect(l).toMatchObject({ finished: expect.any(Boolean), items_total: expect.any(Number), items_resolved: expect.any(Number) });
    const [a] = s.answers as Record<string, unknown>[];
    const ANSWER = ['at', 'template_id', 'item_key', 'item_kind', 'target_lang', 'phase', 'heard_kind', 'matched_text', 'matched_lang', 'expected', 'decided_by', 'attempt', 'unsure', 'counts', 'revision_interval_days', 'clip'];
    expect(Object.keys(a).every((k) => ANSWER.includes(k))).toBe(true);
    expect(a).toMatchObject({ expected: expect.any(Array), attempt: expect.any(Number), unsure: expect.any(Boolean), counts: expect.any(Boolean) });

    // Upload layout: one folder per session; clips c-<stamp>-<seq>.wav beside summary.json.
    const clip = r.queue.keepClip(session, r.take(1), T0)!;
    expect(clip).toMatch(/^c-\d{8}-\d{6}-\d{3}\.wav$/);
    await r.queue.sessionEnded(session);
    expect(r.files.files.has(`${UPLOADS}/${session}/${clip}`)).toBe(true);
    expect(r.files.files.has(`${UPLOADS}/${session}/summary.json`)).toBe(true);

    // The client is configured by the two env vars; no other module holds the upload URL or key.
    const src = fs.readFileSync(path.join(__dirname, 'client.ts'), 'utf8');
    expect(src).toMatch(/process\.env\.EXPO_PUBLIC_UPLOAD_URL/);
    expect(src).toMatch(/process\.env\.EXPO_PUBLIC_UPLOAD_KEY/);
  });
});
