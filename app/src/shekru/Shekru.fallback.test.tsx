// GURU-48: the hint slot when the letter font has no glyph for the text. Lessons pass a picture emoji
// (content/pictures.ts), and Skia's Text draws with one typeface and no fallback, so Shekru.tsx sends
// such text through Paragraph. Shekru.test.tsx cannot reach this path: its font has every glyph.
//
// Skia is faked: components render host elements named 'sk' + name, and the font reports glyph 0
// (missing) for anything outside ASCII. Shared and derived values are plain objects read on demand.
/* eslint-disable @typescript-eslint/no-require-imports */
import { render, screen } from '@testing-library/react-native';
import { createElement as h, type ReactElement } from 'react';

import artJson from './generated/shekru.art.json';
import type { PartValue, PartValues } from './useShekruRig';

const BASELINE = 40;
const HEIGHT = 56;
const mockBuilt: { text: string; style: Record<string, unknown>; layout: number[] }[] = [];

jest.mock('./useShekruRig', () => ({ FRONT_SUFFIX: '@front', SHADOW: '@shadow', SHADOW_CX: 202.4, SHADOW_CY: 442.6 }));

jest.mock('react-native-reanimated', () => ({
  useDerivedValue: (fn: () => unknown) => ({
    get value() {
      return fn();
    },
  }),
}));

jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const host = (name: string) =>
    function SkiaHost({ children, ...props }: { children?: unknown }) {
      return React.createElement('sk' + name, props, children);
    };
  const components = Object.fromEntries(
    ['Canvas', 'Circle', 'Group', 'Oval', 'Paint', 'Paragraph', 'Path', 'RadialGradient', 'Text'].map((n) => [n, host(n)]),
  );
  const builder = () => {
    const made = { text: '', style: {} as Record<string, unknown>, layout: [] as number[] };
    const self = {
      pushStyle: (style: Record<string, unknown>) => ((made.style = style), self),
      addText: (text: string) => ((made.text += text), self),
      build: () => {
        mockBuilt.push(made);
        return {
          layout: (w: number) => made.layout.push(w),
          getLineMetrics: () => [{ baseline: BASELINE }],
          getHeight: () => HEIGHT,
        };
      },
    };
    return self;
  };
  return {
    __esModule: true,
    ...components,
    TextAlign: { Center: 'center' },
    vec: (x: number, y: number) => ({ x, y }),
    rect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    matchFont: () => ({
      getGlyphIDs: (text: string) => [...text].map((ch) => ((ch.codePointAt(0) ?? 0) > 127 ? 0 : ch.codePointAt(0))),
      getGlyphWidths: (ids: number[]) => ids.map(() => 30),
    }),
    Skia: { Path: { MakeFromSVGString: (d: string) => ({ d }) }, Color: (c: string) => c, ParagraphBuilder: { Make: builder } },
  };
});

const CARD = 'fx-hint-card'; // the one rig part above the hint slot
const at = (o = 1, d: PartValue['d'] = 'inline'): PartValue => ({ m: [1, 0, 0, 1, 0, 0], o, d });

function makeValues(): PartValues {
  const v: Record<string, { value: PartValue }> = {};
  for (const id of [...Object.keys(artJson.parts), ...artJson.front.map((f) => f + '@front'), '@shadow']) {
    v[id] = { value: at() };
  }
  return v as unknown as PartValues;
}

type Drawn = { type: string; props: Record<string, unknown>; children: (Drawn | string)[] | null };
function drawn(type: string): Drawn[] {
  const out: Drawn[] = [];
  const walk = (n: Drawn | string | (Drawn | string)[] | null) => {
    if (n === null || typeof n === 'string') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === type) out.push(n);
    walk(n.children);
  };
  walk(screen.toJSON() as Drawn | Drawn[] | null);
  return out;
}

describe('GURU-48 hint slot fallback', () => {
  const { Shekru } = require('./Shekru') as typeof import('./Shekru');

  beforeEach(() => {
    mockBuilt.length = 0;
  });

  it('a letter the font has is drawn as Text, with no paragraph', () => {
    render(h(Shekru, { values: makeValues(), size: 240, hintLetter: 'C' }));
    expect(drawn('skText')).toHaveLength(1);
    expect(drawn('skParagraph')).toHaveLength(0);
    expect(mockBuilt).toHaveLength(0);
  });

  it('a picture emoji is drawn as a paragraph centred on x = 362 with its baseline on y = 264, in the letter style', () => {
    render(h(Shekru, { values: makeValues(), size: 240, hintLetter: '🍍' }));
    expect(drawn('skText')).toHaveLength(0);
    expect(drawn('skParagraph')).toHaveLength(1);
    const p = drawn('skParagraph')[0].props as { x: number; y: number; width: number };
    expect(p.x + p.width / 2).toBe(362);
    expect(p.y + BASELINE).toBe(264);

    expect(mockBuilt).toHaveLength(1);
    expect(mockBuilt[0].text).toBe('🍍');
    expect(mockBuilt[0].style).toMatchObject({ color: '#3D1420', fontSize: 48, fontStyle: { weight: 800 } });
    expect(mockBuilt[0].layout).toEqual([p.width]);
  });

  it('the paragraph fades and hides with the hint card, through a layer that reads the card value and is clipped to the text box', () => {
    const values = makeValues();
    render(h(Shekru, { values, size: 240, hintLetter: '🍍' }));
    const layers = drawn('skGroup').filter((g) => g.props.layer !== undefined);
    expect(layers).toHaveLength(1);
    expect(layers[0].children?.map((c) => (c as Drawn).type)).toEqual(['skParagraph']);
    // Skia saves the layer before it clips, so the clip sits on a group outside the layer
    const clips = drawn('skGroup').filter((g) => g.props.clip !== undefined);
    expect(clips).toHaveLength(1);
    expect(clips[0].children).toEqual([layers[0]]);
    const p = drawn('skParagraph')[0].props as { x: number; y: number; width: number };
    expect(clips[0].props.clip).toEqual({ x: p.x, y: p.y, width: p.width, height: HEIGHT });
    const opacity = () => ((layers[0].props.layer as ReactElement).props as { opacity: { value: number } }).opacity.value;

    expect(opacity()).toBe(1);
    values[CARD].value = at(0.4);
    expect(opacity()).toBe(0.4);
    values[CARD].value = at(0.8, 'none');
    expect(opacity()).toBe(0);
    // no other part reaches it
    values[CARD].value = at();
    for (const id of Object.keys(artJson.parts)) {
      if (id !== CARD) values[id].value = at(0.5);
    }
    expect(opacity()).toBe(1);
  });
});
