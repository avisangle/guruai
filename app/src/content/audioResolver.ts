// Where a tutor line's audio and viseme clip come from: the app bundle, else an installed pack (D-GURU-14).
import type { Db } from '../data/db';
import type { FsPort } from '../downloads/install';
import type { VisemeEvent } from '../shekru/useShekruRig';

import { LINE_AUDIO } from './generated/audio';
import clipsJson from './generated/clips.json';

export type LineClip = { duration: number; events: VisemeEvent[] };
/** `source` is a bundled asset (number) or an installed pack's file URI (string). */
export type ResolvedLine = { source: number | string; clip: LineClip };

export type AudioResolverDeps = {
  db: Db;
  fs: Pick<FsPort, 'size' | 'read'>;
  bundled: { audio: Record<string, number>; clips: Record<string, LineClip> };
};

export type AudioResolver = { resolveLine(id: string): ResolvedLine | null };

export function createAudioResolver({ db, fs, bundled }: AudioResolverDeps): AudioResolver {
  // clips.json per installed pack directory; a directory is one (pack id, version), so this is once per install.
  const packClips = new Map<string, Record<string, LineClip>>();
  const logged = new Set<string>();

  const clipsIn = (dir: string): Record<string, LineClip> => {
    let clips = packClips.get(dir);
    if (!clips) {
      clips = {};
      const path = `${dir}/clips.json`;
      const size = fs.size(path);
      if (size) {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(fs.read(path, 0, size)));
          if (parsed && typeof parsed === 'object') clips = parsed as Record<string, LineClip>;
        } catch {
          // a broken clips.json contributes no lines
        }
      }
      packClips.set(dir, clips);
    }
    return clips;
  };

  return {
    resolveLine(id) {
      const asset = bundled.audio[id];
      const bundledClip = bundled.clips[id];
      if (asset != null && bundledClip) return { source: asset, clip: bundledClip };

      // Re-read every time, so a pack installed or replaced while the app runs is seen.
      const dirs = db
        .all<{ path: string }>("SELECT path FROM pack_install WHERE status = 'installed' ORDER BY version DESC")
        .map((r) => r.path);
      for (const dir of packClips.keys()) if (!dirs.includes(dir)) packClips.delete(dir);
      for (const dir of dirs) {
        const clip = clipsIn(dir)[id];
        if (clip) return { source: `${dir}/${id}.mp3`, clip };
      }

      if (!logged.has(id)) {
        logged.add(id);
        console.warn(`No audio for line ${id}`);
      }
      return null;
    },
  };
}

// ---- the app's instance ----

let live: AudioResolver | null = null;

/** The app's resolver over the bundled lines and the device's installed packs. */
export function resolveLine(id: string): ResolvedLine | null {
  // Lazy, so importing this module never touches native modules.
  if (!live) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { liveDb } = require('../data/liveDb') as typeof import('../data/liveDb');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fsPort } = require('../downloads/live') as typeof import('../downloads/live');
    live = createAudioResolver({
      db: liveDb(),
      fs: fsPort,
      bundled: { audio: LINE_AUDIO, clips: clipsJson as unknown as Record<string, LineClip> },
    });
  }
  return live.resolveLine(id);
}
