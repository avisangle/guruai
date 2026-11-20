// Typed view of design/foundations/tokens.json (copied by `npm run build:theme`).
// Components take every colour, size and touch target from here.
import { faces, type FontName } from './fonts';
import tokens from './generated/tokens.json';

export type TextStyleToken = { family: FontName; size: number; lineHeight: number };

function mapValues<T extends object, R>(obj: T, fn: (value: T[keyof T], name: string) => R): { [K in keyof T]: R } {
  return Object.fromEntries(Object.entries(obj).map(([name, value]) => [name, fn(value, name)])) as { [K in keyof T]: R };
}

function textStyle(f: { size: number; lineHeight: number; weight: number; family: string }, name: string): TextStyleToken {
  const family = faces[f.family as keyof typeof faces]?.[f.weight];
  if (!family) throw new Error(`theme: no loaded font for ${f.family} ${f.weight} (font.${name})`);
  return { family, size: f.size, lineHeight: f.lineHeight };
}

export const theme = {
  color: {
    child: mapValues(tokens.color.child, (t) => t.value),
    parent: mapValues(tokens.color.parent, (t) => t.value),
  },
  font: { child: mapValues(tokens.font.child, textStyle), parent: mapValues(tokens.font.parent, textStyle) },
  space: tokens.space,
  radius: tokens.radius,
  touch: tokens.touch,
};

export type Mode = keyof typeof theme.color;
