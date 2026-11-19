// Evaluates the core at fixed times and writes posed SVG frames + manifest.json.
// usage: node filmstrips.mjs <outDir>   then: python filmstrips.py <outDir> <sheet.png>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRig } from '../shekru-anim.js';
import { poseSvg, withFx } from './pose-svg.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const anim = JSON.parse(fs.readFileSync(path.join(here, '../shekru.anim.json'), 'utf8'));
const rigJson = JSON.parse(fs.readFileSync(path.join(here, '../../svg/shekru.rig.json'), 'utf8'));
const svg = withFx(fs.readFileSync(path.join(here, '../../svg/shekru.svg'), 'utf8'), fs.readFileSync(path.join(here, '..', anim.fx.asset), 'utf8'));
const vis = JSON.parse(fs.readFileSync(path.join(here, '../visemes.json'), 'utf8')).clips.shekru;
const outDir = process.argv[2];
const N = +(process.argv[3] || 10);
fs.mkdirSync(outDir, { recursive: true });

const rows = [];
function strip(label, script, times, opts = {}) {
  // script: [[time, stateName], ...]; idle runs before t=0
  const rig = createRig(rigJson, anim, { seed: 3 });
  if (opts.speech) rig.setSpeech(vis[opts.speech].events);
  rig.update(-2, { noRandom: true });
  const frames = [];
  let si = 0, t = -2;
  for (const target of times) {
    // step at 60 fps so setState calls land where a real player would put them
    while (t < target - 1e-9) {
      t = Math.min(target, t + 1 / 60);
      while (si < script.length && script[si][0] <= t) rig.setState(script[si++][1]);
      if (opts.blinkAt != null && t >= opts.blinkAt && !opts._b) { rig.trigger('blink', t, 0); opts._b = true; }
      var fr = rig.update(t, { noRandom: true, speechTime: opts.speech ? t - (opts.speechStart || 0) : undefined });
    }
    const name = `${label.replace(/[^a-z0-9]+/gi, '_')}_${frames.length}.svg`;
    fs.writeFileSync(path.join(outDir, name), poseSvg(svg, fr));
    frames.push({ file: name, t: +target.toFixed(2), state: fr.state, viseme: fr.viseme });
  }
  rows.push({ label, frames });
}
const lin = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

const only = process.argv[4];
if (only && only.startsWith('keys:')) {
  // ad hoc key poses: keys:state@t,state@t,...
  for (const spec of only.slice(5).split(',')) { const [st, t] = spec.split('@'); strip(st + '@' + t, [[0, st]], [+t], { speech: st === 'talking' ? 'teach' : undefined }); }
  const frames = rows.flatMap((r) => r.frames.map((f) => ({ ...f, t: f.t })));
  rows.length = 0; rows.push({ label: 'key', frames });
}
for (const name of Object.keys(anim.states)) {
  if (only && only.startsWith('keys:')) break;
  if (only && only !== name && only !== 'all') continue;
  const s = anim.states[name];
  let times = s.filmstrip || lin(0.05, s.duration, N);
  strip(name, [[0, name]], times, { speech: name === 'talking' ? 'teach' : undefined, blinkAt: name === 'idle' ? 1.7 : undefined });
}
if (!only || only === 'all' || only === 'trans') {
  // transition strips
  strip('idle>correct>idle', [[0, 'correct']], [-0.1, 0.05, 0.12, 0.2, 0.3, 0.42, 2.5, 2.7, 2.8, 2.9, 3.0, 3.2].slice(0, 12));
  strip('talking>listening', [[-1.5, 'talking'], [1.0, 'listening']], [0.9, 1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5, 1.7, 2.0], { speech: 'teach', speechStart: -1.5 });
  strip('idle>listening', [[0, 'listening']], [-0.05, 0.06, 0.14, 0.22, 0.3, 0.4, 0.5, 0.62, 0.76, 0.9, 1.1, 1.4]);
  strip('thinking>tryagain', [[-3, 'thinking'], [0, 'tryagain']], [-0.05, 0.05, 0.1, 0.15, 0.2, 0.26, 0.32, 0.4, 0.5, 0.7, 1.0, 1.5]);
  strip('listening>thinking>hint', [[-3, 'listening'], [0, 'thinking'], [2, 'hint']], [-0.05, 0.08, 0.16, 0.24, 0.4, 1.0, 1.95, 2.08, 2.16, 2.24, 2.4, 3.0]);
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ rows }, null, 1));
console.log('frames:', rows.reduce((n, r) => n + r.frames.length, 0));
