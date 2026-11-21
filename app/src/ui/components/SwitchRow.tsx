import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../theme';
import { Text } from './Text';

const { color, space, touch } = theme;

type Props = {
  testID: string;
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  /** Replaces the plain label as the row's text; `label` still names the switch. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** A parent-mode on/off row. The whole row toggles; not accessible itself, so TalkBack still reaches the switch. */
export function SwitchRow({ testID, label, value, onChange, children, style }: Props) {
  return (
    <Pressable accessible={false} onPress={() => onChange(!value)} style={[styles.row, style]}>
      <View style={styles.text}>{children ?? <Text variant="label">{label}</Text>}</View>
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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.parent.min },
  text: { flex: 1, gap: space[1] },
});
