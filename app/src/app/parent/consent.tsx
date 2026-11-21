// Consent prompt (wireframe pm-consent, decision 12): two separate switches, off until the parent turns
// them on. Save stores them as set; Not now stores both off. Either answer ends the question.
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { answerConsent, getDevice } from '../../data/device';
import { liveDb } from '../../data/liveDb';
import { consentChanged } from '../../upload/uploadQueue';
import { Button } from '../../ui/components/Button';
import { Screen } from '../../ui/components/Screen';
import { SwitchRow } from '../../ui/components/SwitchRow';
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
    consentChanged(); // D-GURU-38-upload-queue: after any consent write
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
    <SwitchRow testID={testID} label={t(title)} value={value} onChange={onChange} style={styles.choice}>
      <Text variant="section">{t(title)}</Text>
      <Text variant="small">{t(body)}</Text>
    </SwitchRow>
  );
}

const { color, radius, space } = theme;

const styles = StyleSheet.create({
  body: { gap: space[4], paddingVertical: space[5] },
  choice: {
    padding: space[4],
    borderRadius: radius.parent.card,
    backgroundColor: color.parent.surface,
    borderWidth: 1,
    borderColor: color.parent.border,
  },
});
