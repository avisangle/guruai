import { Pressable, StyleSheet } from 'react-native';

import { theme } from '../theme';
import { Text } from './Text';

const { color, radius, space, touch } = theme;

type Props = {
  label: string;
  help?: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
};

/** One option of a parent-mode single choice (radio). */
export function Choice({ label, help, selected, onPress, disabled, testID }: Props) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.base, selected && styles.selected, disabled && styles.disabled]}
    >
      <Text variant="label">{label}</Text>
      {help ? (
        <Text variant="helper" style={styles.help}>
          {help}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touch.parent.min,
    justifyContent: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.parent.control,
    borderWidth: 2,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  selected: { borderColor: color.parent.accent, backgroundColor: color.parent.accentSurface },
  disabled: { opacity: 0.4 },
  help: { color: color.parent.textMuted },
});
