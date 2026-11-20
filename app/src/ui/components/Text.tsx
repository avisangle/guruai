import { Text as RNText, type TextProps } from 'react-native';

import { theme, type Mode, type TextStyleToken } from '../theme';

type Props = TextProps &
  (
    | { mode?: 'parent'; variant?: keyof typeof theme.font.parent }
    | { mode: 'child'; variant?: keyof typeof theme.font.child }
  );

const DEFAULT_VARIANT = { child: 'caption', parent: 'body' } as const;

/** Text in a type style from the tokens; parent body unless told otherwise. */
export function Text({ mode = 'parent', variant, style, ...rest }: Props) {
  const fonts: Record<string, TextStyleToken> = theme.font[mode as Mode];
  const f = fonts[variant ?? DEFAULT_VARIANT[mode]];
  return (
    <RNText
      style={[{ fontFamily: f.family, fontSize: f.size, lineHeight: f.lineHeight, color: theme.color[mode].text }, style]}
      {...rest}
    />
  );
}
