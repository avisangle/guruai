// Generates ../shekru.anim.json. Edit the motion here, then run:
//   node tools/build-anim.mjs
// Sign conventions (SVG, y down, positive rotation is clockwise on screen):
//   arm-l raises outward with +, arm-r with -; head + tilts toward screen-right;
//   ear-l flops outward with -, ear-r with +; brow ty - is up; tail + swings right/down.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalKeys } from '../shekru-anim.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_NOTES = [
  'Shekru motion data. Consumed by shekru-anim.js (createRig). Times in seconds, angles in degrees, lengths in viewBox units (512 square).',
  'TRACKS: { partId: { channel: [[time, value, easing?], ...] } }. The easing name belongs to the key it leads INTO (default inOutSine). Before the first key a track holds its first value, after the last key its last value.',
  'CHANNELS: r = rotation about the rig pivot; tx, ty = translation; sx, sy = scale about the pivot; v = visibility delta (rest visibility + sum of v, shown when >= 0.5); o = opacity delta. All values are offsets from the rest pose: r/tx/ty/v/o add across layers, sx/sy multiply. Pivots come from shekru.rig.json, never from this file, except for `groups`.',
  'EASINGS: linear, step, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, inSine, outSine, inOutSine, inBack, outBack, inOutBack, outSoft (small overshoot).',
  'groups: virtual parents for SVG siblings. A group has a pivot and members; its matrix is pre-multiplied onto every member. `upper` is everything except the legs, pivoting at the hips, so leans and weight shifts keep the feet planted. `shekru` (the real root) is used for squash/stretch and jumps.',
  'rest: rest visibility for parts that are hidden in the art (eyelids, eyes-happy).',
  'transition: default blend when the state changes ({duration, easing}); a state may override it with its own `transition`. If any rotation in the on-screen pose exceeds `posedAngle` (an arm is already raised), the blend uses `poseToPose` seconds and `poseEasing` instead, and a looping state that has an intro is entered at its loop pose (the intro is authored from the rest pose and would drop the arm first). The blend starts from the pose that is on screen, so interrupting a state never snaps.',
  'states.<name>: duration; loop (true: after `duration` time wraps to `loopStart`, so 0..loopStart is a one-time intro); next (one-shot states hand over to this state at `duration`); tracks; mouth = [[time, viseme]] default mouth shape when no speech is playing; front = root children drawn above the head while the state is active (hand-on-face poses); mix = weights for base/speech layers by mix name (default 1); still = the time used as the frozen pose under reduced motion.',
  'base.loops[]: always-on looping layers {name, period, mix, tracks, phase}. phase = per-part delay in seconds (follow-through: the tail tip lags the tail base). Periods are deliberately not multiples of each other so idle does not visibly repeat.',
  'base.random.<name>: clips fired at random intervals {interval: [min, max] seconds, duration, doubleChance, variants: [tracks, ...], mix, reducedMotion (keep under reduced motion)}.',
  'fx: effect shapes drawn over the character (thought bubble, sound waves). fx.asset = SVG file with the shapes, in the same 512 viewBox as the character, to be drawn above it; fx.parts.<id>.pivot = pivot of each effect group (effects are not in shekru.rig.json). Effect ids animate exactly like body parts and appear in the frame `parts`; `rest` hides them (o: 0) until a state shows them.',
  'states.<name>.fx: { tracks, loopStart?, still? }. A second track set for effect ids, same key format. Its clock starts when the state is really entered and is never moved by the posed-entry intro skip, so a pop-in always plays in full. It loops loopStart..state duration (loopStart defaults to the state loopStart); `still` is its frozen time under reduced motion (default loopStart). Leaving the state fades the effect out through the normal transition blend, because the next state has no keys for it.',
  'speech.beat: an accent clip (head nod, brow lift) fired on stressed syllables. Beats are derived from the viseme events: an open vowel in `visemes` (value = strength) after a pause or at least `minGap` s after the previous beat. `lead` starts the accent slightly before the vowel. Variants are used in rotation.',
].join('\n');

// ---------------------------------------------------------------- helpers
const tracksOf = () => ({});
function set(tr, part, ch, keys) {
  (tr[part] ||= {})[ch] = keys;
  return tr;
}
// same keys on several parts, optional per-part value multiplier
function setAll(tr, parts, ch, keys, gains) {
  parts.forEach((p, i) => set(tr, p, ch, keys.map(([t, v, e]) => (e ? [t, v * (gains ? gains[i] : 1), e] : [t, v * (gains ? gains[i] : 1)]))));
}
// delayed copy of keys (follow-through). The first key stays at its time.
function lag(keys, delay, gain = 1, maxT = Infinity) {
  return keys.map(([t, v, e], i) => {
    const nt = i === 0 ? t : Math.min(maxT, +(t + delay).toFixed(3));
    return e ? [nt, +(v * gain).toFixed(3), e] : [nt, +(v * gain).toFixed(3)];
  });
}
const PUPILS = ['eye-l-pupil', 'eye-r-pupil', 'eye-l-highlight', 'eye-r-highlight'];
const gaze = (tr, xKeys, yKeys) => { if (xKeys) setAll(tr, PUPILS, 'tx', xKeys); if (yKeys) setAll(tr, PUPILS, 'ty', yKeys); };
// swap round eyes for happy arcs between t0 and t1
function happy(tr, t0, t1) {
  const pre = t0 > 0 ? [[0, 0]] : [];
  set(tr, 'eyes', 'v', [...pre, [t0, -1, 'step'], [t1, 0, 'step']]);
  set(tr, 'eyes-happy', 'v', [...pre, [t0, 1, 'step'], [t1, 0, 'step']]);
  // tiny pop on the arcs and cheeks so the swap has life
  set(tr, 'eyes-happy', 'sy', [[0, 1], [t0, 0.6, 'step'], [t0 + 0.12, 1.08, 'outQuad'], [t0 + 0.26, 1], [t1, 1]]);
  setAll(tr, ['cheeks'], 'sx', [[0, 1], [Math.max(0.01, t0), 1], [t0 + 0.15, 1.14, 'outQuad'], [t1, 1.14], [t1 + 0.2, 1]]);
}
const TAIL = ['tail-1', 'tail-2', 'tail-3', 'tail-4'];
// tail keys with follow-through down the chain
function tail(tr, keys, { delay = 0.07, gains = [1, 0.8, 0.9, 1.3], maxT } = {}) {
  TAIL.forEach((p, i) => set(tr, p, 'r', lag(keys, delay * i, gains[i], maxT)));
}

// ---------------------------------------------------------------- base alive layer
const P_BREATH = 3.7, P_TAIL = 5.3, P_TIP = 8.9;
const base = {
  loops: [
    {
      name: 'breath', period: P_BREATH, mix: 'breath',
      phase: { head: 0.22, 'arm-l-upper': 0.3, 'arm-r-upper': 0.3, bag: 0.4, 'neck-ruff': 0.1 },
      tracks: {
        shekru: { sy: [[0, 1], [1.55, 1.013], [P_BREATH, 1]], sx: [[0, 1], [1.55, 0.994], [P_BREATH, 1]] },
        head: { ty: [[0, 0], [1.55, -0.9], [P_BREATH, 0]] },
        'arm-l-upper': { r: [[0, 0], [1.55, 1.6], [P_BREATH, 0]] },
        'arm-r-upper': { r: [[0, 0], [1.55, -1.6], [P_BREATH, 0]] },
        bag: { r: [[0, 0], [1.55, -0.8], [P_BREATH, 0]] },
      },
    },
    {
      name: 'tailSway', period: P_TAIL, mix: 'tail',
      phase: { 'tail-2': 0.3, 'tail-3': 0.6, 'tail-4': 0.95 },
      tracks: {
        'tail-1': { r: [[0, -1.6], [P_TAIL / 2, 1.6], [P_TAIL, -1.6]] },
        'tail-2': { r: [[0, -2.0], [P_TAIL / 2, 2.0], [P_TAIL, -2.0]] },
        'tail-3': { r: [[0, -2.6], [P_TAIL / 2, 2.6], [P_TAIL, -2.6]] },
        'tail-4': { r: [[0, -4.2], [P_TAIL / 2, 4.2], [P_TAIL, -4.2]] },
      },
    },
    {
      name: 'tailTip', period: P_TIP, mix: 'tail',
      phase: { 'tail-4': 0.5 },
      tracks: {
        'tail-3': { r: [[0, 0], [2.2, -1.8], [4.4, 0.8], [P_TIP, 0]] },
        'tail-4': { r: [[0, 0], [2.2, -3.5], [4.4, 1.5], [P_TIP, 0]] },
      },
    },
  ],
  random: {
    blink: {
      interval: [2, 6], duration: 0.2, doubleChance: 0.22, reducedMotion: true,
      variants: [(() => {
        const tr = tracksOf();
        const lid = [[0, 0.06], [0.065, 1, 'outQuad'], [0.105, 1], [0.2, 0.06, 'inOutQuad']];
        for (const s of ['l', 'r']) {
          set(tr, `eye-${s}-eyelid`, 'v', [[0, 1], [0.2, 1]]);
          set(tr, `eye-${s}-eyelid`, 'sy', lid);
          set(tr, `brow-${s}`, 'ty', [[0, 0], [0.07, 1.4, 'outQuad'], [0.2, 0]]);
        }
        return tr;
      })()],
    },
    earFlick: {
      interval: [3.5, 8], duration: 0.36, mix: 'ears',
      variants: [
        { 'ear-l': { r: [[0, 0], [0.07, -10, 'outQuad'], [0.18, 3.5], [0.36, 0]] } },
        { 'ear-r': { r: [[0, 0], [0.07, 10, 'outQuad'], [0.18, -3.5], [0.36, 0]] } },
        { 'ear-r': { r: [[0, 0], [0.07, 8, 'outQuad'], [0.18, -3], [0.36, 0]] }, 'ear-l': { r: [[0, 0], [0.04, 0], [0.11, -8, 'outQuad'], [0.22, 3], [0.36, 0]] } },
      ],
    },
  },
};

// ---------------------------------------------------------------- speech accents
const beatVariant = (tilt, dip) => ({
  head: { ty: [[0, 0], [0.11, dip, 'outQuad'], [0.44, 0]], r: [[0, 0], [0.13, tilt, 'outQuad'], [0.44, 0]] },
  upper: { ty: [[0, 0], [0.1, dip * 0.35, 'outQuad'], [0.4, 0]] },
  'brow-l': { ty: [[0, 0], [0.09, -3, 'outQuad'], [0.26, -2.2], [0.44, 0]] },
  'brow-r': { ty: [[0, 0], [0.09, -3, 'outQuad'], [0.26, -2.2], [0.44, 0]] },
  'ear-l': { r: [[0, 0], [0.17, -3.5, 'outQuad'], [0.44, 0]] },
  'ear-r': { r: [[0, 0], [0.17, 3.5, 'outQuad'], [0.44, 0]] },
});
const speech = {
  beat: {
    visemes: { AA: 1, O: 0.9, EE: 0.7 }, minGap: 0.34, lead: 0.05, duration: 0.44,
    variants: [beatVariant(1.8, 3.4), beatVariant(-1.8, 3.4), beatVariant(1.2, 3.0), beatVariant(-0.8, -2.2)],
  },
};

// ---------------------------------------------------------------- effects (written to ../shekru-fx.svg)
// Shapes live in stage space (same 512 viewBox as the character) and are animated like body parts.
const FX_GREEN = '#5C853C', FX_INK = '#801936', FX_WHITE = '#FFFFFF';
const n2 = (x) => +x.toFixed(2);
const polar = (c, r, deg) => [n2(c[0] + r * Math.cos((deg * Math.PI) / 180)), n2(c[1] + r * Math.sin((deg * Math.PI) / 180))];
// listening: one arc, three copies; each is scaled about the ear from `far` to `near`
const WAVE = { ids: ['fx-wave-1', 'fx-wave-2', 'fx-wave-3'], ear: [120, 100], r: 40, dir: -138, span: 36, far: 1.55, near: 0.5, period: 1.5 };
// thinking: trail of dots from the head to a cloud, up on screen-right where he looks
const THINK = {
  root: 'fx-think', cloud: 'fx-think-cloud', dots: ['fx-think-dot-1', 'fx-think-dot-2', 'fx-think-dot-3'],
  ellipsis: ['fx-think-e1', 'fx-think-e2', 'fx-think-e3'],
  trail: [[217, 125, 4], [226, 110, 6], [237, 94, 8]],
  lobes: [[228, 51, 18], [245, 34, 20], [268, 32, 22], [284, 49, 18], [264, 58, 20], [243, 60, 17]],
  centre: [255, 46], pop: [232, 68], e: [[239, 47], [255, 47], [271, 47]], eR: 5, line: 3,
};
// hint: a letter card pops out of the pointing paw; the letter goes in the empty `slot` group (filled by the player)
const CARD = { id: 'fx-hint-card', slot: 'fx-hint-letter', x: 326, y: 212, size: 72, r: 14, pivot: [326, 284], stroke: '#DF8F1F', line: 4 };
const fxParts = { 'fx-listen': { pivot: WAVE.ear }, [THINK.root]: { pivot: THINK.centre }, [THINK.cloud]: { pivot: THINK.pop } };
const fxRest = { [THINK.cloud]: { o: 0 } };
function fxSvg() {
  const L = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">', '  <g id="shekru-fx">', '    <g id="fx-listen">'];
  const [a, b] = [polar(WAVE.ear, WAVE.r, WAVE.dir - WAVE.span), polar(WAVE.ear, WAVE.r, WAVE.dir + WAVE.span)];
  for (const id of WAVE.ids) {
    fxParts[id] = { pivot: WAVE.ear }; fxRest[id] = { o: 0 };
    L.push(`      <g id="${id}">`, `        <path d="M ${a[0]} ${a[1]} A ${WAVE.r} ${WAVE.r} 0 0 1 ${b[0]} ${b[1]}" fill="none" stroke="${FX_GREEN}" stroke-width="6.5" stroke-linecap="round"/>`, '      </g>');
  }
  L.push('    </g>', `    <g id="${THINK.root}">`);
  THINK.dots.forEach((id, i) => {
    const [x, y, r] = THINK.trail[i];
    fxParts[id] = { pivot: [x, y] }; fxRest[id] = { o: 0 };
    L.push(`      <g id="${id}">`, `        <circle cx="${x}" cy="${y}" r="${r + THINK.line * 0.8}" fill="${FX_INK}"/>`, `        <circle cx="${x}" cy="${y}" r="${r}" fill="${FX_WHITE}"/>`, '      </g>');
  });
  L.push(`      <g id="${THINK.cloud}">`);
  for (const pad of [THINK.line, 0]) {
    for (const [x, y, r] of THINK.lobes) L.push(`        <circle cx="${x}" cy="${y}" r="${r + pad}" fill="${pad ? FX_INK : FX_WHITE}"/>`);
    L.push(`        <ellipse cx="${THINK.centre[0]}" cy="${THINK.centre[1]}" rx="${31 + pad}" ry="${18 + pad}" fill="${pad ? FX_INK : FX_WHITE}"/>`);
  }
  THINK.ellipsis.forEach((id, i) => {
    const [x, y] = THINK.e[i];
    fxParts[id] = { pivot: [x, y] };
    L.push(`        <g id="${id}">`, `          <circle cx="${x}" cy="${y}" r="${THINK.eR}" fill="${FX_INK}"/>`, '        </g>');
  });
  L.push('      </g>', '    </g>');
  const { x, y, size: w, r } = CARD, h = (x0, y0, s) => `M ${x0 + r} ${y0} H ${x0 + s - r} A ${r} ${r} 0 0 1 ${x0 + s} ${y0 + r} V ${y0 + s - r} A ${r} ${r} 0 0 1 ${x0 + s - r} ${y0 + s} H ${x0 + r} A ${r} ${r} 0 0 1 ${x0} ${y0 + s - r} V ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z`;
  fxParts[CARD.id] = { pivot: CARD.pivot }; fxRest[CARD.id] = { o: 0 };
  L.push(`    <g id="${CARD.id}">`, `      <path d="${h(x, y, w)}" fill="${FX_WHITE}" stroke="${CARD.stroke}" stroke-width="${CARD.line}"/>`, `      <g id="${CARD.slot}"></g>`, '    </g>');
  L.push('  </g>', '</svg>');
  return L.join('\n') + '\n';
}
const FX_SVG = fxSvg();
// cut a key list at time D (segments crossing D must be linear)
function clip(keys, D) {
  const out = keys.filter((k) => k[0] < D - 1e-9);
  out.push([D, +evalKeys(keys, D).toFixed(4), 'linear']);
  return out.map(([t, v, e]) => (e ? [+t.toFixed(4), v, e] : [+t.toFixed(4), v]));
}

// ---------------------------------------------------------------- states
const states = {};

// 1. idle: weight shifts, two glances, the arms and bag settle late
{
  const tr = tracksOf(), D = 14;
  set(tr, 'upper', 'r', [[0, 0], [3, 0], [4.3, 1.6, 'inOutCubic'], [8, 1.6], [9.4, -1.4, 'inOutCubic'], [12.3, -1.4], [13.6, 0, 'inOutCubic'], [D, 0]]);
  set(tr, 'upper', 'tx', [[0, 0], [3, 0], [4.3, 2.2, 'inOutCubic'], [8, 2.2], [9.4, -2, 'inOutCubic'], [12.3, -2], [13.6, 0, 'inOutCubic'], [D, 0]]);
  set(tr, 'head', 'r', [[0, 0], [3.1, 0], [4.45, -2.2, 'inOutCubic'], [5.0, -1.3], [5.6, -1.3], [5.8, 0.4, 'outCubic'], [7.0, 0.4], [7.3, -1.3], [8.1, -1.3], [9.55, 2.0, 'inOutCubic'], [10.1, 1.1], [10.6, 1.1], [10.8, -0.6, 'outCubic'], [11.7, -0.6], [12.0, 1.1], [12.4, 1.1], [13.8, 0, 'inOutCubic'], [D, 0]]);
  const hang = [[0, 0], [3.15, 0], [4.5, -2.6, 'inOutCubic'], [5.1, -1.4], [8.15, -1.4], [9.6, 2.3, 'inOutCubic'], [10.2, 1.2], [12.45, 1.2], [13.75, -0.5, 'inOutCubic'], [D, 0]];
  set(tr, 'arm-l-upper', 'r', hang);
  set(tr, 'arm-r-upper', 'r', hang);
  set(tr, 'arm-l-lower', 'r', lag(hang, 0.12, 0.7, D));
  set(tr, 'arm-r-lower', 'r', lag(hang, 0.12, 0.7, D));
  set(tr, 'bag', 'r', [[0, 0], [3.2, 0], [4.55, -3.4, 'inOutCubic'], [5.05, -0.8], [5.6, -2], [6.2, -1.5], [8.2, -1.5], [9.65, 3.2, 'inOutCubic'], [10.15, 0.7], [10.7, 1.8], [11.3, 1.4], [12.5, 1.4], [13.7, -0.6, 'inOutCubic'], [D, 0]]);
  gaze(tr,
    [[0, 0], [5.6, 0], [5.74, 3.6, 'outCubic'], [7.0, 3.6], [7.16, 0, 'outCubic'], [10.6, 0], [10.74, -3.6, 'outCubic'], [11.7, -3.6], [11.86, 0, 'outCubic'], [D, 0]],
    [[0, 0], [10.6, 0], [10.74, -1.6, 'outCubic'], [11.7, -1.6], [11.86, 0, 'outCubic'], [D, 0]]);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [5.6, 0], [5.78, -1.8, 'outCubic'], [7.0, -1.8], [7.3, 0], [D, 0]]);
  states.idle = { duration: D, loop: true, still: 0, tracks: tr, filmstrip: [0.5, 1.72, 1.78, 3.6, 4.3, 5.0, 5.8, 7.5, 9.0, 9.6, 10.9, 13.0] };
}

// 2. hello: dip, pop up, wave with the screen-right arm, happy eyes on the first beat
{
  const tr = tracksOf(), D = 3.0;
  set(tr, 'shekru', 'sy', [[0, 1], [0.2, 0.955, 'outQuad'], [0.42, 1.035, 'inOutCubic'], [0.66, 0.99], [0.9, 1]]);
  set(tr, 'shekru', 'sx', [[0, 1], [0.2, 1.03, 'outQuad'], [0.42, 0.98, 'inOutCubic'], [0.66, 1.006], [0.9, 1]]);
  set(tr, 'upper', 'r', [[0, 0], [0.22, 1.2], [0.6, -2.2, 'inOutCubic'], [2.0, -1.6], [2.7, 0, 'inOutCubic']]);
  set(tr, 'head', 'ty', [[0, 0], [0.22, 2.5, 'outQuad'], [0.5, -2, 'inOutCubic'], [0.8, 0]]);
  set(tr, 'head', 'r', [[0, 0], [0.24, 2], [0.68, -8.5, 'inOutCubic'], [0.95, -7], [1.25, -8], [1.6, -6.5], [2.0, -7], [2.75, 0.8, 'inOutCubic'], [D, 0]]);
  set(tr, 'arm-r-upper', 'r', [[0, 0], [0.2, 9, 'outQuad'], [0.58, -96, 'inOutQuad'], [0.8, -88], [1.02, -93], [1.24, -87], [1.47, -92], [1.72, -88], [2.0, -90], [2.55, 5, 'inOutQuad'], [2.8, -1.5], [D, 0]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [0.24, 6, 'outQuad'], [0.66, -62, 'inOutQuad'], [0.86, -30], [1.08, -68], [1.3, -33], [1.53, -64], [1.78, -40], [2.02, -54], [2.62, 12, 'inOutQuad'], [2.84, -4], [D, 0]]);
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.22, -5, 'outQuad'], [0.6, 10, 'inOutQuad'], [0.95, 5], [2.0, 5], [2.7, 0]]);
  set(tr, 'arm-l-lower', 'r', [[0, 0], [0.3, -4], [0.7, 12, 'inOutQuad'], [1.05, 5], [2.0, 5], [2.75, 0]]);
  set(tr, 'bag', 'r', [[0, 0], [0.25, 2], [0.6, -5, 'inOutCubic'], [0.95, 2.5], [1.3, -1], [1.7, 0]]);
  for (const [e, s] of [['ear-l', -1], ['ear-r', 1]]) set(tr, e, 'r', [[0, 0], [0.22, 7 * s, 'outQuad'], [0.52, -9 * s, 'inOutCubic'], [0.78, 4 * s], [1.05, 0]]);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.2, 1], [0.5, -4.5, 'outBack'], [1.9, -3.5], [2.5, 0]]);
  happy(tr, 0.46, 1.42);
  tail(tr, [[0, 0], [0.24, 4, 'outQuad'], [0.62, -9, 'inOutCubic'], [1.02, 6], [1.45, -3.5], [1.9, 1.5], [2.4, 0]], { delay: 0.08 });
  states.hello = { duration: D, loop: false, next: 'idle', still: 0.86, mouth: [[0, 'rest'], [0.44, 'EE'], [1.9, 'rest']], mix: { tail: 0.4 }, tracks: tr };
}

// 3. talking: slow attention shifts and two small gestures; nods come from the speech layer
{
  const tr = tracksOf(), D = 8;
  set(tr, 'head', 'r', [[0, 0], [1.2, 2.6, 'inOutCubic'], [3.6, 2.2], [4.8, -2.2, 'inOutCubic'], [7, -1.8], [D, 0, 'inOutCubic']]);
  set(tr, 'upper', 'r', [[0, 0], [1.1, 1.1, 'inOutCubic'], [3.5, 1.1], [4.7, -0.9, 'inOutCubic'], [6.9, -0.9], [D, 0, 'inOutCubic']]);
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.9, 0], [1.05, -4, 'outQuad'], [1.5, 36, 'inOutQuad'], [1.8, 31], [2.35, 35], [2.9, 31], [3.6, -2, 'inOutQuad'], [3.9, 0], [D, 0]]);
  set(tr, 'arm-l-lower', 'r', [[0, 0], [1.0, 0], [1.6, 64, 'inOutQuad'], [1.9, 54], [2.4, 62], [2.95, 54], [3.7, -6, 'inOutQuad'], [4.0, 0], [D, 0]]);
  set(tr, 'arm-r-upper', 'r', [[0, 0], [5.0, 0], [5.45, -24, 'inOutQuad'], [5.75, -20], [6.2, -23], [6.9, 1.5, 'inOutQuad'], [7.2, 0], [D, 0]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [5.08, 0], [5.55, -52, 'inOutQuad'], [5.85, -44], [6.25, -50], [7.0, 5, 'inOutQuad'], [7.3, 0], [D, 0]]);
  set(tr, 'bag', 'r', [[0, 0], [1.2, -2], [1.9, 0.8], [2.6, 0], [4.8, 1.6], [5.6, -0.6], [D, 0]]);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, -1], [D, -1]]);
  states.talking = { duration: D, loop: true, still: 0, tracks: tr, filmstrip: [0.3, 0.62, 0.7, 0.8, 0.96, 1.5, 2.1, 2.2, 2.4, 3.0, 3.74, 5.6] };
}

// 4. listening: lean in toward the child, head cocked, ears up, wide eyes, paws together at the chest,
//    slow nods. No arm above the shoulder. Sound waves travel in to the screen-left ear (fx).
{
  const tr = tracksOf(), L = 1.0, D = 6.0;
  // lean in: the upper body grows a touch (closer to the viewer) and tips forward
  for (const ch of ['sx', 'sy']) set(tr, 'upper', ch, [[0, 1], [0.14, 0.985, 'outQuad'], [0.6, 1.05, 'inOutCubic'], [0.88, 1.04], [L, 1.04], [D, 1.04]]);
  set(tr, 'upper', 'r', [[0, 0], [0.14, -0.8, 'outQuad'], [0.6, 2.6, 'inOutCubic'], [0.88, 2], [L, 2], [3.4, 2.6], [D, 2]]);
  set(tr, 'upper', 'ty', [[0, 0], [0.14, 2, 'outQuad'], [0.6, 3.5, 'inOutCubic'], [L, 3], [1.9, 3], [2.2, 4.4, 'outQuad'], [2.75, 3], [3.9, 3], [4.18, 4.2, 'outQuad'], [4.5, 3.4], [4.78, 4.2, 'outQuad'], [5.3, 3], [D, 3]]);
  for (const ch of ['sx', 'sy']) set(tr, 'head', ch, [[0, 1], [0.2, 1], [0.66, 1.06, 'inOutCubic'], [0.92, 1.045], [L, 1.045], [D, 1.045]]);
  set(tr, 'head', 'r', [[0, 0], [0.17, -1.8, 'outQuad'], [0.66, 10.5, 'inOutCubic'], [0.92, 9], [L, 9], [1.9, 9], [2.2, 10.2, 'outQuad'], [2.75, 9], [3.9, 9], [4.18, 10, 'outQuad'], [4.5, 9.3], [4.78, 10, 'outQuad'], [5.3, 9], [D, 9]]);
  // slow attentive nods: one, then a double
  set(tr, 'head', 'ty', [[0, 0], [0.2, 1.5, 'outQuad'], [0.66, 3, 'inOutCubic'], [L, 3], [1.9, 3], [2.2, 7.2, 'outQuad'], [2.75, 3], [3.9, 3], [4.18, 6.8, 'outQuad'], [4.5, 4.2], [4.78, 6.6, 'outQuad'], [5.3, 3], [D, 3]]);
  // paws come together at the chest and stay below the chin
  for (const [s, k] of [['l', 1], ['r', -1]]) {
    const d = s === 'r' ? 0.04 : 0;
    set(tr, `arm-${s}-upper`, 'r', [[0, 0], [0.14 + d, -4 * k, 'outQuad'], [0.6 + d, 9 * k, 'inOutQuad'], [0.88, 6 * k], [L, 6 * k], [1.9, 6 * k], [2.25, 8 * k], [2.8, 6 * k], [3.9, 6 * k], [4.8, 8 * k], [5.35, 6 * k], [D, 6 * k]]);
    set(tr, `arm-${s}-lower`, 'r', [[0, 0], [0.2 + d, 6 * k, 'outQuad'], [0.68 + d, -125 * k, 'inOutQuad'], [0.92, -118 * k], [L, -118 * k], [1.95, -118 * k], [2.3, -122 * k], [2.85, -118 * k], [3.95, -118 * k], [4.85, -122 * k], [5.4, -118 * k], [D, -118 * k]]);
    set(tr, `eye-${s}`, 'sx', [[0, 1], [0.4, 1], [0.7, 1.09, 'outBack'], [L, 1.07], [D, 1.07]]);
    set(tr, `eye-${s}`, 'sy', [[0, 1], [0.4, 1], [0.7, 1.09, 'outBack'], [L, 1.07], [D, 1.07]]);
  }
  // ears up and turned in toward the child; the screen-left ear twitches at the sound
  set(tr, 'ear-l', 'r', [[0, 0], [0.3, 0], [0.52, 10, 'outBack'], [L, 7], [2.9, 7], [2.98, 13, 'outQuad'], [3.12, 5], [3.32, 7], [5.5, 7], [5.58, 12, 'outQuad'], [5.72, 5.5], [5.9, 7], [D, 7]]);
  set(tr, 'ear-r', 'r', [[0, 0], [0.34, 0], [0.56, -10, 'outBack'], [L, -7], [D, -7]]);
  setAll(tr, ['ear-l', 'ear-r'], 'sy', [[0, 1], [0.3, 1], [0.54, 1.18, 'outBack'], [L, 1.13], [D, 1.13]]);
  setAll(tr, ['eye-l-pupil', 'eye-r-pupil'], 'sx', [[0, 1], [0.4, 1], [0.7, 1.1, 'outBack'], [L, 1.07], [D, 1.07]]);
  setAll(tr, ['eye-l-pupil', 'eye-r-pupil'], 'sy', [[0, 1], [0.4, 1], [0.7, 1.1, 'outBack'], [L, 1.07], [D, 1.07]]);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.36, 0], [0.62, -5, 'outBack'], [L, -4], [D, -4]]);
  set(tr, 'tail-3', 'r', [[0, 0], [L, -3], [D, -3]]);
  set(tr, 'tail-4', 'r', [[0, 0], [L, -6], [D, -6]]);
  set(tr, 'bag', 'r', [[0, 0], [0.2, 1.2], [0.62, -3, 'inOutCubic'], [0.95, -1.2], [L, -1.5], [D, -1.5]]);

  // fx: three arcs shrink in toward the ear, one after another, 1.5 s per wave
  const fx = tracksOf(), P = WAVE.period, FL = 1.5;
  WAVE.ids.forEach((id, i) => {
    const s = [[0, WAVE.far]], o = [[0, 0]];
    for (let c = 0.3 + (i * P) / 3; c < D; c += P) {
      s.push([c, WAVE.far, 'step'], [c + P - 0.002, WAVE.near, 'linear']);
      o.push([c, 0, 'step'], [c + 0.22 * P, 1, 'linear'], [c + 0.66 * P, 1, 'linear'], [c + P - 0.002, 0, 'linear']);
    }
    set(fx, id, 'sx', clip(s, D)); set(fx, id, 'sy', clip(s, D)); set(fx, id, 'o', clip(o, D));
  });
  states.listening = { duration: D, loop: true, loopStart: L, still: L, mix: { tail: 0.35 }, tracks: tr, fx: { loopStart: FL, still: 1.6, tracks: fx },
    filmstrip: [0.08, 0.2, 0.34, 0.5, 0.66, 0.85, 1.0, 1.5, 2.2, 3.0, 4.18, 5.6] };
}

// 5. thinking: screen-left paw at the jaw, eyes up and away to screen-right, uneven brows, slow hmm tilt,
//    tail curls away to leave room for the thought bubble (fx) that he looks at.
{
  const tr = tracksOf(), L = 1.0, D = 7.0;
  gaze(tr,
    [[0, 0], [0.22, 0], [0.42, 4.1, 'outCubic'], [L, 4.1], [3.4, 4.1], [3.56, 1.2, 'outCubic'], [5.2, 1.2], [5.36, 4.1, 'outCubic'], [D, 4.1]],
    [[0, 0], [0.22, 0], [0.42, -4.2, 'outCubic'], [L, -4.2], [3.4, -4.2], [3.56, -5, 'outCubic'], [5.2, -5], [5.36, -4.2, 'outCubic'], [D, -4.2]]);
  set(tr, 'brow-r', 'ty', [[0, 0], [0.3, 0], [0.6, -6, 'outBack'], [L, -5], [D, -5]]);
  set(tr, 'brow-r', 'r', [[0, 0], [0.3, 0], [0.6, 9, 'outBack'], [L, 8], [D, 8]]);
  set(tr, 'brow-l', 'ty', [[0, 0], [0.36, 0], [0.66, 2, 'outCubic'], [L, 1.5], [D, 1.5]]);
  set(tr, 'brow-l', 'r', [[0, 0], [0.36, 0], [0.66, -8, 'outCubic'], [L, -7], [D, -7]]);
  // slow "hmm": the head rests toward the paw and rocks
  set(tr, 'head', 'r', [[0, 0], [0.2, 1.8, 'outQuad'], [0.72, -8, 'inOutCubic'], [L, -6.5], [2.6, -8.6], [4.4, -5.6], [D, -6.5]]);
  set(tr, 'upper', 'r', [[0, 0], [0.6, -1.8, 'inOutCubic'], [L, -1.5], [3.6, -2], [D, -1.5]]);
  // the forearm folds first so the paw comes up close to the body, not out wide
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.12, -5, 'outQuad'], [0.68, 84, 'inOutQuad'], [0.9, 78], [L, 78], [D, 78]]);
  set(tr, 'arm-l-lower', 'r', [[0, 0], [0.1, -6, 'outQuad'], [0.56, 128, 'inOutQuad'], [0.86, 120], [L, 120], [2.0, 120], [2.12, 112, 'outQuad'], [2.26, 120], [2.4, 113, 'outQuad'], [2.6, 120], [D, 120]]);
  set(tr, 'arm-r-upper', 'r', [[0, 0], [0.7, -6], [L, -4], [D, -4]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [0.8, -7], [L, -5], [D, -5]]);
  set(tr, 'mouth', 'tx', [[0, 0], [0.5, 0], [0.8, 3], [D, 3]]);
  set(tr, 'tail-1', 'r', [[0, 0], [L, 3, 'inOutCubic'], [D, 3]]);
  set(tr, 'tail-2', 'r', [[0, 0], [L, 4, 'inOutCubic'], [D, 4]]);
  set(tr, 'tail-3', 'r', [[0, 0], [L, 7, 'inOutCubic'], [4.0, 5], [D, 7]]);
  set(tr, 'tail-4', 'r', [[0, 0], [L, 12, 'inOutCubic'], [4.2, 7], [D, 12]]);

  // fx: three dots pop in rising from the head, then the cloud, then "..." bounces inside
  const fx = tracksOf(), FL = 1.6;
  THINK.dots.forEach((id, i) => {
    const t0 = 0.3 + i * 0.14;
    set(fx, id, 'o', [[0, 0], [t0, 0], [t0 + 0.06, 1, 'outQuad'], [D, 1]]);
    for (const ch of ['sx', 'sy']) set(fx, id, ch, [[0, 0.2], [t0, 0.2], [t0 + 0.24, 1, 'outBack'], [D, 1]]);
  });
  set(fx, THINK.cloud, 'o', [[0, 0], [0.72, 0], [0.82, 1, 'outQuad'], [D, 1]]);
  for (const ch of ['sx', 'sy']) set(fx, THINK.cloud, ch, [[0, 0.3], [0.72, 0.3], [1.08, 1, 'outBack'], [D, 1]]);
  const BP = (D - FL) / 4; // bounce period
  THINK.ellipsis.forEach((id, i) => {
    const k = [[0, 0]];
    for (let c = FL - BP + i * 0.17; c < D; c += BP) k.push([c, 0, 'linear'], [c + 0.2, -6, 'outQuad'], [c + 0.44, 0, 'inQuad']);
    set(fx, id, 'ty', clip(k, D));
  });
  set(fx, THINK.root, 'ty', [[0, 0], [FL, 0], [FL + 1.35, -3], [FL + 2.7, 0], [FL + 4.05, -3], [D, 0]]);
  set(fx, THINK.root, 'r', [[0, 0], [FL, 0], [FL + 1.8, 1.2], [FL + 3.6, -1], [D, 0]]);
  states.thinking = { duration: D, loop: true, loopStart: L, still: L, front: ['arm-l'], mouth: [[0, 'rest'], [0.45, 'MBP']], mix: { tail: 0.5 }, tracks: tr, fx: { loopStart: FL, tracks: fx },
    filmstrip: [0.1, 0.3, 0.42, 0.56, 0.7, 0.84, 0.96, 1.1, 2.12, 3.56, 4.4, 6.5] };
}

// 6. correct: crouch, jump (stretch up, squash on landing), arms up, happy eyes, tail whips after
{
  const tr = tracksOf(), D = 2.8;
  const up = 0.34, apex = 0.64, land = 0.94;
  set(tr, 'shekru', 'ty', [[0, 0], [up, 0], [apex, -40, 'outQuad'], [land, 0, 'inQuad'], [D, 0]]);
  set(tr, 'shekru', 'sy', [[0, 1], [0.26, 0.86, 'outCubic'], [0.4, 1.1, 'inOutQuad'], [apex, 1.0], [0.9, 1.06, 'inQuad'], [1.02, 0.86, 'outQuad'], [1.2, 1.045, 'inOutQuad'], [1.36, 0.985], [1.54, 1]]);
  set(tr, 'shekru', 'sx', [[0, 1], [0.26, 1.08, 'outCubic'], [0.4, 0.95, 'inOutQuad'], [apex, 1.0], [0.9, 0.97, 'inQuad'], [1.02, 1.08, 'outQuad'], [1.2, 0.975, 'inOutQuad'], [1.36, 1.008], [1.54, 1]]);
  for (const [s, k] of [['l', 1], ['r', -1]]) {
    set(tr, `arm-${s}-upper`, 'r', [[0, 0], [0.26, -14 * k, 'outCubic'], [0.56, 128 * k, 'inOutQuad'], [0.78, 120 * k], [0.98, 106 * k, 'inQuad'], [1.2, 126 * k, 'outCubic'], [1.45, 118 * k], [1.75, 121 * k], [2.4, -4 * k, 'inOutQuad'], [2.62, 1 * k], [D, 0]]);
    set(tr, `arm-${s}-lower`, 'r', [[0, 0], [0.26, 24 * k, 'outCubic'], [0.5, 40 * k], [0.66, 8 * k, 'outCubic'], [0.86, 20 * k], [1.04, 34 * k, 'inQuad'], [1.28, 6 * k, 'outCubic'], [1.5, 18 * k], [1.8, 12 * k], [2.46, -10 * k, 'inOutQuad'], [2.68, 3 * k], [D, 0]]);
    set(tr, `leg-${s}`, 'r', [[0, 0], [up, 0], [0.5, 9 * k, 'outQuad'], [0.78, 6 * k], [land, 0, 'inQuad'], [D, 0]]);
    set(tr, `ear-${s}`, 'r', [[0, 0], [0.26, 6 * k, 'outCubic'], [0.46, -13 * k, 'inOutQuad'], [0.72, 7 * k], [0.96, 4 * k], [1.08, -15 * k, 'outQuad'], [1.3, 6 * k], [1.5, -2 * k], [1.7, 0]]);
  }
  set(tr, 'head', 'ty', [[0, 0], [0.26, 4, 'outCubic'], [0.44, 5, 'inOutQuad'], [0.7, -3.5], [0.94, -1], [1.06, 7, 'outQuad'], [1.28, -2], [1.5, 0.5], [1.7, 0]]);
  set(tr, 'head', 'r', [[0, 0], [0.26, 2], [0.6, -4, 'inOutCubic'], [1.06, 3.5, 'inOutCubic'], [1.4, -1.5], [1.8, 0]]);
  set(tr, 'bag', 'r', [[0, 0], [0.3, 2], [0.56, -6, 'inOutQuad'], [0.9, 5], [1.1, -6, 'outQuad'], [1.36, 3], [1.62, -1], [1.9, 0]]);
  set(tr, 'bag', 'ty', [[0, 0], [0.4, 0], [0.56, 4, 'outQuad'], [0.8, -5], [1.0, -2], [1.1, 4, 'outQuad'], [1.4, 0]]);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.26, 2, 'outCubic'], [0.46, -5.5, 'outBack'], [1.9, -4], [2.3, 0]]);
  happy(tr, 0.36, 1.95);
  tail(tr, [[0, 0], [0.26, 4, 'outCubic'], [0.52, 8, 'inOutQuad'], [0.84, -7, 'inOutQuad'], [1.08, 7, 'outQuad'], [1.36, -4.5], [1.66, 2.2], [2.0, -0.8], [2.3, 0]], { delay: 0.07, gains: [1, 0.7, 0.8, 1.2] });
  states.correct = { duration: D, loop: false, next: 'idle', still: 1.5, mouth: [[0, 'rest'], [0.34, 'AA'], [1.6, 'EE'], [2.2, 'rest']], mix: { tail: 0.3, speech: 0.5, breath: 0.5 }, tracks: tr,
    filmstrip: [0.12, 0.26, 0.36, 0.46, 0.56, 0.64, 0.8, 0.94, 1.02, 1.2, 1.5, 2.2] };
}

// 7. tryagain: soft nod, kind brows, open palms toward the child
{
  const tr = tracksOf(), L = 1.0, D = 5.0;
  set(tr, 'head', 'ty', [[0, 0], [0.26, 4.5, 'outQuad'], [0.62, -1, 'inOutCubic'], [L, 0], [2.6, 0], [2.86, 3, 'outQuad'], [3.3, 0], [D, 0]]);
  set(tr, 'head', 'r', [[0, 0], [0.8, 5.5, 'inOutCubic'], [L, 5], [3.2, 3.8], [D, 5]]);
  set(tr, 'upper', 'r', [[0, 0], [0.7, -1.4, 'inOutCubic'], [L, -1.2], [D, -1.2]]);
  set(tr, 'upper', 'ty', [[0, 0], [0.26, 2, 'outQuad'], [0.62, 0], [L, 0], [2.6, 0], [2.86, 1.2], [3.3, 0], [D, 0]]);
  for (const [s, k] of [['l', 1], ['r', -1]]) {
    const d = s === 'r' ? 0.05 : 0;
    set(tr, `arm-${s}-upper`, 'r', [[0, 0], [0.24 + d, -5 * k, 'outQuad'], [0.74 + d, 35 * k, 'inOutQuad'], [L, 30 * k], [2.9, 27 * k], [3.3, 31 * k], [D, 30 * k]]);
    set(tr, `arm-${s}-lower`, 'r', [[0, 0], [0.3 + d, -3 * k], [0.84 + d, 82 * k, 'inOutQuad'], [L, 74 * k], [2.92, 80 * k], [3.36, 71 * k], [3.9, 74 * k], [D, 74 * k]]);
    set(tr, `brow-${s}`, 'ty', [[0, 0], [0.3, 0], [0.6, -4.2, 'outBack'], [L, -3.5], [D, -3.5]]);
    set(tr, `brow-${s}`, 'r', [[0, 0], [0.3, 0], [0.6, -6 * k, 'outBack'], [L, -5 * k], [D, -5 * k]]);
  }
  happy(tr, 0.2, 0.72);
  set(tr, 'bag', 'r', [[0, 0], [0.6, -2.5], [L, -1], [D, -1]]);
  states.tryagain = { duration: D, loop: true, loopStart: L, still: L, mix: { tail: 0.5 }, tracks: tr, filmstrip: [0.1, 0.26, 0.4, 0.55, 0.72, 0.86, 1.0, 2.0, 2.86, 3.3, 4.0, 4.9] };
}

// 8. hint: wind up, point to screen-right, eyes follow the paw, then a cheeky look back with a double brow raise
{
  const tr = tracksOf(), L = 1.0, D = 6.0;
  set(tr, 'upper', 'r', [[0, 0], [0.18, -1.8, 'outQuad'], [0.62, 5.2, 'inOutCubic'], [0.9, 4.2], [L, 4.2], [D, 4.2]]);
  set(tr, 'head', 'r', [[0, 0], [0.2, -2.5, 'outQuad'], [0.72, 6.5, 'inOutCubic'], [L, 5], [3.6, 5], [3.92, 1, 'inOutCubic'], [4.9, 1], [5.22, 5, 'inOutCubic'], [D, 5]]);
  set(tr, 'arm-r-upper', 'r', [[0, 0], [0.18, 12, 'outQuad'], [0.56, -93, 'inOutQuad'], [0.8, -85], [L, -85], [2.2, -85], [2.36, -91, 'outQuad'], [2.66, -85], [2.84, -90, 'outQuad'], [3.2, -85], [D, -85]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [0.22, -26, 'outQuad'], [0.5, -30], [0.64, 5, 'outQuad'], [0.86, -7], [L, -5], [2.2, -5], [2.4, 2], [2.66, -5], [2.88, 1], [3.2, -5], [D, -5]]);
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.3, -3], [0.8, 30, 'inOutQuad'], [L, 27], [D, 27]]);
  set(tr, 'arm-l-lower', 'r', [[0, 0], [0.36, 0], [0.86, -58, 'inOutQuad'], [L, -52], [D, -52]]);
  gaze(tr, [[0, 0], [0.24, 0], [0.4, 4.2, 'outCubic'], [L, 4.2], [3.6, 4.2], [3.74, 0, 'outCubic'], [4.9, 0], [5.04, 4.2, 'outCubic'], [D, 4.2]], null);
  set(tr, 'brow-l', 'ty', [[0, 0], [0.3, 0], [0.56, -4, 'outBack'], [L, -3], [4.0, -3], [4.12, -6, 'outQuad'], [4.3, -3], [4.44, -6, 'outQuad'], [4.72, -3], [D, -3]]);
  set(tr, 'brow-r', 'ty', [[0, 0], [0.3, 0], [0.56, -6, 'outBack'], [L, -5], [4.0, -5], [4.12, -7.5, 'outQuad'], [4.3, -5], [4.44, -7.5, 'outQuad'], [4.72, -5], [D, -5]]);
  set(tr, 'brow-r', 'r', [[0, 0], [0.3, 0], [0.56, 7, 'outBack'], [L, 6], [D, 6]]);
  set(tr, 'tail-4', 'r', [[0, 0], [L, 0], [2.2, 0], [2.42, -11, 'outQuad'], [2.8, 4], [3.2, 0], [D, 0]]);
  set(tr, 'tail-3', 'r', [[0, 0], [L, 0], [2.14, 0], [2.36, -5, 'outQuad'], [2.74, 2], [3.1, 0], [D, 0]]);
  set(tr, 'bag', 'r', [[0, 0], [0.2, 2], [0.66, -6, 'inOutCubic'], [L, -3.2], [D, -3.2]]);
  // fx: the letter card pops out of the paw as the point lands, and jumps with each re-point tap
  const fx = tracksOf(), FL = 1.0;
  set(fx, CARD.id, 'o', [[0, 0], [0.5, 0], [0.58, 1, 'outQuad'], [D, 1]]);
  for (const ch of ['sx', 'sy']) set(fx, CARD.id, ch, [[0, 0.2], [0.5, 0.2], [0.86, 1, 'outBack'], [D, 1]]);
  set(fx, CARD.id, 'ty', [[0, 0], [FL, 0], [2.3, 0], [2.42, -6, 'outQuad'], [2.62, 0, 'inQuad'], [2.78, 0], [2.9, -5, 'outQuad'], [3.1, 0, 'inQuad'], [D, 0]]);
  states.hint = { duration: D, loop: true, loopStart: L, still: L, mouth: [[0, 'rest'], [0.5, 'EE']], mix: { tail: 0.8 }, tracks: tr, fx: { loopStart: FL, tracks: fx }, filmstrip: [0.1, 0.2, 0.34, 0.48, 0.62, 0.8, 1.0, 2.36, 2.66, 3.9, 4.12, 4.44] };
}

// 9. nohear: puzzled tilt, paw to the cheek, one brow up, lean in and a shrug with the other arm
{
  const tr = tracksOf(), L = 1.0, D = 5.0;
  set(tr, 'upper', 'r', [[0, 0], [0.15, -1.2, 'outQuad'], [0.62, 6, 'inOutCubic'], [0.9, 5], [L, 5], [3.0, 5.6], [D, 5]]);
  set(tr, 'head', 'r', [[0, 0], [0.18, -2, 'outQuad'], [0.7, 14.5, 'inOutCubic'], [0.95, 12.5], [L, 12.5], [3.0, 11], [D, 12.5]]);
  set(tr, 'head', 'ty', [[0, 0], [L, 0], [1.4, 0], [1.66, 2.6, 'outQuad'], [2.25, 0], [3.5, 0], [3.76, 2.2, 'outQuad'], [4.35, 0], [D, 0]]);
  set(tr, 'arm-r-upper', 'r', [[0, 0], [0.12, 6, 'outQuad'], [0.56, -123, 'inOutQuad'], [0.82, -117], [L, -117], [D, -117]]);
  set(tr, 'arm-r-upper', 'ty', [[0, 0], [L, 0], [1.4, 0], [1.66, -3, 'outQuad'], [2.25, 0], [3.5, 0], [3.76, -2.5, 'outQuad'], [4.35, 0], [D, 0]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [0.2, -10, 'outQuad'], [0.64, -56, 'inOutQuad'], [0.9, -48], [L, -48], [D, -48]]);
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.3, -3], [0.76, 27, 'inOutQuad'], [L, 23], [1.4, 23], [1.66, 29, 'outQuad'], [2.25, 23], [3.5, 23], [3.76, 28, 'outQuad'], [4.35, 23], [D, 23]]);
  set(tr, 'arm-l-upper', 'ty', [[0, 0], [L, 0], [1.4, 0], [1.66, -5, 'outQuad'], [2.25, 0], [3.5, 0], [3.76, -4, 'outQuad'], [4.35, 0], [D, 0]]);
  set(tr, 'arm-l-lower', 'r', [[0, 0], [0.38, 0], [0.86, 64, 'inOutQuad'], [L, 56], [1.4, 56], [1.7, 68, 'outQuad'], [2.3, 56], [3.5, 56], [3.8, 66, 'outQuad'], [4.4, 56], [D, 56]]);
  set(tr, 'brow-l', 'ty', [[0, 0], [0.3, 0], [0.6, -7, 'outBack'], [L, -6], [D, -6]]);
  set(tr, 'brow-l', 'r', [[0, 0], [0.3, 0], [0.6, -11, 'outBack'], [L, -9], [D, -9]]);
  set(tr, 'brow-r', 'ty', [[0, 0], [0.36, 0], [0.66, 1.5], [L, 1], [D, 1]]);
  set(tr, 'brow-r', 'r', [[0, 0], [0.36, 0], [0.66, 5], [L, 4], [D, 4]]);
  set(tr, 'ear-l', 'r', [[0, 0], [0.4, 0], [0.7, -9, 'outBack'], [L, -7], [D, -7]]);
  set(tr, 'ear-r', 'r', [[0, 0], [0.4, 0], [0.64, -7, 'outBack'], [L, -5], [D, -5]]);
  set(tr, 'bag', 'r', [[0, 0], [0.2, 1.5], [0.66, -6.5, 'inOutCubic'], [L, -3.8], [D, -3.8]]);
  set(tr, 'tail-4', 'r', [[0, 0], [L, -4], [D, -4]]);
  states.nohear = { duration: D, loop: true, loopStart: L, still: L, front: ['arm-r'], mouth: [[0, 'rest'], [0.5, 'OO']], mix: { tail: 0.6 }, tracks: tr, filmstrip: [0.1, 0.22, 0.36, 0.5, 0.64, 0.8, 1.0, 1.66, 2.25, 3.0, 3.76, 4.6] };
}

// 10. bye: slower wave, tail tip waves along, small bow with happy eyes, settle
{
  const tr = tracksOf(), D = 4.0;
  set(tr, 'upper', 'r', [[0, 0], [0.2, 1], [0.8, -2, 'inOutCubic'], [2.6, -1.5], [3.0, 0, 'inOutCubic']]);
  set(tr, 'head', 'r', [[0, 0], [0.24, 1.5], [0.9, -7.5, 'inOutCubic'], [1.6, -6], [2.3, -7], [2.95, 0, 'inOutCubic'], [D, 0]]);
  set(tr, 'arm-r-upper', 'r', [[0, 0], [0.2, 7, 'outQuad'], [0.78, -103, 'inOutQuad'], [1.05, -97], [1.4, -102], [1.75, -96], [2.1, -101], [2.45, -97], [3.15, 4, 'inOutQuad'], [3.45, -1.2], [3.7, 0]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [0.26, 5, 'outQuad'], [0.88, -60, 'inOutQuad'], [1.22, -30], [1.57, -70], [1.92, -34], [2.27, -64], [2.6, -46], [3.24, 10, 'inOutQuad'], [3.52, -3], [3.78, 0]]);
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.8, 6], [2.6, 5], [3.3, 0]]);
  // bow
  set(tr, 'head', 'ty', [[0, 0], [2.55, 0], [2.95, 7, 'inOutCubic'], [3.3, 7], [3.72, -1, 'inOutCubic'], [D, 0]]);
  set(tr, 'shekru', 'sy', [[0, 1], [2.5, 1], [2.9, 0.965, 'inOutCubic'], [3.28, 0.965], [3.66, 1.01, 'inOutCubic'], [3.9, 1]]);
  set(tr, 'shekru', 'sx', [[0, 1], [2.5, 1], [2.9, 1.02, 'inOutCubic'], [3.28, 1.02], [3.66, 0.996, 'inOutCubic'], [3.9, 1]]);
  for (const [e, s] of [['ear-l', -1], ['ear-r', 1]]) set(tr, e, 'r', [[0, 0], [2.6, 0], [3.0, -6 * s], [3.34, 2 * s], [3.74, 7 * s, 'inOutCubic'], [D, 0]]);
  happy(tr, 2.72, 3.42);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.5, 0], [0.85, -3.5, 'outBack'], [2.5, -3], [2.9, 0]]);
  set(tr, 'tail-3', 'r', [[0, 0], [0.9, 0], [1.3, -8], [1.65, 4], [2.0, -7], [2.35, 3], [2.9, 0]]);
  set(tr, 'tail-4', 'r', [[0, 0], [1.0, 0], [1.4, -13], [1.75, 7], [2.1, -11], [2.45, 5], [3.0, 0]]);
  set(tr, 'bag', 'r', [[0, 0], [0.8, -2.5], [1.3, 0.8], [2.9, 0], [3.3, 1.5], [3.8, 0]]);
  states.bye = { duration: D, loop: false, next: 'idle', still: 1.2, mouth: [[0, 'rest'], [0.7, 'EE'], [2.5, 'rest']], mix: { tail: 0.4 }, tracks: tr,
    filmstrip: [0.2, 0.5, 0.8, 1.22, 1.57, 1.92, 2.27, 2.7, 2.95, 3.3, 3.6, 3.95] };
}

// ---------------------------------------------------------------- validate + write
function validate() {
  const errs = [];
  const check = (where, tracks, maxT) => {
    for (const p in tracks) for (const ch in tracks[p]) {
      const keys = tracks[p][ch];
      for (let i = 0; i < keys.length; i++) {
        if (i && keys[i][0] <= keys[i - 1][0]) errs.push(`${where} ${p}.${ch}: key ${i} not after previous (${keys[i - 1][0]} -> ${keys[i][0]})`);
        if (keys[i][0] > maxT + 1e-9) errs.push(`${where} ${p}.${ch}: key at ${keys[i][0]} beyond ${maxT}`);
      }
    }
  };
  for (const [name, s] of Object.entries(states)) {
    check(name, s.tracks, s.duration);
    if (s.fx) {
      check(name + '.fx', s.fx.tracks, s.duration);
      const a = s.fx.loopStart ?? s.loopStart ?? 0;
      for (const p in s.fx.tracks) {
        if (!fxParts[p]) errs.push(`${name}.fx ${p}: not an fx part`);
        for (const ch in s.fx.tracks[p]) {
          const d = Math.abs(evalKeys(s.fx.tracks[p][ch], a) - evalKeys(s.fx.tracks[p][ch], s.duration));
          if (d > 1e-3) errs.push(`${name}.fx ${p}.${ch}: loop seam mismatch ${d}`);
        }
      }
    }
    if (s.loop) {
      const a = s.loopStart || 0;
      for (const p in s.tracks) for (const ch in s.tracks[p]) {
        const d = Math.abs(evalKeys(s.tracks[p][ch], a) - evalKeys(s.tracks[p][ch], s.duration));
        if (d > 1e-6) errs.push(`${name} ${p}.${ch}: loop seam mismatch ${d}`);
      }
    }
  }
  for (const l of base.loops) {
    check('base.' + l.name, l.tracks, l.period);
    for (const p in l.tracks) for (const ch in l.tracks[p]) {
      const k = l.tracks[p][ch];
      if (k[0][1] !== k[k.length - 1][1] || k[0][0] !== 0 || k[k.length - 1][0] !== l.period) errs.push(`base.${l.name} ${p}.${ch}: loop seam`);
    }
  }
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
}
validate();

const out = {
  $schema_notes: SCHEMA_NOTES,
  version: 1,
  character: 'shekru',
  initial: 'idle',
  transition: { duration: 0.28, easing: 'inOutCubic', poseToPose: 0.42, poseEasing: 'inOutSine', posedAngle: 25 },
  groups: { upper: { pivot: [148.8, 420], members: ['tail', 'body', 'bag', 'arm-l', 'arm-r', 'head'] } },
  rest: { 'eye-l-eyelid': { v: 0 }, 'eye-r-eyelid': { v: 0 }, 'eyes-happy': { v: 0 }, ...fxRest },
  fx: { asset: 'shekru-fx.svg', parts: fxParts },
  base,
  speech,
  states,
};
// compact JSON: one line per track
const json = JSON.stringify(out, null, 1).replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)(?:,\n\s+("[a-zA-Z]+"))?\n\s+\]/g, (_, a, b, c) => `[${a}, ${b}${c ? ', ' + c : ''}]`)
  .replace(/\[\n\s+((?:\[[^\]\n]+\],?\n?\s*)+)\]/g, (_, inner) => '[' + inner.replace(/\n\s*/g, ' ').trim() + ']');
JSON.parse(json);
fs.writeFileSync(path.join(here, '../shekru.anim.json'), json + '\n');
fs.writeFileSync(path.join(here, '../shekru-fx.svg'), FX_SVG);
// keep the folder self-contained: copies of the art and rig (source of truth stays in ../svg)
for (const f of ['shekru.svg', 'shekru.rig.json']) fs.copyFileSync(path.join(here, '../../svg', f), path.join(here, '..', f));
console.log('wrote shekru.anim.json', (json.length / 1024).toFixed(1) + ' kB', Object.keys(states).join(' '));
