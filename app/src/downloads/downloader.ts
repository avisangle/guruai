// Download manager (TDD 2.7): queues the model and audio packs listed in the manifest, downloads
// them with resume, verifies SHA-256, installs, and records each in pack_install.
// One pack_install row per (pack id, version): an installed version stays usable until a newer one installs.
import { randomUUID } from 'expo-crypto';

import type { Db } from '../data/db';
import { getDevice } from '../data/device';
import type { ChildProfile } from '../data/types';
import { installPack, LESSONS_FILE, packLessons, sha256File, type FsPort, type HasherFactory } from './install';
import { fileUrl, manifestUrl, parseManifest, type Manifest, type ManifestFile } from './manifest';
import { storagePlan, type StoragePlan } from './plan';

type NetState = { type?: string; isConnected?: boolean | null };

export type FetchResponse = {
  ok: boolean;
  status: number;
  body: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> };
  } | null;
  json(): Promise<unknown>;
};

export type DownloaderDeps = {
  db: Db;
  fetch(url: string, init: { headers: Record<string, string> }): Promise<FetchResponse>;
  fs: FsPort;
  /** expo-network's shape. */
  network: {
    getNetworkStateAsync(): Promise<NetState>;
    addNetworkStateListener(listener: (state: NetState) => void): { remove(): void };
  };
  sha256: HasherFactory;
  clock: { now(): Date; sleep(ms: number): Promise<void> };
  cdnBase: string;
  paths: { model: string; packs: string };
  content: { bundledLessons: string[]; packsForChild(child: ChildProfile): string[] };
};

export type ItemStatus = 'queued' | 'downloading' | 'installed' | 'failed';

export type DownloadItem = {
  id: string;
  kind: 'model' | 'pack';
  version: number;
  status: ItemStatus;
  bytesDone: number;
  bytesTotal: number;
};

export type DownloadStatus = {
  /** Blocked by the Wi-Fi rule: mobile data is not allowed and there is no Wi-Fi. */
  waitingForWifi: boolean;
  /** The last storage plan; downloads started by themselves only when it was `start`. */
  plan: StoragePlan | null;
  /** The newest version of each model or pack the device has queued or installed. */
  items: DownloadItem[];
};

export type Downloader = ReturnType<typeof createDownloader>;

type Row = {
  id: string;
  pack_id: string;
  version: number;
  status: ItemStatus;
  bytes_done: number;
  bytes_total: number | null;
  path: string | null;
};

type Job = ManifestFile & { kind: 'model' | 'pack'; dest: string; lessons: string[] };

/** A checksum mismatch re-downloads this many times before the file is marked failed. */
const MAX_REDOWNLOADS = 3;
/** pack_install.bytes_done is written at most once per this many bytes. */
const PROGRESS_STEP = 1_000_000;
const backoff = (attempt: number) => Math.min(60_000, 2_000 * 2 ** attempt);
const UNMETERED = new Set(['WIFI', 'ETHERNET']);

export function createDownloader(deps: DownloaderDeps) {
  const { db, fs, clock, paths } = deps;
  const bundled = new Set(deps.content.bundledLessons);
  const listeners = new Set<() => void>();
  const wakers = new Set<() => void>();
  const queue: Job[] = [];
  let manifestP: Promise<Manifest> | null = null;
  let worker: Promise<void> | null = null;
  let waitingForWifi = false;
  let plan: StoragePlan | null = null;
  let lessonIndex: Set<string> | null = null;
  /** Cached until the next change, so useSyncExternalStore gets a stable snapshot. */
  let snapshot: DownloadStatus | null = null;

  const stamp = () => clock.now().toISOString();
  const notify = () => {
    snapshot = null;
    listeners.forEach((l) => l());
  };
  const isModelRow = (r: Row) => r.path === paths.model;
  const partPath = (job: Job, version = job.version) =>
    job.kind === 'model' ? `${paths.model}.v${version}.part` : `${paths.packs}/${job.id}/v${version}.zip.part`;
  /** Deletes another version's files; the model's shared path is never another version's. */
  const deleteOther = (job: Job, r: Row) => r.path && r.path !== job.dest && fs.delete(r.path);

  const row = (id: string, version: number) =>
    db.get<Row>('SELECT * FROM pack_install WHERE pack_id = ? AND version = ?', [id, version]);

  function setRow(job: Job, status: ItemStatus, bytesDone: number) {
    db.run('UPDATE pack_install SET status = ?, bytes_done = ?, updated_at = ? WHERE pack_id = ? AND version = ?', [
      status,
      bytesDone,
      stamp(),
      job.id,
      job.version,
    ]);
    notify();
  }

  // ---- network rule ----

  const allowMobileData = () => getDevice(db).allow_mobile_data;

  const usable = (s: NetState) => !!s.isConnected && (UNMETERED.has(s.type ?? '') || allowMobileData());

  function setWaiting(v: boolean) {
    if (waitingForWifi === v) return;
    waitingForWifi = v;
    notify();
  }

  /** Resolves once the network may be used: Wi-Fi, or any connection when the parent allows mobile data. */
  async function allowedNetwork() {
    while (!usable(await deps.network.getNetworkStateAsync())) {
      setWaiting(!allowMobileData());
      await new Promise<void>((resolve) => {
        const done = () => {
          sub.remove();
          wakers.delete(done);
          resolve();
        };
        const sub = deps.network.addNetworkStateListener((s) => usable(s) && done());
        wakers.add(done);
      });
    }
    setWaiting(false);
  }

  /** Re-checks the network rule now, e.g. after the parent allows mobile data. */
  const kick = () => [...wakers].forEach((w) => w());

  // ---- manifest ----

  async function fetchManifest(): Promise<Manifest> {
    if (!deps.cdnBase) throw new Error('No CDN base URL (EXPO_PUBLIC_CDN_BASE)');
    const url = manifestUrl(deps.cdnBase);
    for (let attempt = 0; ; attempt++) {
      await allowedNetwork();
      let json: unknown;
      try {
        const res = await deps.fetch(url, { headers: {} });
        if (res.ok) json = await res.json();
      } catch {
        // Network error: retry below.
      }
      if (json !== undefined) return parseManifest(json);
      await clock.sleep(backoff(attempt));
    }
  }

  function manifest() {
    manifestP ??= fetchManifest().catch((e) => {
      manifestP = null;
      throw e;
    });
    return manifestP;
  }

  // ---- queue ----

  const modelJob = (m: Manifest): Job => ({ ...m.model, kind: 'model', dest: paths.model, lessons: [] });
  const packJobs = (m: Manifest, ids: string[]): Job[] =>
    ids.flatMap((id) => {
      const p = m.packs.find((x) => x.id === id);
      return p ? [{ ...p, kind: 'pack' as const, dest: `${paths.packs}/${p.id}/v${p.version}` }] : [];
    });

  /** Installed at this version, with its files still on disk. */
  function isCurrent(job: Job) {
    if (row(job.id, job.version)?.status !== 'installed') return false;
    return fs.size(job.kind === 'model' ? job.dest : `${job.dest}/${LESSONS_FILE}`) !== null;
  }

  /** Creates or resets this version's row and drops unfinished rows (and files) of other versions. */
  function ensureRow(job: Job) {
    const stale = db.all<Row>(
      "SELECT * FROM pack_install WHERE pack_id = ? AND version != ? AND status != 'installed'",
      [job.id, job.version],
    );
    for (const r of stale) {
      fs.delete(partPath(job, r.version));
      deleteOther(job, r);
    }
    const at = stamp();
    db.transaction(() => {
      db.run("DELETE FROM pack_install WHERE pack_id = ? AND version != ? AND status != 'installed'", [
        job.id,
        job.version,
      ]);
      if (row(job.id, job.version)) {
        db.run(
          "UPDATE pack_install SET status = 'queued', bytes_total = ?, path = ?, updated_at = ? WHERE pack_id = ? AND version = ?",
          [job.bytes, job.dest, at, job.id, job.version],
        );
      } else {
        db.run(
          `INSERT INTO pack_install (id, pack_id, version, status, bytes_done, bytes_total, path, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
          [randomUUID(), job.id, job.version, job.bytes, job.dest, at, at],
        );
      }
    });
  }

  function enqueue(jobs: Job[]): Promise<void> {
    const todo = jobs.filter((j) => !isCurrent(j) && !queue.some((q) => q.id === j.id && q.version === j.version));
    if (todo.length) {
      const files = todo.map((j) => ({
        id: j.id,
        bytes: Math.max(0, j.bytes - (fs.size(partPath(j)) ?? 0)),
      }));
      plan = storagePlan(files, fs.freeBytes());
      if (plan.kind === 'start') {
        for (const j of todo) {
          ensureRow(j);
          queue.push(j);
        }
      }
      notify();
    }
    return pump();
  }

  /** Runs the queue one file at a time; resolves when it is empty. */
  function pump(): Promise<void> {
    // Only with work queued: the first await then defers `finally` until after the assignment.
    if (!worker && queue.length) {
      worker = (async () => {
        try {
          while (queue.length) {
            await runJob(queue[0]);
            queue.shift();
          }
        } finally {
          worker = null;
        }
      })();
    }
    return worker ?? Promise.resolve();
  }

  // ---- one file ----

  /** Streams the file from `from` onwards into part; false on a network or HTTP error. */
  async function fetchInto(job: Job, part: string, from: number): Promise<boolean> {
    try {
      const headers: Record<string, string> = from > 0 ? { Range: `bytes=${from}-` } : {};
      const res = await deps.fetch(fileUrl(deps.cdnBase, job.url), { headers });
      if (!res.ok || !res.body) return false;
      if (res.status !== 206) fs.delete(part); // the server sent the whole file
      let done = fs.size(part) ?? 0;
      let saved = done;
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (!value?.length) continue;
        // Never write past the manifest size; the checksum judges what was kept.
        const keep = value.subarray(0, Math.max(0, job.bytes - done));
        fs.append(part, keep);
        done += keep.length;
        if (done >= job.bytes) {
          await reader.cancel?.();
          break;
        }
        if (done - saved >= PROGRESS_STEP) {
          setRow(job, 'downloading', done);
          saved = done;
        }
      }
      setRow(job, 'downloading', done);
      return done >= job.bytes;
    } catch {
      setRow(job, 'downloading', fs.size(part) ?? 0);
      return false;
    }
  }

  async function runJob(job: Job) {
    const part = partPath(job);
    let failures = 0;
    let redownloads = 0;
    for (;;) {
      const have = fs.size(part) ?? 0;
      if (have < job.bytes) {
        await allowedNetwork();
        setRow(job, 'downloading', have);
        if (!(await fetchInto(job, part, have))) {
          await clock.sleep(backoff(failures++));
          continue;
        }
        failures = 0;
      }
      const hash = await sha256File(fs, deps.sha256, part, () => clock.sleep(0));
      if (hash === job.sha256 && fs.size(part) === job.bytes) return install(job, part, hash);
      fs.delete(part);
      if (++redownloads > MAX_REDOWNLOADS) return setRow(job, 'failed', 0);
    }
  }

  function install(job: Job, part: string, hash: string) {
    if (job.kind === 'model') fs.move(part, job.dest);
    else installPack(fs, part, job.dest, job.lessons);
    const older = db.all<Row>('SELECT * FROM pack_install WHERE pack_id = ? AND version != ?', [job.id, job.version]);
    db.transaction(() => {
      db.run(
        "UPDATE pack_install SET status = 'installed', bytes_done = ?, sha256 = ?, path = ?, updated_at = ? WHERE pack_id = ? AND version = ?",
        [job.bytes, hash, job.dest, stamp(), job.id, job.version],
      );
      db.run('DELETE FROM pack_install WHERE pack_id = ? AND version != ?', [job.id, job.version]);
    });
    for (const r of older) deleteOther(job, r);
    lessonIndex = null;
    notify();
  }

  // ---- public ----

  /** Every app start: queues the model, and resumes or updates packs the device already has. */
  async function startInitialDownloads(): Promise<void> {
    kick();
    const m = await manifest();
    const known = db.all<{ pack_id: string }>('SELECT DISTINCT pack_id FROM pack_install').map((r) => r.pack_id);
    return enqueue([modelJob(m), ...packJobs(m, known)]);
  }

  async function queuePacks(packIds: string[]): Promise<void> {
    kick();
    if (!packIds.length) return pump();
    return enqueue(packJobs(await manifest(), packIds));
  }

  const queueChildPacks = (child: ChildProfile) => queuePacks(deps.content.packsForChild(child));

  function isLessonInstalled(templateId: string): boolean {
    if (bundled.has(templateId)) return true;
    if (!lessonIndex) {
      const rows = db.all<Row>("SELECT * FROM pack_install WHERE status = 'installed'");
      lessonIndex = new Set(rows.flatMap((r) => (r.path ? packLessons(fs, r.path) : [])));
    }
    return lessonIndex.has(templateId);
  }

  function downloadStatus(): DownloadStatus {
    if (snapshot) return snapshot;
    const rows = db.all<Row>('SELECT * FROM pack_install ORDER BY pack_id, version DESC');
    const items = rows
      .filter((r, i) => i === 0 || rows[i - 1].pack_id !== r.pack_id)
      .map((r) => ({
        id: r.pack_id,
        kind: isModelRow(r) ? ('model' as const) : ('pack' as const),
        version: r.version,
        status: r.status,
        bytesDone: r.bytes_done,
        bytesTotal: r.bytes_total ?? 0,
      }));
    snapshot = { waitingForWifi, plan, items };
    return snapshot;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { startInitialDownloads, queuePacks, queueChildPacks, isLessonInstalled, downloadStatus, subscribe };
}

// ---- the app's instance ----

let live: Downloader | null = null;

function instance(): Downloader {
  // Lazy, so importing this module never touches native modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  live ??= createDownloader((require('./live') as typeof import('./live')).liveDeps());
  return live;
}

export const startInitialDownloads = () => instance().startInitialDownloads();
export const queuePacks = (packIds: string[]) => instance().queuePacks(packIds);
export const queueChildPacks = (child: ChildProfile) => instance().queueChildPacks(child);
export const isLessonInstalled = (templateId: string) => instance().isLessonInstalled(templateId);
export const downloadStatus = () => instance().downloadStatus();
export const subscribeDownloads = (listener: () => void) => instance().subscribe(listener);
