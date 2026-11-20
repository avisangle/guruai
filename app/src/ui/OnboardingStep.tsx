// Frame of a first-run screen: the parent-mode bar with the step count, then scrolling content.
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Screen } from './components/Screen';
import { Text } from './components/Text';
import { useT } from './i18n';
import { theme } from './theme';

const { color, space } = theme;

type Props = { step: 1 | 2 | 3; children?: ReactNode };

export function OnboardingStep({ step, children }: Props) {
  const { t } = useT();
  return (
    <Screen variant="parent" style={styles.screen}>
      <View style={styles.bar}>
        <Text variant="label" style={styles.barText}>{`${t('forParents')} · ${step} / 3`}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { paddingHorizontal: 0 },
  bar: { backgroundColor: color.parent.accent, paddingHorizontal: space.screenGutterParent, paddingVertical: space[2] },
  barText: { color: color.parent.onAccent },
  content: { padding: space.screenGutterParent, gap: space[4] },
});
