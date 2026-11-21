// Copies lesson content into the app. Re-run after any lesson, prompt or
// voice change:  npm run build:content
//
//   content/paths/*.json (paths, goals.json, packs.json)    -> src/content/generated/paths.json
//                                                              ({ paths, goals, packs, lessonPack })
//   content/lessons/*.json reachable from a path            -> src/content/generated/lessons.json (in path order)
//   both only after validatePaths and validateContent (src/content/validate.ts) pass
//   content/prompts/mr.json                                 -> src/content/generated/prompts.json
//   bundled audio: shared lines + the starter pack's lessons (D-GURU-14); other packs: build-packs.mjs
//   content/audio/visemes.json (the bundled ids)            -> src/content/generated/clips.json
//   content/audio/shekru/<id>.mp3 (the bundled ids)         -> assets/audio/lesson/<id with _ for .>.mp3
//   static require() map (Metro cannot require by variable) -> src/content/generated/audio.ts
//   listening chime                                         -> assets/audio/chime.wav
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STARTER_PACK, lessonLines, packContents } from '../src/content/packs.ts';
import { packsByLesson, reachableLessons, validateContent, validatePaths } from '../src/content/validate.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = path.join(here, '../../content');
const out = path.join(here, '../src/content/generated');
const audioOut = path.join(here, '../assets/audio/lesson');

const TUTOR = 'shekru';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const jsonFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

const pathsDir = path.join(content, 'paths');
const paths = jsonFiles(pathsDir)
  .filter((f) => f !== 'goals.json' && f !== 'packs.json')
  .map((f) => readJson(path.join(pathsDir, f)));
const goals = readJson(path.join(pathsDir, 'goals.json'));
const packs = readJson(path.join(pathsDir, 'packs.json'));

const allLessons = new Map(
  jsonFiles(path.join(content, 'lessons')).map((f) => {
    const lesson = readJson(path.join(content, 'lessons', f));
    return [lesson.template_id, lesson];
  }),
);
// The menu: every lesson reachable from a path, in path order (paths sorted by file name).
const lessons = reachableLessons(paths).filter((id) => allLessons.has(id)).map((id) => allLessons.get(id));
const packOf = packsByLesson(packs);
const lessonPack = Object.fromEntries(lessons.map((l) => [l.template_id, packOf.get(l.template_id)?.[0]]));

const prompts = readJson(path.join(content, 'prompts/mr.json'));
const { tokens } = readJson(path.join(here, '../src/asr/generated/mr-tokens.json'));
// Every lesson file is checked, reachable or not; only reachable ones are written.
const errors = [...validatePaths(paths, packs, [...allLessons.keys()]), ...validateContent([...allLessons.values()], prompts, tokens)];
if (errors.length) {
  console.error(`content: ${errors.length} error(s), nothing written:\n${errors.map((e) => `  ${e}`).join('\n')}`);
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
// Never cleared: the lesson mp3s are tracked and content/audio/ may be absent (fresh worktree).
fs.mkdirSync(audioOut, { recursive: true });
fs.writeFileSync(path.join(out, 'lessons.json'), JSON.stringify(lessons) + '\n');
fs.writeFileSync(path.join(out, 'prompts.json'), JSON.stringify(prompts) + '\n');
fs.writeFileSync(path.join(out, 'paths.json'), JSON.stringify({ paths, goals, packs, lessonPack }) + '\n');

// The lines whose audio ships in the app, by audio id: shared lines and the starter pack.
const lessonText = Object.fromEntries(lessons.flatMap(lessonLines));
const starter = packContents({ packs, lessonPack }, lessons, prompts)[STARTER_PACK];
const text = { ...prompts.lines, ...Object.fromEntries(starter.map((id) => [id, lessonText[id]])) };

const visemesPath = path.join(content, 'audio/visemes.json');
const voiced = fs.existsSync(visemesPath);
const visemes = voiced ? readJson(visemesPath) : { lines: {}, clips: {} };
const clips = {};
const requires = [];
const missing = [];
const stale = [];
let bundledBytes = 0;
for (const id of Object.keys(text)) {
  const clip = visemes.clips[TUTOR]?.[id];
  const mp3 = path.join(content, 'audio', TUTOR, `${id}.mp3`);
  if (!clip || !fs.existsSync(mp3)) { missing.push(id); continue; }
  if (visemes.lines[id] !== text[id]) stale.push(id);
  // Android resource names keep only [a-z0-9_]
  const file = `${id.replaceAll('.', '_')}.mp3`;
  fs.copyFileSync(mp3, path.join(audioOut, file));
  bundledBytes += fs.statSync(mp3).size;
  clips[id] = { duration: clip.duration, events: clip.events };
  requires.push(`  '${id}': require('../../../assets/audio/lesson/${file}'),`);
}
// Without content/audio/ the committed audio map stays as it is rather than going silent.
if (voiced) {
  fs.writeFileSync(path.join(out, 'clips.json'), JSON.stringify(clips) + '\n');
  fs.writeFileSync(
    path.join(out, 'audio.ts'),
    `// GENERATED by scripts/build-content.mjs. Do not edit.
export const LINE_AUDIO: Record<string, number> = {
${requires.join('\n')}
};
`,
  );
}

// ---- chime: same two notes as chime() in design/characters/shekru/anim/index.html
const RATE = 44100;
const NOTES = [[659.25, 0], [987.77, 0.13]];
const ATTACK = 0.02, END = 0.55, PEAK = 0.16, FLOOR = 0.0008;
const samples = new Float64Array(Math.ceil((0.13 + 0.6) * RATE));
for (const [freq, at] of NOTES) {
  for (let i = 0; i < 0.6 * RATE; i++) {
    const t = i / RATE;
    const gain = t < ATTACK ? (PEAK * t) / ATTACK : PEAK * (FLOOR / PEAK) ** ((t - ATTACK) / (END - ATTACK));
    samples[Math.round(at * RATE) + i] += (t < END ? gain : 0) * Math.sin(2 * Math.PI * freq * t);
  }
}
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples.length * 2, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); // PCM, mono
wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
samples.forEach((s, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
fs.writeFileSync(path.join(here, '../assets/audio/chime.wav'), wav);

console.log(`content: ${lessons.map((l) => l.template_id).join(', ')}, ${Object.keys(clips).length}/${Object.keys(text).length} voice lines bundled`);
console.log(`  bundled audio (shared lines + ${STARTER_PACK} pack): ${(bundledBytes / 1e6).toFixed(2)} MB`);
if (stale.length) console.warn(`  text changed since the audio was made: ${stale.join(', ')}`);
if (missing.length) {
  console.warn(`  no audio yet (the app shows these lines silently): ${missing.join(', ')}`);
  if (process.argv.includes('--strict')) process.exit(1);
}
