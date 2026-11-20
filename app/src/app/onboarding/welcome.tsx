// First run 1 of 3: welcome, with the parent-text language switch before anything else.
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button } from '../../ui/components/Button';
import { Choice } from '../../ui/components/Choice';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { OnboardingStep } from '../../ui/OnboardingStep';
import { theme } from '../../ui/theme';

export default function Welcome() {
  const router = useRouter();
  const { t, lang, setLang } = useT();
  return (
    <OnboardingStep step={1}>
      <Text variant="label">{t('langLabel')}</Text>
      <View style={styles.row}>
        <View style={styles.cell}>
          <Choice label={t('langMr')} selected={lang === 'mr'} onPress={() => setLang('mr')} />
        </View>
        <View style={styles.cell}>
          <Choice label={t('langEn')} selected={lang === 'en'} onPress={() => setLang('en')} />
        </View>
      </View>
      <Text variant="title">{t('welcomeTitle')}</Text>
      <Text>{t('welcomeBody')}</Text>
      <Text variant="helper">{`${t('welcomeWho')} ${t('welcomeLater')}`}</Text>
      <Button variant="parent" label={t('getStarted')} onPress={() => router.push('/onboarding/lock')} />
    </OnboardingStep>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: theme.touch.parent.gap },
  cell: { flex: 1 },
});
