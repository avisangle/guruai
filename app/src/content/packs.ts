// Audio packs (TDD 2.7, D-GURU-14-downloads-starter-pack, D-GURU-16). Pure: build-content.mjs and build-packs.mjs
// run it under Node's type stripping, so only erasable syntax and .ts import paths.
import type { Manifest, ManifestFile } from '../downloads/manifest.ts';
import type { Lesson, Prompts } from '../lesson/types.ts';

/** Ships inside the app with the shared lines; never zipped or published. */
export const STARTER_PACK = 'starter';

export type Catalogue = { packs: Record<string, { lessons: string[] }>; lessonPack: Record<string, string | undefined> };
/** content/packs.lock.json: the last built version of each pack and its zip's SHA-256. */
export type PackLock = Record<string, { version: number; hash: string }>;
export type BuiltPack = { tutor: string; pack: string; version: number; sha256: string; bytes: number; lessons: string[] };
export type BuiltModel = { id: string; version: number; sha256: string; bytes: number };
/** The manifest parseManifest reads; the model is optional until publish. */
export type PackManifest = Omit<Manifest, 'model'> & { model?: ManifestFile };

/** Every line a lesson can speak, as [audio id, text]: `<template_id>.<name>`, `<template_id>.<item id>.<name>`. */
export function lessonLines(lesson: Pick<Lesson, 'template_id' | 'lines' | 'items'>): [string, string][] {
  const t = lesson.template_id;
  return [
    ...Object.entries(lesson.lines).map(([name, text]): [string, string] => [`${t}.${name}`, text]),
    ...lesson.items.flatMap((item) =>
      Object.entries(item.lines).map(([name, text]): [string, string] => [`${t}.${item.id}.${name}`, text]),
    ),
  ];
}

/** Line ids per pack, for every pack in the catalogue. A lesson's pack is `lessonPack` (D-GURU-16); shared lines are in no pack. */
export function packContents(catalogue: Catalogue, lessons: Lesson[], prompts: Prompts): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(Object.keys(catalogue.packs).map((p) => [p, []]));
  for (const lesson of lessons) {
    const pack = catalogue.lessonPack[lesson.template_id];
    if (!pack || !out[pack]) continue;
    out[pack].push(...lessonLines(lesson).map(([id]) => id).filter((id) => !(id in prompts.lines)));
  }
  return out;
}

/** A pack's version goes up only when its hash changes. Packs not built this time keep their entry, so a version is never reused. */
export function nextVersions(lock: PackLock, hashes: Record<string, string>): PackLock {
  const next: PackLock = { ...lock };
  for (const [id, hash] of Object.entries(hashes)) {
    const prev = lock[id];
    if (prev?.hash === hash) continue;
    next[id] = { version: (prev?.version ?? 0) + 1, hash };
  }
  return next;
}

export const packId = (tutor: string, pack: string) => `${tutor}.${pack}`;
export const packUrl = (tutor: string, pack: string, version: number) => `packs/${tutor}/${pack}.v${version}.zip`;
const modelUrl = (id: string, version: number) => `models/${id}.v${version}.onnx`;

/** The TDD 2.7 manifest. URLs are relative to the manifest's folder. */
export function buildManifest(packs: BuiltPack[], model?: BuiltModel): PackManifest {
  return {
    format: 1,
    published_at: new Date().toISOString(),
    ...(model && { model: { ...model, url: modelUrl(model.id, model.version) } }),
    packs: packs.map((p) => ({
      id: packId(p.tutor, p.pack),
      tutor: p.tutor,
      version: p.version,
      url: packUrl(p.tutor, p.pack, p.version),
      sha256: p.sha256,
      bytes: p.bytes,
      lessons: p.lessons,
    })),
  };
}
