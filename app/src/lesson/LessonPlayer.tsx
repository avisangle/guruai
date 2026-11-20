// One lesson for one child inside their open session: Shekru, the item card, captions and the
// listen turn (wireframes l-talking, l-listening, l-word-*, l-paused). Answers become events and
// the position is saved after each one. Pause, the app leaving the foreground or an audio
// interruption of a line (a call) pause the lesson; Stop ends the session.
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { AppState, Pressable, StyleSheet, Text as RNText, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { PICTURES } from '../content/pictures';
import { liveDb } from '../data/liveDb';
import { recordAnswer } from '../learning/events';
import { savePosition } from '../learning/positions';
import { endSession, lessonLeft, lessonStarted } from '../learning/session';
import { dropSessionClock, sessionClock } from '../learning/sessionClock';
import { useLinePlayer } from '../screens/useLinePlayer';
import { useRecording, type JudgedClip } from '../screens/useRecording';
import { useTesterAnswers } from '../screens/useTesterAnswers';
import { Shekru } from '../shekru/Shekru';
import { useShekruRig } from '../shekru/useShekruRig';
import { Text } from '../ui/components/Text';
import { theme } from '../ui/theme';
import type { AnswerSource } from './answerSource';
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

function Mic() {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [pulse]);
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: 1 + 0.45 * pulse.value }], opacity: 0.5 - 0.4 * pulse.value }));
  return (
    <View style={styles.mic} testID="mic" accessibilityLabel="ऐकत आहे">
      <Animated.View style={[styles.micRing, ring]} />
      <View style={styles.micDot}><RNText style={styles.micIcon}>🎤</RNText></View>
    </View>
  );
}

export function LessonPlayer({ lesson, childId, sessionId, styleLevel, revision, start }: LessonPlayerProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const deps = useContext(LessonPlayerDeps);
  const db = liveDb();
  const rig = useShekruRig();
  const interrupted = useRef(() => undefined as void);
  const onInterrupt = useCallback(() => interrupted.current(), []);
  const defaultLines = useLinePlayer(rig, onInterrupt);
  const lines = deps.linePlayer ?? defaultLines;
  const tester = useTesterAnswers();
  const items = useMemo(() => [...lesson.items, ...revision.map((r) => r.item)], [lesson, revision]);
  const rec = useRecording(lesson.template_id, items, deps.answerSource ?? tester.source);
  const clock = sessionClock(sessionId);
  const ctx = useCallback(() => ({ childId, sessionId, at: new Date().toISOString() }), [childId, sessionId]);

  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/child/[id]', params: { id: childId } });
  }, [router, childId]);

  const answered = useRef(new Set<string>()); // items answered in this run, for lesson_left
  const { view, pause, resume, halt } = usePlayerLoop({
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
    interrupted.current = pause;
  }, [pause]);

  useEffect(() => {
    lessonStarted(db, ctx(), lesson.template_id);
  }, [db, ctx, lesson.template_id]);

  // Leaving the app pauses exactly like the pause button.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') pause();
    });
    return () => sub.remove();
  }, [pause]);

  const stop = () => {
    halt();
    const at = new Date();
    lessonLeft(db, { childId, sessionId, at: at.toISOString() }, lesson.template_id, {
      done: answered.current.size,
      total: items.length,
    });
    endSession(db, sessionId, 'stop', { at: at.toISOString(), activeMs: clock.activeMs(at.getTime()), parentHelps: false });
    dropSessionClock(sessionId);
    back();
  };

  const bigSize = Math.min(width * 0.72, height * 0.3, 420);
  const picture = view.card ? PICTURES[view.card.item.anchor.picture] : undefined;
  const word = view.card?.item.kind === 'word';

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={[styles.stage, { width: bigSize, height: bigSize }]}>
        <Shekru values={rig.values} size={bigSize} hintLetter={picture} />
      </View>
      <View style={styles.card} testID="card">
        <Text mode="child" variant={word ? 'wordCard' : 'letterCard'} style={styles.cardText}>
          {view.card?.item.display ?? ' '}
        </Text>
        <RNText style={[styles.anchor, !view.card?.showAnchor && styles.hidden]}>{picture ?? ' '}</RNText>
      </View>
      <Text mode="child" variant="caption" style={styles.caption} numberOfLines={3} testID="caption">
        {view.caption || ' '}
      </Text>
      {view.paused ? (
        <View style={styles.pausedRow} testID="paused">
          <Pressable
            testID="continue"
            accessibilityRole="button"
            accessibilityLabel="पुढे"
            onPress={resume}
            style={[styles.big, styles.continue]}>
            <Text mode="child" variant="mainButton">▶ पुढे</Text>
          </Pressable>
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
          {view.listening && <Mic />}
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
      {!view.paused && (
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
    </SafeAreaView>
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
  screen: {
    flex: 1, backgroundColor: color.child.background, alignItems: 'center',
    paddingHorizontal: space.screenGutterChild, paddingBottom: space[3],
  },
  stage: { alignItems: 'center', paddingTop: space[1] },
  hidden: { opacity: 0 },
  card: {
    flex: 1, alignSelf: 'stretch', maxWidth: 560, width: '100%', marginTop: space[1], borderRadius: radius.child.card,
    borderWidth: 2, borderColor: color.child.border, backgroundColor: color.child.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  cardText: { textAlign: 'center' },
  anchor: { textAlign: 'center', fontSize: font.child.letterCard.size / 2 },
  caption: { color: color.child.textMuted, textAlign: 'center', minHeight: 40, marginTop: space[2], maxWidth: 560 },
  controls: { height: 132, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end', gap: space[2] },
  mic: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  micRing: { position: 'absolute', width: 56, height: 56, borderRadius: radius.child.round, backgroundColor: color.child.listeningRing },
  micDot: {
    width: 48, height: 48, borderRadius: radius.child.round, backgroundColor: color.child.listening,
    alignItems: 'center', justifyContent: 'center',
  },
  micIcon: { fontSize: 24 },
  testerNote: { fontSize: 11, color: color.child.textMuted },
  testerRow: { flexDirection: 'row', gap: touch.child.gap, alignSelf: 'stretch', justifyContent: 'center' },
  answer: {
    flex: 1, maxWidth: 180, minHeight: touch.child.min, borderRadius: radius.child.chip, borderWidth: 2,
    borderStyle: 'dashed', borderColor: color.child.borderStrong, backgroundColor: color.child.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  pause: {
    position: 'absolute', right: space[3], width: touch.child.pause, height: touch.child.pause, borderRadius: radius.child.round,
    flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.child.surface, borderWidth: 2, borderColor: color.child.borderStrong,
  },
  pauseBar: { width: 7, height: 22, borderRadius: 2, backgroundColor: color.child.brand },
  pausedRow: {
    height: 132, alignSelf: 'stretch', flexDirection: 'row', gap: touch.child.gap, alignItems: 'flex-end', justifyContent: 'center',
  },
  big: {
    flex: 1, maxWidth: 240, minHeight: touch.child.mainButton, borderRadius: radius.child.mainButton,
    alignItems: 'center', justifyContent: 'center',
  },
  continue: { backgroundColor: color.child.primary },
  stopButton: { backgroundColor: color.child.surface, borderWidth: 2, borderColor: color.child.borderStrong },
});
