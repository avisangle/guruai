// A small strip for the adult at the bottom of a child screen (wireframes c-ask-mic, l-goodbye).
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import type { StringKey } from '../ui/strings/mr';
import { theme } from '../ui/theme';

type Props = { label: StringKey; testID?: string; onPress?: () => void };

export function ParentStrip({ label, testID, onPress }: Props) {
  const { t } = useT();
  const text = <Text variant="small">{t(label)}</Text>;
  return onPress ? (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={[styles.strip, styles.pressable]}>
      {text}
    </Pressable>
  ) : (
    <View testID={testID} style={styles.strip}>
      {text}
    </View>
  );
}

const { color, radius, space, touch } = theme;

const styles = StyleSheet.create({
  strip: {
    padding: space[3],
    marginBottom: space[3],
    borderRadius: radius.parent.card,
    backgroundColor: color.parent.surface,
    borderWidth: 1,
    borderColor: color.parent.border,
  },
  pressable: { minHeight: touch.parent.min, justifyContent: 'center' },
});
