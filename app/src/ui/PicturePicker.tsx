// The fixed set of child pictures (M1); a picture a sibling uses is disabled.
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from './components/Text';
import { theme } from './theme';

const { color, radius, touch } = theme;

export const CHILD_PICTURES: Record<string, string> = {
  peacock: '🦚',
  elephant: '🐘',
  tiger: '🐯',
  rabbit: '🐰',
  parrot: '🦜',
  lion: '🦁',
  turtle: '🐢',
  butterfly: '🦋',
};

type Props = { value?: string | null; onChange: (id: string) => void; taken?: string[] };

export function PicturePicker({ value, onChange, taken = [] }: Props) {
  return (
    <View style={styles.row}>
      {Object.entries(CHILD_PICTURES).map(([id, glyph]) => {
        const disabled = taken.includes(id);
        const selected = value === id;
        return (
          <Pressable
            key={id}
            testID={`picture-${id}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            disabled={disabled}
            onPress={() => onChange(id)}
            style={[styles.tile, selected && styles.selected, disabled && styles.disabled]}
          >
            <Text variant="title" style={styles.glyph}>
              {glyph}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: touch.parent.gap },
  tile: {
    width: touch.parent.keypadKey,
    height: touch.parent.keypadKey,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.parent.card,
    borderWidth: 2,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  selected: { borderColor: color.parent.accent, backgroundColor: color.parent.accentSurface },
  disabled: { opacity: 0.3 },
  glyph: { textAlign: 'center' },
});
