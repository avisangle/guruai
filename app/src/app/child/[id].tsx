// Today's queue (wireframes c-queue, c-queue-mid, c-queue-first) and the waiting screens before it
// (c-getting-ready, c-ready, c-ask-mic, c-ask-weak). The start button is the only control besides the lock.
import { Redirect, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { judgeReadiness, type JudgeReadiness } from '../../asr/speedCheck';
import { readiness, type Readiness } from '../../child/readiness';
import { Trail } from '../../child/Trail';
import promptsJson from '../../content/generated/prompts.json';
import { liveDb } from '../../data/liveDb';
import { getChild } from '../../data/profiles';
import { downloadStatus, isLessonInstalled, subscribeDownloads, type DownloadItem } from '../../downloads/downloader';
import { installKey, useDownloads } from '../../downloads/useDownloads';
import { localDay } from '../../learning/mastery';
import { buildTodayQueue, type TodayQueue } from '../../learning/queue';
import { readQueueInput } from '../../learning/queueInput';
import { lessonsFinished } from '../../learning/session';
import { familyLines, pickLine, type Family } from '../../lesson/lines';
import type { Prompts } from '../../lesson/types';
import type { MicState } from '../../parent/attention';
import { ADULT, Icon, MIC, STAR } from '../../parent/icons';
import { readMic } from '../../parent/mic';
import { ParentLock } from '../../parent/ParentLock';
import { useLinePlayer } from '../../screens/useLinePlayer';
import { Shekru } from '../../shekru/Shekru';
import { useShekruRig } from '../../shekru/useShekruRig';
import { Button } from '../../ui/components/Button';
import { Screen } from '../../ui/components/Screen';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { mr } from '../../ui/strings/mr';
import { theme } from '../../ui/theme';

const prompts = promptsJson as Prompts;

// What Shekru says and how he stands on each screen; the waiting screens also show the adult outline.
const SAY: Record<Readiness, { family: Family; pose: string; icon?: string }> = {
  ready: { family: 'ready', pose: 'correct' },
  getting_ready: { family: 'ask_grownup_model', pose: 'thinking', icon: ADULT },
  ask_mic: { family: 'ask_grownup_mic', pose: 'nohear', icon: MIC },
  ask_weak: { family: 'ask_grownup_weak', pose: 'idle', icon: ADULT },
};

const modelRow = () => downloadStatus().items.find((i) => i.kind === 'model') ?? null;

type Today = { queue: TodayQueue; stars: number; midDay: boolean; judge: JudgeReadiness; model: DownloadItem | null };

function readToday(childId: string): Today | null {
  const db = liveDb();
  const child = getChild(db, childId);
  if (!child) return null;
  const input = readQueueInput(db, child, localDay(new Date().toISOString()), isLessonInstalled);
  const queue = buildTodayQueue(input);
  return {
    queue,
    stars: lessonsFinished(db, childId),
    // c-queue-mid: a lesson was left part-way or one is finished today.
    midDay: input.inProgress.length > 0 || queue.done > 0,
    judge: judgeReadiness(),
    model: modelRow(),
  };
}

export default function TodayQueueScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { width, height } = useWindowDimensions();
  const rig = useShekruRig();
  const lines = useLinePlayer(rig);
  const [today, setToday] = useState(() => readToday(id));
  const [mic, setMic] = useState<MicState | null>(null); // null until read: no waiting screen flashes
  const [caption, setCaption] = useState<string | null>(null);
  const shown = useRef<Readiness | null>(null);
  const firstFocus = useRef(true);

  // Reread on every return (a finished lesson changes the trail and the stars) and the mic, which the
  // parent may have allowed meanwhile.
  useFocusEffect(
    useCallback(() => {
      if (!firstFocus.current) setToday(readToday(id));
      firstFocus.current = false;
      readMic().then(setMic);
    }, [id]),
  );

  // The model arriving turns the waiting screen into the queue by itself; a new pack can add a lesson.
  useEffect(() => {
    let key = installKey(downloadStatus());
    return subscribeDownloads(() => {
      const next = installKey(downloadStatus());
      if (next === key) return;
      key = next;
      setToday(readToday(id));
    });
  }, [id]);

  const state = today && mic ? readiness({ model: today.model, mic, judge: today.judge, parentHelps: false }) : null;

  // Shekru asks for a grown-up on each waiting screen, and says he is ready when one turns into the queue.
  useEffect(() => {
    if (!state || state === shown.current) return;
    const was = shown.current;
    shown.current = state;
    if (state === 'ready' && was === null) return;
    const { family, pose } = SAY[state];
    rig.setState(pose);
    const { id: line } = pickLine(family, familyLines(family, prompts.lines), [], Math.random);
    const text = prompts.lines[line];
    setCaption(prompts.captions?.[line] ?? text);
    lines.play(line, text).then(() => rig.setState('idle'));
  }, [state, rig, lines]);

  if (!today) return <Redirect href="/" />;
  if (today.queue.goalMet) return <Redirect href="/goodbye" />;

  const { queue, stars, midDay } = today;
  const lesson = queue.stops.find((s) => s.kind === 'lesson');
  const start = () => {
    if (!lesson) return;
    lines.stop();
    router.push({
      pathname: '/lesson/[template]',
      params: { template: lesson.template_id, child: id, stop: JSON.stringify(lesson) },
    });
  };
  const icon = state && SAY[state].icon;

  return (
    <Screen variant="child">
      <View style={styles.top}>
        <ParentLock />
        <Stars n={stars} />
      </View>
      <View style={styles.middle}>
        <Shekru values={rig.values} size={Math.min(width * 0.6, height * 0.3)} />
        {state === 'getting_ready' && today.model && <Progress />}
        {caption && (
          <Text mode="child" style={styles.caption}>
            {caption}
          </Text>
        )}
        {icon && <Icon d={icon} size={theme.touch.child.mainButton} color={theme.color.child.borderStrong} />}
        <Trail stops={queue.stops} />
      </View>
      {state === 'ready' && lesson && (
        <Button testID="queue-start" variant="childPrimary" label={midDay ? mr.next : mr.letsStart} onPress={start} />
      )}
      {icon && <GrownupStrip />}
    </Screen>
  );
}

// Decision 5: day one shows an empty outline with 0, never an empty or error look.
function Stars({ n }: { n: number }) {
  return (
    <View testID="stars" style={styles.star}>
      <Icon d={STAR} size={theme.space[6]} color={theme.color.child.primary} fill={n > 0 ? theme.color.child.primary : 'none'} />
      <Text mode="child" variant="name">
        {String(n)}
      </Text>
    </View>
  );
}

// Only the bar follows byte progress, so the screen itself re-renders on installs, not on every chunk.
function Progress() {
  const item = useDownloads().items.find((i) => i.kind === 'model');
  if (!item) return null;
  const share = item.status === 'installed' ? 1 : item.bytesTotal > 0 ? item.bytesDone / item.bytesTotal : 0;
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.round(share * 100)}%` }]} />
    </View>
  );
}

function GrownupStrip() {
  const { t } = useT();
  return (
    <View style={styles.strip}>
      <Text variant="small">{t('askGrownupStrip')}</Text>
    </View>
  );
}

const { color, radius, space } = theme;

const styles = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  star: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[4] },
  caption: { textAlign: 'center', color: color.child.textMuted },
  track: { width: '60%', height: space[2], borderRadius: radius.child.round, backgroundColor: color.child.border, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: color.child.primary },
  strip: {
    padding: space[3],
    marginBottom: space[3],
    borderRadius: radius.parent.card,
    backgroundColor: color.parent.surface,
    borderWidth: 1,
    borderColor: color.parent.border,
  },
});
