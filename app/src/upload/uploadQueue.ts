// Consented uploads (PRD Behavioral Flows, Edge Cases "consent withdrawn"; TDD 2.8, 2.9;
// D-GURU-38-upload-queue). With `consent_clips` on, a judged take is kept under
// <uploads>/<session>/ and queued; at session end with `consent_summaries` on, summary.json is
// written and queued. On Wi-Fi the queue asks the Worker for links per session (at most 200 files),
// PUTs each file, marks it uploaded and deletes the local copy. Turning a consent off deletes that
// kind's pending items and aborts its upload in flight. Only the device id and child code leave the phone.
import { randomUUID } from 'expo-crypto';

import type { Db, SqlParam } from '../data/db';
import { getDevice, updateDevice } from '../data/device';
import type { Device } from '../data/types';
import { backoff, onUnmetered, type DownloaderDeps } from '../downloads/downloader';
import type { FsPort } from '../downloads/install';
import { clipNamer } from '../recording/clips';
import { createUploadClient, fileName, uploadConfig, type FetchPort, type UploadConfig } from './client';
import { buildSessionSummary } from './summary';

type Kind = 'clip' | 'summary';

export type UploadDeps = {
  db: Db;
  fetch: FetchPort;
  fs: FsPort;
  network: DownloaderDeps['network'];
  clock: DownloaderDeps['clock'];
  config: UploadConfig;
  paths: { uploads: string };
  appVersion: string;
};

export type UploadQueue = {
  /** Moves a judged take into the session's upload folder and returns its name; null (and nothing kept) without consent. */
  keepClip(sessionId: string, audioUri: string, recordedAt: Date): string | null;
  /** Writes and queues summary.json with the summaries consent, then runs the queue. */
  sessionEnded(sessionId: string): Promise<void>;
  /** Drops items past retention, sends a waiting deletion request, then uploads on Wi-Fi. */
  run(): Promise<void>;
  /** Call after a consent flag is written: a switched-off kind stops at once. */
  consentChanged(): void;
  /** Queues a request to delete everything sent; sent once the phone is online. */
  requestDeletion(): Promise<void>;
};

const DAY = 86_400_000;
const RETENTION_MS = 30 * DAY;
const MAX_FILES = 200; // per link request (Worker limit)
const MAX_FAILURES = 6; // in a row; then wait for the next trigger
const TYPE: Record<Kind, string> = { clip: 'audio/wav', summary: 'application/json' };

const consented = (d: Device, kind: Kind) => (kind === 'clip' ? d.consent_clips : d.consent_summaries) === true;

type Item = { id: string; kind: Kind; path: string; session_id: string; child_code: string };
type Batch = { items: (Item & { bytes: number })[]; deviceId: string };

export function createUploadQueue(deps: UploadDeps): UploadQueue {
  const { db, fs, network, clock, paths } = deps;
  const client = createUploadClient(deps.config, deps.fetch);
  const nextClipId = clipNamer();
  let inFlight: { kind: Kind; abort: AbortController } | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let deleting: Promise<void> | null = null;

  const stamp = () => clock.now().toISOString();
  const folder = (sessionId: string) => `${paths.uploads}/${sessionId}`;

  function enqueue(kind: Kind, path: string, sessionId: string) {
    const at = stamp();
    db.run(
      "INSERT INTO upload_item (id, kind, path, session_id, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
      [randomUUID(), kind, path, sessionId, at, at],
    );
  }

  function drop(item: { id: string; path: string }) {
    fs.delete(item.path);
    db.run('DELETE FROM upload_item WHERE id = ?', [item.id]);
  }

  function dropPending(where: string, params: SqlParam[]) {
    db.all<{ id: string; path: string }>(`SELECT id, path FROM upload_item WHERE status = 'pending' AND ${where}`, params).forEach(drop);
  }

  /** The oldest session's pending items (at most MAX_FILES), with sizes; unconsented or missing files are dropped. */
  function nextBatch(): Batch | null {
    const device = getDevice(db);
    const rows = db.all<Item>(
      `SELECT u.id, u.kind, u.path, u.session_id, c.child_code FROM upload_item u
       JOIN session s ON s.id = u.session_id JOIN child_profile c ON c.id = s.child_id
       WHERE u.status = 'pending' ORDER BY u.created_at, u.rowid`,
    );
    const items: Batch['items'] = [];
    for (const row of rows) {
      if (items.length === MAX_FILES || (items.length > 0 && row.session_id !== items[0].session_id)) break;
      const bytes = consented(device, row.kind) ? fs.size(row.path) : null;
      if (bytes === null) drop(row);
      else items.push({ ...row, bytes });
    }
    return items.length ? { items, deviceId: device.device_id } : null;
  }

  async function uploadBatch({ items, deviceId }: Batch) {
    const [{ session_id, child_code }] = items;
    const links = await client.links({
      device_id: deviceId,
      child_code,
      session_id,
      files: items.map((i) => ({ name: fileName(i.path), bytes: i.bytes, type: TYPE[i.kind] })),
    });
    const urls = new Map(links.urls.map((u) => [u.name, u.url]));
    for (const item of items) {
      if (!consented(getDevice(db), item.kind)) {
        drop(item); // checked before each file
        continue;
      }
      const url = urls.get(fileName(item.path));
      if (!url) throw new Error(`no upload link for ${fileName(item.path)}`);
      const bytes = fs.read(item.path, 0, item.bytes);
      const abort = new AbortController();
      inFlight = { kind: item.kind, abort };
      db.run('UPDATE upload_item SET attempts = attempts + 1, updated_at = ? WHERE id = ?', [stamp(), item.id]);
      try {
        await client.put(url, bytes, TYPE[item.kind], abort.signal);
      } catch (e) {
        if (abort.signal.aborted) continue; // consent withdrawn: consentChanged dropped the item
        throw e;
      } finally {
        inFlight = null;
      }
      db.run("UPDATE upload_item SET status = 'uploaded', updated_at = ? WHERE id = ?", [stamp(), item.id]);
      fs.delete(item.path);
    }
    if (!db.get("SELECT 1 FROM upload_item WHERE session_id = ? AND status = 'pending'", [session_id])) fs.delete(folder(session_id));
  }

  /** Waiting deletion request: sent on any connection; on failure it stays queued for the next run. */
  function sendDeletion(): Promise<void> {
    deleting ??= (async () => {
      const device = getDevice(db);
      if (!device.deletion_requested_at || !(await network.getNetworkStateAsync()).isConnected) return;
      await client.deletionRequest(device.device_id);
      updateDevice(db, { deletion_requested_at: null });
    })()
      .catch(() => undefined)
      .finally(() => {
        deleting = null;
      });
    return deleting;
  }

  async function pass() {
    dropPending('created_at < ?', [new Date(clock.now().getTime() - RETENTION_MS).toISOString()]);
    await sendDeletion();
    let failures = 0;
    while (onUnmetered(await network.getNetworkStateAsync())) {
      const batch = nextBatch();
      if (!batch) return;
      try {
        await uploadBatch(batch);
        failures = 0;
      } catch {
        if (failures === MAX_FAILURES) return;
        await clock.sleep(backoff(failures++));
      }
    }
  }

  function run(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  // Any connection may carry a waiting deletion request; Wi-Fi starts uploads.
  network.addNetworkStateListener((s) => {
    if (s.isConnected) run().catch(() => undefined);
  });

  return {
    keepClip(sessionId, audioUri, recordedAt) {
      if (!consented(getDevice(db), 'clip')) return null;
      const name = `${nextClipId(recordedAt)}.wav`;
      const path = `${folder(sessionId)}/${name}`;
      fs.move(audioUri, path);
      enqueue('clip', path, sessionId);
      return name;
    },
    async sessionEnded(sessionId) {
      const queued = () => db.get("SELECT 1 FROM upload_item WHERE kind = 'summary' AND session_id = ?", [sessionId]);
      if (consented(getDevice(db), 'summary') && !queued()) {
        const path = `${folder(sessionId)}/summary.json`;
        const summary = buildSessionSummary(db, sessionId, { appVersion: deps.appVersion });
        fs.write(path, new TextEncoder().encode(JSON.stringify(summary)));
        enqueue('summary', path, sessionId);
      }
      await run();
    },
    run,
    consentChanged() {
      const device = getDevice(db);
      for (const kind of ['clip', 'summary'] as const) {
        if (consented(device, kind)) continue;
        if (inFlight?.kind === kind) inFlight.abort.abort();
        dropPending('kind = ?', [kind]);
      }
    },
    async requestDeletion() {
      updateDevice(db, { deletion_requested_at: stamp() });
      await sendDeletion();
    },
  };
}

// ---- the app's queue: created on first use (the root layout's start effect), so importing this touches no native module ----

let live: UploadQueue | null | undefined;

function liveQueue(): UploadQueue | null {
  if (live === undefined) {
    const config = uploadConfig();
    live = config && createUploadQueue(liveUploadDeps(config));
  }
  return live;
}

function liveUploadDeps(config: UploadConfig): UploadDeps {
  /* eslint-disable @typescript-eslint/no-require-imports -- device modules load only when the queue is first used */
  const { fetch } = require('expo/fetch') as typeof import('expo/fetch');
  const Network = require('expo-network') as typeof import('expo-network');
  const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
  const { Directory, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  const { liveDb } = require('../data/liveDb') as typeof import('../data/liveDb');
  const { fsPort, liveClock, noSlash } = require('../downloads/live') as typeof import('../downloads/live');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    db: liveDb(),
    // A Uint8Array body is valid at runtime; the DOM typings only accept ArrayBuffer-backed views.
    fetch: (url, init) => fetch(url, { ...init, body: init.body as BodyInit | undefined }),
    fs: fsPort,
    network: Network,
    clock: liveClock,
    config,
    paths: { uploads: noSlash(new Directory(Paths.document, 'uploads').uri) },
    appVersion: Constants.expoConfig?.version ?? 'unknown',
  };
}

/** The app's queue; without EXPO_PUBLIC_UPLOAD_URL and _KEY nothing is kept or sent. Fire and forget: never rejects. */
export const keepClip = (sessionId: string, audioUri: string, recordedAt: Date) =>
  liveQueue()?.keepClip(sessionId, audioUri, recordedAt) ?? null;
const quiet = (p: Promise<void> | undefined) => (p ?? Promise.resolve()).catch(() => undefined);
export const sessionEnded = (sessionId: string) => quiet(liveQueue()?.sessionEnded(sessionId));
export const requestDeletion = () => quiet(liveQueue()?.requestDeletion());
export const runUploads = () => quiet(liveQueue()?.run());
export const consentChanged = () => liveQueue()?.consentChanged();
