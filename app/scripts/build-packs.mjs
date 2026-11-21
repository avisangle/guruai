// Builds the downloadable audio packs and the manifest (TDD 2.7). Run after build:content:
//   npm run build:packs [-- --model PATH --model-version N] [--publish]
//
//   generated paths/lessons/prompts + content/audio/<tutor>/  -> dist/packs/<tutor>/<pack>.v<n>.zip
//                                                               (<line id>.mp3 + clips.json; not starter, not empty packs)
//   content/packs.lock.json                                    <- pack versions; a version goes up only when its zip changes
//   --model                                                    -> manifest model entry (SHA-256, size)
//   dist/manifest.json
//   --publish: puts each file not yet in R2 ($R2_BUCKET, keys guru/v1/<url>), then the manifest.
//              A published file is never overwritten (D-GURU-14); one with other bytes stops the publish.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { zipSync } from 'fflate';

import { STARTER_PACK, buildManifest, lessonLines, nextVersions, packContents, packId, packUrl } from '../src/content/packs.ts';
import { MANIFEST_PATH } from '../src/downloads/manifest.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = path.join(here, '../../content');
const generated = path.join(here, '../src/content/generated');
const dist = path.join(here, '../dist');
const lockPath = path.join(content, 'packs.lock.json');

const TUTOR = 'shekru';
// R2 key of the manifest's folder (`guru/v1/`); file urls are relative to it.
const R2_PREFIX = MANIFEST_PATH.slice(1, MANIFEST_PATH.lastIndexOf('/') + 1);
const MANIFEST_NAME = MANIFEST_PATH.slice(MANIFEST_PATH.lastIndexOf('/') + 1);
// Local-time fields, so the zip's DOS timestamps (and its bytes) are the same in every time zone.
const ZIP_MTIME = new Date(2000, 0, 1);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const die = (msg) => {
  console.error(`build:packs: ${msg}`);
  process.exit(1);
};

const { values: opts } = parseArgs({
  options: { model: { type: 'string' }, 'model-version': { type: 'string' }, publish: { type: 'boolean' } },
});
const bucket = process.env.R2_BUCKET;
// Checked before anything is built: a manifest without a model fails parseManifest on every phone.
if (opts.publish && !opts.model) die('--publish needs --model PATH --model-version N');
if (opts.publish && !bucket) die('--publish needs R2_BUCKET');
const modelVersion = Number(opts['model-version']);
if (opts.model && !(Number.isInteger(modelVersion) && modelVersion >= 1)) die('--model needs --model-version N (1 or more)');

const catalogue = readJson(path.join(generated, 'paths.json'));
const lessons = readJson(path.join(generated, 'lessons.json'));
const prompts = readJson(path.join(generated, 'prompts.json'));
const text = Object.fromEntries(lessons.flatMap(lessonLines));

const visemesPath = path.join(content, 'audio/visemes.json');
const visemes = fs.existsSync(visemesPath) ? readJson(visemesPath) : { lines: {}, clips: {} };
const mp3 = (id) => path.join(content, 'audio', TUTOR, `${id}.mp3`);

const contents = Object.entries(packContents(catalogue, lessons, prompts))
  .filter(([pack, ids]) => pack !== STARTER_PACK && ids.length > 0)
  .sort(([a], [b]) => a.localeCompare(b));

const packLines = contents.flatMap(([, ids]) => ids);
const missing = packLines.filter((id) => !visemes.clips[TUTOR]?.[id] || !fs.existsSync(mp3(id)));
if (missing.length) die(`no audio for ${missing.length} pack line(s), nothing written:\n  ${missing.join('\n  ')}`);
const stale = packLines.filter((id) => visemes.lines[id] !== text[id]);
if (stale.length) console.warn(`  text changed since the audio was made: ${stale.join(', ')}`);

const zips = contents.map(([pack, ids]) => {
  const files = {};
  const clips = {};
  for (const id of [...ids].sort()) {
    files[`${id}.mp3`] = [fs.readFileSync(mp3(id)), { level: 0 }]; // mp3 does not compress
    const { duration, events } = visemes.clips[TUTOR][id];
    clips[id] = { duration, events };
  }
  files['clips.json'] = new TextEncoder().encode(JSON.stringify(clips));
  const zip = zipSync(files, { mtime: ZIP_MTIME });
  return { pack, id: packId(TUTOR, pack), zip, sha256: sha256(zip), lessons: catalogue.packs[pack].lessons };
});

const lock = fs.existsSync(lockPath) ? readJson(lockPath) : {};
const next = nextVersions(lock, Object.fromEntries(zips.map((z) => [z.id, z.sha256])));

// dist mirrors the R2 layout: dist/<manifest url>
fs.rmSync(path.join(dist, 'packs'), { recursive: true, force: true });
const built = zips.map((z) => {
  const { version } = next[z.id];
  const file = path.join(dist, packUrl(TUTOR, z.pack, version));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, z.zip);
  console.log(`  ${z.id} v${version}: ${mb(z.zip.length)}`);
  return { tutor: TUTOR, pack: z.pack, version, sha256: z.sha256, bytes: z.zip.length, lessons: z.lessons };
});
const sortedLock = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(lockPath, JSON.stringify(sortedLock, null, 2) + '\n');

let model;
if (opts.model) {
  const bytes = fs.readFileSync(opts.model);
  model = { id: path.basename(opts.model).replace(/\.onnx$/, ''), version: modelVersion, sha256: sha256(bytes), bytes: bytes.length };
}
const manifest = buildManifest(built, model);
const manifestPath = path.join(dist, MANIFEST_NAME);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`build:packs: ${built.length} pack(s)${model ? `, model ${model.id} v${model.version}` : ''} -> dist/manifest.json`);

if (opts.publish) {
  const wrangler = (...args) => spawnSync('npx', ['--yes', 'wrangler', 'r2', 'object', ...args, '--remote'], { encoding: 'utf8' });
  const put = (file, url, contentType) => {
    const r = wrangler('put', `${bucket}/${R2_PREFIX}${url}`, '--file', file, '--content-type', contentType);
    if (r.status !== 0) die(`upload of ${url} failed:\n${r.stdout}${r.stderr}`);
    console.log(`  put ${R2_PREFIX}${url}`);
  };
  /** true if the object is already in R2 with these bytes; stops if it is there with other bytes. */
  const published = (url, expectedSha) => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guru-packs-')), 'object');
    try {
      const r = wrangler('get', `${bucket}/${R2_PREFIX}${url}`, '--file', tmp);
      if (r.status !== 0) {
        if (/does not exist|not found/i.test(`${r.stdout}${r.stderr}`)) return false;
        die(`could not check ${url} in R2:\n${r.stdout}${r.stderr}`);
      }
      if (sha256(fs.readFileSync(tmp)) !== expectedSha) {
        die(`${url} is already in R2 with other bytes; published files are never overwritten. Bump the version.`);
      }
      return true;
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  };

  // Packs before the model, so a pack conflict stops the run before the model's large download.
  const files = [
    ...manifest.packs.map((p) => ({ file: path.join(dist, p.url), url: p.url, sha256: p.sha256, type: 'application/zip' })),
    { file: opts.model, url: manifest.model.url, sha256: model.sha256, type: 'application/octet-stream' },
  ];
  // Check every file before putting any, so a conflict stops the publish with nothing changed.
  const fresh = files.filter((f) => !published(f.url, f.sha256));
  for (const f of fresh) put(f.file, f.url, f.type);
  put(manifestPath, MANIFEST_NAME, 'application/json');
}
