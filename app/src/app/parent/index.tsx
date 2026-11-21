// Parent home (wireframes pm-home, pm-home-2, pm-attention): one tab per child, today's progress,
// the attention banner, the "parent helps" switch, the "Finish setting up" card and the lesson sections.
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { judgeReadiness, type JudgeReadiness } from '../../asr/speedCheck';
import { getDevice } from '../../data/device';
import { liveDb } from '../../data/liveDb';
import { listChildren } from '../../data/profiles';
import type { ChildProfile, Device } from '../../data/types';
import { downloadStatus, isLessonInstalled, startInitialDownloads, subscribeDownloads } from '../../downloads/downloader';
import { installKey } from '../../downloads/useDownloads';
import { localDay } from '../../learning/mastery';
import { lessonTitle } from '../../learning/queueInput';
import { attentionBanner, type Banner, type MicState } from '../../parent/attention';
import { loadChildHome, type HomeSection } from '../../parent/home';
import { ADULT, Icon } from '../../parent/icons';
import { askForMic, readMic } from '../../parent/mic';
import { parentHelps, useParentHelps } from '../../parent/parentHelps';
import { useParentMode } from '../../parent/ParentModeProvider';
import { setupRows, type SetupRow, type SetupSection } from '../../parent/setup';
import { Button } from '../../ui/components/Button';
import { Screen } from '../../ui/components/Screen';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { CHILD_PICTURES } from '../../ui/PicturePicker';
import type { StringKey } from '../../ui/strings/mr';
import { theme } from '../../ui/theme';

/** fn(), or the fallback when SQLite or a native module is missing (component tests without them). */
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const downloadsKey = () => attempt(() => installKey(downloadStatus()), '');

type Home = { children: ChildProfile[]; device: Device | null; readiness: JudgeReadiness; downloads: string };

function readHome(): Home {
  const { children, device } = attempt(
    () => {
      const db = liveDb();
      return { children: listChildren(db), device: getDevice(db) as Device | null };
    },
    { children: [], device: null },
  );
  return { children, device, readiness: attempt<JudgeReadiness>(() => judgeReadiness(), 'ready'), downloads: downloadsKey() };
}

const SECTION_TITLE: Record<HomeSection['id'], StringKey> = {
  upNext: 'sectionUpNext',
  waiting: 'sectionWaiting',
  pending: 'sectionPending',
  revision: 'sectionRevision',
  completed: 'sectionCompleted',
};

const SETUP_LABEL: Record<SetupSection, StringKey> = {
  board: 'setupBoard',
  goals_style: 'setupGoalsStyle',
  lessons_per_day: 'setupLessonsPerDay',
};

export default function ParentHome() {
  const { t } = useT();
  const { exit } = useParentMode();
  const [home, setHome] = useState(readHome);
  const [childId, setChildId] = useState<string | null>(null);
  const [mic, setMic] = useState<MicState | null>(null); // null until read: no banner flashes
  const [completedOpen, setCompletedOpen] = useState(false);
  const firstFocus = useRef(true);

  // Reread on every return to this screen (the first focus has the initial read), so a saved
  // profile or consent leaves the setup card.
  useFocusEffect(
    useCallback(() => {
      if (!firstFocus.current) setHome(readHome());
      firstFocus.current = false;
      readMic().then(setMic);
    }, []),
  );

  // An installed model or pack updates the banner and the sections without leaving the screen.
  useEffect(
    () =>
      attempt(
        () =>
          subscribeDownloads(() => {
            const key = downloadsKey();
            setHome((h) => (h.downloads === key ? h : readHome()));
          }),
        undefined,
      ),
    [],
  );

  const child = home.children.find((c) => c.id === childId) ?? home.children[0];
  const data = useMemo(
    () => (child ? attempt(() => loadChildHome(liveDb(), child, localDay(new Date().toISOString()), isLessonInstalled), null) : null),
    [child],
  );
  const banner = mic && attentionBanner({ readiness: home.readiness, mic, micLastGrantedAt: home.device?.mic_last_granted_at ?? null });
  const rows = child && home.device ? setupRows(child, home.device) : [];

  const act = async (b: Banner) => {
    if (b.action === 'resumeDownload') startInitialDownloads().catch(() => undefined);
    else if (b.action === 'openSettings') Linking.openSettings().catch(() => undefined);
    else if (b.action === 'requestPermission') {
      const next = await askForMic(liveDb()); // null: the dialog failed to open; the banner stays
      if (next) setMic(next);
    }
  };

  const selectChild = (id: string) => {
    setChildId(id);
    setCompletedOpen(false);
  };

  return (
    <Screen variant="parent">
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.tabs} accessibilityRole="tablist">
          {home.children.map((c) => {
            const on = c.id === child?.id;
            return (
              <Pressable
                key={c.id}
                testID={`child-tab-${c.id}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => selectChild(c.id)}
                style={[styles.tab, on && styles.tabOn]}
              >
                <Text variant="section">{CHILD_PICTURES[c.picture] ?? ''}</Text>
                <Text variant="label">{c.nickname}</Text>
              </Pressable>
            );
          })}
        </View>

        {banner && <AttentionBanner banner={banner} onAction={() => act(banner)} />}

        {child && <ParentHelpsCard childId={child.id} />}

        {data && (
          <View testID="today-progress" style={styles.card}>
            <Text variant="helper">{t('todayProgress', { done: data.done, goal: data.goal })}</Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(100, (data.done / Math.max(1, data.goal)) * 100)}%` }]} />
            </View>
          </View>
        )}

        {child && rows.length > 0 && <SetupCard child={child} rows={rows} />}

        {child && (
          <>
            <Button
              testID="home-assign"
              variant="parent"
              label={t('assignTitle')}
              onPress={() => router.push(`/parent/assign/${child.id}`)}
            />
            <Button
              testID="home-report"
              variant="parentGhost"
              label={t('reportTitle')}
              onPress={() => router.push(`/parent/report/${child.id}`)}
            />
          </>
        )}

        {data?.sections.map((section) => (
          <Section
            key={section.id}
            section={section}
            assigned={data.assigned}
            open={section.id !== 'completed' || completedOpen}
            onToggle={() => setCompletedOpen((v) => !v)}
          />
        ))}
      </ScrollView>
      <Button testID="home-settings" variant="parentGhost" label={t('settingsTitle')} onPress={() => router.push('/parent/settings')} />
      <Button variant="parentGhost" label={t('backToChildren')} onPress={exit} />
    </Screen>
  );
}

function bannerText(banner: Banner): { title: StringKey; body: StringKey; action?: StringKey } {
  switch (banner.kind) {
    case 'model':
      return { title: 'bannerModelTitle', body: 'bannerModelBody', action: 'bannerModelAction' };
    case 'weak':
      return { title: 'bannerWeakTitle', body: 'bannerWeakBody' };
    case 'mic':
      return banner.action === 'openSettings'
        ? { title: 'bannerMicTitle', body: 'bannerMicSettings', action: 'bannerMicSettingsAction' }
        : { title: 'bannerMicTitle', body: banner.chooseWhileUsing ? 'bannerMicWhileUsing' : 'bannerMicBody', action: 'bannerMicAction' };
  }
}

function AttentionBanner({ banner, onAction }: { banner: Banner; onAction: () => void }) {
  const { t } = useT();
  const { title, body, action } = bannerText(banner);
  return (
    <View
      testID="attention-banner"
      accessibilityRole="alert"
      style={[styles.card, banner.kind === 'weak' ? styles.bannerInfo : styles.bannerWarn]}
    >
      <Text variant="label">{t(title)}</Text>
      <Text>{t(body)}</Text>
      {action && <Button testID="attention-action" variant="parent" label={t(action)} onPress={onAction} />}
    </View>
  );
}

/** The "parent helps" switch for one child (D-GURU-34-parent-helps). */
function ParentHelpsCard({ childId }: { childId: string }) {
  const { t } = useT();
  const on = useParentHelps(childId);
  return (
    <View testID="parent-helps" style={[styles.card, styles.row]}>
      <View style={styles.grow}>
        <View style={styles.title}>
          <Icon d={ADULT} size={space[5]} color={color.parent.accent} />
          <Text variant="label">{t('helpsTitle')}</Text>
        </View>
        <Text variant="helper">{t(on ? 'helpsHelpOn' : 'helpsHelpOff')}</Text>
      </View>
      <Switch
        testID="parent-helps-switch"
        accessibilityLabel={t('helpsTitle')}
        value={on}
        onValueChange={(value) => parentHelps.set(childId, value)}
        trackColor={{ false: color.parent.border, true: color.parent.accent }}
        thumbColor={color.parent.surface}
      />
    </View>
  );
}

function SetupCard({ child, rows }: { child: ChildProfile; rows: SetupRow[] }) {
  const { t } = useT();
  return (
    <View testID="setup-card" style={styles.card}>
      <View style={styles.row}>
        <Text variant="section">{t('setupTitle')}</Text>
        <Text variant="small">{t('setupLeft', { n: rows.length })}</Text>
      </View>
      {rows.map((row) => (
        <Pressable
          key={row.kind}
          testID={`setup-row-${row.kind}`}
          accessibilityRole="link"
          onPress={() => router.push(row.href as Href)}
          style={styles.tapRow}
        >
          {row.kind === 'profile' ? (
            <>
              <Text variant="label">{t('setupProfile', { name: child.nickname })}</Text>
              <Text variant="helper">{row.sections.map((s) => t(SETUP_LABEL[s])).join(', ')}</Text>
            </>
          ) : (
            <Text variant="label">{t('setupConsent')}</Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

type SectionProps = { section: HomeSection; assigned: string[]; open: boolean; onToggle: () => void };

function Section({ section, assigned, open, onToggle }: SectionProps) {
  const { t } = useT();
  const count = section.id === 'revision' ? section.items.length : section.lessons.length;
  const title = t(SECTION_TITLE[section.id], { n: count });

  // Completed's header is the press target, so its testID sits on the header, not the section.
  return (
    <View testID={section.id === 'completed' ? undefined : `home-section-${section.id}`} style={styles.section}>
      {section.id === 'completed' ? (
        <Pressable
          testID="home-section-completed"
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={onToggle}
          style={styles.tapRow}
        >
          <Text variant="section">{title}</Text>
        </Pressable>
      ) : (
        <Text variant="section">{title}</Text>
      )}
      {open && (
        <View style={styles.card}>
          <SectionBody section={section} count={count} assigned={assigned} />
        </View>
      )}
    </View>
  );
}

function SectionBody({ section, count, assigned }: { section: HomeSection; count: number; assigned: string[] }) {
  const { t } = useT();
  if (count === 0) return <Text variant="helper">{t('sectionEmpty')}</Text>;
  if (section.id === 'revision') {
    return (
      <View>
        <Text variant="label">{t('revisionCount', { n: count })}</Text>
        <Text variant="helper">
          {section.items.map((i) => i.item_key).join(', ')} · {t('revisionNotCounted')}
        </Text>
      </View>
    );
  }
  return section.lessons.map((id) => (
    <View key={id} testID={`lesson-row-${id}`} style={styles.lesson}>
      <Text variant="label">{lessonTitle(id)}</Text>
      {section.id === 'upNext' && assigned.includes(id) && <Text variant="small">{t('assignedToday')}</Text>}
      {section.id === 'waiting' && <Text variant="helper">{t('waitingNote')}</Text>}
    </View>
  ));
}

const { color, radius, space, touch } = theme;

const styles = StyleSheet.create({
  body: { gap: space[4], paddingVertical: space[4] },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: touch.parent.gap },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: touch.parent.min,
    paddingHorizontal: space[4],
    borderRadius: radius.parent.round,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  tabOn: { borderColor: color.parent.accent, backgroundColor: color.parent.accentSurface },
  card: {
    gap: space[2],
    padding: space[4],
    borderRadius: radius.parent.card,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  bannerWarn: { borderColor: color.parent.warning },
  bannerInfo: { backgroundColor: color.parent.accentSurface },
  track: { height: space[2], borderRadius: radius.parent.round, backgroundColor: color.parent.border, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: color.parent.accent },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  grow: { flex: 1, gap: space[1] },
  title: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  tapRow: { minHeight: touch.parent.min, justifyContent: 'center' },
  section: { gap: space[2] },
  lesson: { gap: space[1], paddingVertical: space[1] },
});
