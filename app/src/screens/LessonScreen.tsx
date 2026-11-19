// The lesson player: runs the engine's steps with Shekru, the letter card,
// voice lines and a listening turn after every mic-opening line. Pausing
// (button or app to background) cancels the run; continuing starts a new run
// from saved progress, which restarts the item at its last mic-opening line.
import { Link } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing, FadeIn, FadeInDown, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import lessonsJson from '../content/generated/lessons.json';
import promptsJson from '../content/generated/prompts.json';
import { PICTURES } from '../content/pictures';
import { createLesson, isFinished } from '../lesson/engine';
import type { Answer, Item, Lesson, Prompts } from '../lesson/types';
import { loadLessonChoice, loadProgress, resetProgress, saveLessonChoice, saveProgress } from '../progress/storage';
import anim from '../shekru/generated/shekru.anim.json';
import { Shekru } from '../shekru/Shekru';
import { useShekruRig } from '../shekru/useShekruRig';
import { RecordingPanel } from './RecordingPanel';
import { useLinePlayer } from './useLinePlayer';
import { useRecording, type JudgedClip } from './useRecording';
import { useTesterAnswers } from './useTesterAnswers';

const LESSONS = lessonsJson as unknown as Lesson[];
const prompts = promptsJson as Prompts;
const STATE_DEFS = anim.states as Record<string, { loop?: boolean; duration: number }>;
const THINKING_SECONDS = 0.6;
const SHRINK_SECONDS = 0.7; // Shekru moves into place before the intro starts
const ANSWERS: [Answer, string][] = [['correct', '✓ बरोबर'], ['wrong', '✗ चूक'], ['silent', '… शांत']];

const wait = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

function Mic() {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [pulse]);
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: 1 + 0.45 * pulse.value }], opacity: 0.5 - 0.4 * pulse.value }));
  return (
    <View style={styles.mic} testID="mic" accessibilityLabel="ऐकत आहे">
      <Animated.View style={[styles.micRing, ring]} />
      <View style={styles.micDot}><Text style={styles.micIcon}>🎤</Text></View>
    </View>
  );
}

export function LessonScreen() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Shekru is drawn once at the home size and scaled down for the lesson, so
  // the shrink is a cheap view transform rather than an SVG redraw per frame.
  const bigSize = Math.min(width * 0.92, height * 0.5, 520);
  const smallSize = Math.min(width * 0.72, height * 0.3, 420);
  const homeTop = Math.max(0, (height - bigSize - 320) / 3);
  const letterSize = Math.round(Math.min(width * 0.38, height * 0.19, 220));
  // Home screen: Shekru shrinks to tinySize as the menu scrolls up, at the scroll's own pace
  // (a collapsing header), so the tester panel and its text fields get the screen.
  const tinySize = Math.round(Math.min(bigSize * 0.3, 110));
  const collapseRange = homeTop + bigSize - tinySize;

  const [lessonId, setLessonId] = useState(loadLessonChoice);
  const lesson = LESSONS.find((l) => l.template_id === lessonId) ?? LESSONS[0];
  const [playing, setPlaying] = useState(false);
  const [saved, setSaved] = useState(() => loadProgress(lesson.template_id));
  const [caption, setCaption] = useState('');
  const [card, setCard] = useState<{ item: Item; showAnchor: boolean } | null>(null);
  const [listening, setListening] = useState(false);
  const [paused, setPaused] = useState(false);
  const rig = useShekruRig();
  const lines = useLinePlayer(rig);
  const tester = useTesterAnswers();
  const rec = useRecording(lesson.template_id, lesson.items, tester.source);
  const source = rec.source; // the on-device judge; tester buttons when it cannot run (web, no model, no mic)
  const run = useRef(0); // bumping it cancels a running lesson
  const live = useRef(false); // a lesson run is in progress (not paused)
  const lessonMode = useSharedValue(0); // 0 home, 1 lesson
  const homeScroll = useSharedValue(0);
  const homeRef = useAnimatedRef<Animated.ScrollView>();
  const [homeOrigin, setHomeOrigin] = useState(0); // where an absolute child's top:0 lands (parent padding or not)
  const [keyboard, setKeyboard] = useState(0);
  const [homeHeight, setHomeHeight] = useState(0); // the menu's visible height

  const onHomeScroll = useAnimatedScrollHandler((e) => {
    homeScroll.value = e.contentOffset.y;
  });
  // Both styles read the shared values directly: Reanimated only re-runs a style for values it sees in it.
  const stageStyle = useAnimatedStyle(() => {
    const c = Math.min(1, Math.max(0, homeScroll.value / collapseRange));
    const home = bigSize + (tinySize - bigSize) * c;
    return { height: home + (smallSize - home) * lessonMode.value, marginTop: homeTop * (1 - c) * (1 - lessonMode.value) };
  });
  const shekruStyle = useAnimatedStyle(() => {
    const home = bigSize + (tinySize - bigSize) * Math.min(1, Math.max(0, homeScroll.value / collapseRange));
    return { transform: [{ scale: (home + (smallSize - home) * lessonMode.value) / bigSize }] };
  });

  // The keyboard covers the lower half: pad the menu by its height and bring the fields above it.
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => {
      setKeyboard(e.endCoordinates.height);
      setTimeout(() => homeRef.current?.scrollToEnd({ animated: true }), 50);
    });
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [homeRef]);

  useEffect(() => rig.setState('hello'), [rig]); // greets on the home screen

  const stop = useCallback(() => {
    run.current++;
    source.cancel(); // also discards a clip being recorded
    lines.stop();
  }, [source, lines]);
  useEffect(() => stop, [stop]);

  const pause = useCallback(() => {
    if (!live.current) return;
    live.current = false;
    stop();
    rig.setState('idle');
    setListening(false);
    setCaption('');
    setPaused(true);
  }, [stop, rig]);

  // Leaving the app pauses exactly like the pause button.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') pause();
    });
    return () => sub.remove();
  }, [pause]);

  const goHome = () => {
    live.current = false;
    homeScroll.value = 0; // the menu comes back unscrolled
    rig.setState('idle');
    setCard(null);
    setCaption('');
    setListening(false);
    setPaused(false);
    setPlaying(false);
    lessonMode.value = withTiming(0, { duration: 650, easing: Easing.inOut(Easing.cubic) });
  };

  // resume: continue after a pause, without the shrink
  const play = async (resume = false) => {
    const token = ++run.current;
    const alive = () => token === run.current;
    // Before the run is live: the permission screen briefly backgrounds the app (even when already
    // granted, on Samsung), and leaving the app pauses a live run.
    await rec.prepare();
    if (!alive()) return;
    if (resume && saved.position && isFinished(lesson, saved.position)) return goHome();
    // a finished lesson starts over; mastery is kept
    const engine = createLesson(lesson, prompts, {
      mastery: saved.mastery,
      position: saved.position && !isFinished(lesson, saved.position) ? saved.position : null,
    });
    const save = (progress = engine.progress()) => {
      saveProgress(lesson.template_id, progress);
      setSaved(progress);
    };
    live.current = true;
    setPaused(false);
    if (!resume) {
      setPlaying(true);
      lessonMode.value = withSpring(1, { damping: 15, stiffness: 120 });
      await wait(SHRINK_SECONDS);
      if (!alive()) return;
    }
    for (;;) {
      const step = engine.next();
      if (step.type === 'done') break;
      setCard(step.item && { item: step.item, showAnchor: step.showAnchor });
      if (step.type === 'say') {
        const started = Date.now();
        rig.setState(step.state);
        setCaption(step.text);
        await lines.play(step.line, step.text);
        if (!alive()) return;
        // let one-shot gestures finish even when the line is shorter than the motion
        const def = STATE_DEFS[step.state];
        await wait(Math.max(0, (def.loop ? 0 : def.duration) + 0.25 - (Date.now() - started) / 1000));
      } else {
        lines.chime();
        rig.setState('listening');
        setCaption('');
        setListening(true);
        const answer = await source.listen(step.item, step.kind);
        if (!alive()) return;
        setListening(false);
        save(engine.answer(answer)); // progress is saved after every answer
        rig.setState('thinking');
        await wait(THINKING_SECONDS);
      }
      if (!alive()) return;
    }
    save();
    goHome();
  };

  const choose = (l: Lesson) => {
    setLessonId(l.template_id);
    saveLessonChoice(l.template_id);
    setSaved(loadProgress(l.template_id));
  };

  const position = saved.position;
  const finished = !!position && isFinished(lesson, position);
  const picture = card ? PICTURES[card.item.anchor.picture] : undefined;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <Animated.View style={[styles.stage, { width: bigSize }, stageStyle]}>
        <Animated.View style={[styles.shekru, shekruStyle]}>
          <Shekru values={rig.values} size={bigSize} hintLetter={picture} />
        </Animated.View>
      </Animated.View>

      {playing ? (
        <>
          <Animated.View entering={FadeInDown.delay(350).duration(450)} style={styles.card} testID="card">
            <Text
              testID="letter"
              style={[styles.letter, { fontSize: letterSize, lineHeight: Math.round(letterSize * 1.3) }]}>
              {card?.item.display ?? ' '}
            </Text>
            <Text testID="anchor" style={[styles.anchor, { fontSize: Math.round(letterSize * 0.5) }, !card?.showAnchor && styles.hidden]}>
              {picture ?? ' '}
            </Text>
          </Animated.View>
          <Text style={styles.caption} numberOfLines={3} testID="caption">{caption || ' '}</Text>
          {paused ? (
            <View style={styles.pausedRow} testID="paused">
              <Pressable testID="continue" accessibilityRole="button" accessibilityLabel="पुढे" onPress={() => play(true)} style={[styles.big, styles.continue]}>
                <Text style={styles.bigLabel}>▶ पुढे</Text>
              </Pressable>
              <Pressable testID="stop" accessibilityRole="button" accessibilityLabel="थांब" onPress={goHome} style={[styles.big, styles.stopButton]}>
                <Text style={styles.bigLabel}>■ थांब</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.controls}>
              {rec.active && rec.judged && <JudgeNote judged={rec.judged} />}
              {listening && <Mic />}
              {tester.waiting && (
                <View style={styles.tester}>
                  <Text style={styles.testerNote}>tester: what did the child say?</Text>
                  <View style={styles.testerRow}>
                    {ANSWERS.map(([answer, label]) => (
                      <Pressable
                        key={answer}
                        testID={`answer-${answer}`}
                        accessibilityRole="button"
                        onPress={() => tester.give(answer)}
                        style={[styles.answer, styles[answer]]}>
                        <Text style={styles.answerLabel}>{label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
            </View>
          )}
          {!paused && (
            <Pressable
              testID="pause"
              accessibilityRole="button"
              accessibilityLabel="विराम"
              onPress={pause}
              hitSlop={8}
              style={[styles.pause, { top: insets.top + 8 }]}>
              <View style={styles.pauseBar} />
              <View style={styles.pauseBar} />
            </Pressable>
          )}
        </>
      ) : (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none" onLayout={(e) => setHomeOrigin(e.nativeEvent.layout.y)}>
        <Animated.ScrollView
          ref={homeRef}
          onLayout={(e) => setHomeHeight(e.nativeEvent.layout.height)}
          onScroll={onHomeScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          entering={FadeIn.duration(400)}
          // starts below the shrunk Shekru; the padding above the menu is the part he gives back
          style={[styles.homeWrap, { marginTop: insets.top + tinySize - homeOrigin }]}
          // tall enough to always shrink Shekru fully, even when the menu is short
          contentContainerStyle={[styles.home, { paddingTop: collapseRange + 8, paddingBottom: 16 + keyboard, minHeight: homeHeight + collapseRange }]}>
          <View style={styles.menu} testID="lesson-menu">
            {LESSONS.map((l) => {
              const chosen = l.template_id === lesson.template_id;
              return (
                <Pressable
                  key={l.template_id}
                  testID={`lesson-${l.template_id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: chosen }}
                  accessibilityLabel={l.title}
                  onPress={() => choose(l)}
                  style={[styles.lessonChip, chosen && styles.lessonChosen]}>
                  <Text style={styles.lessonLetters}>{l.items.map((i) => i.display).join(' ')}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.title}>{lesson.title}</Text>
          <Pressable testID="start" accessibilityRole="button" onPress={() => play()} style={styles.start}>
            <Text style={styles.startLabel}>{finished ? '▶ पुन्हा खेळूया' : '▶ सुरू करूया'}</Text>
          </Pressable>
          <View style={styles.links}>
            <Pressable
              testID="reset"
              accessibilityRole="button"
              onPress={() => { resetProgress(); setSaved(loadProgress(lesson.template_id)); }}
              style={styles.link}>
              <Text style={styles.linkLabel}>
                tester: reset progress ({!position ? 'new' : finished ? 'finished' : `step ${position.flow + 1}/${lesson.flow.length}, item ${position.index + 1}`})
              </Text>
            </Pressable>
            <Link href="/demo" testID="demo-link" style={[styles.link, styles.linkLabel]}>Shekru demo ›</Link>
          </View>
          <RecordingPanel rec={rec} />
        </Animated.ScrollView>
        </View>
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
  return <Text style={styles.testerNote} numberOfLines={2} testID="judge-note">{text}</Text>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFF6E6', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12 },
  stage: { alignItems: 'center', paddingTop: 4 },
  shekru: { transformOrigin: 'top' },
  hidden: { opacity: 0 },
  card: {
    flex: 1, alignSelf: 'stretch', maxWidth: 560, width: '100%', marginTop: 4, borderRadius: 28, borderWidth: 2,
    borderColor: '#F0DCC0', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center',
  },
  letter: { fontWeight: '700', color: '#3D1420', textAlign: 'center' },
  anchor: { textAlign: 'center' },
  caption: { fontSize: 14, color: '#7A5A45', textAlign: 'center', minHeight: 40, marginTop: 6, maxWidth: 560 },
  controls: { height: 132, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  mic: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  micRing: { position: 'absolute', width: 56, height: 56, borderRadius: 28, backgroundColor: '#ED9950' },
  micDot: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#801936', alignItems: 'center', justifyContent: 'center' },
  micIcon: { fontSize: 24 },
  tester: { alignSelf: 'stretch', alignItems: 'center' },
  testerNote: { fontSize: 11, color: '#7A5A45', marginBottom: 2 },
  testerRow: { flexDirection: 'row', gap: 8, alignSelf: 'stretch', justifyContent: 'center' },
  answer: {
    flex: 1, maxWidth: 180, minHeight: 48, borderRadius: 14, borderWidth: 2, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF',
  },
  correct: { borderColor: '#2E7D4F' },
  wrong: { borderColor: '#B3261E' },
  silent: { borderColor: '#7A5A45' },
  answerLabel: { fontSize: 16, fontWeight: '700', color: '#3D1420' },
  homeWrap: { flex: 1, alignSelf: 'stretch' },
  home: { alignItems: 'center', gap: 16, paddingHorizontal: 12 },
  pause: {
    position: 'absolute', right: 12, width: 56, height: 56, borderRadius: 28, flexDirection: 'row', gap: 7,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: '#F0DCC0',
  },
  pauseBar: { width: 7, height: 22, borderRadius: 2, backgroundColor: '#801936' },
  pausedRow: { height: 132, alignSelf: 'stretch', flexDirection: 'row', gap: 12, alignItems: 'flex-end', justifyContent: 'center' },
  big: { flex: 1, maxWidth: 240, minHeight: 96, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  continue: { backgroundColor: '#ED9950' },
  stopButton: { backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: '#F0DCC0' },
  bigLabel: { fontSize: 30, fontWeight: '800', color: '#3D1420' },
  title: { fontSize: 24, fontWeight: '700', color: '#3D1420' },
  menu: { width: '100%', maxWidth: 420, gap: 8 },
  lessonChip: {
    minHeight: 56, borderRadius: 18, borderWidth: 2, borderColor: '#F0DCC0', backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12,
  },
  lessonChosen: { borderColor: '#ED9950', borderWidth: 3, backgroundColor: '#FFF0DC' },
  lessonLetters: { fontSize: 24, fontWeight: '700', color: '#3D1420', letterSpacing: 2 },
  start: {
    minHeight: 96, width: '100%', maxWidth: 420, borderRadius: 28, backgroundColor: '#ED9950',
    alignItems: 'center', justifyContent: 'center',
  },
  startLabel: { fontSize: 32, fontWeight: '800', color: '#3D1420' },
  links: { alignItems: 'center' },
  link: { minHeight: 48, minWidth: 48, paddingHorizontal: 12, justifyContent: 'center', textAlignVertical: 'center' },
  linkLabel: { fontSize: 13, color: '#7A5A45', textDecorationLine: 'underline' },
});
