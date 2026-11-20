import { Pressable, StyleSheet } from 'react-native';

import { theme } from '../theme';
import { Text } from './Text';

export type ButtonVariant = 'childPrimary' | 'childSecondary' | 'parent';

type Props = { variant: ButtonVariant; label: string; onPress: () => void };

const { color, font, radius, space, touch } = theme;

const looks = {
  childPrimary: { font: font.child.mainButton, color: color.child.onPrimary },
  childSecondary: { font: font.child.button, color: color.child.text },
  parent: { font: font.parent.section, color: color.parent.onAccent },
};

export function Button({ variant, label, onPress }: Props) {
  const look = looks[variant];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.base, styles[variant], pressed && styles.pressed]}
    >
      <Text
        style={{ fontFamily: look.font.family, fontSize: look.font.size, lineHeight: look.font.lineHeight, color: look.color }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: space[4] },
  childPrimary: {
    backgroundColor: color.child.primary,
    minHeight: touch.child.mainButton,
    borderRadius: radius.child.mainButton,
  },
  // A tappable edge on the child background needs borderStrong (tokens: 3:1).
  childSecondary: {
    backgroundColor: color.child.surface,
    minHeight: touch.child.min,
    borderRadius: radius.child.tile,
    borderWidth: 2,
    borderColor: color.child.borderStrong,
  },
  parent: { backgroundColor: color.parent.accent, minHeight: touch.parent.min, borderRadius: radius.parent.control },
  pressed: { opacity: 0.8 },
});
