// Downloads (wireframes pm-downloads, pm-downloads-resume), opened from Settings: overall progress, a
// row per file, resume for a failed file, the mobile-data switch, and the storage prompt when space is short.
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { getDevice, updateDevice } from '../../data/device';
import { liveDb } from '../../data/liveDb';
import { queuePacks, startInitialDownloads, type DownloadItem } from '../../downloads/downloader';
import { toMb } from '../../downloads/plan';
import { allInstalled, useDownloads } from '../../downloads/useDownloads';
import { useParentMode } from '../../parent/ParentModeProvider';
import { SwitchRow } from '../../ui/components/SwitchRow';
import { StoragePrompt } from '../../parent/StoragePrompt';
import { Button } from '../../ui/components/Button';
import { Screen } from '../../ui/components/Screen';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { theme } from '../../ui/theme';

const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);
const bytesText = (t: ReturnType<typeof useT>['t'], done: number, total: number) => t('downloadsBytes', { done: toMb(done), total: toMb(total) });

export default function DownloadsScreen() {
  const { t } = useT();
  const { exit } = useParentMode();
  const status = useDownloads();
  const [mobileData, setMobileData] = useState(() => getDevice(liveDb()).allow_mobile_data);

  const done = status.items.reduce((sum, i) => sum + i.bytesDone, 0);
  const total = status.items.reduce((sum, i) => sum + i.bytesTotal, 0);
  const pct = percent(done, total);
  const allDone = allInstalled(status);
  const overall = status.waitingForWifi
    ? t('downloadsOverallWifi', { pct })
    : allDone
      ? t('downloadsDone')
      : t('downloadsOverall', { pct });

  // The model's id comes from the manifest; packs show their id.
  const labelOf = (id: string) => (status.items.find((i) => i.id === id)?.kind === 'model' ? t('downloadsModel') : id);

  const changeMobileData = (on: boolean) => {
    updateDevice(liveDb(), { allow_mobile_data: on }); // before the kick: the downloader re-reads it
    setMobileData(on);
    if (on) queuePacks([]).catch(() => undefined); // wakes downloads waiting for Wi-Fi
  };

  return (
    <Screen variant="parent">
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="title">{t('downloadsLabel')}</Text>

        {status.plan?.kind === 'needs_choice' && <StoragePrompt key={status.plan.fits.join()} plan={status.plan} labelOf={labelOf} />}

        {status.items.length > 0 && ( // nothing queued yet: the storage prompt above says why
          <View testID="downloads-overall" style={styles.card}>
            <Text variant="section">{overall}</Text>
            {!allDone && <Text variant="helper">{bytesText(t, done, total)}</Text>}
            {status.waitingForWifi && <Text variant="helper">{t('downloadsWifiNote')}</Text>}
          </View>
        )}

        <View style={styles.card}>
          {status.items.map((item) => (
            <ItemRow key={item.id} item={item} label={labelOf(item.id)} />
          ))}
          <Text variant="helper">{t('downloadsResumeNote')}</Text>
        </View>

        <View style={styles.card}>
          <SwitchRow testID="downloads-mobile-data" label={t('downloadsMobileData')} value={mobileData} onChange={changeMobileData} />
        </View>
      </ScrollView>
      <Button variant="parentGhost" label={t('backToChildren')} onPress={exit} />
    </Screen>
  );
}

/** One file: percent while downloading, done, queued, or failed with resume. */
function ItemRow({ item, label }: { item: DownloadItem; label: string }) {
  const { t } = useT();
  const resume = () => (item.kind === 'model' ? startInitialDownloads() : queuePacks([item.id])).catch(() => undefined);
  // While downloading, the percent follows the bytes on the size line.
  const size =
    item.status === 'downloading'
      ? `${bytesText(t, item.bytesDone, item.bytesTotal)} · ${percent(item.bytesDone, item.bytesTotal)}%`
      : t('downloadsSize', { mb: toMb(item.bytesTotal) });
  const state = {
    downloading: null,
    installed: t('done'),
    queued: t('downloadsItemQueued'),
    failed: t('downloadsItemFailed'),
  }[item.status];

  return (
    <View testID={`downloads-item-${item.id}`} style={styles.line}>
      <View style={styles.grow}>
        <Text variant="label">{label}</Text>
        <Text variant="helper">{size}</Text>
        {item.status === 'failed' && <Text variant="helper">{state}</Text>}
      </View>
      {item.status === 'failed' ? (
        <Button testID={`downloads-resume-${item.id}`} variant="parentGhost" label={t('downloadsResume')} onPress={resume} />
      ) : (
        state && (
          <Text variant="label" style={item.status === 'installed' && styles.accent}>
            {state}
          </Text>
        )
      )}
    </View>
  );
}

const { color, radius, space, touch } = theme;

const styles = StyleSheet.create({
  body: { gap: space[4], paddingVertical: space[4] },
  card: {
    gap: space[2],
    padding: space[4],
    borderRadius: radius.parent.card,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.parent.min },
  grow: { flex: 1 },
  accent: { color: color.parent.accent },
});
