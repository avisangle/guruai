import { Pressable, StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

import { theme } from '../theme';
import { Text, type TextLook } from './Text';

const { color, radius, space, touch } = theme;

type Look = { text: TextLook; label: TextStyle; box: ViewStyle };

const variants = {
  childPrimary: {
    text: { mode: 'child', variant: 'mainButton' },
    label: { color: color.child.onPrimary },
    box: { backgroundColor: color.child.primary, minHeight: touch.child.mainButton, borderRadius: radius.child.mainButton },
  },
  // A tappable edge on the child background needs borderStrong (tokens: 3:1).
  childSecondary: {
    text: { mode: 'child', variant: 'button' },
    label: { color: color.child.text },
    box: {
      backgroundColor: color.child.surface,
      minHeight: touch.child.min,
      borderRadius: radius.child.tile,
      borderWidth: 2,
      borderColor: color.child.borderStrong,
    },
  },
  parent: {
    text: { mode: 'parent', variant: 'section' },
    label: { color: color.parent.onAccent },
    box: { backgroundColor: color.parent.accent, minHeight: touch.parent.min, borderRadius: radius.parent.control },
  },
} satisfies Record<string, Look>;

export type ButtonVariant = keyof typeof variants;

type Props = { variant: ButtonVariant; label: string; onPress: () => void; disabled?: boolean; testID?: string };

export function Button({ variant, label, onPress, disabled, testID }: Props) {
  const look: Look = variants[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.base, look.box, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text {...look.text} style={look.label}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[4] },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
});
