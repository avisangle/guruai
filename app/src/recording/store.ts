// Recording settings (localStorage) and saved clips (app-private files).
// Each clip is <id>.m4a plus <id>.json holding its manifest entry, in
// <documents>/clips. Nothing leaves the device except through exportClips().
import 'expo-sqlite/localStorage/install';

import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { ClipJudge } from '../asr/lessonJudge';
import type { ClipSink } from './capture';
import { buildManifest, exportFileName, zipClips, type ClipMeta } from './clips';

// Clips need the device file system; the web build only shows the controls.
export const RECORDING_SUPPORTED = Platform.OS !== 'web';

export type RecordingSettings = { child: string; age: number | null };

const SETTINGS_KEY = 'guru.recording.v1';
const EXPORT_PREFIX = 'guruai-clips-';

export function loadSettings(): RecordingSettings {
  try {
    const raw = globalThis.localStorage.getItem(SETTINGS_KEY);
    if (raw) return { child: '', age: null, ...JSON.parse(raw) };
  } catch {
    // unreadable: defaults
  }
  return { child: '', age: null };
}

export function saveSettings(settings: RecordingSettings) {
  globalThis.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const clipsDir = () => new Directory(Paths.document, 'clips');

function ensureClipsDir() {
  const dir = clipsDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const metaFiles = () => {
  if (!RECORDING_SUPPORTED) return [];
  const dir = clipsDir();
  if (!dir.exists) return [];
  return dir.list().filter((f): f is File => f instanceof File && f.name.endsWith('.json'));
};

export const countClips = () => metaFiles().length;

export function listClips(): ClipMeta[] {
  return metaFiles()
    .map((f) => JSON.parse(f.textSync()) as ClipMeta)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const clipSink: ClipSink = {
  async save(audioUri, meta) {
    const dir = ensureClipsDir();
    const audio = new File(audioUri);
    audio.moveSync(new File(dir, meta.file.slice('clips/'.length)));
    // written last: a clip without its .json is never listed
    new File(dir, `${meta.id}.json`).writeSync(JSON.stringify(meta));
  },
  discard(audioUri) {
    const audio = new File(audioUri);
    if (audio.exists) audio.delete();
  },
};

// The saved audio of a clip, and its judge verdict written into the clip's record.
export const clipAudioUri = (meta: ClipMeta) => new File(clipsDir(), meta.file.slice('clips/'.length)).uri;

export function annotateClip(id: string, judge: ClipJudge) {
  const f = new File(clipsDir(), `${id}.json`);
  if (!f.exists) return; // deleted meanwhile
  f.writeSync(JSON.stringify({ ...JSON.parse(f.textSync()), judge }));
}

const oldExports = () =>
  Paths.cache.list().filter((f): f is File => f instanceof File && f.name.startsWith(EXPORT_PREFIX));

export function deleteAllClips() {
  if (!RECORDING_SUPPORTED) return;
  const dir = clipsDir();
  if (dir.exists) dir.delete();
  for (const f of oldExports()) f.delete();
}

// Zips every clip (docs/clip-export.md) and opens the share sheet.
// Returns the number of clips exported.
export async function exportClips(): Promise<number> {
  const dir = clipsDir();
  const audio: Record<string, Uint8Array> = {};
  const clips = listClips().filter((clip) => {
    const file = new File(dir, clip.file.slice('clips/'.length));
    if (!file.exists) return false;
    audio[clip.file] = file.bytesSync();
    return true;
  });
  const now = new Date();
  const zip = zipClips(buildManifest(clips, now, Constants.expoConfig?.version ?? 'unknown'), audio);
  for (const f of oldExports()) f.delete(); // keep only the newest export in the cache
  const out = new File(Paths.cache, exportFileName(now));
  out.writeSync(zip);
  await Sharing.shareAsync(out.uri, { mimeType: 'application/zip', dialogTitle: 'GuruAI answer clips' });
  return clips.length;
}
