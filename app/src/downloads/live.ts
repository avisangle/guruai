// The downloader's device dependencies: expo-file-system, expo/fetch, expo-network, SQLite.
import { sha256 } from '@noble/hashes/sha2.js';
import { fetch } from 'expo/fetch';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as Network from 'expo-network';

import { modelFile } from '../asr/model';
import lessons from '../content/generated/lessons.json';
import catalogue from '../content/generated/paths.json';
import { liveDb } from '../data/liveDb';
import type { ChildProfile } from '../data/types';
import { pathsFor } from '../learning/enrol';
import type { DownloaderDeps } from './downloader';
import type { FsPort } from './install';

const noSlash = (uri: string) => uri.replace(/\/$/, '');

function ensureParent(file: File) {
  file.parentDirectory.create({ intermediates: true, idempotent: true });
}

const fsPort: FsPort = {
  size(path) {
    const f = new File(path);
    return f.exists ? f.size : null;
  },
  append(path, bytes) {
    const f = new File(path);
    if (!f.exists) {
      ensureParent(f);
      f.create();
    }
    const h = f.open(FileMode.Append);
    try {
      h.writeBytesSync(bytes);
    } finally {
      h.close();
    }
  },
  read(path, offset, length) {
    const h = new File(path).open(FileMode.ReadOnly);
    try {
      h.offset = offset;
      return h.readBytesSync(length);
    } finally {
      h.close();
    }
  },
  write(path, bytes) {
    const f = new File(path);
    ensureParent(f);
    f.create({ overwrite: true });
    f.writeSync(bytes);
  },
  move(from, to) {
    const dest = new File(to);
    ensureParent(dest);
    new File(from).moveSync(dest, { overwrite: true });
  },
  delete(path) {
    const f = new File(path);
    if (f.exists) return f.delete();
    const d = new Directory(path);
    if (d.exists) d.delete();
  },
  freeBytes: () => Paths.availableDiskSpace,
};

// Lessons whose audio build-content bundles (D-GURU-14-downloads-starter-pack).
const bundledLessons = lessons.map((l) => l.template_id);
const lessonPack: Record<string, string | undefined> = catalogue.lessonPack;

/** Packs holding the not-bundled lessons of the child's paths, by `lessonPack` (D-GURU-16). */
export function packsForChild(child: ChildProfile, bundled: string[] = bundledLessons): string[] {
  const wanted = new Set(pathsFor(child).map(([id]) => id));
  const skip = new Set(bundled);
  const ids = catalogue.paths
    .filter((p) => wanted.has(p.path_id))
    .flatMap((p) => p.units.flatMap((u) => u.lessons))
    .filter((l) => !skip.has(l))
    .map((l) => lessonPack[l]);
  return [...new Set(ids.filter((id) => id != null))];
}

export function liveDeps(): DownloaderDeps {
  return {
    db: liveDb(),
    fetch: (url, init) => fetch(url, init),
    fs: fsPort,
    network: Network,
    sha256: () => sha256.create(),
    clock: { now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    cdnBase: process.env.EXPO_PUBLIC_CDN_BASE ?? '',
    paths: { model: modelFile().uri, packs: noSlash(new Directory(Paths.document, 'packs').uri) },
    content: { bundledLessons, packsForChild: (child) => packsForChild(child) },
  };
}
