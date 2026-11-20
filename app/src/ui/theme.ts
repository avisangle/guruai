// Typed view of design/foundations/tokens.json (copied by `npm run build:theme`).
// Components take every colour, size and touch target from here.
import type { FontName } from './fonts';
import tokens from './generated/tokens.json';

type Palette<T> = { [K in keyof T]: string };
type FontToken = { size: number; lineHeight: number; weight: number; family: string };
export type TextStyleToken = { family: FontName; size: number; lineHeight: number };

// Token family and weight to the loaded face (see fonts.ts).
const FACES: Record<keyof typeof tokens.font.family, Partial<Record<number, FontName>>> = {
  childDisplay: { 700: 'Baloo2_700Bold', 800: 'Baloo2_800ExtraBold' },
  text: {
    400: 'Mukta_400Regular',
    500: 'Mukta_500Medium',
    600: 'Mukta_600SemiBold',
    700: 'Mukta_700Bold',
    800: 'Mukta_800ExtraBold',
  },
};

function palette<T extends Record<string, { value: string }>>(group: T): Palette<T> {
  return Object.fromEntries(Object.entries(group).map(([name, token]) => [name, token.value])) as Palette<T>;
}

function textStyles<T extends Record<string, FontToken>>(group: T): { [K in keyof T]: TextStyleToken } {
  return Object.fromEntries(
    Object.entries(group).map(([name, f]) => {
      const family = FACES[f.family as keyof typeof FACES]?.[f.weight];
      if (!family) throw new Error(`theme: no loaded font for ${f.family} ${f.weight} (font.${name})`);
      return [name, { family, size: f.size, lineHeight: f.lineHeight }];
    }),
  ) as { [K in keyof T]: TextStyleToken };
}

export const theme = {
  color: { child: palette(tokens.color.child), parent: palette(tokens.color.parent) },
  font: { child: textStyles(tokens.font.child), parent: textStyles(tokens.font.parent) },
  space: tokens.space,
  radius: tokens.radius,
  touch: tokens.touch,
};

export type Mode = 'child' | 'parent';
