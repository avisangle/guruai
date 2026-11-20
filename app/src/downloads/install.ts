// Verifying and installing a downloaded file: chunked SHA-256, pack unzip, the pack's lesson list.
import { unzipSync } from 'fflate';

/** Sync file port over string paths, mirroring expo-file-system's sync File API. */
export type FsPort = {
  /** Byte size, or null when the file does not exist. */
  size(path: string): number | null;
  append(path: string, bytes: Uint8Array): void;
  read(path: string, offset: number, length: number): Uint8Array;
  write(path: string, bytes: Uint8Array): void;
  move(from: string, to: string): void;
  /** Deletes a file, or a directory with everything in it; no-op when absent. */
  delete(path: string): void;
  freeBytes(): number;
};

/** The `@noble/hashes` `sha256.create()` shape. */
export type HasherFactory = () => { update(chunk: Uint8Array): unknown; digest(): Uint8Array };

const HASH_CHUNK = 1_000_000;
/** Written next to the pack's audio, so installed lessons are known offline. */
export const LESSONS_FILE = 'lessons.json';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Hashes the file one chunk at a time, yielding between chunks so the UI keeps running. */
export async function sha256File(
  fs: FsPort,
  create: HasherFactory,
  path: string,
  yieldTurn: () => Promise<void>,
): Promise<string> {
  const size = fs.size(path) ?? 0;
  const hasher = create();
  for (let at = 0; at < size; at += HASH_CHUNK) {
    hasher.update(fs.read(path, at, Math.min(HASH_CHUNK, size - at)));
    await yieldTurn();
  }
  return hex(hasher.digest());
}

/** Unzips a pack into dir (replacing anything there) and records its lessons. */
export function installPack(fs: FsPort, zipPath: string, dir: string, lessons: string[]): void {
  const entries = unzipSync(fs.read(zipPath, 0, fs.size(zipPath) ?? 0));
  fs.delete(dir);
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Unsafe path in pack: ${name}`);
    fs.write(`${dir}/${name}`, bytes);
  }
  fs.write(`${dir}/${LESSONS_FILE}`, new TextEncoder().encode(JSON.stringify(lessons)));
  fs.delete(zipPath);
}

/** The lessons an installed pack recorded; empty when the file is missing or unreadable. */
export function packLessons(fs: FsPort, dir: string): string[] {
  const path = `${dir}/${LESSONS_FILE}`;
  const size = fs.size(path);
  if (!size) return [];
  try {
    const list: unknown = JSON.parse(new TextDecoder().decode(fs.read(path, 0, size)));
    return Array.isArray(list) ? list.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}
