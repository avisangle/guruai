// Storage prompt (wireframe pm-storage, PRD Edge Cases: not enough storage): shown when storagePlan()
// says needs_choice. Shows the space needed and free, offers the files that fit, and queues nothing
// until the parent presses download.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { queuePacks } from '../downloads/downloader';
import { toMb, type StoragePlan } from '../downloads/plan';
import { Button } from '../ui/components/Button';
import { Text } from '../ui/components/Text';
import { TickBox } from '../ui/components/TickBox';
import { useT } from '../ui/i18n';
import { theme } from '../ui/theme';

type Props = {
  plan: Extract<StoragePlan, { kind: 'needs_choice' }>;
  /** The name shown for a file id. */
  labelOf: (id: string) => string;
};

export function StoragePrompt({ plan, labelOf }: Props) {
  const { t } = useT();
  // All ticked at first: storagePlan() picks `fits` so that they fit together.
  const [ticked, setTicked] = useState<string[]>(plan.fits);

  const flip = (id: string) => setTicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));

  const download = () => {
    const chosen = plan.fits.filter((id) => ticked.includes(id));
    if (chosen.length) queuePacks(chosen).catch(() => undefined);
  };

  return (
    <View testID="storage-prompt" style={styles.card}>
      <Text variant="section">{t('storageTitle')}</Text>
      <View style={styles.space}>
        <Text testID="storage-needed" variant="label">
          {t('storageNeeded', { mb: toMb(plan.needed) })}
        </Text>
        <Text testID="storage-free" variant="label">
          {t('storageFree', { mb: toMb(plan.free) })}
        </Text>
      </View>
      <Text variant="helper">{t('storageFewer')}</Text>
      {plan.fits.map((id) => (
        <TickBox key={id} testID={`storage-pack-${id}`} label={labelOf(id)} checked={ticked.includes(id)} onPress={() => flip(id)} />
      ))}
      <Text variant="helper">{t('storageFreeUp')}</Text>
      <Button testID="storage-download" variant="parent" label={t('storageDownload')} disabled={!ticked.length} onPress={download} />
    </View>
  );
}

const { color, radius, space } = theme;

const styles = StyleSheet.create({
  card: {
    gap: space[2],
    padding: space[4],
    borderRadius: radius.parent.card,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  space: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
});
