// Consent prompt (wireframe pm-consent, decision 12): two separate switches, off until the parent turns
// them on. Save stores them as set; Not now stores both off. Either answer ends the question.
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';

import { answerConsent, getDevice } from '../../data/device';
import { liveDb } from '../../data/liveDb';
import { Button } from '../../ui/components/Button';
import { Screen } from '../../ui/components/Screen';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import type { StringKey } from '../../ui/strings/mr';
import { theme } from '../../ui/theme';

export default function ConsentScreen() {
  const { t } = useT();
  const [stored] = useState(() => getDevice(liveDb()));
  const [clips, setClips] = useState(stored.consent_clips ?? false);
  const [summaries, setSummaries] = useState(stored.consent_summaries ?? false);

  const answer = (consent: { clips: boolean; summaries: boolean }) => {
    answerConsent(liveDb(), consent);
    router.dismissTo('/parent');
  };

  return (
    <Screen variant="parent">
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="title">{t('consentTitle')}</Text>
        <Text>{t('consentOnPhone')}</Text>
        <Choice testID="consent-clips" title="consentClips" body="consentClipsBody" value={clips} onChange={setClips} />
        <Choice
          testID="consent-summaries"
          title="consentSummaries"
          body="consentSummariesBody"
          value={summaries}
          onChange={setSummaries}
        />
        <Text testID="consent-what-is-sent" variant="small">
          {t('consentWhatIsSent')}
        </Text>
        <Button variant="parent" label={t('save')} onPress={() => answer({ clips, summaries })} />
        <Button variant="parentGhost" label={t('notNow')} onPress={() => answer({ clips: false, summaries: false })} />
      </ScrollView>
    </Screen>
  );
}

type ChoiceProps = { testID: string; title: StringKey; body: StringKey; value: boolean; onChange: (on: boolean) => void };

function Choice({ testID, title, body, value, onChange }: ChoiceProps) {
  const { t } = useT();
  return (
    <View style={styles.choice}>
      <View style={styles.choiceText}>
        <Text variant="section">{t(title)}</Text>
        <Text variant="small">{t(body)}</Text>
      </View>
      <Switch
        testID={testID}
        accessibilityLabel={t(title)}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: color.parent.border, true: color.parent.accent }}
        thumbColor={color.parent.surface}
      />
    </View>
  );
}

const { color, radius, space } = theme;

const styles = StyleSheet.create({
  body: { gap: space[4], paddingVertical: space[5] },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    padding: space[4],
    borderRadius: radius.parent.card,
    backgroundColor: color.parent.surface,
    borderWidth: 1,
    borderColor: color.parent.border,
  },
  choiceText: { flex: 1, gap: space[1] },
});
