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
// surprises: colours are design/foundations/tokens.json color.child values, named after their token.
// Copied, not read: this script must run from a copy of anim/ and svg/ alone.
// brand maroon is FX_INK.
const TOK = { primary: '#ED9950', success: '#2E7D4F', tryAgain: '#FFE7A3', onTryAgain: '#6B4700', trailStop: '#B08B66' };
// sneeze: a puff and four droplets burst from the nose
const SNEEZE = { puff: 'fx-sneeze-puff', c: [155, 286], lobes: [[-19, 3, 15], [0, -9, 17], [19, 3, 15], [0, 11, 15]], line: 3,
  drops: ['fx-sneeze-drop-1', 'fx-sneeze-drop-2', 'fx-sneeze-drop-3', 'fx-sneeze-drop-4'], dropR: 5.5, fly: [[-84, -4], [-62, 44], [62, 44], [84, -4]] };
// dropnut: an acorn, drawn at the grip point of the resting screen-left paw (arm-l-lower space)
const NUT = { id: 'fx-nut', c: [88, 404], rx: 19, ry: 21, shell: TOK.trailStop, cap: TOK.onTryAgain, shine: TOK.tryAgain, line: 3 };
// dance: two music notes float up above the head
const NOTES = [{ id: 'fx-note-1', c: [50, 104], fill: FX_INK }, { id: 'fx-note-2', c: [196, 84], fill: FX_GREEN }];
// celebrate: confetti bursts above the head and drifts down either side of the face.
// piece = [dx, rise, fall, delay, spin]; |dx| stays wide so nothing crosses the face on the way down
const CONFETTI = {
  at: [148.8, 112], colors: [TOK.primary, TOK.success, FX_INK, TOK.tryAgain],
  pieces: [[-112, 62, 150, 0, 300], [104, 78, 170, 0.02, -260], [-132, 44, 190, 0.04, -340], [150, 56, 200, 0.03, 380], [-120, 88, 120, 0.06, 220], [126, 92, 130, 0.07, -300], [-146, 70, 210, 0.09, 420], [172, 34, 180, 0.08, -220],
    [-110, 80, 180, 0.32, -280], [112, 60, 190, 0.34, 320], [-138, 58, 140, 0.36, 260], [158, 76, 160, 0.38, -360], [-124, 96, 200, 0.4, 340], [138, 98, 150, 0.42, 240]],
};
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
  // sneeze
  fxParts[SNEEZE.puff] = { pivot: SNEEZE.c }; fxRest[SNEEZE.puff] = { o: 0 };
  L.push(`    <g id="${SNEEZE.puff}">`);
  for (const pad of [SNEEZE.line, 0]) for (const [dx, dy, pr] of SNEEZE.lobes) L.push(`      <circle cx="${n2(SNEEZE.c[0] + dx)}" cy="${n2(SNEEZE.c[1] + dy)}" r="${pr + pad}" fill="${pad ? FX_INK : FX_WHITE}"/>`);
  L.push('    </g>');
  for (const id of SNEEZE.drops) {
    fxParts[id] = { pivot: SNEEZE.c }; fxRest[id] = { o: 0 };
    L.push(`    <g id="${id}">`, `      <circle cx="${SNEEZE.c[0]}" cy="${SNEEZE.c[1]}" r="${SNEEZE.dropR + 2.4}" fill="${FX_INK}"/>`, `      <circle cx="${SNEEZE.c[0]}" cy="${SNEEZE.c[1]}" r="${SNEEZE.dropR}" fill="${FX_WHITE}"/>`, '    </g>');
  }
  // nut: shell, cap, stalk, shine
  {
    const [cx, cy] = NUT.c, { rx, ry } = NUT, capY = n2(cy - ry * 0.45), cw = rx + 3;
    fxParts[NUT.id] = { pivot: NUT.c }; fxRest[NUT.id] = { o: 0 };
    L.push(`    <g id="${NUT.id}">`,
      `      <path d="M ${cx + 1} ${n2(cy - ry - 4)} Q ${cx + 2} ${n2(cy - ry - 9)} ${cx + 6} ${n2(cy - ry - 11)}" fill="none" stroke="${FX_INK}" stroke-width="4.5" stroke-linecap="round"/>`,
      `      <path d="M ${cx - rx} ${capY} C ${cx - rx} ${n2(cy + ry * 0.55)} ${cx - rx * 0.45} ${cy + ry} ${cx} ${n2(cy + ry + 2)} C ${n2(cx + rx * 0.45)} ${cy + ry} ${cx + rx} ${n2(cy + ry * 0.55)} ${cx + rx} ${capY} Z" fill="${NUT.shell}" stroke="${FX_INK}" stroke-width="${NUT.line}" stroke-linejoin="round"/>`,
      `      <ellipse cx="${n2(cx - rx * 0.42)}" cy="${n2(cy + ry * 0.22)}" rx="3.5" ry="6.5" fill="${NUT.shine}"/>`,
      `      <path d="M ${cx - cw} ${n2(capY + 2)} C ${cx - cw} ${n2(cy - ry - 3)} ${cx - cw * 0.5} ${n2(cy - ry - 5)} ${cx} ${n2(cy - ry - 5)} C ${n2(cx + cw * 0.5)} ${n2(cy - ry - 5)} ${cx + cw} ${n2(cy - ry - 3)} ${cx + cw} ${n2(capY + 2)} Q ${cx} ${n2(capY + 7)} ${cx - cw} ${n2(capY + 2)} Z" fill="${NUT.cap}" stroke="${FX_INK}" stroke-width="${NUT.line}" stroke-linejoin="round"/>`,
      '    </g>');
  }
  // music notes: a quaver and a beamed pair
  NOTES.forEach(({ id, c: [x, y], fill }, i) => {
    fxParts[id] = { pivot: [x, y] }; fxRest[id] = { o: 0 };
    const head = (hx, hy) => `      <ellipse cx="${hx}" cy="${hy}" rx="8.5" ry="6.5" fill="${fill}"/>`;
    const line = (d) => `      <path d="${d}" fill="none" stroke="${fill}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    L.push(`    <g id="${id}">`);
    if (i === 0) L.push(head(x - 4, y + 13), line(`M ${x + 3} ${y + 12} V ${y - 15} Q ${x + 14} ${y - 11} ${x + 13} ${y - 1}`));
    else L.push(head(x - 12, y + 15), head(x + 10, y + 10), line(`M ${x - 5} ${y + 14} V ${y - 11} L ${x + 17} ${y - 16} V ${y + 9}`));
    L.push('    </g>');
  });
  // confetti: strips and dots
  CONFETTI.pieces.forEach((_, i) => {
    const id = `fx-confetti-${i + 1}`, [x, y] = CONFETTI.at, fill = CONFETTI.colors[i % CONFETTI.colors.length];
    fxParts[id] = { pivot: CONFETTI.at }; fxRest[id] = { o: 0 };
    L.push(`    <g id="${id}">`, i % 3 === 2 ? `      <circle cx="${x}" cy="${y}" r="8.5" fill="${fill}"/>` : `      <path d="M ${x - 12} ${y - 6.5} H ${x + 12} V ${y + 6.5} H ${x - 12} Z" fill="${fill}"/>`, '    </g>');
  });
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

// one-shot fx: put a channel back at its hidden rest value at D (validate() checks the seam on one-shots too)
const home = (keys, D) => (keys[keys.length - 1][1] === keys[0][1] ? keys : [...keys, [D, keys[0][1], 'step']]);
// A held prop: fx shapes are not parented to a limb, so the prop is keyed to where the paw is on stage.
const RIG = JSON.parse(fs.readFileSync(path.join(here, '../../svg/shekru.rig.json'), 'utf8')).parts;
const UPPER_PIVOT = [148.8, 420];
// stage position at time t of a point given in arm-<side>-lower space (state tracks only, base layers ignored)
function pawAt(tr, side, t, point) {
  let [x, y] = point;
  for (const [id, pivot] of [[`arm-${side}-lower`], [`arm-${side}-upper`], ['upper', UPPER_PIVOT], ['shekru']]) {
    const k = tr[id] || {}, v = (ch, d) => (k[ch] ? evalKeys(k[ch], t) : d), [px, py] = pivot || RIG[id].pivot;
    const a = (v('r', 0) * Math.PI) / 180, dx = (x - px) * v('sx', 1), dy = (y - py) * v('sy', 1);
    [x, y] = [px + v('tx', 0) + dx * Math.cos(a) - dy * Math.sin(a), py + v('ty', 0) + dx * Math.sin(a) + dy * Math.cos(a)];
  }
  return [x, y];
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

// 11. sneeze: nose tickle, two rising "ah"s as the eyes squeeze shut, a whole-body "choo" that pops him off his feet, dazed head shake
{
  const tr = tracksOf(), D = 2.6, A1 = 0.5, A2 = 1.08, C = 1.2, HIT = 1.3;
  set(tr, 'nose', 'sx', [[0, 1], [0.07, 1.2], [0.14, 0.88], [0.21, 1.18], [0.28, 0.9], [0.36, 1.12], [A1, 1], [C, 1], [HIT, 1.3, 'outQuad'], [1.5, 1], [1.84, 1], [1.91, 1.16], [1.98, 0.9], [2.05, 1.12], [2.14, 1]]);
  set(tr, 'nose', 'sy', [[0, 1], [0.07, 0.88], [0.14, 1.14], [0.21, 0.9], [0.28, 1.12], [0.36, 0.94], [A1, 1], [1.84, 1], [1.91, 0.9], [1.98, 1.1], [2.05, 0.94], [2.14, 1]]);
  set(tr, 'nose', 'tx', [[0, 0], [0.07, -1.6], [0.14, 1.6], [0.21, -1.6], [0.28, 1.4], [0.36, 0]]);
  set(tr, 'shekru', 'sy', [[0, 1], [0.3, 1], [A1, 1.03, 'outQuad'], [0.64, 1], [A2, 1.075, 'outCubic'], [C, 1.085], [HIT, 0.84, 'inCubic'], [1.44, 1.07, 'outQuad'], [1.62, 0.93, 'inQuad'], [1.78, 1.025], [1.94, 1]]);
  set(tr, 'shekru', 'sx', [[0, 1], [0.3, 1], [A1, 0.985, 'outQuad'], [0.64, 1], [A2, 0.965, 'outCubic'], [C, 0.96], [HIT, 1.1, 'inCubic'], [1.44, 0.96, 'outQuad'], [1.62, 1.05, 'inQuad'], [1.78, 0.99], [1.94, 1]]);
  set(tr, 'shekru', 'ty', [[0, 0], [HIT + 0.02, 0], [1.46, -16, 'outQuad'], [1.6, 0, 'inQuad']]);
  set(tr, 'upper', 'r', [[0, 0], [0.3, 0], [A1, -1.5, 'outQuad'], [0.64, -0.5], [A2, -3.5, 'outCubic'], [C, -4], [HIT, 2, 'inCubic'], [1.5, -1], [1.7, 0]]);
  set(tr, 'head', 'ty', [[0, 0], [0.3, 0], [A1, -4, 'outQuad'], [0.64, -1], [A2, -9, 'outCubic'], [C, -10], [HIT, 14, 'inCubic'], [1.46, -3, 'outQuad'], [1.64, 2], [1.8, 0]]);
  set(tr, 'head', 'r', [[0, 0], [0.3, 0], [A1, -3, 'outQuad'], [0.64, -1], [A2, -6, 'outCubic'], [C, -7], [HIT, 3, 'inCubic'], [1.5, 0], [1.66, 0], [1.8, -6], [1.94, 5], [2.08, -3.5], [2.22, 2], [2.38, 0]]);
  for (const [s, k] of [['l', 1], ['r', -1]]) {
    // cross-eyed look down at the tickle; a little cross-eyed again while dazed
    setAll(tr, [`eye-${s}-pupil`, `eye-${s}-highlight`], 'tx', [[0, 0], [0.06, 0], [0.18, 4 * k, 'outCubic'], [0.38, 4 * k], [A1, 0], [1.66, 0], [1.76, 2.5 * k, 'outCubic'], [2.12, 2.5 * k], [2.3, 0]]);
    setAll(tr, [`eye-${s}-pupil`, `eye-${s}-highlight`], 'ty', [[0, 0], [0.06, 0], [0.18, 4, 'outCubic'], [0.38, 4], [A1, -2], [1.66, 1], [2.12, 1], [2.3, 0]]);
    // lids droop on each "ah", shut for the choo
    set(tr, `eye-${s}-eyelid`, 'v', [[0, 0], [0.4, 1, 'step'], [1.76, 0, 'step']]);
    set(tr, `eye-${s}-eyelid`, 'sy', [[0, 1], [0.4, 0.06, 'step'], [A1, 0.5, 'outQuad'], [0.64, 0.25], [0.9, 0.7], [A2, 1], [1.66, 1], [1.76, 0.06, 'outQuad'], [1.8, 1, 'step']]);
    for (const ch of ['sx', 'sy']) set(tr, `eye-${s}`, ch, [[0, 1], [1.66, 1], [1.8, 1.1, 'outBack'], [2.2, 1.06], [2.42, 1]]);
    // paws creep up toward the nose, then fling out
    set(tr, `arm-${s}-upper`, 'r', [[0, 0], [0.3, 0], [A1, 14 * k, 'outQuad'], [0.64, 9 * k], [A2, 30 * k, 'outCubic'], [C, 33 * k], [HIT, 52 * k, 'inCubic'], [1.5, 30 * k], [1.68, 10 * k], [1.9, -2 * k], [2.1, 0]]);
    set(tr, `arm-${s}-lower`, 'r', [[0, 0], [0.3, 0], [A1, -40 * k, 'outQuad'], [0.64, -28 * k], [A2, -95 * k, 'outCubic'], [C, -102 * k], [HIT + 0.02, 34 * k, 'inCubic'], [1.52, 12 * k], [1.72, -10 * k], [1.96, 3 * k], [2.16, 0]]);
    set(tr, `ear-${s}`, 'r', [[0, 0], [0.3, 0], [A1, -5 * k], [0.64, -2 * k], [A2, -11 * k, 'outCubic'], [C, -12 * k], [HIT, 16 * k, 'inCubic'], [1.46, -12 * k], [1.62, 7 * k], [1.78, -3 * k], [1.94, 0]]);
  }
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.1, -3, 'outQuad'], [0.36, -3], [A1, -5], [0.64, -3], [A2, -7, 'outCubic'], [C, -7], [HIT, 3, 'inCubic'], [1.66, 3], [1.8, -6, 'outBack'], [2.2, -4], [2.45, 0]]);
  set(tr, 'bag', 'r', [[0, 0], [C, 0], [HIT, 5], [1.48, -7], [1.68, 4], [1.9, -2], [2.1, 0]]);
  set(tr, 'bag', 'ty', [[0, 0], [HIT, 0], [1.46, -5], [1.62, 3], [1.8, 0]]);
  tail(tr, [[0, 0], [0.3, 0], [A1, -3], [0.64, -1], [A2, -5, 'outCubic'], [C, -5.5], [HIT, 6, 'inCubic'], [1.5, -6], [1.72, 3.5], [1.96, -2], [2.2, 0]], { delay: 0.06 });
  // fx: the puff swells and sinks away from the nose, droplets fly out to both sides
  const fx = tracksOf(), P = HIT - 0.04;
  set(fx, SNEEZE.puff, 'o', [[0, 0], [P, 0], [P + 0.03, 1, 'linear'], [P + 0.28, 1], [P + 0.58, 0]]);
  for (const ch of ['sx', 'sy']) set(fx, SNEEZE.puff, ch, home([[0, 0.4], [P, 0.4], [P + 0.16, 1.15, 'outCubic'], [P + 0.58, 1.45]], D));
  set(fx, SNEEZE.puff, 'ty', home([[0, 0], [P, 0], [P + 0.58, 24, 'outCubic']], D));
  SNEEZE.drops.forEach((id, i) => {
    const [dx, dy] = SNEEZE.fly[i], t0 = P + 0.02 * (i % 2);
    set(fx, id, 'o', [[0, 0], [t0, 0], [t0 + 0.04, 1, 'linear'], [t0 + 0.26, 1], [t0 + 0.44, 0]]);
    set(fx, id, 'tx', home([[0, 0], [t0, 0], [t0 + 0.44, dx, 'outCubic']], D));
    set(fx, id, 'ty', home([[0, 0], [t0, 0], [t0 + 0.44, dy, 'outQuad']], D));
  });
  states.sneeze = { duration: D, loop: false, next: 'idle', still: 1.36, tracks: tr, fx: { still: 1.36, tracks: fx }, mix: { tail: 0.3, speech: 0.5, breath: 0.5 },
    mouth: [[0, 'rest'], [0.3, 'AA'], [0.62, 'MBP'], [0.72, 'AA'], [C, 'OO'], [1.5, 'O'], [1.76, 'rest'], [2.3, 'EE'], [2.5, 'rest']],
    filmstrip: [0.1, 0.24, 0.5, 0.64, 0.9, 1.1, 1.26, 1.32, 1.46, 1.64, 1.8, 2.3] };
}

// 12. dropnut: holds a nut up proudly beside his face, it slips and bounces on the ground, he gapes, bends to pick it up,
//     hugs it in relief and tucks it into the bag. The nut is fx, keyed to the screen-left paw while he holds it.
{
  const tr = tracksOf(), D = 3.9;
  const UP = 0.55, SLIP = 1.05, GROUND = 1.5, REST = 1.95, GRAB = 2.38, HUG = 2.86, TUCK = 3.2, IN = 3.5;
  const GU = 11, GL = 8; // arm angles that put the paw on the fallen nut
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.12, -6, 'outQuad'], [UP, 104, 'inOutQuad'], [0.74, 96], [SLIP, 96], [SLIP + 0.08, 106, 'outQuad'], [SLIP + 0.28, 98], [REST - 0.15, 98], [GRAB, GU, 'inOutQuad'], [GRAB + 0.1, GU], [HUG, 15, 'inOutQuad'], [TUCK, 15], [TUCK + 0.2, -22, 'inOutQuad'], [IN, -22], [D - 0.08, 0, 'inOutQuad']]);
  set(tr, 'arm-l-lower', 'r', [[0, 0], [0.08, -8, 'outQuad'], [0.38, 92, 'inOutQuad'], [UP + 0.03, 60], [0.74, 52], [0.86, 60], [0.96, 52], [SLIP, 52], [SLIP + 0.07, 26, 'outQuad'], [SLIP + 0.2, 66], [SLIP + 0.36, 56], [REST - 0.15, 56], [GRAB, GL, 'inOutQuad'], [GRAB + 0.1, GL], [HUG, -125, 'inOutQuad'], [HUG + 0.14, -118], [TUCK, -120], [TUCK + 0.2, -48, 'inOutQuad'], [IN, -48], [IN + 0.08, -40], [D - 0.05, 0, 'inOutQuad']]);
  set(tr, 'arm-r-upper', 'r', [[0, 0], [UP, -8], [SLIP, -6], [SLIP + 0.1, -30, 'outQuad'], [GROUND, -18], [REST, -12], [GRAB, -34, 'inOutQuad'], [HUG, -15, 'inOutQuad'], [TUCK, -15], [TUCK + 0.22, 4, 'inOutQuad'], [IN, 4], [D - 0.1, 0]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [SLIP, 0], [SLIP + 0.1, -25, 'outQuad'], [REST, -10], [GRAB, -20], [HUG, 112, 'inOutQuad'], [TUCK, 112], [TUCK + 0.24, 38, 'inOutQuad'], [IN, 38], [D - 0.08, 0]]);
  set(tr, 'upper', 'r', [[0, 0], [0.14, 1, 'outQuad'], [UP, -2.5, 'inOutCubic'], [SLIP, -2], [SLIP + 0.12, 1.5, 'outQuad'], [GROUND, -3], [REST, -4], [GRAB, -11, 'inOutCubic'], [GRAB + 0.1, -11], [HUG, 2, 'inOutCubic'], [HUG + 0.2, 0]]);
  set(tr, 'upper', 'ty', [[0, 0], [REST, 0], [GRAB, 10, 'inOutCubic'], [GRAB + 0.1, 10], [HUG - 0.1, 0, 'inOutCubic']]);
  set(tr, 'shekru', 'sy', [[0, 1], [SLIP, 1], [SLIP + 0.1, 1.05, 'outQuad'], [SLIP + 0.3, 1], [REST, 1], [GRAB, 0.87, 'inOutCubic'], [GRAB + 0.1, 0.87], [HUG - 0.1, 1.03, 'inOutCubic'], [HUG + 0.12, 0.985], [HUG + 0.3, 1], [IN, 1], [IN + 0.1, 0.98], [IN + 0.25, 1]]);
  set(tr, 'shekru', 'sx', [[0, 1], [SLIP, 1], [SLIP + 0.1, 0.975, 'outQuad'], [SLIP + 0.3, 1], [REST, 1], [GRAB, 1.05, 'inOutCubic'], [GRAB + 0.1, 1.05], [HUG - 0.1, 0.985, 'inOutCubic'], [HUG + 0.12, 1.008], [HUG + 0.3, 1]]);
  set(tr, 'head', 'r', [[0, 0], [0.16, 2], [UP, -7, 'inOutCubic'], [SLIP, -6], [SLIP + 0.12, -2, 'outQuad'], [GROUND, -9, 'inOutQuad'], [REST, -10], [GRAB, -6], [HUG, 5, 'inOutCubic'], [TUCK, 4], [IN, 6], [D - 0.1, 0]]);
  set(tr, 'head', 'ty', [[0, 0], [SLIP, 0], [SLIP + 0.1, -4, 'outQuad'], [GROUND, 5, 'inOutQuad'], [GRAB, 7], [HUG, 0, 'inOutCubic'], [TUCK, 0], [IN, 3], [IN + 0.25, 0]]);
  gaze(tr,
    [[0, 0], [0.3, 0], [0.46, -4.5, 'outCubic'], [SLIP, -4.5], [GROUND, -4, 'linear'], [GRAB, -3.5], [HUG - 0.1, -1], [TUCK, 0], [TUCK + 0.14, 2.5, 'outCubic'], [IN + 0.1, 2.5], [IN + 0.3, 0]],
    [[0, 0], [0.3, 0], [0.46, -1.5, 'outCubic'], [SLIP, -1.5], [SLIP + 0.1, -3, 'outQuad'], [GROUND, 4.5, 'inQuad'], [GRAB, 4.5], [HUG - 0.1, 3], [TUCK, 0], [TUCK + 0.14, 4, 'outCubic'], [IN + 0.1, 4], [IN + 0.3, 0]]);
  happy(tr, HUG - 0.06, TUCK);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.3, 0], [UP, -4.5, 'outBack'], [SLIP, -3.5], [SLIP + 0.1, -7.5, 'outQuad'], [REST, -6], [GRAB, -2], [HUG, -4, 'outBack'], [IN, -3], [IN + 0.3, 0]]);
  for (const [s, k] of [['l', 1], ['r', -1]]) {
    for (const ch of ['sx', 'sy']) set(tr, `eye-${s}`, ch, [[0, 1], [SLIP, 1], [SLIP + 0.1, 1.12, 'outBack'], [REST, 1.08], [GRAB, 1]]);
    set(tr, `ear-${s}`, 'r', [[0, 0], [SLIP, 0], [SLIP + 0.1, 11 * k, 'outQuad'], [REST, 7 * k], [GRAB, -8 * k], [HUG, 4 * k], [HUG + 0.25, 0]]);
  }
  set(tr, 'bag', 'r', [[0, 0], [REST, 0], [GRAB, 7, 'inOutCubic'], [HUG, -3], [HUG + 0.25, 0], [IN, 0], [IN + 0.07, 5, 'outQuad'], [IN + 0.2, -3], [IN + 0.34, 0]]);
  tail(tr, [[0, 0], [SLIP, 0], [SLIP + 0.12, -6, 'outQuad'], [GROUND, 3], [REST, 0], [GRAB, 9, 'inOutCubic'], [HUG, -4, 'inOutCubic'], [HUG + 0.3, 2], [TUCK + 0.2, 0]]);

  // fx: the nut. Held = sampled from the paw; free = hand keys (pop up, fall, two bounces, lie on its side)
  const fx = tracksOf(), N = NUT.id, off = (x, y) => [n2(x - NUT.c[0]), n2(y - NUT.c[1])];
  const BAG = off(174, 384), LIE = off(52, 430), nx = [[0, BAG[0]]], ny = [[0, BAG[1]]];
  const hold = (t0, t1) => {
    const n = Math.ceil((t1 - t0) * 30);
    for (let i = 0; i <= n; i++) {
      const t = +(t0 + ((t1 - t0) * i) / n).toFixed(3), [x, y] = off(...pawAt(tr, 'l', t, NUT.c));
      nx.push([t, x, 'linear']); ny.push([t, y, 'linear']);
    }
  };
  hold(0.26, SLIP);
  const [x0, y0] = [nx[nx.length - 1][1], ny[ny.length - 1][1]];
  nx.push([SLIP + 0.1, x0 - 2, 'outQuad'], [GROUND, LIE[0] + 10, 'linear'], [1.78, LIE[0] + 3, 'linear'], [1.92, LIE[0], 'linear'], [GRAB - 0.06, LIE[0]]);
  ny.push([SLIP + 0.1, y0 - 12, 'outQuad'], [GROUND, LIE[1], 'inQuad'], [1.64, LIE[1] - 30, 'outQuad'], [1.78, LIE[1], 'inQuad'], [1.85, LIE[1] - 9, 'outQuad'], [1.92, LIE[1], 'inQuad'], [GRAB - 0.06, LIE[1]]);
  hold(GRAB, TUCK + 0.2);
  nx.push([IN, BAG[0]]); ny.push([IN, BAG[1]]);
  set(fx, N, 'tx', nx); set(fx, N, 'ty', ny);
  set(fx, N, 'r', home([[0, -8], [SLIP, -8], [SLIP + 0.1, -30, 'outQuad'], [GROUND, 70, 'linear'], [1.78, 96, 'linear'], [1.92, 90], [GRAB, 90], [HUG, -6, 'inOutQuad'], [TUCK, -6], [IN, 20]], D));
  set(fx, N, 'o', [[0, 0], [0.26, 0], [0.32, 1, 'linear'], [TUCK + 0.22, 1], [IN, 0]]);
  for (const ch of ['sx', 'sy']) set(fx, N, ch, home([[0, 0.2], [0.26, 0.2], [0.5, 1, 'outBack'], [TUCK + 0.2, 1], [IN, 0.4, 'inQuad']], D));
  states.dropnut = { duration: D, loop: false, next: 'idle', still: 0.9, tracks: tr, fx: { still: 0.9, tracks: fx }, mix: { tail: 0.4, speech: 0.5, breath: 0.3 },
    mouth: [[0, 'rest'], [0.4, 'EE'], [SLIP, 'O'], [GRAB + 0.1, 'MBP'], [HUG - 0.06, 'AA'], [TUCK, 'EE'], [IN + 0.25, 'rest']],
    filmstrip: [0.3, 0.6, 0.95, 1.14, 1.3, 1.5, 1.64, 1.95, 2.38, 2.6, 2.95, 3.4] };
}

// 13. dance: four swaying disco points, the far arm up and the far foot kicking out, three quick hops with pumping fists, a ta-da pose; notes float up
{
  const tr = tracksOf(), D = 3.6, B = [0.3, 0.7, 1.1, 1.5], H = [1.92, 2.22, 2.52], TA = 2.84, END = 3.2;
  const side = (i) => (i % 2 ? 1 : -1); // even beats lean to screen-left
  const sway = (amp) => [[0, 0], ...B.flatMap((t, i) => [[t, amp * side(i), 'inOutQuad'], [t + 0.2, amp * side(i) * 0.85]])];
  set(tr, 'upper', 'r', [...sway(6), [1.76, 0], ...H.map((t, i) => [t, -3 * side(i)]), [TA, 5, 'outBack'], [END, 4], [D - 0.08, 0, 'inOutCubic']]);
  set(tr, 'upper', 'tx', [...sway(7), [1.76, 0], [TA, 3], [END, 3], [D - 0.08, 0]]);
  set(tr, 'head', 'r', [...lag(sway(7), 0.05), [1.82, 0], ...H.map((t, i) => [t + 0.03, 4 * side(i)]), [TA + 0.04, 8, 'outBack'], [END, 7], [D - 0.05, 0]]);
  // bounce on every beat, hop on every H
  const sy = [[0, 1]], sx = [[0, 1]], hy = [[0, 0]];
  for (const t of B) { sy.push([t - 0.14, 1.035], [t, 0.94, 'outQuad']); sx.push([t - 0.14, 0.975], [t, 1.045, 'outQuad']); hy.push([t - 0.14, -2.5], [t, 4, 'outQuad']); }
  sy.push([1.66, 1.03], [1.79, 0.93, 'outQuad']); sx.push([1.66, 0.98], [1.79, 1.05, 'outQuad']); hy.push([1.66, -2], [1.79, 4, 'outQuad']);
  const ty = [[0, 0], [1.8, 0]];
  H.forEach((t, i) => {
    const last = i === H.length - 1;
    ty.push([t, last ? -24 : -18, 'outQuad'], [t + 0.15, 0, 'inQuad']);
    sy.push([t, 1.05, 'outQuad'], [t + 0.15, last ? 0.9 : 0.93, 'inQuad']); sx.push([t, 0.97, 'outQuad'], [t + 0.15, last ? 1.07 : 1.05, 'inQuad']);
    hy.push([t, -3], [t + 0.15, 5]);
  });
  sy.push([TA, 1.05, 'outQuad'], [TA + 0.18, 0.99], [END, 1]); sx.push([TA, 0.97, 'outQuad'], [TA + 0.18, 1.005], [END, 1]); hy.push([TA, -3, 'outQuad'], [END, -2], [D - 0.1, 0]);
  set(tr, 'shekru', 'sy', sy); set(tr, 'shekru', 'sx', sx); set(tr, 'shekru', 'ty', ty); set(tr, 'head', 'ty', hy);
  for (const [s, k] of [['l', 1], ['r', -1]]) {
    const u = [[0, 0]], l = [[0, 0]], leg = [[0, 0]], ear = [[0, 0]];
    B.forEach((t, i) => {
      const point = side(i) === k; // the arm away from the lean points up and that foot kicks out; the other paw goes to the hip
      u.push([t, (point ? 112 : 27) * k, 'inOutQuad'], [t + 0.2, (point ? 105 : 24) * k]);
      l.push([t + 0.03, (point ? 18 : -52) * k, 'inOutQuad'], [t + 0.2, (point ? 4 : -48) * k]);
      if (point) leg.push([t - 0.1, 0], [t, 15 * k, 'outQuad'], [t + 0.2, 13 * k], [t + 0.3, 0]);
      ear.push([t - 0.14, 3 * k], [t, -7 * k, 'outQuad']);
    });
    u.push([1.78, 15 * k]); l.push([1.78, -70 * k]); ear.push([1.66, 3 * k], [1.79, -7 * k, 'outQuad']);
    H.forEach((t, i) => {
      const fwd = side(i) === -k;
      u.push([t, (fwd ? 48 : 8) * k, 'outQuad']); l.push([t, (fwd ? -125 : -80) * k, 'outQuad']);
      leg.push([t - 0.08, 0], [t, (fwd ? 16 : 5) * k, 'outQuad'], [t + 0.15, 0, 'inQuad']);
      ear.push([t, 4 * k], [t + 0.15, -9 * k, 'outQuad']);
    });
    u.push([TA, (k > 0 ? 122 : -96), 'outBack'], [END, (k > 0 ? 116 : -92)], [D - 0.06, 0, 'inOutQuad']);
    l.push([TA + 0.04, 22 * k, 'outBack'], [END, 14 * k], [D - 0.02, 0, 'inOutQuad']);
    if (k > 0) leg.push([TA, 18, 'outBack'], [END, 16], [D - 0.1, 0]);
    ear.push([TA, 5 * k], [TA + 0.2, -3 * k], [TA + 0.4, 0]);
    set(tr, `arm-${s}-upper`, 'r', u); set(tr, `arm-${s}-lower`, 'r', l); set(tr, `leg-${s}`, 'r', leg); set(tr, `ear-${s}`, 'r', ear);
  }
  happy(tr, 0.3, END + 0.05);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.14, 1], [0.3, -4.5, 'outBack'], [END, -3.5], [END + 0.3, 0]]);
  set(tr, 'bag', 'r', [[0, 0], ...B.map((t, i) => [t + 0.06, -5 * side(i)]), ...H.flatMap((t) => [[t, 3], [t + 0.15, -5]]), [TA + 0.05, -5], [END, -1], [D - 0.2, 0]]);
  set(tr, 'bag', 'ty', [[0, 0], [1.8, 0], ...H.flatMap((t) => [[t, -4], [t + 0.15, 3]]), [TA, 0]]);
  tail(tr, [[0, 0], ...B.map((t, i) => [t, -8 * side(i)]), ...H.flatMap((t) => [[t, 6], [t + 0.15, -6]]), [TA + 0.1, 9], [END, 3], [D - 0.3, 0]], { delay: 0.07, maxT: D });
  // fx: each note pops in, floats up with a sway and fades, twice
  const fx = tracksOf();
  NOTES.forEach(({ id }, i) => {
    const d = i ? 1 : -1, o = [[0, 0]], s = [[0, 0.4]], x = [[0, 0]], y = [[0, 0]], r = [[0, 0]];
    for (const t0 of i ? [0.7, 2.2] : [0.3, 1.9]) {
      const t1 = t0 + 1.25;
      o.push([t0, 0], [t0 + 0.08, 1, 'linear'], [t1 - 0.35, 1], [t1, 0, 'linear']);
      s.push([t0, 0.4, 'step'], [t0 + 0.25, 1, 'outBack'], [t1, 1]);
      y.push([t0, 0, 'step'], [t1, -44, 'outSine']);
      x.push([t0, 0, 'step'], [t0 + 0.4, 7 * d], [t0 + 0.8, -5 * d], [t1, 6 * d]);
      r.push([t0, -10 * d, 'step'], [t0 + 0.4, 10 * d], [t0 + 0.8, -8 * d], [t1, 8 * d]);
    }
    set(fx, id, 'o', o); for (const ch of ['sx', 'sy']) set(fx, id, ch, home(s, D)); set(fx, id, 'tx', home(x, D)); set(fx, id, 'ty', home(y, D)); set(fx, id, 'r', home(r, D));
  });
  states.dance = { duration: D, loop: false, next: 'idle', still: 2.95, tracks: tr, fx: { still: 2.95, tracks: fx }, mix: { tail: 0.3, speech: 0.5, breath: 0.5 },
    mouth: [[0, 'rest'], [0.26, 'EE'], [1.8, 'AA'], [2.7, 'EE'], [TA, 'AA'], [END + 0.1, 'EE'], [D - 0.15, 'rest']],
    filmstrip: [0.16, 0.3, 0.7, 1.1, 1.5, 1.79, 1.92, 2.22, 2.52, 2.67, 2.9, 3.4] };
}

// 14. celebrate: two hops, a fist punched up on each (screen-right, then screen-left), then both arms wave through a tiptoe shimmy
//     under a confetti burst. No crouch-and-one-jump, so it never reads as `correct`.
{
  const tr = tracksOf(), D = 3.3, H1 = 0.38, H2 = 0.92, V = 1.5, BURST = 1.44, S = [1.62, 1.86, 2.1, 2.34, 2.58], OUT = 2.76;
  const shimmy = (a, b = -a, dt = 0) => S.map((t, i) => [+(t + dt).toFixed(2), i % 2 ? b : a]);
  set(tr, 'shekru', 'ty', [[0, 0], [0.22, 0], [H1, -22, 'outQuad'], [0.54, 0, 'inQuad'], [0.76, 0], [H2, -22, 'outQuad'], [1.08, 0, 'inQuad']]);
  set(tr, 'shekru', 'sy', [[0, 1], [0.18, 0.9, 'outCubic'], [0.3, 1.07, 'inOutQuad'], [H1, 1], [0.52, 1.04, 'inQuad'], [0.62, 0.89, 'outQuad'], [0.72, 0.92], [0.84, 1.07, 'inOutQuad'], [H2, 1], [1.06, 1.04, 'inQuad'], [1.16, 0.87, 'outQuad'], [1.26, 0.9], [V, 1.08, 'outBack'], ...S.flatMap((t) => [[t, 1.035], [t + 0.12, 1.07]]), [OUT, 1.02], [2.96, 0.97], [3.14, 1]]);
  set(tr, 'shekru', 'sx', [[0, 1], [0.18, 1.06, 'outCubic'], [0.3, 0.96, 'inOutQuad'], [H1, 1], [0.52, 0.98, 'inQuad'], [0.62, 1.07, 'outQuad'], [0.72, 1.05], [0.84, 0.96, 'inOutQuad'], [H2, 1], [1.06, 0.98, 'inQuad'], [1.16, 1.08, 'outQuad'], [1.26, 1.06], [V, 0.96, 'outBack'], [OUT, 0.99], [2.96, 1.02], [3.14, 1]]);
  // screen-right fist first, then it pulls down to a flex as the screen-left fist goes up; in the shimmy the arms wave in turn.
  // Raised arms stay near 120 degrees and straight: any higher and the head hides them.
  set(tr, 'arm-r-upper', 'r', [[0, 0], [0.18, 14, 'outCubic'], [H1, -118, 'inOutQuad'], [0.56, -108], [0.72, -96], [H2, -32, 'inOutQuad'], [1.1, -38], [1.24, -20], [V, -112, 'outBack'], ...shimmy(-96, -126), [OUT, -112], [3.1, 3, 'inOutQuad'], [3.22, 0]]);
  set(tr, 'arm-r-lower', 'r', [[0, 0], [0.18, -110, 'outCubic'], [H1 + 0.02, -4, 'outCubic'], [0.56, -16], [0.74, -40], [H2, -118, 'inOutQuad'], [1.1, -108], [1.24, -125], [V + 0.03, -8, 'outBack'], ...shimmy(-26, 4), [OUT, -10], [3.12, 8, 'inOutQuad'], [3.24, 0]]);
  set(tr, 'arm-l-upper', 'r', [[0, 0], [0.18, -8, 'outCubic'], [H1, 24, 'inOutQuad'], [0.6, 20], [0.74, -10], [H2, 118, 'inOutQuad'], [1.1, 108], [1.24, 84], [V, 112, 'outBack'], ...shimmy(126, 96), [OUT, 112], [3.1, -3, 'inOutQuad'], [3.22, 0]]);
  set(tr, 'arm-l-lower', 'r', [[0, 0], [0.18, 20], [H1, 105, 'inOutQuad'], [0.6, 95], [0.74, 118], [H2 + 0.02, 4, 'outCubic'], [1.1, 16], [1.24, 40], [V + 0.03, 8, 'outBack'], ...shimmy(-4, 26), [OUT, 10], [3.12, -8, 'inOutQuad'], [3.24, 0]]);
  set(tr, 'upper', 'r', [[0, 0], [0.18, -2], [H1, 5, 'inOutQuad'], [0.6, 2], [0.74, 2], [H2, -5, 'inOutQuad'], [1.12, -2], [1.26, 0], [V, 0], ...shimmy(4), [2.82, 0, 'inOutCubic']]);
  set(tr, 'upper', 'tx', [[0, 0], [V, 0], ...shimmy(4), [2.82, 0]]);
  set(tr, 'head', 'r', [[0, 0], [0.18, -2], [H1, 6], [0.6, 3], [H2, -6], [1.14, -3], [1.3, 0], [V, 0], ...shimmy(-5, 5, 0.04), [2.88, 0]]);
  set(tr, 'head', 'ty', [[0, 0], [0.18, 5, 'outCubic'], [0.34, -3], [0.54, -1], [0.64, 7, 'outQuad'], [0.8, -3], [1.08, -1], [1.18, 8, 'outQuad'], [1.3, 4], [V, -5, 'outBack'], [OUT, -4], [2.96, 3], [3.14, 0]]);
  for (const [s, k] of [['l', 1], ['r', -1]]) {
    set(tr, `leg-${s}`, 'r', [[0, 0], [0.22, 0], [H1, 10 * k, 'outQuad'], [0.54, 0, 'inQuad'], [0.76, 0], [H2, 10 * k, 'outQuad'], [1.08, 0, 'inQuad']]);
    set(tr, `ear-${s}`, 'r', [[0, 0], [0.18, 6 * k, 'outCubic'], [H1, -12 * k], [0.56, 4 * k], [0.66, -14 * k, 'outQuad'], [0.8, 3 * k], [H2 + 0.02, -12 * k], [1.1, 4 * k], [1.2, -15 * k, 'outQuad'], [1.36, 5 * k], [V + 0.05, -6 * k], ...shimmy(5, -5, 0.08), [2.9, 0]]);
  }
  set(tr, 'bag', 'r', [[0, 0], [0.2, 2], [H1, -6], [0.58, 5], [0.7, -4], [H2, 6], [1.12, -6], [1.3, 2], ...shimmy(-4, 4, 0.06), [2.86, 0]]);
  set(tr, 'bag', 'ty', [[0, 0], [0.24, 0], [H1, -4], [0.58, 3], [0.76, 0], [H2, -4], [1.12, 3], [1.3, 0]]);
  setAll(tr, ['brow-l', 'brow-r'], 'ty', [[0, 0], [0.18, 2, 'outCubic'], [0.34, -6, 'outBack'], [2.66, -4.5], [3.05, 0]]);
  happy(tr, 0.26, 2.84);
  tail(tr, [[0, 0], [0.18, 4, 'outCubic'], [H1, 8], [0.6, -7], [H2, 8], [1.14, -8], [1.3, 3], ...shimmy(-9), [2.84, -4], [3.02, 0]], { delay: 0.07, maxT: D });
  // fx: two volleys of confetti shoot up from above the head, spread, tumble and drift down
  const fx = tracksOf();
  CONFETTI.pieces.forEach(([dx, rise, fall, delay, spin], i) => {
    const id = `fx-confetti-${i + 1}`, t0 = BURST + delay, ta = t0 + 0.3, te = Math.min(D - 0.05, t0 + 1.55);
    set(fx, id, 'o', [[0, 0], [t0, 0], [t0 + 0.04, 1, 'linear'], [te - 0.3, 1], [te, 0, 'linear']]);
    set(fx, id, 'tx', home([[0, 0], [t0, 0], [ta, dx * 0.72, 'outQuad'], [te, dx, 'outSine']], D));
    set(fx, id, 'ty', home([[0, 0], [t0, 0], [ta, -rise, 'outQuad'], [te, fall, 'inSine']], D));
    set(fx, id, 'r', home([[0, 0], [t0, 0], [te, spin, 'linear']], D));
    set(fx, id, 'sy', [[0, 1], [t0, 1], [ta, 0.5], [ta + 0.24, 1], [ta + 0.48, 0.5], [ta + 0.72, 1]]);
  });
  states.celebrate = { duration: D, loop: false, next: 'idle', still: 2.1, tracks: tr, fx: { still: 2.1, tracks: fx }, mix: { tail: 0.3, speech: 0.5, breath: 0.5 },
    mouth: [[0, 'rest'], [0.24, 'AA'], [2.8, 'EE'], [3.12, 'rest']],
    filmstrip: [0.18, 0.38, 0.62, 0.92, 1.16, 1.5, 1.62, 1.86, 2.1, 2.34, 2.7, 3.05] };
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
  groups: { upper: { pivot: UPPER_PIVOT, members: ['tail', 'body', 'bag', 'arm-l', 'arm-r', 'head'] } },
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
