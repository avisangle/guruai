// Goodbye (wireframe l-goodbye): the daily goal is met or the active-time cap ended the day. Shekru says
// bye, the session ends, and the trail shows today's finished lessons and what is left for tomorrow.
// No start button: done means done for the day (decision 8). The only controls are the parent lock and,
// until the consent question is answered, the "For parents" strip (decision 12).
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { ParentStrip } from '../child/ParentStrip';
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
import { parentHelps } from '../parent/parentHelps';
import { useLinePlayer } from '../screens/useLinePlayer';
import { Shekru } from '../shekru/Shekru';
import { useShekruRig } from '../shekru/useShekruRig';
import { Screen } from '../ui/components/Screen';
import { Text } from '../ui/components/Text';
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
  // This child's finished lesson already proves one ended on the phone; else ask the whole device.
  return { done, left, askConsent: getDevice(db).consent_answered_at === null && (done.length > 0 || anyLessonEnded(db)) };
}

export default function GoodbyeScreen() {
  const { child } = useLocalSearchParams<{ child: string }>();
  const { width, height } = useWindowDimensions();
  const rig = useShekruRig();
  const lines = useLinePlayer(rig);
  const [day] = useState(() => (child ? readDay(child) : null));
  const [bye] = useState(() => pickLine('bye', familyLines('bye', prompts.lines), [], Math.random).id);

  useEffect(() => {
    if (!day) return;
    const db = liveDb();
    const session = openSession(db, child);
    if (session) endSessionNow(db, session, 'goodbye', parentHelps.end(child));

    rig.setState('bye');
    lines.play(bye, prompts.lines[bye]).then(() => rig.setState('idle'));
    return () => lines.stop();
  }, [day, child, bye, rig, lines]);

  if (!day) return <Redirect href="/" />;

  return (
    <Screen variant="child">
      <View style={styles.top}>
        <ParentLock />
      </View>
      <View style={styles.middle}>
        <Shekru values={rig.values} size={Math.min(width * 0.6, height * 0.3)} />
        <Text mode="child" style={styles.caption}>
          {prompts.captions?.[bye] ?? prompts.lines[bye]}
        </Text>
        <Trail done={day.done} stops={day.left} />
      </View>
      {/* For the adult; a child who taps it only reaches the parent lock. */}
      {day.askConsent && <ParentStrip testID="consent-strip" label="consentStrip" onPress={() => router.push('/parent/unlock')} />}
    </Screen>
  );
}

const { color, space } = theme;

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[4] },
  caption: { textAlign: 'center', color: color.child.textMuted },
});
