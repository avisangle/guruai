// One lesson for one child inside their open session: Shekru, the item dots, the card, captions and
// the listen turn, and the moments between (wireframes l-talking, l-listening, l-word-*, l-paused,
// l-correct, l-streak, l-nohear, l-surprise, l-finished). Answers become events and
// the position is saved after each one. Pause, the app leaving the foreground or an audio
// interruption of a line (a call) pause the lesson; Stop ends the session.
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text as RNText, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PICTURES } from '../content/pictures';
import { now } from '../data/db';
import { liveDb } from '../data/liveDb';
import { recordAnswer } from '../learning/events';
import { savePosition } from '../learning/positions';
import { lessonLeft, lessonStarted } from '../learning/session';
import { endSessionNow, sessionClock } from '../learning/sessionClock';
import { ParentLock } from '../parent/ParentLock';
import { useLinePlayer } from '../screens/useLinePlayer';
import { useRecording, type JudgedClip } from '../screens/useRecording';
import { useTesterAnswers } from '../screens/useTesterAnswers';
import { Shekru } from '../shekru/Shekru';
import { useShekruRig } from '../shekru/useShekruRig';
import { Button } from '../ui/components/Button';
import { Screen } from '../ui/components/Screen';
import { Text } from '../ui/components/Text';
import { theme } from '../ui/theme';
import type { AnswerSource } from './answerSource';
import { dotStates, ItemDots } from './ItemDots';
import { MicIndicator } from './MicIndicator';
import { CorrectBadge, FinishedStar, RewardStar, StreakTicks } from './Moments';
import { onLessonEnd, usePlayerLoop, type LinePlayer } from './usePlayerLoop';
import type { Answer, Lesson, Position, RevisionItem, StyleLevel } from './types';

const { color, font, radius, space, touch } = theme;

/** Replaces the default answer source (mic and judge) or line player, e.g. in tests or "parent helps". */
export const LessonPlayerDeps = createContext<{ answerSource?: AnswerSource; linePlayer?: LinePlayer }>({});

export type LessonPlayerProps = {
  lesson: Lesson;
  childId: string;
  sessionId: string;
  styleLevel: StyleLevel;
  revision: RevisionItem[];
  start: Position | null;
};

// Tester buttons, shown only when the judge cannot answer (until "parent helps" replaces them).
const ANSWERS: [Answer, string][] = [['correct', '✓ बरोबर'], ['wrong', '✗ चूक'], ['silent', '… शांत']];

export function LessonPlayer({ lesson, childId, sessionId, styleLevel, revision, start }: LessonPlayerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const deps = useContext(LessonPlayerDeps);
  const db = liveDb();
  const rig = useShekruRig();
  const defaultLines = useLinePlayer(rig);
  const lines = deps.linePlayer ?? defaultLines;
  const tester = useTesterAnswers();
  const items = useMemo(() => [...lesson.items, ...revision.map((r) => r.item)], [lesson, revision]);
  const rec = useRecording(lesson.template_id, items, deps.answerSource ?? tester.source);
  const [clock] = useState(() => sessionClock(sessionId));
  const ctx = useCallback((at = now()) => ({ childId, sessionId, at }), [childId, sessionId]);

  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/child/[id]', params: { id: childId } });
  }, [router, childId]);

  const answered = useRef(new Set<string>()); // items answered in this run, for lesson_left
  const { view, pause, resume } = usePlayerLoop({
    lesson,
    styleLevel,
    revision,
    start,
    source: rec.source,
    lines,
    tutor: rig,
    prepare: rec.prepare,
    onAnswer: (event, position) => {
      recordAnswer(db, ctx(), event);
      savePosition(db, childId, lesson.template_id, position);
      answered.current.add(event.item_key);
    },
    onActivity: () => clock.activity(Date.now()),
    onPause: () => clock.pause(Date.now()),
    onResume: () => clock.resume(Date.now()),
    onDone: () => {
      const at = new Date();
      const next = onLessonEnd(db, { childId, sessionId, templateId: lesson.template_id, at, activeMs: clock.activeMs(at.getTime()) });
      if (next === 'goodbye') router.replace({ pathname: '/goodbye', params: { child: childId } });
      else back();
    },
  });

  useEffect(() => {
    lessonStarted(db, ctx(), lesson.template_id);
  }, [db, ctx, lesson.template_id]);

  // Only reachable while paused, so the loop is already halted.
  const stop = () => {
    lessonLeft(db, ctx(), lesson.template_id, { done: answered.current.size, total: items.length });
    endSessionNow(db, sessionId, 'stop', false); // "parent helps" (GURU-34) is not wired yet
    back();
  };

  const bigSize = Math.min(width * 0.72, height * 0.3, 420);
  const centreSize = Math.min(width * 0.9, height * 0.5, 560);
  const picture = view.card ? PICTURES[view.card.item.anchor.picture] : undefined;
  const word = view.card?.item.kind === 'word';
  const dots = useMemo(() => dotStates(lesson, revision, view.position), [lesson, revision, view.position]);
  const finished = view.moment === 'finished';
  // surprise and finished: the card steps aside and Shekru takes the centre
  const centre = view.moment !== null;
  // the control zone: a reward in place of the mic
  const control = finished ? <FinishedStar />
    : view.correct === 'ticks' ? <StreakTicks />
    : view.correct ? <RewardStar />
    : <MicIndicator open={view.listening} again={view.again} />;

  return (
    <Screen variant="child" style={styles.screen}>
      <StatusBar style="dark" />
      {/* one Shekru for every layout, so a moment never remounts the rig */}
      <View
        style={centre ? styles.centre : [styles.stage, { width: bigSize, height: bigSize }]}
        testID={finished ? 'lesson-finished' : centre ? 'surprise' : undefined}>
        <Shekru values={rig.values} size={centre ? centreSize : bigSize} hintLetter={centre ? undefined : picture} />
      </View>
      <ItemDots states={dots} />
      {!centre && (
        <View style={[styles.card, view.correct && styles.cardCorrect]} testID="card">
          {view.correct && <CorrectBadge />}
          <Text mode="child" variant={word ? 'wordCard' : 'letterCard'} style={styles.cardText}>
            {view.card?.item.display ?? ' '}
          </Text>
          <RNText style={[styles.anchor, !view.card?.showAnchor && styles.hidden]}>{picture ?? ' '}</RNText>
        </View>
      )}
      <Text mode="child" variant="caption" style={styles.caption} numberOfLines={3} testID="caption">
        {view.caption || ' '}
      </Text>
      {view.paused ? (
        <View style={styles.pausedRow} testID="paused">
          <View style={styles.big}>
            <Button variant="childPrimary" label="▶ पुढे" onPress={resume} testID="continue" />
          </View>
          <Pressable
            testID="stop"
            accessibilityRole="button"
            accessibilityLabel="थांब"
            onPress={stop}
            style={[styles.big, styles.stopButton]}>
            <Text mode="child" variant="mainButton">■ थांब</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.controls}>
          {rec.active && rec.judged && <JudgeNote judged={rec.judged} />}
          {control}
          {tester.waiting && (
            <View style={styles.testerRow}>
              {ANSWERS.map(([answer, label]) => (
                <Pressable
                  key={answer}
                  testID={`answer-${answer}`}
                  accessibilityRole="button"
                  onPress={() => tester.give(answer)}
                  style={styles.answer}>
                  <Text mode="child" variant="button">{label}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}
      <View style={[styles.lock, { top: insets.top + space[2] }]}>
        <ParentLock onOpen={pause} />
      </View>
      {!view.paused && !finished && (
        <Pressable
          testID="pause"
          accessibilityRole="button"
          accessibilityLabel="विराम"
          onPress={pause}
          hitSlop={8}
          style={[styles.pause, { top: insets.top + space[2] }]}>
          <View style={styles.pauseBar} />
          <View style={styles.pauseBar} />
        </Pressable>
      )}
    </Screen>
  );
}

// Tester-only (recording mode): what the judge heard in the last answer, and in tap mode whether it agreed.
function JudgeNote({ judged: { judge, answer, tapped } }: { judged: JudgedClip }) {
  const agrees = judge.verdict === answer || (judge.verdict === 'unclear' && answer === 'silent');
  const text = judge.error
    ? `judge error: ${judge.error}`
    : `judge: ${judge.choice} → ${judge.verdict}${tapped ? (agrees ? ' ✓' : ` ✗ (you: ${answer})`) : ''} · heard "${judge.free}" · ${judge.ms} ms`;
  return <RNText style={styles.testerNote} numberOfLines={2} testID="judge-note">{text}</RNText>;
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center', paddingBottom: space[3] },
  stage: { alignItems: 'center', paddingTop: space[1] },
  hidden: { opacity: 0 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    flex: 1, alignSelf: 'stretch', maxWidth: 560, width: '100%', marginTop: space[1], borderRadius: radius.child.card,
    borderWidth: 2, borderColor: color.child.border, backgroundColor: color.child.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  cardCorrect: { borderWidth: 5, borderColor: color.child.success, backgroundColor: color.child.successSurface },
  cardText: { textAlign: 'center' },
  anchor: { textAlign: 'center', fontSize: font.child.letterCard.size / 2 },
  caption: { color: color.child.textMuted, textAlign: 'center', minHeight: 40, marginTop: space[2], maxWidth: 560 },
  controls: { height: 132, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end', gap: space[2] },
  testerNote: { fontSize: 11, color: color.child.textMuted },
  testerRow: { flexDirection: 'row', gap: touch.child.gap, alignSelf: 'stretch', justifyContent: 'center' },
  answer: {
    flex: 1, maxWidth: 180, minHeight: touch.child.min, borderRadius: radius.child.chip, borderWidth: 2,
    borderStyle: 'dashed', borderColor: color.child.borderStrong, backgroundColor: color.child.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  lock: { position: 'absolute', left: space[3] },
  pause: {
    position: 'absolute', right: space[3], width: touch.child.pause, height: touch.child.pause, borderRadius: radius.child.round,
    flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.child.surface, borderWidth: 2, borderColor: color.child.borderStrong,
  },
  pauseBar: { width: 7, height: 22, borderRadius: 2, backgroundColor: color.child.brand },
  pausedRow: {
    height: 132, alignSelf: 'stretch', flexDirection: 'row', gap: touch.child.gap, alignItems: 'flex-end', justifyContent: 'center',
  },
  big: { flex: 1, maxWidth: 240 },
  stopButton: {
    minHeight: touch.child.mainButton, borderRadius: radius.child.mainButton, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.child.surface, borderWidth: 2, borderColor: color.child.borderStrong,
  },
});
