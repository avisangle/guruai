// First run 3 of 3: who is learning, then the hand-over. Everything not asked here takes its
// default (board msb, goals from class, style from medium, 3 lessons a day, Shekru).
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { liveDb } from '../../data/liveDb';
import { createChild, updateChild } from '../../data/profiles';
import type { Medium } from '../../data/types';
import { queueChildPacks } from '../../downloads/downloader';
import { ensureEnrolment } from '../../learning/enrol';
import { useFirstRun } from '../../onboarding/firstRun';
import { liveGate } from '../../parent/live';
import { askForMic } from '../../parent/mic';
import { CLASSES, DEFAULT_GOALS } from '../../parent/profile';
import type { GateMode } from '../../parent/gate';
import { Button } from '../../ui/components/Button';
import { Choice } from '../../ui/components/Choice';
import { Field } from '../../ui/components/Field';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { OnboardingStep } from '../../ui/OnboardingStep';
import { PicturePicker } from '../../ui/PicturePicker';
import { theme } from '../../ui/theme';

type ClassName = (typeof CLASSES)[number];

export default function Who() {
  const { t } = useT();
  const { childAdded } = useFirstRun();
  const [nickname, setNickname] = useState('');
  const [picture, setPicture] = useState<string | null>(null);
  const [cls, setCls] = useState<ClassName | null>(null);
  const [medium, setMedium] = useState<Medium | null>(null);
  const [gateMode, setGateMode] = useState<GateMode>('device');
  const busy = useRef(false);

  useEffect(() => {
    liveGate()
      .mode()
      .then(setGateMode)
      .catch(() => undefined);
  }, []);

  const name = nickname.trim();
  const complete = name !== '' && picture !== null && cls !== null && medium !== null;

  // Save, enrol, queue packs, then ask for the mic while the adult still holds the phone.
  async function handOver() {
    if (!complete || busy.current) return;
    busy.current = true;
    const db = liveDb();
    const created = createChild(db, { nickname: name, picture, class: cls, medium });
    const child = updateChild(db, created.id, { goals: DEFAULT_GOALS[cls] ?? [] })!;
    ensureEnrolment(db, child);
    queueChildPacks(child).catch(() => undefined); // background; the downloader retries on next start
    await askForMic(db); // a refusal or a failed request still hands over
    childAdded(); // the root guards now send the app to the child picker
  }

  return (
    <OnboardingStep step={3}>
      <Text variant="title">{t('whoTitle')}</Text>
      <Field testID="who-nickname" label={t('nickname')} value={nickname} onChangeText={setNickname} maxLength={20} />
      <Text variant="label">{t('choosePicture')}</Text>
      <PicturePicker value={picture} onChange={setPicture} />
      <Text variant="helper">{t('pictureHelp')}</Text>
      <Text variant="label">{t('classLabel')}</Text>
      <View style={styles.row}>
        {CLASSES.map((c) => (
          <Choice key={c} testID={`class-${c}`} label={t(`class${c}`)} selected={cls === c} onPress={() => setCls(c)} />
        ))}
      </View>
      <Text variant="label">{t('mediumLabel')}</Text>
      <View style={styles.row}>
        <Choice testID="medium-en" label={t('mediumEn')} selected={medium === 'en'} onPress={() => setMedium('en')} />
        <Choice testID="medium-mr" label={t('mediumMr')} selected={medium === 'mr'} onPress={() => setMedium('mr')} />
      </View>
      <Text variant="helper">{t('defaultsNote')}</Text>
      <Text variant="helper">{t(gateMode === 'pin' ? 'wayBackPin' : 'wayBackDevice')}</Text>
      <Button testID="who-handover" variant="parent" label={t('handOver')} disabled={!complete} onPress={handOver} />
    </OnboardingStep>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.touch.parent.gap },
});
