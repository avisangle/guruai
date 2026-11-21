// Parent-mode status row (label and value, no switch). The on/off row is ui/components/SwitchRow.
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

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

const { space, touch } = theme;

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.parent.min },
  grow: { flex: 1 },
});
