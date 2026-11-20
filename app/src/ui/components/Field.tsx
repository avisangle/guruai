import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { theme } from '../theme';
import { Text } from './Text';

const { color, font, radius, space, touch } = theme;

type Props = TextInputProps & { label: string };

/** A labelled parent-mode text input. */
export function Field({ label, style, ...input }: Props) {
  return (
    <View style={styles.wrap}>
      <Text variant="label">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.parent.textMuted}
        style={[styles.input, style]}
        {...input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[1] },
  input: {
    minHeight: touch.parent.min,
    paddingHorizontal: space[3],
    borderRadius: radius.parent.control,
    borderWidth: 2,
    borderColor: color.parent.borderStrong,
    backgroundColor: color.parent.surface,
    color: color.parent.text,
    fontFamily: font.parent.body.family,
    fontSize: font.parent.body.size,
  },
});
