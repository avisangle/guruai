// Parent-mode setting rows shared by Settings and Downloads.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Text } from '../ui/components/Text';
import { theme } from '../ui/theme';

type StatusProps = { testID?: string; label: string; value: string; children?: ReactNode };

/** A label and its status; no switch. */
export function StatusRow({ testID, label, value, children }: StatusProps) {
  return (
    <View testID={testID} style={styles.line}>
      <View style={styles.grow}>
        <Text variant="label">{label}</Text>
        <Text variant="helper">{value}</Text>
      </View>
      {children}
    </View>
  );
}

type SwitchProps = { testID: string; label: string; value: boolean; onChange: (on: boolean) => void };

/** The whole row toggles; not accessible itself, so TalkBack still reaches the switch. */
export function SwitchRow({ testID, label, value, onChange }: SwitchProps) {
  return (
    <Pressable accessible={false} onPress={() => onChange(!value)} style={styles.line}>
      <Text variant="label" style={styles.grow}>
        {label}
      </Text>
      <Switch
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: color.parent.border, true: color.parent.accent }}
        thumbColor={color.parent.surface}
      />
    </Pressable>
  );
}

const { color, space, touch } = theme;

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.parent.min },
  grow: { flex: 1 },
});
