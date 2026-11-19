// Converts the Shekru design files into what the app consumes. Re-run after any
// art, rig, motion, viseme or engine change:  npm run build:shekru
//
//   design/characters/shekru/svg/shekru.svg + anim/shekru-fx.svg -> src/shekru/generated/shekru.art.json
//   anim/shekru-anim.js (engine, minus applyToDom)                -> src/shekru/generated/engine.ts (worklet)
//   anim/shekru.anim.json, shekru.rig.json, visemes.json          -> src/shekru/generated/ (copied)
//   anim/audio/<line>.mp3 for LINES                               -> assets/audio/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const design = path.join(here, '../../design/characters/shekru');
const anim = path.join(design, 'anim');
const out = path.join(here, '../src/shekru/generated');
const audioOut = path.join(here, '../assets/audio');

// Voice lines bundled with the app.
const LINES = ['hello', 'teach', 'nohear', 'tryagain', 'hint', 'correct', 'bye'];
// Padding around the 512 viewBox. Over all states the art spans x 0..475 and
// y 3..471 (measured in the web preview), so this centres it with a margin.
const VIEWBOX = [-24, -24, 524, 524];

const ATTR = {
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
};
const TAGS = new Set(['g', 'path', 'circle', 'ellipse']);

// Minimal parser for the subset the art uses: g, path, circle, ellipse.
function parseSvg(text) {
  const root = { t: 'svg', c: [] };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(text))) {
    const [, close, tag, attrText, selfClose] = m;
    if (tag === 'svg') continue;
    if (close) { stack.pop(); continue; }
    if (!TAGS.has(tag)) throw new Error(`Unsupported element <${tag}>`);
    const node = { t: tag };
    const p = {};
    for (const a of attrText.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) {
      if (a[1] === 'id') node.id = a[2];
      else if (a[1] === 'display') continue; // visibility comes from the engine
      else p[ATTR[a[1]] || a[1]] = a[2];
    }
    if (Object.keys(p).length) node.p = p;
    stack[stack.length - 1].c.push(node);
    if (!selfClose) { node.c = []; stack.push(node); }
  }
  return root.c;
}

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(audioOut, { recursive: true });

const rigJson = JSON.parse(fs.readFileSync(path.join(anim, 'shekru.rig.json'), 'utf8'));
const animJson = JSON.parse(fs.readFileSync(path.join(anim, 'shekru.anim.json'), 'utf8'));
const visemes = JSON.parse(fs.readFileSync(path.join(anim, 'visemes.json'), 'utf8'));

// ---- art
const character = parseSvg(fs.readFileSync(path.join(design, 'svg/shekru.svg'), 'utf8'));
const fx = animJson.fx ? parseSvg(fs.readFileSync(path.join(anim, animJson.fx.asset), 'utf8')) : [];

// Parts a state can lift above the head. React Native cannot reorder SVG
// children on the UI thread, so each gets a second copy after the last root
// child; the app shows one copy or the other.
const front = [...new Set(Object.values(animJson.states).flatMap((s) => s.front || []))];
const rootNode = character.find((n) => n.id === 'shekru');
for (const id of front) {
  const src = rootNode.c.find((n) => n.id === id);
  if (!src) throw new Error(`front part "${id}" is not a child of #shekru`);
  rootNode.c.push({ ...structuredClone(src), front: true });
}

// Rest frame from the real engine: the animated part ids and their initial values.
const engine = await import(pathToFileURL(path.join(anim, 'shekru-anim.js')).href);
const frame = engine.createRig(rigJson, animJson, { seed: 1 }).update(0, { noRandom: true });
const parts = {};
for (const id in frame.parts) {
  const p = frame.parts[id];
  parts[id] = { m: p.matrix.map((v) => +v.toFixed(4)), o: p.opacity, d: p.visible ? 'inline' : 'none' };
}
const ids = new Set();
(function walk(nodes) { for (const n of nodes) { if (n.id) ids.add(n.id); if (n.c) walk(n.c); } })([...character, ...fx]);
const missing = Object.keys(parts).filter((id) => !ids.has(id));
if (missing.length) throw new Error('Engine parts missing from the art: ' + missing.join(', '));

const order = rigJson.conventions.drawOrder;
const art = {
  viewBox: VIEWBOX,
  ground: rigJson.ground,
  character,
  fx,
  parts,
  front,
  // a front part is lifted when it comes after this id in frame.order
  frontAfter: order.filter((id) => !front.includes(id)).at(-1),
};
fs.writeFileSync(path.join(out, 'shekru.art.json'), JSON.stringify(art) + '\n');

// ---- engine as one worklet: the whole module becomes the body of makeEngine(),
// so it runs unchanged on the UI thread and keeps its state there.
const src = fs.readFileSync(path.join(anim, 'shekru-anim.js'), 'utf8');
const marker = src.indexOf('// ---------------------------------------------------------------- DOM only');
if (marker < 0) throw new Error('DOM-only marker not found in shekru-anim.js');
const body = src.slice(0, marker).replace(/^export /gm, '');
if (/\b(document|window|CSS)\b/.test(body)) throw new Error('Engine core references the DOM');
fs.writeFileSync(
  path.join(out, 'engine.ts'),
  `// @ts-nocheck
// GENERATED by scripts/build-shekru.mjs from design/characters/shekru/anim/shekru-anim.js. Do not edit.
export function makeEngine() {
  'worklet';
${body.replace(/^/gm, '  ').replace(/[ \t]+$/gm, '')}
  return { createRig, deriveBeats, visemeAt };
}
`,
);

// ---- data and audio
fs.writeFileSync(path.join(out, 'shekru.rig.json'), JSON.stringify(rigJson) + '\n');
fs.writeFileSync(path.join(out, 'shekru.anim.json'), JSON.stringify(animJson) + '\n');
const clips = {};
for (const line of LINES) {
  const clip = visemes.clips.shekru[line];
  if (!clip) throw new Error(`No viseme clip for "${line}"`);
  clips[line] = { text: visemes.lines[line], duration: clip.duration, events: clip.events };
  fs.copyFileSync(path.join(anim, 'audio', `${line}.mp3`), path.join(audioOut, `${line}.mp3`));
}
fs.writeFileSync(path.join(out, 'visemes.json'), JSON.stringify(clips) + '\n');

console.log(`shekru: ${Object.keys(parts).length} animated parts, front copies: ${front.join(', ') || 'none'}, lines: ${LINES.join(', ')}`);
