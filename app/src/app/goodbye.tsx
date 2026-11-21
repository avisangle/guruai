// Goodbye (wireframe l-goodbye): the daily goal is met or the active-time cap ended the day. Shekru says
// bye, the session ends, and the trail shows today's finished lessons and what is left for tomorrow.
// No start button: done means done for the day (decision 8). The only controls are the parent lock and,
// until the consent question is answered, the "For parents" strip (decision 12).
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Trail } from '../child/Trail';
import promptsJson from '../content/generated/prompts.json';
import { getDevice } from '../data/device';
import { liveDb } from '../data/liveDb';
import { getChild } from '../data/profiles';
import { isLessonInstalled } from '../downloads/downloader';
import { localDay } from '../learning/mastery';
import { buildTodayQueue, type Stop } from '../learning/queue';
import { readQueueInput } from '../learning/queueInput';
import { anyLessonEnded, lessonsEndedOn, openSession } from '../learning/session';
import { endSessionNow } from '../learning/sessionClock';
import { familyLines, pickLine } from '../lesson/lines';
import type { Prompts } from '../lesson/types';
import { ParentLock } from '../parent/ParentLock';
import { useLinePlayer } from '../screens/useLinePlayer';
import { Shekru } from '../shekru/Shekru';
import { useShekruRig } from '../shekru/useShekruRig';
import { Screen } from '../ui/components/Screen';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import { theme } from '../ui/theme';

const prompts = promptsJson as Prompts;

type Day = { done: string[]; left: Stop[]; askConsent: boolean };

function readDay(childId: string): Day | null {
  const db = liveDb();
  const child = getChild(db, childId);
  if (!child) return null;
  const today = localDay(new Date().toISOString());
  const done = lessonsEndedOn(db, childId, today);
  // Stops the queue still has for today: only left when the active-time cap ended the day early.
  const left = buildTodayQueue(readQueueInput(db, child, today, isLessonInstalled)).stops.filter(
    (s) => s.kind !== 'lesson' || !done.includes(s.template_id),
  );
  return { done, left, askConsent: getDevice(db).consent_answered_at === null && anyLessonEnded(db) };
}

export default function GoodbyeScreen() {
  const { child } = useLocalSearchParams<{ child: string }>();
  const { width, height } = useWindowDimensions();
  const rig = useShekruRig();
  const lines = useLinePlayer(rig);
  const [day] = useState(() => (child ? readDay(child) : null));
  const [caption, setCaption] = useState<string | null>(null);

  useEffect(() => {
    if (!day) return;
    const db = liveDb();
    const session = openSession(db, child);
    if (session) endSessionNow(db, session, 'goodbye', false); // "parent helps" (GURU-34) is not wired yet

    rig.setState('bye');
    const { id } = pickLine('bye', familyLines('bye', prompts.lines), [], Math.random);
    const text = prompts.lines[id];
    setCaption(prompts.captions?.[id] ?? text);
    lines.play(id, text).then(() => rig.setState('idle'));
    return () => lines.stop();
  }, [day, child, rig, lines]);

  if (!day) return <Redirect href="/" />;

  return (
    <Screen variant="child">
      <View style={styles.top}>
        <ParentLock />
      </View>
      <View style={styles.middle}>
        <Shekru values={rig.values} size={Math.min(width * 0.6, height * 0.3)} />
        {caption && (
          <Text mode="child" style={styles.caption}>
            {caption}
          </Text>
        )}
        <Trail done={day.done} stops={day.left} tomorrow />
      </View>
      {day.askConsent && <ConsentStrip />}
    </Screen>
  );
}

/** For the adult; a child who taps it only reaches the parent lock. */
function ConsentStrip() {
  const { t } = useT();
  return (
    <Pressable testID="consent-strip" accessibilityRole="button" onPress={() => router.push('/parent/unlock')} style={styles.strip}>
      <Text variant="small">{t('consentStrip')}</Text>
    </Pressable>
  );
}

const { color, radius, space, touch } = theme;

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[4] },
  caption: { textAlign: 'center', color: color.child.textMuted },
  strip: {
    minHeight: touch.parent.min,
    justifyContent: 'center',
    padding: space[3],
    marginBottom: space[3],
    borderRadius: radius.parent.card,
    backgroundColor: color.parent.surface,
    borderWidth: 1,
    borderColor: color.parent.border,
  },
});
