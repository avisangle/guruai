import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../theme';
import { Text } from './Text';

const { color, radius, space, touch } = theme;

type Props = { label: string; help?: string; checked: boolean; onPress: () => void; testID: string };

/** A tick box: the tick and a thicker edge show the choice, not colour alone. */
export function TickBox({ label, help, checked, onPress, testID }: Props) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[styles.base, checked && styles.on]}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked && (
          <Text variant="label" style={styles.mark}>
            ✓
          </Text>
        )}
      </View>
      <View style={styles.text}>
        <Text variant="label">{label}</Text>
        {help ? <Text variant="helper">{help}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: touch.parent.min,
    padding: space[3],
    borderRadius: radius.parent.control,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  on: { borderWidth: 2, borderColor: color.parent.accent },
  box: {
    width: space[5],
    height: space[5],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.parent.control,
    borderWidth: 2,
    borderColor: color.parent.borderStrong,
  },
  boxOn: { borderColor: color.parent.accent, backgroundColor: color.parent.accent },
  mark: { color: color.parent.onAccent },
  text: { flex: 1 },
});
