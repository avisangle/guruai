/// <reference types="node" />
// GURU-23: pack build and publish tool; only shared lines and the starter pack ship inside the app.
// TDD 2.7 (manifest), D-GURU-14 (immutable versioned files, one manifest, starter + shared lines bundled),
// D-GURU-16 (a lesson sits in one pack; build skips empty packs).
//
// Real shapes this file relies on (read, not assumed):
// - generated/paths.json  { paths, goals, packs: Record<pack, {title, lessons}>, lessonPack }   (GURU-16)
// - generated/lessons.json: lessons with `lines` and items[].lines; generated/prompts.json: { lines, captions }
// - line ids (build-content.mjs): shared `<name>`, lesson `<template_id>.<name>`, item `<template_id>.<item id>.<name>`
// - content/audio/<tutor>/<line id>.mp3 and content/audio/visemes.json { lines: {id: text}, clips: {<tutor>: {id: {duration, events}}} }
//   are local only (gitignored), so every build here runs in a scratch copy with synthetic audio.
// - parseManifest (app/src/downloads/manifest.ts, GURU-14) is the reader; a manifest it rejects breaks every app.
// - modelFile() is `mr_ctc_wav.int8.onnx`; TDD 2.7 model id `mr_ctc_wav.int8`, url `models/mr_ctc_wav.int8.v1.onnx`.
// - `wrangler r2 object put|get <bucket>/<key>` defaults to LOCAL storage; `--remote` is needed to reach R2.
//
// Names pinned here (the contract /implement follows):
//   app/src/content/packs.ts
//     packContents(catalogue, lessons, prompts) -> Record<pack name, line id[]>   (every pack in catalogue.packs)
//     nextVersions(lock, hashes) -> PackLock          PackLock = Record<pack id, { version, hash }>
//     buildManifest(packs: BuiltPack[], model?: BuiltModel) -> manifest per TDD 2.7
//   pack id `<tutor>.<pack>`; zip `app/dist/packs/<tutor>/<pack>.v<n>.zip`; manifest `app/dist/manifest.json`
//   R2 keys `guru/v1/<manifest url>` and `guru/v1/manifest.json` in bucket $R2_BUCKET
//   content/packs.lock.json is a PackLock
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { unzipSync } from 'fflate';

import { parseManifest } from '../downloads/manifest';

type Clip = { duration: number; events: [number, string][] };
type Lesson = {
  template_id: string;
  lines: Record<string, string>;
  items: { id: string; lines: Record<string, string> }[];
};
type Prompts = { lines: Record<string, string> };
type Catalogue = { packs: Record<string, { lessons: string[] }>; lessonPack: Record<string, string> };
type PackLock = Record<string, { version: number; hash: string }>;
type BuiltPack = { tutor: string; pack: string; version: number; sha256: string; bytes: number; lessons: string[] };
type BuiltModel = { id: string; version: number; sha256: string; bytes: number };
type ManifestFile = { id: string; version: number; url: string; sha256: string; bytes: number };
type ManifestOut = {
  format: number;
  published_at: string;
  model?: ManifestFile;
  packs: (ManifestFile & { tutor: string; lessons: string[] })[];
};
type PacksModule = {
  packContents(catalogue: Catalogue, lessons: Lesson[], prompts: Prompts): Record<string, string[]>;
  nextVersions(lock: PackLock, hashes: Record<string, string>): PackLock;
  buildManifest(packs: BuiltPack[], model?: BuiltModel): ManifestOut;
};
// Lazy, so each test fails on its own while packs.ts does not exist.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packs = (): PacksModule => require('./packs');

const APP = path.join(__dirname, '../..');
const ROOT = path.join(APP, '..');
const GENERATED = path.join(APP, 'src/content/generated');
const TUTOR = 'shekru';
const STARTER = 'starter';

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const sorted = (xs: Iterable<string>) => [...xs].sort();

const catalogue = (): Catalogue => readJson(path.join(GENERATED, 'paths.json'));
const lessons = (): Lesson[] => readJson(path.join(GENERATED, 'lessons.json'));
const prompts = (): Prompts => readJson(path.join(GENERATED, 'prompts.json'));

/** Every line id a lesson can speak, as build-content.mjs names them. */
const lessonLineIds = (l: Lesson) => [
  ...Object.keys(l.lines).map((n) => `${l.template_id}.${n}`),
  ...l.items.flatMap((it) => Object.keys(it.lines).map((n) => `${l.template_id}.${it.id}.${n}`)),
];
const lessonLineText = (l: Lesson): [string, string][] => [
  ...Object.entries(l.lines).map(([n, t]): [string, string] => [`${l.template_id}.${n}`, t]),
  ...l.items.flatMap((it) => Object.entries(it.lines).map(([n, t]): [string, string] => [`${l.template_id}.${it.id}.${n}`, t])),
];
const linesOfPack = (pack: string) => {
  const ids = new Set(catalogue().packs[pack].lessons);
  return sorted(lessons().filter((l) => ids.has(l.template_id)).flatMap(lessonLineIds));
};
/** Packs build-packs publishes: not bundled, not empty. */
const downloadablePacks = () =>
  Object.keys(catalogue().packs).filter((p) => p !== STARTER && linesOfPack(p).length > 0);

// ---- packs.ts: pure functions

describe('packContents', () => {
  test("lists every line of a pack's lessons under its line id, and never a shared line", () => {
    const got = packs().packContents(catalogue(), lessons(), prompts());

    expect(sorted(Object.keys(got))).toEqual(sorted(Object.keys(catalogue().packs)));
    for (const pack of Object.keys(catalogue().packs)) {
      expect(sorted(got[pack])).toEqual(linesOfPack(pack));
    }
    // starter is exactly its two lessons; empty packs come back empty (D-GURU-16)
    expect(sorted(got[STARTER])).toEqual(
      sorted(lessons().filter((l) => ['tpl_kg_mr_swar_1', 'tpl_kg_en_letters_1'].includes(l.template_id)).flatMap(lessonLineIds)),
    );
    expect(got['class1']).toEqual([]);
    // shared lines ship in the app, so no pack carries them
    const shared = new Set(Object.keys(prompts().lines));
    expect(Object.values(got).flat().filter((id) => shared.has(id))).toEqual([]);
  });
});

describe('nextVersions', () => {
  test("bumps a pack's version only when its content hash changes, and never reuses a version", () => {
    const lock: PackLock = {
      'shekru.kg': { version: 3, hash: 'aaa' },
      'shekru.class1': { version: 2, hash: 'bbb' },
      'shekru.numbers': { version: 5, hash: 'ccc' },
    };
    const before = JSON.stringify(lock);
    const next = packs().nextVersions(lock, {
      'shekru.kg': 'aaa', // unchanged
      'shekru.class1': 'b2', // changed
      'shekru.en-words': 'ddd', // new
      // shekru.numbers not built this time
    });

    expect(next['shekru.kg']).toEqual({ version: 3, hash: 'aaa' });
    expect(next['shekru.class1']).toEqual({ version: 3, hash: 'b2' });
    expect(next['shekru.en-words']).toEqual({ version: 1, hash: 'ddd' });
    // kept, so a pack that comes back never republishes under an old (immutable) version number
    expect(next['shekru.numbers']).toEqual({ version: 5, hash: 'ccc' });
    expect(JSON.stringify(lock)).toBe(before);

    // the committed lock is a PackLock
    const committed = readJson(path.join(ROOT, 'content/packs.lock.json')) as PackLock;
    for (const [id, e] of Object.entries(committed)) {
      expect(id).toMatch(new RegExp(`^${TUTOR}\\.[A-Za-z0-9._-]+$`));
      expect(Number.isInteger(e.version) && e.version >= 1).toBe(true);
      expect(typeof e.hash).toBe('string');
    }
  });
});

describe('buildManifest', () => {
  test('writes the TDD 2.7 manifest that the app downloader accepts', () => {
    const zipSha = 'a'.repeat(64);
    const modelSha = 'b'.repeat(64);
    const m = packs().buildManifest(
      [{ tutor: TUTOR, pack: 'kg', version: 3, sha256: zipSha, bytes: 14200000, lessons: ['tpl_kg_mr_swar_2'] }],
      { id: 'mr_ctc_wav.int8', version: 1, sha256: modelSha, bytes: 137000000 },
    );

    expect(m.format).toBe(1);
    expect(Number.isNaN(Date.parse(m.published_at))).toBe(false);
    expect(m.model).toEqual({ id: 'mr_ctc_wav.int8', version: 1, url: 'models/mr_ctc_wav.int8.v1.onnx', sha256: modelSha, bytes: 137000000 });
    expect(m.packs).toEqual([
      { id: 'shekru.kg', tutor: TUTOR, version: 3, url: 'packs/shekru/kg.v3.zip', sha256: zipSha, bytes: 14200000, lessons: ['tpl_kg_mr_swar_2'] },
    ]);
    expect(() => parseManifest(JSON.parse(JSON.stringify(m)))).not.toThrow();
  });
});

// ---- scripts, in a scratch copy with synthetic audio

const FAKE_NPX = `#!/usr/bin/env node
// Stands in for \`npx wrangler r2 object put|get <bucket>/<key>\`; R2 is a folder.
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const w = args.findIndex((a) => /^wrangler(@.*)?$/.test(a));
const [noun, sub, verb, objectPath] = args.slice(w + 1);
const flag = (...names) => { const i = args.findIndex((a) => names.includes(a)); return i < 0 ? undefined : args[i + 1]; };
fs.appendFileSync(process.env.FAKE_R2_LOG, JSON.stringify({ verb, objectPath, args }) + '\\n');
if (w < 0 || noun !== 'r2' || sub !== 'object') { console.error('fake npx: unsupported ' + args.join(' ')); process.exit(2); }
const stored = path.join(process.env.FAKE_R2_DIR, objectPath);
if (verb === 'put') {
  const file = flag('--file', '-f');
  if (!file) { console.error('fake npx: put needs --file'); process.exit(2); }
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.copyFileSync(file, stored);
} else if (verb === 'get') {
  if (!fs.existsSync(stored)) { console.error('The specified key does not exist.'); process.exit(1); }
  const file = flag('--file', '-f');
  if (file) fs.copyFileSync(stored, file); else process.stdout.write(fs.readFileSync(stored));
} else { console.error('fake npx: unsupported verb ' + verb); process.exit(2); }
`;

type Call = { verb: string; objectPath: string; args: string[] };

describe('scripts', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;
  const audio = (id: string) => path.join(tmp, 'content/audio', TUTOR, `${id}.mp3`);
  const fixtureClip = (i: number): Clip => ({ duration: 1 + i / 100, events: [[0.1, 'AA'], [0.5, 'rest']] });
  const fixtureClips: Record<string, Clip> = {};
  const dist = (...p: string[]) => path.join(tmp, 'app/dist', ...p);
  const lock = (): PackLock => readJson(path.join(tmp, 'content/packs.lock.json'));
  const run = (script: string, ...args: string[]) => {
    const r = spawnSync('npm', ['run', script, '--', ...args], { cwd: path.join(tmp, 'app'), encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const calls = (): Call[] => {
    const log = env.FAKE_R2_LOG as string;
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const puts = () => calls().filter((c) => c.verb === 'put');
  const key = (c: Call) => c.objectPath.replace(/^[^/]+\//, '');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guru23-packs-'));
    for (const p of ['content/lessons', 'content/prompts', 'content/paths', 'app/src', 'app/scripts', 'app/package.json']) {
      fs.cpSync(path.join(ROOT, p), path.join(tmp, p), { recursive: true });
    }
    fs.symlinkSync(fs.realpathSync(path.join(APP, 'node_modules')), path.join(tmp, 'app/node_modules'));
    // Synthetic voiced audio for every line, so no real voice file is read or needed.
    const text: Record<string, string> = { ...prompts().lines, ...Object.fromEntries(lessons().flatMap(lessonLineText)) };
    fs.mkdirSync(path.join(tmp, 'content/audio', TUTOR), { recursive: true });
    Object.keys(text).forEach((id, i) => {
      fs.writeFileSync(audio(id), `fake mp3 ${id}`);
      fixtureClips[id] = fixtureClip(i);
    });
    fs.writeFileSync(
      path.join(tmp, 'content/audio/visemes.json'),
      JSON.stringify({ lines: text, clips: { [TUTOR]: fixtureClips } }),
    );
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npx'), FAKE_NPX, { mode: 0o755 });
    fs.mkdirSync(path.join(tmp, 'r2'));
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_R2_DIR: path.join(tmp, 'r2'),
      FAKE_R2_LOG: path.join(tmp, 'r2.log'),
      R2_BUCKET: 'guru-test',
    };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('build:packs zips each downloadable pack with its mp3s and clips.json, and versions it by content', () => {
    let r = run('build:packs');
    expect(r.status).toBe(0);

    // starter ships in the app and empty packs are skipped: only the others become zips
    const expected = downloadablePacks();
    expect(expected.length).toBeGreaterThan(0);
    expect(sorted(fs.readdirSync(dist('packs', TUTOR)))).toEqual(sorted(expected.map((p) => `${p}.v1.zip`)));

    const manifest = readJson(dist('manifest.json')) as ManifestOut;
    expect(sorted(manifest.packs.map((p) => p.id))).toEqual(sorted(expected.map((p) => `${TUTOR}.${p}`)));
    for (const pack of expected) {
      const zipBytes = fs.readFileSync(dist('packs', TUTOR, `${pack}.v1.zip`));
      const entries = unzipSync(new Uint8Array(zipBytes));
      const lines = linesOfPack(pack);
      expect(sorted(Object.keys(entries))).toEqual(sorted([...lines.map((id) => `${id}.mp3`), 'clips.json']));
      for (const id of lines) expect(Buffer.from(entries[`${id}.mp3`]).toString()).toBe(`fake mp3 ${id}`);
      const clips = JSON.parse(Buffer.from(entries['clips.json']).toString()) as Record<string, Clip>;
      expect(sorted(Object.keys(clips))).toEqual(lines);
      for (const id of lines) expect(clips[id]).toEqual(fixtureClips[id]);

      const entry = manifest.packs.find((p) => p.id === `${TUTOR}.${pack}`)!;
      expect(entry).toMatchObject({ tutor: TUTOR, version: 1, url: `packs/${TUTOR}/${pack}.v1.zip`, bytes: zipBytes.length, sha256: sha256(zipBytes) });
      expect(sorted(entry.lessons)).toEqual(sorted(catalogue().packs[pack].lessons));
      expect(lock()[`${TUTOR}.${pack}`].version).toBe(1);
    }

    // Unchanged content: same version and byte-identical zip, or a published sha256 would stop matching.
    const kgZip = () => fs.readFileSync(dist('packs', TUTOR, 'kg.v1.zip'));
    const kgV1 = sha256(kgZip());
    const lockV1 = lock();
    r = run('build:packs');
    expect(r.status).toBe(0);
    expect(sha256(kgZip())).toBe(kgV1);
    expect(lock()).toEqual(lockV1);
    expect(fs.existsSync(dist('packs', TUTOR, 'kg.v2.zip'))).toBe(false);

    // One kg line re-voiced: kg moves to v2 under a new file name.
    fs.writeFileSync(audio(linesOfPack('kg')[0]), 're-voiced');
    r = run('build:packs');
    expect(r.status).toBe(0);
    expect(lock()['shekru.kg'].version).toBe(2);
    const v2 = fs.readFileSync(dist('packs', TUTOR, 'kg.v2.zip'));
    const kg = (readJson(dist('manifest.json')) as ManifestOut).packs.find((p) => p.id === 'shekru.kg')!;
    expect(kg).toMatchObject({ version: 2, url: 'packs/shekru/kg.v2.zip', sha256: sha256(v2), bytes: v2.length });
  });

  test('--publish uploads new files to R2 with --remote, the manifest last, and never re-puts a published version', () => {
    // No model entry: the manifest would fail parseManifest on every phone, so nothing is uploaded.
    let r = run('build:packs', '--publish');
    expect(r.status).not.toBe(0);
    expect(puts()).toEqual([]);

    const model = path.join(tmp, 'model', 'mr_ctc_wav.int8.onnx');
    fs.mkdirSync(path.dirname(model));
    fs.writeFileSync(model, crypto.randomBytes(4096));
    const modelBytes = fs.readFileSync(model);

    r = run('build:packs', '--model', model, '--model-version', '1', '--publish');
    expect(r.status).toBe(0);
    const first = puts();
    expect(first.length).toBeGreaterThan(1);
    for (const c of first) {
      expect(c.args).toContain('--remote');
      expect(c.objectPath.startsWith('guru-test/guru/v1/')).toBe(true);
    }
    const manifest = readJson(dist('manifest.json')) as ManifestOut;
    expect(manifest.model).toEqual({
      id: 'mr_ctc_wav.int8',
      version: 1,
      url: 'models/mr_ctc_wav.int8.v1.onnx',
      sha256: sha256(modelBytes),
      bytes: modelBytes.length,
    });
    expect(key(first[first.length - 1])).toBe('guru/v1/manifest.json');
    expect(sorted(first.slice(0, -1).map(key))).toEqual(
      sorted([manifest.model!.url, ...manifest.packs.map((p) => p.url)].map((u) => `guru/v1/${u}`)),
    );
    // what landed in R2 is what was built, and the app can read the manifest
    const r2 = (k: string) => fs.readFileSync(path.join(tmp, 'r2/guru-test', k));
    expect(r2('guru/v1/manifest.json').toString()).toBe(fs.readFileSync(dist('manifest.json'), 'utf8'));
    expect(() => parseManifest(JSON.parse(r2('guru/v1/manifest.json').toString()))).not.toThrow();
    for (const p of manifest.packs) expect(sha256(r2(`guru/v1/${p.url}`))).toBe(p.sha256);

    // Same content again: the zips and model are already in R2, so only the manifest is put.
    fs.writeFileSync(env.FAKE_R2_LOG as string, '');
    r = run('build:packs', '--model', model, '--model-version', '1', '--publish');
    expect(r.status).toBe(0);
    expect(puts().map(key)).toEqual(['guru/v1/manifest.json']);
  });

  test('build:content bundles only shared lines and the starter lessons, and prints the bundled size', () => {
    const lessonsBefore = fs.readFileSync(path.join(tmp, 'app/src/content/generated/lessons.json'), 'utf8');
    const r = run('build:content');
    expect(r.status).toBe(0);

    const bundled = sorted([...Object.keys(prompts().lines), ...linesOfPack(STARTER)]);
    const audioTs = fs.readFileSync(path.join(tmp, 'app/src/content/generated/audio.ts'), 'utf8');
    expect(sorted([...audioTs.matchAll(/'([^']+)': require\(/g)].map((m) => m[1]))).toEqual(bundled);
    const clips = readJson(path.join(tmp, 'app/src/content/generated/clips.json')) as Record<string, Clip>;
    expect(sorted(Object.keys(clips))).toEqual(bundled);
    expect(sorted(fs.readdirSync(path.join(tmp, 'app/assets/audio/lesson')))).toEqual(
      sorted(bundled.map((id) => `${id.replaceAll('.', '_')}.mp3`)),
    );
    // the menu still lists every lesson; only their audio moved to packs
    expect(fs.readFileSync(path.join(tmp, 'app/src/content/generated/lessons.json'), 'utf8')).toBe(lessonsBefore);
    expect(r.out).toMatch(/bundled[^\n]*\d+(\.\d+)?\s*(B|KB|MB)\b/i);
  });

  // ---- contract for GURU-26 (line audio from installed packs): shape only
  test('contract (GURU-26): build:packs output layout, pack zip contents, packs.ts exports, bundled set', () => {
    const mod = packs();
    expect(typeof mod.packContents).toBe('function');
    expect(typeof mod.nextVersions).toBe('function');
    expect(typeof mod.buildManifest).toBe('function');
    expect(typeof readJson(path.join(APP, 'package.json')).scripts['build:packs']).toBe('string');

    expect(run('build:packs').status).toBe(0);
    expect(fs.existsSync(dist('manifest.json'))).toBe(true);
    const zips = fs.readdirSync(dist('packs', TUTOR));
    expect(zips.length).toBeGreaterThan(0);
    for (const z of zips) {
      expect(z).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.v\d+\.zip$/);
      const entries = unzipSync(new Uint8Array(fs.readFileSync(dist('packs', TUTOR, z))));
      for (const name of Object.keys(entries)) expect(name === 'clips.json' || /^[^/]+\.mp3$/.test(name)).toBe(true);
      expect(Object.keys(entries)).not.toContain('lessons.json'); // reserved in the install folder (D-GURU-14)
      const clips = JSON.parse(Buffer.from(entries['clips.json']).toString()) as Record<string, Clip>;
      for (const c of Object.values(clips)) {
        expect(typeof c.duration).toBe('number');
        expect(Array.isArray(c.events)).toBe(true);
      }
    }

    expect(run('build:content').status).toBe(0);
    const audioTs = fs.readFileSync(path.join(tmp, 'app/src/content/generated/audio.ts'), 'utf8');
    expect(audioTs).toMatch(/export const LINE_AUDIO: Record<string, number> = \{/);
    expect(typeof readJson(path.join(tmp, 'app/src/content/generated/clips.json'))).toBe('object');
  });
});
