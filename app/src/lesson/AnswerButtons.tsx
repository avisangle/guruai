// "Parent helps" in the lesson's control zone (wireframes h-talking, h-lesson): during the answer turn,
// a strip in the parent palette with बरोबर / चूक / शांत for the adult; while Shekru speaks, a dashed
// adult outline where the closed mic would be. Text follows the parent language.
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';

import { ADULT, CHECK, CROSS, DOTS, Icon } from '../ui/icons';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import type { StringKey } from '../ui/strings/mr';
import { theme } from '../ui/theme';
import type { Answer } from './types';

const { color, radius, space, touch } = theme;

// correct: green edge; wrong: plain dark edge, not red (wireframe h-lesson)
const BUTTONS: { answer: Answer; label: StringKey; icon: string; edge?: ViewStyle }[] = [
  { answer: 'correct', label: 'helpsCorrect', icon: CHECK, edge: { borderColor: color.child.success } },
  { answer: 'wrong', label: 'helpsWrong', icon: CROSS, edge: { borderColor: color.child.borderStrong } },
  { answer: 'silent', label: 'helpsSilent', icon: DOTS },
];

export function AnswerButtons({ onAnswer }: { onAnswer(answer: Answer): void }) {
  const { t } = useT();
  return (
    <View style={styles.strip} testID="parent-answers">
      <View style={styles.head}>
        <Icon d={ADULT} size={space[4]} color={color.parent.accent} />
        <Text variant="small">{t('helpsStrip')}</Text>
      </View>
      <View style={styles.row}>
        {BUTTONS.map(({ answer, label, icon, edge }) => (
          <Pressable
            key={answer}
            testID={`parent-answer-${answer}`}
            accessibilityRole="button"
            onPress={() => onAnswer(answer)}
            style={[styles.button, edge]}>
            <Icon d={icon} size={space[5]} color={color.child.text} />
            <Text mode="child" variant="button">{t(label)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The control zone while Shekru speaks with the switch on: a sign, not a control. */
export function AdultOutline() {
  return (
    <View style={styles.outline} testID="parent-helps-idle">
      <Icon d={ADULT} size={space[6]} color={color.child.borderStrong} />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    alignSelf: 'stretch', maxWidth: 560, width: '100%', gap: space[2], padding: space[2],
    borderRadius: radius.parent.card, borderWidth: 1, borderColor: color.parent.border, backgroundColor: color.parent.surface,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  row: { flexDirection: 'row', gap: touch.child.gap },
  button: {
    flex: 1, flexDirection: 'row', gap: space[1], minHeight: touch.child.min, borderRadius: radius.child.chip, borderWidth: 2,
    borderColor: color.child.border, backgroundColor: color.child.surface, alignItems: 'center', justifyContent: 'center',
  },
  outline: {
    width: touch.child.min, height: touch.child.min, borderRadius: radius.child.round, borderWidth: 2, borderStyle: 'dashed',
    borderColor: color.child.borderStrong, alignItems: 'center', justifyContent: 'center',
  },
});
