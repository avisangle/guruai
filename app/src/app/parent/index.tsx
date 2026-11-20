// Parent home (wireframes pm-home, pm-home-2, pm-attention): one tab per child, today's progress,
// the attention banner, the "Finish setting up" card and the lesson sections.
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { judgeReadiness, type JudgeReadiness } from '../../asr/speedCheck';
import { now } from '../../data/db';
import { getDevice, updateDevice } from '../../data/device';
import { liveDb } from '../../data/liveDb';
import { listChildren } from '../../data/profiles';
import type { ChildProfile, Device } from '../../data/types';
import { isLessonInstalled, startInitialDownloads, subscribeDownloads } from '../../downloads/downloader';
import { localDay } from '../../learning/mastery';
import { attentionBanner, type Banner, type MicState } from '../../parent/attention';
import { lessonTitle, loadChildHome, type ChildHome, type HomeSection } from '../../parent/home';
import { useParentMode } from '../../parent/ParentModeProvider';
import { setupRows, type SetupRow, type SetupSection } from '../../parent/setup';
import { Button } from '../../ui/components/Button';
import { Screen } from '../../ui/components/Screen';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { CHILD_PICTURES } from '../../ui/PicturePicker';
import type { StringKey } from '../../ui/strings/mr';
import { theme } from '../../ui/theme';

type Home = { children: ChildProfile[]; device: Device | null };

function readHome(): Home {
  try {
    const db = liveDb();
    return { children: listChildren(db), device: getDevice(db) };
  } catch {
    return { children: [], device: null }; // no SQLite (component tests without a database)
  }
}

function readChild(child: ChildProfile): ChildHome | null {
  try {
    return loadChildHome(liveDb(), child, localDay(new Date().toISOString()), isLessonInstalled);
  } catch {
    return null;
  }
}

function readReadiness(): JudgeReadiness {
  try {
    return judgeReadiness();
  } catch {
    return 'ready'; // no database or model module: nothing to report
  }
}

async function readMic(): Promise<MicState> {
  try {
    const { granted, canAskAgain } = await getRecordingPermissionsAsync();
    return { granted, canAskAgain };
  } catch {
    return { granted: true, canAskAgain: true }; // unknown: no mic banner
  }
}

/** Fills {name} placeholders in a string table entry. */
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));

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
  const [readiness, setReadiness] = useState(readReadiness);
  const [mic, setMic] = useState<MicState | null>(null); // null until read: no banner flashes
  const [completedOpen, setCompletedOpen] = useState(false);

  // Reread on every return to this screen, so a saved profile or consent leaves the setup card.
  useFocusEffect(
    useCallback(() => {
      setHome(readHome());
      setReadiness(readReadiness());
      readMic().then(setMic);
    }, []),
  );

  // A finished model download clears the banner without leaving the screen.
  useEffect(() => {
    try {
      return subscribeDownloads(() => setReadiness(readReadiness()));
    } catch {
      return undefined;
    }
  }, []);

  const child = home.children.find((c) => c.id === childId) ?? home.children[0];
  const data = useMemo(() => (child ? readChild(child) : null), [child]);
  const banner = mic && attentionBanner({ readiness, mic, micLastGrantedAt: home.device?.mic_last_granted_at ?? null });
  const rows = child && home.device ? setupRows(child, home.device) : [];

  const act = async (b: Banner) => {
    if (b.action === 'resumeDownload') startInitialDownloads().catch(() => undefined);
    else if (b.action === 'openSettings') Linking.openSettings().catch(() => undefined);
    else if (b.action === 'requestPermission') {
      try {
        const { granted, canAskAgain } = await requestRecordingPermissionsAsync();
        if (granted) updateDevice(liveDb(), { mic_last_granted_at: now() });
        setMic({ granted, canAskAgain });
      } catch {
        // the dialog failed to open; the banner stays
      }
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

        {data && (
          <View testID="today-progress" style={styles.card}>
            <Text variant="helper">{fill(t('todayProgress'), { done: data.done, goal: data.goal })}</Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.min(100, (data.done / Math.max(1, data.goal)) * 100)}%` }]} />
            </View>
          </View>
        )}

        {child && rows.length > 0 && <SetupCard child={child} rows={rows} />}

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
      <Button variant="parentGhost" label={t('backToChildren')} onPress={exit} />
    </Screen>
  );
}

function AttentionBanner({ banner, onAction }: { banner: Banner; onAction: () => void }) {
  const { t } = useT();
  let title: StringKey;
  let body: StringKey;
  let action: StringKey | null = null;
  if (banner.kind === 'model') {
    [title, body, action] = ['bannerModelTitle', 'bannerModelBody', 'bannerModelAction'];
  } else if (banner.kind === 'mic') {
    title = 'bannerMicTitle';
    if (banner.action === 'openSettings') [body, action] = ['bannerMicSettings', 'bannerMicSettingsAction'];
    else [body, action] = [banner.chooseWhileUsing ? 'bannerMicWhileUsing' : 'bannerMicBody', 'bannerMicAction'];
  } else {
    [title, body] = ['bannerWeakTitle', 'bannerWeakBody'];
  }
  return (
    <View testID="attention-banner" accessibilityRole="alert" style={[styles.banner, banner.kind === 'weak' && styles.bannerInfo]}>
      <Text variant="label">{t(title)}</Text>
      <Text>{t(body)}</Text>
      {action && <Button testID="attention-action" variant="parent" label={t(action)} onPress={onAction} />}
    </View>
  );
}

function SetupCard({ child, rows }: { child: ChildProfile; rows: SetupRow[] }) {
  const { t } = useT();
  return (
    <View testID="setup-card" style={styles.card}>
      <View style={styles.row}>
        <Text variant="section">{t('setupTitle')}</Text>
        <Text variant="small">{fill(t('setupLeft'), { n: rows.length })}</Text>
      </View>
      {rows.map((row) => (
        <Pressable
          key={row.kind}
          testID={`setup-row-${row.kind}`}
          accessibilityRole="link"
          onPress={() => router.push(row.href as Href)}
          style={styles.link}
        >
          {row.kind === 'profile' ? (
            <>
              <Text variant="label">{fill(t('setupProfile'), { name: child.nickname })}</Text>
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
  const title = fill(t(SECTION_TITLE[section.id]), { n: count });
  const header =
    section.id === 'completed' ? (
      <Pressable
        testID="home-section-completed"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.toggle}
      >
        <Text variant="section">{title}</Text>
      </Pressable>
    ) : (
      <Text variant="section">{title}</Text>
    );

  let content = null;
  if (open && count === 0) content = <Text variant="helper">{t('sectionEmpty')}</Text>;
  else if (open && section.id === 'revision') {
    content = (
      <View>
        <Text variant="label">{fill(t('revisionCount'), { n: count })}</Text>
        <Text variant="helper">
          {section.items.map((i) => i.item_key).join(', ')} · {t('revisionNotCounted')}
        </Text>
      </View>
    );
  } else if (open && section.id !== 'revision') {
    content = section.lessons.map((id) => (
      <View key={id} testID={`lesson-row-${id}`} style={styles.lesson}>
        <Text variant="label">{lessonTitle(id)}</Text>
        {section.id === 'upNext' && assigned.includes(id) && <Text variant="small">{t('assignedToday')}</Text>}
        {section.id === 'waiting' && <Text variant="helper">{t('waitingNote')}</Text>}
      </View>
    ));
  }

  return (
    <View testID={section.id === 'completed' ? undefined : `home-section-${section.id}`} style={styles.section}>
      {header}
      {content && <View style={styles.card}>{content}</View>}
    </View>
  );
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
  track: { height: space[2], borderRadius: radius.parent.round, backgroundColor: color.parent.border, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: color.parent.accent },
  banner: {
    gap: space[2],
    padding: space[4],
    borderRadius: radius.parent.card,
    borderWidth: 1,
    borderColor: color.parent.warning,
    backgroundColor: color.parent.surface,
  },
  bannerInfo: { borderColor: color.parent.border, backgroundColor: color.parent.accentSurface },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { minHeight: touch.parent.min, justifyContent: 'center' },
  section: { gap: space[2] },
  toggle: { minHeight: touch.parent.min, justifyContent: 'center' },
  lesson: { gap: space[1], paddingVertical: space[1] },
});
