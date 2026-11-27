// GURU-48: Shekru drawn with @shopify/react-native-skia instead of animated SVG groups.
//
// Contract pinned for /implement:
//   app/src/shekru/skiaArt.ts   pure module, no React:
//     DRAW_TREE: DrawNode[]     the whole drawing in draw order: a group bound to '@shadow' holding
//                               one { kind: 'shadow' } leaf, then artJson.character, then artJson.fx
//     DrawNode                  { kind: 'group'; part?: string; children: DrawNode[] }
//                               | { kind: 'path'; d: string; paints: Paint[] }
//                               | { kind: 'circle'; cx; cy; r: number; paints: Paint[] }
//                               | { kind: 'ellipse'; cx; cy; rx; ry: number; paints: Paint[] }
//                               | { kind: 'shadow' } | { kind: 'hintLetter' }
//                               `part` is the key into PartValues that drives the group. A group
//                               without `part` is static; such groups may be kept or flattened.
//                               The art node 'fx-hint-letter' becomes the { kind: 'hintLetter' } leaf.
//     Paint                     { style: 'fill'; color } | { style: 'stroke'; color; width: number;
//                               cap?: 'butt' | 'round' | 'square'; join?: 'miter' | 'round' | 'bevel' }
//                               in paint order. cap and join default to butt and miter, as in SVG.
//     partMatrix(v: PartValue)  worklet. Row-major number[]: 9 numbers (3x3) or 16 (Matrix4).
//     partOpacity(v: PartValue) worklet. 0 when v.d is 'none', else v.o.
//   app/src/shekru/Shekru.tsx   same export and props. Draws a Skia <Canvas> (style width and height
//                               = size, accessibilityLabel "शेकरू"). Each bound group is a Skia
//                               <Group> whose props hold reanimated values equal to partMatrix(v)
//                               and partOpacity(v) of its part (directly, or on a `layer` element).
//                               The hint letter is a Skia <Text text x y font color>.
//
// Facts read, not assumed:
// - shekru.art.json: 78 keys in `parts`, front = ['arm-l', 'arm-r'], 88 groups, 121 paths, 56
//   circles, 17 ellipses, 44 stroked leaves (3 with a fill too, 41 with fill "none"), every leaf has
//   a fill attribute, no group carries presentation attributes. 'neck-ruff', 'head-base',
//   'shekru-fx' and 'fx-hint-letter' are groups with no entry in `parts`.
// - The four inner arm groups (arm-l-upper, arm-l-lower, arm-r-upper, arm-r-lower) sit inside both
//   the normal arm and its '@front' copy, and the rig has one shared value for each. The reference
//   renderer (git tag shekru-svg-v1) binds both copies to it, so these four ids are bound twice and
//   every other key once. The issue's "exactly one group" is read as "exactly the groups the art
//   walk gives".
// - @shopify/react-native-skia 2.14.0 (the version in expo's bundledNativeModules.json for SDK 58):
//   shared and derived values are passed straight to component props; Group takes `matrix` (SkMatrix
//   or a row-major array of 9 or 16 numbers) and `opacity`; Text takes font, text, x, y;
//   matchFont({ fontFamily, fontSize, fontWeight }) returns an SkFont; Canvas spreads view props.
// - Its own jest setup (jestSetup.js + jestEnv.js) replaces the test environment for every suite and
//   makes matchFont return null, so the hint letter could not be seen. Skia is faked here instead.
// - No database, endpoint or other issue's output is involved.
//
// What is replaced, and why:
//   @shopify/react-native-skia  every component renders a host element named 'sk' + its name, so the
//                               drawn tree can be read; Skia.Path.MakeFromSVGString records each d;
//                               fonts report a fixed advance of 30 per character
//   react-native-reanimated     shared values are plain objects whose writes run every
//                               useAnimatedReaction and listener at once; derived values recompute
//                               on read. A renderer needing another reanimated hook adds it here on
//                               the same terms.
//   react-native-worklets       scheduleOnUI / scheduleOnRN run the function at once on this thread,
//                               so a path from a shared value back into React state would commit
//   expo-router, ./generated/engine   only so the real useShekruRig can mount for the contract test
/* eslint-disable @typescript-eslint/no-require-imports */
import { act, render, renderHook, screen } from '@testing-library/react-native';
import * as fs from 'fs';
import * as path from 'path';
import { createElement as h, isValidElement, Profiler, type ComponentProps } from 'react';
import { AppState, StyleSheet, type NativeEventSubscription } from 'react-native';

import artJson from './generated/shekru.art.json';
import type { PartValue, PartValues, ShekruRig } from './useShekruRig';

type Paint =
  | { style: 'fill'; color: string }
  | { style: 'stroke'; color: string; width: number; cap?: string; join?: string };
type DrawNode =
  | { kind: 'group'; part?: string; children: DrawNode[] }
  | { kind: 'path'; d: string; paints: Paint[] }
  | { kind: 'circle'; cx: number; cy: number; r: number; paints: Paint[] }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; paints: Paint[] }
  | { kind: 'shadow' }
  | { kind: 'hintLetter' };
type SkiaArt = {
  DRAW_TREE: DrawNode[];
  partMatrix: (v: PartValue) => number[];
  partOpacity: (v: PartValue) => number;
};
type ArtNode = { t: string; id?: string; front?: boolean; p?: Record<string, string>; c?: ArtNode[] };

// Compile-time half of the contract (npm run typecheck): the host call sites keep compiling.
type ShekruProps = ComponentProps<typeof import('./Shekru').Shekru>;
const hostCallSites = (rig: ShekruRig, n: number, s?: string): ShekruProps[] => [
  { values: rig.values, size: n },
  { values: rig.values, size: n, hintLetter: s },
];
void hostCallSites;

type Listener = (value: unknown) => void;
const mockUi = { reactions: new Set<() => void>() };
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const flush = () => {
    for (const run of [...mockUi.reactions]) run();
  };
  const makeMutable = (initial: unknown) => {
    let current = initial;
    const listeners = new Map();
    const write = (next: unknown) => {
      current = next;
      listeners.forEach((fn: Listener) => fn(next));
      flush();
    };
    return {
      get value() {
        return current;
      },
      set value(next: unknown) {
        write(next);
      },
      get: () => current,
      set: write,
      addListener: (id: number, fn: Listener) => listeners.set(id, fn),
      removeListener: (id: number) => listeners.delete(id),
    };
  };
  return {
    __esModule: true,
    makeMutable,
    useSharedValue: (initial: unknown) => React.useState(() => makeMutable(initial))[0],
    useDerivedValue: (fn: () => unknown) => {
      const latest = React.useRef(fn);
      latest.current = fn;
      return React.useState(() => ({
        get value() {
          return latest.current();
        },
        get: () => latest.current(),
      }))[0];
    },
    // Runs once on mount and after every shared-value write, like the real one.
    useAnimatedReaction: (prepare: () => unknown, react: (now: unknown, before: unknown) => void) => {
      React.useEffect(() => {
        let before: unknown = null;
        const run = () => {
          const now = prepare();
          react(now, before);
          before = now;
        };
        mockUi.reactions.add(run);
        run();
        return () => {
          mockUi.reactions.delete(run);
        };
      });
    },
    useFrameCallback: () => ({ setActive: () => undefined, isActive: false, callbackId: 1 }),
    runOnJS: (fn: unknown) => fn,
    runOnUI: (fn: unknown) => fn,
  };
});

jest.mock('react-native-worklets', () => {
  const now = (fn: (...a: unknown[]) => unknown, ...args: unknown[]) => fn(...args);
  const later = (fn: (...a: unknown[]) => unknown) => (...args: unknown[]) => fn(...args);
  return { scheduleOnUI: now, scheduleOnRN: now, runOnUI: later, runOnJS: later };
});

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

jest.mock('./generated/engine', () => ({
  makeEngine: () => ({
    createRig: () => ({
      update: () => ({ order: [], parts: {}, state: 'idle' }),
      setState: () => undefined,
      setSpeech: () => undefined,
      setReducedMotion: () => undefined,
    }),
  }),
}));

type FontStyle = { fontFamily?: string; fontSize?: number; fontWeight?: string | number };
const GLYPH_ADVANCE = 30;
const mockSkia = { parsed: [] as string[], advance: GLYPH_ADVANCE };
jest.mock(
  '@shopify/react-native-skia',
  () => {
    const React = require('react');
    const chain = (): unknown =>
      new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : chain()), apply: () => chain() });
    const count = (text: string) => [...text].length;
    const font = (style: FontStyle) => ({
      __typename__: 'Font',
      style,
      getSize: () => style.fontSize,
      getTextWidth: (text: string) => mockSkia.advance * count(text),
      measureText: (text: string) => ({
        x: 0, y: -(style.fontSize ?? 0), width: mockSkia.advance * count(text), height: style.fontSize ?? 0,
      }),
      getGlyphIDs: (text: string) => [...text].map((ch) => ch.codePointAt(0)),
      getGlyphWidths: (ids: number[]) => ids.map(() => mockSkia.advance),
      getMetrics: () => ({ ascent: -(style.fontSize ?? 0), descent: 0, leading: 0 }),
    });
    const own = {
      Path: {
        MakeFromSVGString: (d: string) => {
          mockSkia.parsed.push(d);
          return { __typename__: 'Path', d };
        },
      },
      Font: (typeface: { style?: FontStyle } | null | undefined, size?: number) =>
        font({ ...typeface?.style, fontSize: size }),
      FontMgr: {
        System: () => ({
          matchFamilyStyle: (fontFamily: string, s?: { weight?: number }) => ({
            __typename__: 'Typeface',
            style: { fontFamily, fontWeight: s?.weight },
          }),
        }),
      },
    };
    const Skia = new Proxy(own, {
      get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : chain()),
    });
    const components: Record<string, unknown> = {};
    const component = (name: string) =>
      (components[name] ??= ({ children, ...props }: { children?: unknown }) =>
        React.createElement('sk' + name, props, children));
    const known: Record<string | symbol, unknown> = {
      __esModule: true,
      Skia,
      matchFont: (style: FontStyle = {}) => font(style),
      vec: (x = 0, y = x) => ({ x, y }),
      rect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    };
    return new Proxy(known, {
      get: (t, k) =>
        k in t ? t[k] : typeof k === 'string' && /^[A-Z]/.test(k) ? component(k) : typeof k === 'string' ? chain() : undefined,
    });
  },
  { virtual: true }, // not installed until /implement runs `npx expo install`
);

// Literals on purpose: these are FRONT_SUFFIX and SHADOW in useShekruRig.ts, which this issue may not change.
const FRONT = '@front';
const SHADOW = '@shadow';
const LETTER_SLOT = 'fx-hint-letter';
const INITIAL = artJson.parts as unknown as Record<string, PartValue>;
const KEYS = [...Object.keys(INITIAL), ...artJson.front.map((id) => id + FRONT), SHADOW];
const KEY_SET = new Set(KEYS);
const CHARACTER = artJson.character as ArtNode[];
const FX = artJson.fx as ArtNode[];

// The key the reference renderer bound a group to, if any.
const keyOf = (n: ArtNode) => {
  const key = n.front ? n.id + FRONT : n.id;
  return key !== undefined && KEY_SET.has(key) ? key : undefined;
};

function artLeaves(nodes: ArtNode[], out: ArtNode[] = []): ArtNode[] {
  for (const n of nodes) {
    if (n.id === LETTER_SLOT) continue;
    if (n.t === 'g') artLeaves(n.c ?? [], out);
    else out.push(n);
  }
  return out;
}

type Geometry = { d?: string; cx?: string | number; cy?: string | number; r?: string | number; rx?: string | number; ry?: string | number };
const shape = (kind: string, p: Geometry) =>
  kind === 'path' ? `path ${p.d}`
  : kind === 'circle' ? `circle ${Number(p.cx)} ${Number(p.cy)} ${Number(p.r)}`
  : `${kind} ${Number(p.cx)} ${Number(p.cy)} ${Number(p.rx)} ${Number(p.ry)}`;

// Document order as one sequence: '(key' opens a bound group, ')' closes it, static groups leave no mark.
function artTokens(nodes: ArtNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.id === LETTER_SLOT) out.push('hintLetter');
    else if (n.t !== 'g') out.push(shape(n.t, n.p ?? {}));
    else {
      const key = keyOf(n);
      if (key) out.push('(' + key);
      artTokens(n.c ?? [], out);
      if (key) out.push(')');
    }
  }
  return out;
}

function treeTokens(nodes: DrawNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'shadow' || n.kind === 'hintLetter') out.push(n.kind);
    else if (n.kind !== 'group') out.push(shape(n.kind, n));
    else {
      if (n.part !== undefined) out.push('(' + n.part);
      treeTokens(n.children, out);
      if (n.part !== undefined) out.push(')');
    }
  }
  return out;
}

const EXPECTED_TOKENS = ['(' + SHADOW, 'shadow', ')', ...artTokens(CHARACTER), ...artTokens(FX)];
// Bound groups in draw order, the four inner arm ids appearing once per arm copy.
const EXPECTED_BOUND = EXPECTED_TOKENS.filter((t) => t.startsWith('(')).map((t) => t.slice(1));

const skiaArt = () => require('./skiaArt') as SkiaArt;
const loadShekru = () => require('./Shekru') as typeof import('./Shekru');

function makeValues(): PartValues {
  const { makeMutable } = require('react-native-reanimated');
  const v: PartValues = {};
  for (const id in INITIAL) v[id] = makeMutable(INITIAL[id]);
  for (const id of artJson.front) v[id + FRONT] = makeMutable({ ...INITIAL[id], d: 'none' });
  v[SHADOW] = makeMutable({ m: [1, 0, 0, 1, 0, 0], o: 1, d: 'inline' });
  return v;
}

// A value no part holds at rest, different for every key.
const probe = (i: number, d: PartValue['d'] = 'inline'): PartValue => ({
  m: [1, 0.25, -0.5, 1, 5000 + i, 7000 + i],
  o: d === 'inline' ? 0.37 : 0.8,
  d,
});

type Drawn = { type: string; props: Record<string, unknown>; children: (Drawn | string)[] | null };

// Every host element on screen, in draw order.
function drawn(): Drawn[] {
  const out: Drawn[] = [];
  const walk = (n: Drawn | string | (Drawn | string)[] | null) => {
    if (n === null || typeof n === 'string') return;
    if (Array.isArray(n)) return n.forEach(walk);
    out.push(n);
    walk(n.children);
  };
  walk(screen.toJSON() as Drawn | Drawn[] | null);
  return out;
}

const isShared = (v: unknown): v is { value: unknown } =>
  v !== null && typeof v === 'object' && !isValidElement(v) && 'value' in v;

// The reanimated values an element reads: its own props, and those of an element prop such as `layer`.
function sharedIn(props: Record<string, unknown>): { value: unknown }[] {
  const out: { value: unknown }[] = [];
  for (const v of Object.values(props)) {
    if (isShared(v)) out.push(v);
    else if (isValidElement(v)) out.push(...Object.values(v.props as Record<string, unknown>).filter(isShared));
  }
  return out;
}
const reads = (el: Drawn) => sharedIn(el.props).map((s) => s.value);

// Maps a point through a row-major 3x3 or 4x4 matrix, as Skia does.
function mapPoint(m: number[], x: number, y: number) {
  if (m.length === 9) return { x: m[0] * x + m[1] * y + m[2], y: m[3] * x + m[4] * y + m[5], bottom: [m[6], m[7], m[8]] };
  if (m.length === 16) return { x: m[0] * x + m[1] * y + m[3], y: m[4] * x + m[5] * y + m[7], bottom: [m[12], m[13], m[15]] };
  throw new Error(`partMatrix returned ${m.length} numbers; expected 9 (3x3) or 16 (4x4)`);
}

beforeEach(() => {
  mockUi.reactions.clear();
});

describe('GURU-48 contract', () => {
  it('contract (host screens; Needed by: none): Shekru keeps its export and props and draws a Skia canvas of size x size labelled शेकरू; useShekruRig keeps its API', () => {
    const mod = loadShekru();
    expect(Object.keys(mod)).toContain('Shekru');
    expect((mod.Shekru as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));

    const values = makeValues();
    const view = render(h(mod.Shekru, { values, size: 240, hintLetter: 'C' }));
    const canvas = () => drawn().filter((el) => el.type === 'skCanvas');
    expect(canvas()).toHaveLength(1);
    expect(canvas()[0].props.accessibilityLabel).toBe('शेकरू');
    expect(StyleSheet.flatten(canvas()[0].props.style as object)).toMatchObject({ width: 240, height: 240 });
    // size stays live and hintLetter stays optional: LessonPlayer switches both
    view.rerender(h(mod.Shekru, { values, size: 300 }));
    expect(StyleSheet.flatten(canvas()[0].props.style as object)).toMatchObject({ width: 300, height: 300 });
    view.unmount();

    const rigMod = require('./useShekruRig') as typeof import('./useShekruRig');
    expect(typeof rigMod.FRONT_SUFFIX).toBe('string');
    expect(typeof rigMod.SHADOW).toBe('string');
    expect(typeof rigMod.SHADOW_CX).toBe('number');
    expect(typeof rigMod.SHADOW_CY).toBe('number');
    const listen = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: () => undefined } as NativeEventSubscription);
    try {
      const { result, unmount } = renderHook(() => rigMod.useShekruRig());
      expect(Object.keys(result.current).sort()).toEqual(['setSpeech', 'setState', 'syncSpeech', 'values']);
      expect(typeof result.current.setState).toBe('function');
      expect(typeof result.current.setSpeech).toBe('function');
      expect(typeof result.current.syncSpeech).toBe('function');
      expect(Object.keys(result.current.values).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        const v = result.current.values[key].value;
        expect(v.m).toHaveLength(6);
        expect(typeof v.o).toBe('number');
        expect(['inline', 'none']).toContain(v.d);
      }
      unmount();
    } finally {
      listen.mockRestore();
    }
  });
});

describe('GURU-48 the drawing as data (skiaArt)', () => {
  it('draw order is the SVG document order: shadow, character, fx, with each @front copy and the hint slot where the art has them', () => {
    expect(treeTokens(skiaArt().DRAW_TREE)).toEqual(EXPECTED_TOKENS);
  });

  it('every rig key drives exactly the groups the art gives it, and no group names any other value', () => {
    const counts = (list: string[]) => {
      const out: Record<string, number> = {};
      for (const key of list) out[key] = (out[key] ?? 0) + 1;
      return out;
    };
    const bound = treeTokens(skiaArt().DRAW_TREE).filter((t) => t.startsWith('(')).map((t) => t.slice(1));
    expect(bound.filter((key) => !KEY_SET.has(key))).toEqual([]);
    expect(KEYS.filter((key) => !bound.includes(key))).toEqual([]);
    expect(counts(bound)).toEqual(counts(EXPECTED_BOUND));
    // the art itself: one group per key, except the inner arm groups, which each arm copy repeats
    const twice = Object.entries(counts(EXPECTED_BOUND)).filter(([, n]) => n !== 1);
    expect(twice.sort()).toEqual([['arm-l-lower', 2], ['arm-l-upper', 2], ['arm-r-lower', 2], ['arm-r-upper', 2]]);
    expect(EXPECTED_BOUND).toHaveLength(KEYS.length + 4);
  });

  it('every leaf keeps its paint: fill first, then stroke with colour, width, cap and join; fill "none" paints no fill', () => {
    const want = artLeaves([...CHARACTER, ...FX]).map((n) => {
      const p = n.p ?? {};
      const paints: Paint[] = [];
      if (p.fill !== 'none') paints.push({ style: 'fill', color: p.fill });
      if (p.stroke !== undefined && p.stroke !== 'none') {
        paints.push({
          style: 'stroke', color: p.stroke, width: Number(p.strokeWidth),
          cap: p.strokeLinecap ?? 'butt', join: p.strokeLinejoin ?? 'miter',
        });
      }
      return { shape: shape(n.t, p), paints };
    });
    // the art this was written against
    expect(artLeaves([...CHARACTER, ...FX]).every((n) => n.p?.fill !== undefined)).toBe(true);
    expect(want.filter((l) => l.paints.some((p) => p.style === 'stroke'))).toHaveLength(44);
    expect(want.filter((l) => l.paints.length === 2)).toHaveLength(3);

    const got: { shape: string; paints: Paint[] }[] = [];
    const walk = (nodes: DrawNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'group') walk(n.children);
        else if (n.kind !== 'shadow' && n.kind !== 'hintLetter') {
          got.push({
            shape: shape(n.kind, n),
            paints: n.paints.map((p) =>
              p.style === 'fill'
                ? { style: 'fill', color: p.color }
                : { style: 'stroke', color: p.color, width: p.width, cap: p.cap ?? 'butt', join: p.join ?? 'miter' }),
          });
        }
      }
    };
    walk(skiaArt().DRAW_TREE);
    expect(got).toEqual(want);
  });

  it('partMatrix maps SVG [a, b, c, d, e, f] to x\' = a·x + c·y + e, y\' = b·x + d·y + f', () => {
    const { partMatrix } = skiaArt();
    // b = 3 and c = 5 differ, so a transposed matrix lands elsewhere
    const m = partMatrix({ m: [2, 3, 5, 7, 11, 13], o: 1, d: 'inline' });
    expect(mapPoint(m, 0, 0)).toEqual({ x: 11, y: 13, bottom: [0, 0, 1] });
    expect(mapPoint(m, 1, 0)).toMatchObject({ x: 13, y: 16 });
    expect(mapPoint(m, 0, 1)).toMatchObject({ x: 16, y: 20 });
    expect(mapPoint(m, 4, -6)).toMatchObject({ x: 2 * 4 + 5 * -6 + 11, y: 3 * 4 + 7 * -6 + 13 });
  });

  it('partOpacity: a part with d "none" draws nothing, a part with d "inline" draws at its opacity o', () => {
    const { partOpacity } = skiaArt();
    const m = [1, 0, 0, 1, 0, 0];
    expect(partOpacity({ m, o: 0.8, d: 'none' })).toBe(0);
    expect(partOpacity({ m, o: 1, d: 'none' })).toBe(0);
    expect(partOpacity({ m, o: 0.37, d: 'inline' })).toBe(0.37);
    expect(partOpacity({ m, o: 1, d: 'inline' })).toBe(1);
    expect(partOpacity({ m, o: 0, d: 'inline' })).toBe(0);
  });
});

describe('GURU-48 the drawn tree (Shekru)', () => {
  it('each bound Skia group follows exactly one shared value, the one the art gives it, through partMatrix and partOpacity', () => {
    const { partMatrix, partOpacity } = skiaArt();
    const values = makeValues();
    render(h(loadShekru().Shekru, { values, size: 240 }));
    // every group that reads any reanimated value, in draw order
    const groups = drawn().filter((el) => el.type === 'skGroup' && sharedIn(el.props).length > 0);
    const follows = groups.map(() => [] as string[]);

    KEYS.forEach((key, i) => {
      const rest = values[key].value;
      const before = groups.map((g) => JSON.stringify(reads(g)));
      const shown = probe(i);
      act(() => {
        values[key].value = shown;
      });
      const moved = groups.filter((g, at) => JSON.stringify(reads(g)) !== before[at]);
      moved.forEach((g) => {
        follows[groups.indexOf(g)].push(key);
        expect(reads(g)).toContainEqual(partMatrix(shown));
        expect(reads(g)).toContain(partOpacity(shown));
      });
      const hidden = probe(i, 'none');
      act(() => {
        values[key].value = hidden;
      });
      moved.forEach((g) => expect(reads(g)).toContain(0));
      act(() => {
        values[key].value = rest;
      });
    });

    // unbound, bound to the wrong id, or reading a second value: all show up in this one comparison
    expect(follows.map((keys) => keys.join(' + '))).toEqual(EXPECTED_BOUND);
  });

  it('with hintLetter="C" the hint slot draws the letter centred on x = 362, baseline y = 264, size 48, weight 800, #3D1420; with none it draws no text', () => {
    const { Shekru } = loadShekru();
    const values = makeValues();
    const texts = () => drawn().filter((el) => el.type === 'skText');

    const view = render(h(Shekru, { values, size: 240 }));
    expect(drawn().filter((el) => el.type === 'skCanvas')).toHaveLength(1);
    expect(texts()).toHaveLength(0);

    view.rerender(h(Shekru, { values, size: 240, hintLetter: 'C' }));
    expect(texts()).toHaveLength(1);
    const letter = texts()[0].props as {
      text: string; x: number; y: number; color: string;
      font: { style: { fontSize?: number; fontWeight?: string | number } };
    };
    expect(letter.text).toBe('C');
    expect(letter.y).toBe(264);
    expect(letter.x).toBeCloseTo(362 - GLYPH_ADVANCE / 2, 5);
    expect(letter.color).toBe('#3D1420');
    expect(letter.font.style.fontSize).toBe(48);
    expect(String(letter.font.style.fontWeight)).toBe('800');

    // a wider glyph still sits on the same centre
    view.rerender(h(Shekru, { values, size: 240, hintLetter: 'अ' }));
    expect(texts()[0].props.text).toBe('अ');
    expect(texts()[0].props.x).toBeCloseTo(362 - GLYPH_ADVANCE / 2, 5);
    mockSkia.advance = 44;
    try {
      view.rerender(h(Shekru, { values, size: 240, hintLetter: 'W' }));
      expect(texts()[0].props.x).toBeCloseTo(362 - 44 / 2, 5);
    } finally {
      mockSkia.advance = GLYPH_ADVANCE;
    }
  });

  it('commits once per mount: new PartValues on every shared value cause no further React commit', () => {
    const { Shekru } = loadShekru();
    const values = makeValues();
    let commits = 0;
    render(h(Profiler, { id: 'shekru', onRender: () => { commits += 1; } }, h(Shekru, { values, size: 240 })));
    expect(drawn().filter((el) => el.type === 'skCanvas')).toHaveLength(1);
    expect(commits).toBe(1);

    for (let step = 0; step < 3; step++) {
      act(() => {
        KEYS.forEach((key, i) => {
          values[key].value = probe(i + step * 100, step === 1 ? 'none' : 'inline');
        });
      });
    }
    expect(commits).toBe(1);
  });

  it('Skia paths are built from the d strings once: a second mount, a new size and new values parse nothing more', () => {
    const { Shekru } = loadShekru();
    const values = makeValues();
    const view = render(h(Shekru, { values, size: 240 }));
    const built = mockSkia.parsed.length;
    const wanted = new Set(artLeaves([...CHARACTER, ...FX]).filter((n) => n.t === 'path').map((n) => n.p?.d));
    expect([...wanted].filter((d) => !mockSkia.parsed.includes(d as string))).toEqual([]);
    // prebuilt paths reach the canvas, not d strings for Skia to parse on every draw
    expect(drawn().filter((el) => el.type === 'skPath' && typeof el.props.path === 'string')).toEqual([]);

    view.rerender(h(Shekru, { values, size: 300 }));
    act(() => {
      KEYS.forEach((key, i) => {
        values[key].value = probe(i);
      });
    });
    render(h(Shekru, { values: makeValues(), size: 120 }));
    expect(mockSkia.parsed).toHaveLength(built);
  });
});

describe('GURU-48 the SVG renderer is gone', () => {
  const APP = path.resolve(__dirname, '../..');

  it('Shekru.tsx imports nothing from react-native-svg, no source file keeps an animated SVG group, and Skia is installed at the version Expo pins', () => {
    expect(fs.readFileSync(path.join(__dirname, 'Shekru.tsx'), 'utf8')).not.toMatch(/react-native-svg/);

    const sources: string[] = [];
    const collect = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'generated') collect(file);
        } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && file !== __filename) sources.push(file);
      }
    };
    collect(path.join(APP, 'src'));
    collect(path.join(APP, 'modules'));
    const svgRenderer = /AnimatedG\b|createAnimatedComponent\(\s*G\s*\)/;
    expect(sources.filter((file) => svgRenderer.test(fs.readFileSync(file, 'utf8')))).toEqual([]);

    const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
    const pinned = require('expo/bundledNativeModules.json')['@shopify/react-native-skia'] as string;
    expect(pinned).toBeDefined();
    expect(String(pkg.dependencies['@shopify/react-native-skia']).replace(/^[~^]/, '')).toBe(pinned.replace(/^[~^]/, ''));
  });
});
