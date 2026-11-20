import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { theme, type Mode } from '../theme';

type Props = { variant: Mode; children?: ReactNode; style?: StyleProp<ViewStyle> };

/** Full-screen safe-area container with the mode's background and gutter. */
export function Screen({ variant, children, style }: Props) {
  return <SafeAreaView style={[styles.base, styles[variant], style]}>{children}</SafeAreaView>;
}

const styles = StyleSheet.create({
  base: { flex: 1 },
  child: { backgroundColor: theme.color.child.background, paddingHorizontal: theme.space.screenGutterChild },
  parent: { backgroundColor: theme.color.parent.background, paddingHorizontal: theme.space.screenGutterParent },
});
