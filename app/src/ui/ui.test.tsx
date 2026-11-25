// GURU-5: UI foundation. Strings (mr/en), LanguageProvider + useT, theme from
// design/foundations/tokens.json, base components, fonts in the root layout, and
// a scan for literal colours in app/src/ui. No database or external service.
import * as fs from 'fs';
import * as path from 'path';
import { createElement, type ReactElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import RootLayout from '../app/_layout';
import { Button } from './components/Button';
import * as ButtonModule from './components/Button';
import { Screen } from './components/Screen';
import { Text } from './components/Text';
import { LanguageProvider, useT } from './i18n';
import { en } from './strings/en';
import { mr } from './strings/mr';
import { theme } from './theme';

// Fonts: the root layout may use useFonts (expo-font or an @expo-google-fonts
// package, which wraps it) or loadAsync. Both report the requested families and
// stay unloaded until mockFonts.loaded is true.
const mockFonts = { loaded: false, requested: [] as string[] };
jest.mock(
  'expo-font',
  () => {
    const note = (map: unknown) => {
      if (typeof map === 'string') mockFonts.requested.push(map);
      else if (map && typeof map === 'object') mockFonts.requested.push(...Object.keys(map));
    };
    return {
      useFonts: (map: unknown) => {
        note(map);
        return [mockFonts.loaded, null];
      },
      loadAsync: (map: unknown) => {
        note(map);
        return mockFonts.loaded ? Promise.resolve() : new Promise(() => {});
      },
      isLoaded: () => mockFonts.loaded,
    };
  },
  { virtual: true },
);
jest.mock(
  'expo-splash-screen',
  () => ({
    preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
    hideAsync: jest.fn(() => Promise.resolve(true)),
    hide: jest.fn(),
    setOptions: jest.fn(),
  }),
  { virtual: true },
);
// The navigator stands in as a marker: visible means the first screen rendered.
jest.mock('expo-router', () => {
  const { createElement: h } = require('react');
  const { Text: RNText } = require('react-native');
  const Stack = () => h(RNText, null, 'first-screen');
  Stack.Screen = function StackScreen() {
    return null;
  };
  return { Stack };
});
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

const APP = path.resolve(__dirname, '../..');
const UI = __dirname;
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sourceTokens = readJson(path.resolve(APP, '../design/foundations/tokens.json'));

type Key = keyof typeof mr;
// A key whose Marathi and English texts differ, so a switch is visible.
function differingKey(): Key {
  const key = (Object.keys(mr) as Key[]).find((k) => mr[k] !== en[k]);
  if (!key) throw new Error('no string differs between mr and en');
  return key;
}

type Json = { props?: Record<string, unknown>; children?: (Json | string)[] | null };
// Every flattened host style in the rendered tree.
function styles(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: Json | string | null | undefined) => {
    if (!n || typeof n === 'string') return;
    const s = StyleSheet.flatten(n.props?.style as never) as Record<string, unknown> | undefined;
    if (s) out.push(s);
    n.children?.forEach(walk);
  };
  const tree = screen.toJSON() as Json | Json[] | null;
  (Array.isArray(tree) ? tree : [tree]).forEach(walk);
  return out;
}
const backgrounds = () => styles().map((s) => s.backgroundColor).filter(Boolean);
const tallest = () => Math.max(0, ...styles().flatMap((s) => [Number(s.minHeight) || 0, Number(s.height) || 0]));

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGB = /rgba?\(/;
function colourLiterals(source: string): number[] {
  return source.split('\n').flatMap((line, i) => (HEX.test(line) || RGB.test(line) ? [i + 1] : []));
}
function uiSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'generated' ? [] : uiSources(p);
    return /\.(ts|tsx|js|jsx)$/.test(e.name) ? [p] : [];
  });
}

describe('GURU-5 UI foundation', () => {
  beforeEach(() => {
    mockFonts.loaded = false;
    mockFonts.requested = [];
  });

  test('strings: English has exactly the Marathi keys, every text is non-empty, Marathi is in Devanagari', () => {
    // Compile-time fence: a key missing from en fails `npm run typecheck` here.
    const enCoversMr: Record<keyof typeof mr, string> = en;
    expect(enCoversMr).toBe(en);

    expect(Object.keys(en).sort()).toEqual(Object.keys(mr).sort());
    expect(Object.keys(mr).length).toBeGreaterThan(0);
    for (const table of [mr, en] as Record<string, unknown>[]) {
      for (const value of Object.values(table)) {
        expect(typeof value).toBe('string');
        expect((value as string).trim()).not.toBe('');
      }
    }
    expect(Object.values(mr).some((v) => /[ऀ-ॿ]/.test(v))).toBe(true);
    expect(differingKey()).toBeDefined();
  });

  test('LanguageProvider: Marathi by default, initial="en" starts in English, setLang switches and reports onChange', () => {
    const key = differingKey();
    function Harness() {
      const { t, lang, setLang } = useT();
      return createElement(
        Screen,
        { variant: 'parent' },
        createElement(Text, null, t(key)),
        createElement(Text, null, `lang:${lang}`),
        createElement(Button, { variant: 'parent', label: 'switch', onPress: () => setLang('en') }),
      );
    }
    const onChange = jest.fn();

    render(createElement(LanguageProvider, { onChange }, createElement(Harness)));
    expect(screen.getByText(mr[key])).toBeTruthy();
    expect(screen.getByText('lang:mr')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole('button', { name: 'switch' }));
    expect(screen.getByText(en[key])).toBeTruthy();
    expect(screen.queryByText(mr[key])).toBeNull();
    expect(screen.getByText('lang:en')).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('en');

    screen.unmount();
    render(createElement(LanguageProvider, { initial: 'en', onChange: jest.fn() }, createElement(Harness)));
    expect(screen.getByText(en[key])).toBeTruthy();
    expect(screen.getByText('lang:en')).toBeTruthy();
  });

  test('theme: values come from design/foundations/tokens.json via the committed generated copy', () => {
    expect(readJson(path.join(UI, 'generated/tokens.json'))).toEqual(sourceTokens);
    const pkg = readJson(path.join(APP, 'package.json'));
    expect(pkg.scripts['build:theme']).toMatch(/scripts\/build-theme\.mjs/);
    expect(fs.existsSync(path.join(APP, 'scripts/build-theme.mjs'))).toBe(true);

    for (const mode of ['child', 'parent'] as const) {
      const src = sourceTokens.color[mode] as Record<string, { value: string }>;
      const got = theme.color[mode] as Record<string, unknown>;
      expect(Object.keys(got).sort()).toEqual(Object.keys(src).sort());
      for (const [name, token] of Object.entries(src)) expect(got[name]).toBe(token.value);
    }
    for (const mode of ['child', 'parent'] as const) {
      const src = sourceTokens.font[mode] as Record<string, { size: number; lineHeight: number }>;
      const got = theme.font[mode] as Record<string, unknown>;
      for (const [variant, f] of Object.entries(src)) {
        expect(got[variant]).toMatchObject({ size: f.size, lineHeight: f.lineHeight });
      }
    }
    expect(theme.space).toEqual(sourceTokens.space);
    expect(theme.radius).toEqual(sourceTokens.radius);
    expect(theme.touch).toEqual(sourceTokens.touch);
    expect(theme.touch.parentGate.holdMs).toBe(2000);
  });

  test('components: Button variants take colour and touch size from the theme; Screen takes its background', () => {
    const cases = [
      { variant: 'childPrimary', bg: theme.color.child.primary, min: theme.touch.child.mainButton },
      { variant: 'childSecondary', bg: theme.color.child.surface, min: theme.touch.child.min },
      { variant: 'parent', bg: theme.color.parent.accent, min: theme.touch.parent.min },
    ] as const;
    for (const c of cases) {
      const onPress = jest.fn();
      render(createElement(Button, { variant: c.variant, label: `go-${c.variant}`, onPress }));
      expect(screen.getByRole('button', { name: `go-${c.variant}` })).toBeTruthy();
      expect(backgrounds()).toContain(c.bg);
      expect(tallest()).toBeGreaterThanOrEqual(c.min);
      fireEvent.press(screen.getByText(`go-${c.variant}`));
      expect(onPress).toHaveBeenCalledTimes(1);
      screen.unmount();
    }

    for (const mode of ['child', 'parent'] as const) {
      render(createElement(Screen, { variant: mode }, createElement(Text, null, `in-${mode}`)));
      expect(screen.getByText(`in-${mode}`)).toBeTruthy();
      expect(backgrounds()).toContain(theme.color[mode].background);
      const other = mode === 'child' ? 'parent' : 'child';
      expect(backgrounds()).not.toContain(theme.color[other].background);
      screen.unmount();
    }

    render(createElement(Text, null, 'plain'));
    const family = styles().map((s) => s.fontFamily).find(Boolean);
    expect(String(family)).toMatch(/mukta|baloo/i);
  });

  test('root layout: requests Baloo 2 and Mukta and renders no screen until they have loaded', async () => {
    render(createElement(RootLayout));
    await act(async () => {});
    expect(mockFonts.requested.some((f) => /baloo ?2/i.test(f))).toBe(true);
    expect(mockFonts.requested.some((f) => /mukta/i.test(f))).toBe(true);
    expect(screen.queryByText('first-screen')).toBeNull();
    screen.unmount();

    mockFonts.loaded = true;
    render(createElement(RootLayout));
    expect(await screen.findByText('first-screen')).toBeTruthy();
  });

  test('no colour literals (# hex, rgb/rgba) in app/src/ui outside generated/', () => {
    // The scanner itself must catch both forms (built by concatenation so this file stays clean).
    expect(colourLiterals(`color: '${'#'}3D1420'`)).toEqual([1]);
    expect(colourLiterals(`x\nbackgroundColor: '${'rgb'}(1, 2, 3)'`)).toEqual([2]);
    expect(colourLiterals('backgroundColor: theme.color.child.primary')).toEqual([]);

    const files = uiSources(UI);
    const rel = files.map((f) => path.relative(UI, f));
    // Non-vacuous: the modules this issue adds must be among the scanned files.
    for (const f of ['i18n.ts', 'theme.ts', 'components/Button.tsx', 'components/Screen.tsx', 'components/Text.tsx']) {
      expect(rel).toContain(f);
    }
    const hits = files.flatMap((f) =>
      colourLiterals(fs.readFileSync(f, 'utf8')).map((line) => `${path.relative(UI, f)}:${line}`),
    );
    expect(hits).toEqual([]);
  });

  // Contract for GURU-9, GURU-24, GURU-25, GURU-28 (output_for_dependents). Shape only.
  test('contract (GURU-9, GURU-24, GURU-25, GURU-28): exports and shapes dependents rely on', () => {
    expect(() => require.resolve('@testing-library/react-native')).not.toThrow();

    const isComponent = (c: unknown) =>
      typeof c === 'function' || (typeof c === 'object' && c !== null && '$$typeof' in c);
    for (const c of [LanguageProvider, Button, Screen, Text, RootLayout]) expect(isComponent(c)).toBe(true);
    expect(typeof useT).toBe('function');

    let api: ReturnType<typeof useT> | undefined;
    function Probe(): ReactElement | null {
      api = useT();
      return null;
    }
    render(createElement(LanguageProvider, { onChange: () => {} }, createElement(Probe)));
    expect(typeof api?.t).toBe('function');
    expect(typeof api?.setLang).toBe('function');
    expect(typeof api?.lang).toBe('string');
    expect(typeof api?.t(differingKey())).toBe('string');

    expect(typeof mr).toBe('object');
    expect(typeof en).toBe('object');
    for (const k of ['color', 'font', 'space', 'radius', 'touch']) expect(theme).toHaveProperty(k);
    expect(typeof theme.color.child).toBe('object');
    expect(typeof theme.color.parent).toBe('object');
  });
});

// GURU-43: Marathi labels in the shared Button wrap or lose their last word on Android 15.
// Cause (from react-native 0.88.1 sources, the phone's settings and the font files): Button's
// `alignItems: 'center'` shrinks the label Text to ceil(sum of glyph advances), which is how
// React Native measures. The app targets SDK 36, so on Android 15 the TextView that draws it
// breaks lines by glyph ink bounds, and Mukta and Baloo 2 Devanagari ink overhangs the advance
// (about 0.5 px a side for Mukta 700 at 18sp, 3 to 4 px for Baloo 2 800 at 32sp, at density 3).
// The ink no longer fits the box and the last word moves to a second line that the one-line box
// has no room for. Fence: the label takes the button's inner width and centres its text itself.
// Jest does no text layout, so one line on the phone is the owner's device check.
const flat = (style: unknown) => (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
// The label Text and the pressable box of the one rendered Button with this label.
function buttonParts(label: string) {
  const text = screen.getByText(label);
  const box = screen.getByRole('button', { name: label });
  return { labelProps: text.props as Record<string, unknown>, label: flat(text.props.style), box: flat(box.props.style) };
}
const LINE_CAPS = ['numberOfLines', 'ellipsizeMode', 'adjustsFontSizeToFit'];
const BUTTON_VARIANTS = ['childPrimary', 'childSecondary', 'parent', 'parentGhost'] as const;

describe('GURU-43 Button keeps Marathi labels whole', () => {
  test('every variant: the label takes the full inner width of the button and centres its own text', () => {
    for (const variant of BUTTON_VARIANTS) {
      render(createElement(Button, { variant, label: `go-${variant}`, onPress: jest.fn() }));
      const { label } = buttonParts(`go-${variant}`);
      expect({ variant, alignSelf: label.alignSelf }).toEqual({ variant, alignSelf: 'stretch' });
      expect({ variant, textAlign: label.textAlign }).toEqual({ variant, textAlign: 'center' });
      screen.unmount();
    }
  });

  test('the Marathi labels from the phone test render as one whole label with no line cap', () => {
    const cases = [
      { variant: 'parent', label: mr.save },
      { variant: 'parentGhost', label: mr.notNow },
      { variant: 'parent', label: mr.assignTitle },
      { variant: 'parent', label: mr.setupTitle },
      { variant: 'parentGhost', label: mr.backToChildren },
      { variant: 'parentGhost', label: mr.addChild },
      { variant: 'childPrimary', label: mr.letsStart },
    ] as const;
    for (const c of cases) {
      render(createElement(Button, { variant: c.variant, label: c.label, onPress: jest.fn() }));
      const { labelProps, label } = buttonParts(c.label); // found by its full text: every word is in one Text
      for (const cap of LINE_CAPS) expect(labelProps[cap]).toBeUndefined();
      expect({ label: c.label, alignSelf: label.alignSelf, textAlign: label.textAlign }).toEqual({
        label: c.label,
        alignSelf: 'stretch',
        textAlign: 'center',
      });
      screen.unmount();
    }
  });

  test('a label too long for one line can wrap in full: the box grows from its minimum height and clips nothing', () => {
    const long = `${mr.backToChildren} ${mr.backToChildren}`; // about 40 characters
    const minimum = {
      childPrimary: theme.touch.child.mainButton,
      childSecondary: theme.touch.child.min,
      parent: theme.touch.parent.min,
      parentGhost: theme.touch.parent.min,
    };
    for (const variant of BUTTON_VARIANTS) {
      render(createElement(Button, { variant, label: long, onPress: jest.fn() }));
      const { labelProps, label, box } = buttonParts(long);
      for (const cap of LINE_CAPS) expect(labelProps[cap]).toBeUndefined();
      expect(box.minHeight).toBe(minimum[variant]);
      expect(box.height).toBeUndefined();
      expect(box.maxHeight).toBeUndefined();
      expect(box.overflow).not.toBe('hidden');
      expect(label.height).toBeUndefined();
      expect(label.maxHeight).toBeUndefined();
      // The wrapped lines are measured and centred across the box, not across a shrunk label.
      expect({ variant, alignSelf: label.alignSelf, textAlign: label.textAlign }).toEqual({
        variant,
        alignSelf: 'stretch',
        textAlign: 'center',
      });
      screen.unmount();
    }
  });

  test('the label keeps its type style and colour from the theme: the fix adds no size, family or colour', () => {
    const { font, color } = theme;
    const looks = {
      childPrimary: { type: font.child.mainButton, colour: color.child.onPrimary },
      childSecondary: { type: font.child.button, colour: color.child.text },
      parent: { type: font.parent.section, colour: color.parent.onAccent },
      parentGhost: { type: font.parent.section, colour: color.parent.accent },
    };
    for (const variant of BUTTON_VARIANTS) {
      render(createElement(Button, { variant, label: mr.save, onPress: jest.fn() }));
      const { label } = buttonParts(mr.save);
      const { type, colour } = looks[variant];
      expect(label).toMatchObject({
        fontFamily: type.family,
        fontSize: type.size,
        lineHeight: type.lineHeight,
        color: colour,
        alignSelf: 'stretch',
        textAlign: 'center',
      });
      for (const size of ['width', 'minWidth', 'maxWidth', 'fontWeight', 'letterSpacing']) expect(label[size]).toBeUndefined();
      screen.unmount();
    }
  });

  test('a disabled Button does not press, and its label is laid out the same way', () => {
    const onPress = jest.fn();
    render(createElement(Button, { variant: 'parent', label: mr.notNow, onPress, disabled: true }));
    fireEvent.press(screen.getByText(mr.notNow));
    expect(onPress).not.toHaveBeenCalled();
    const { labelProps, label } = buttonParts(mr.notNow);
    for (const cap of LINE_CAPS) expect(labelProps[cap]).toBeUndefined();
    expect(label).toMatchObject({ alignSelf: 'stretch', textAlign: 'center' });
  });

  test('the fix sits in Button: a plain Text keeps its natural width and alignment', () => {
    render(createElement(Button, { variant: 'parentGhost', label: mr.notNow, onPress: jest.fn() }));
    expect(buttonParts(mr.notNow).label).toMatchObject({ alignSelf: 'stretch', textAlign: 'center' });
    screen.unmount();

    render(createElement(Text, null, mr.notNow));
    const plain = flat(screen.getByText(mr.notNow).props.style);
    expect(plain.alignSelf).toBeUndefined();
    expect(plain.textAlign).toBeUndefined();
  });

  // Contract for GURU-43's output_for_dependents (no dependent issue). Shape only.
  test('contract (GURU-43): Button props unchanged, no new exports, label Text has the fix styles and no numberOfLines', () => {
    expect(Object.keys(ButtonModule)).toEqual(['Button']);

    // Exactly these props: a new required prop fails `npm run typecheck` here.
    const props: Parameters<typeof Button>[0] = {
      variant: 'parent',
      label: 'contract',
      onPress: () => {},
      disabled: false,
      testID: 'contract-button',
    };
    render(createElement(Button, props));
    expect(screen.getByTestId('contract-button')).toBeTruthy();
    const { labelProps, label } = buttonParts('contract');
    expect(labelProps).not.toHaveProperty('numberOfLines');
    expect(label).toHaveProperty('alignSelf');
    expect(label).toHaveProperty('textAlign');
    screen.unmount();

    render(createElement(Button, { variant: 'childPrimary', label: 'required-only', onPress: () => {} }));
    expect(screen.getByRole('button', { name: 'required-only' })).toBeTruthy();
  });
});
