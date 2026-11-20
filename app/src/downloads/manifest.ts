// The download manifest (TDD 2.7): one JSON file listing the model and the audio packs.

export const MANIFEST_PATH = '/guru/v1/manifest.json';

export type ManifestFile = { id: string; version: number; url: string; sha256: string; bytes: number };
export type ManifestPack = ManifestFile & { tutor: string; lessons: string[] };
export type Manifest = { format: 1; published_at: string; model: ManifestFile; packs: ManifestPack[] };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // ids become directory names
const SHA256 = /^[0-9a-f]{64}$/i;

function fail(what: string): never {
  throw new Error(`Invalid manifest: ${what}`);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') fail(`${where}.${key}`);
  return v;
}

function count(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) fail(`${where}.${key}`);
  return v;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(where);
  return v as Record<string, unknown>;
}

function file(v: unknown, where: string): ManifestFile {
  const o = obj(v, where);
  const id = str(o, 'id', where);
  if (!SAFE_ID.test(id)) fail(`${where}.id`);
  const url = str(o, 'url', where);
  // Relative to the manifest, or absolute https; no other scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('https://')) fail(`${where}.url`);
  const sha256 = str(o, 'sha256', where);
  if (!SHA256.test(sha256)) fail(`${where}.sha256`);
  return { id, version: count(o, 'version', where), url, sha256: sha256.toLowerCase(), bytes: count(o, 'bytes', where) };
}

export function parseManifest(json: unknown): Manifest {
  const m = obj(json, 'root');
  if (m.format !== 1) fail('format');
  if (!Array.isArray(m.packs)) fail('packs');
  return {
    format: 1,
    published_at: str(m, 'published_at', 'root'),
    model: file(m.model, 'model'),
    packs: m.packs.map((p, i) => {
      const where = `packs[${i}]`;
      const o = obj(p, where);
      const lessons = o.lessons;
      if (!Array.isArray(lessons) || !lessons.every((l) => typeof l === 'string')) fail(`${where}.lessons`);
      return { ...file(p, where), tutor: str(o, 'tutor', where), lessons: [...lessons] };
    }),
  };
}

/** A manifest URL is absolute https or relative to the manifest's folder. */
export function fileUrl(cdnBase: string, url: string): string {
  if (url.startsWith('https://')) return url;
  const dir = MANIFEST_PATH.slice(0, MANIFEST_PATH.lastIndexOf('/') + 1);
  return `${cdnBase.replace(/\/$/, '')}${dir}${url.replace(/^\//, '')}`;
}
