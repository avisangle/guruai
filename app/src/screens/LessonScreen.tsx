// Tester tools (route /tester, test builds only): the lesson menu, which opens a lesson in the
// lesson route (/lesson/[template]) for the first child, plus the recording panel. Shekru shrinks
// as the menu scrolls up, so the tester panel and its text fields get the screen.
import { Link } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { TestOnly } from '../config/TestOnly';
import lessonsJson from '../content/generated/lessons.json';
import { liveDb } from '../data/liveDb';
import { listChildren } from '../data/profiles';
import type { Lesson } from '../lesson/types';
import { Shekru } from '../shekru/Shekru';
import { useShekruRig } from '../shekru/useShekruRig';
import { RecordingPanel } from './RecordingPanel';
import { useRecording } from './useRecording';

const LESSONS = lessonsJson as unknown as Lesson[];

export function LessonScreen() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bigSize = Math.min(width * 0.92, height * 0.5, 520);
  const homeTop = Math.max(0, (height - bigSize - 320) / 3);
  // Shekru shrinks to tinySize as the menu scrolls up, at the scroll's own pace (a collapsing header).
  const tinySize = Math.round(Math.min(bigSize * 0.3, 110));
  const collapseRange = homeTop + bigSize - tinySize;

  const [lessonId, setLessonId] = useState(LESSONS[0].template_id);
  const lesson = LESSONS.find((l) => l.template_id === lessonId) ?? LESSONS[0];
  const [childId] = useState(() => listChildren(liveDb())[0]?.id);
  const rig = useShekruRig();
  const rec = useRecording(lesson.template_id, lesson.items);
  const homeScroll = useSharedValue(0);
  const homeRef = useAnimatedRef<Animated.ScrollView>();
  const [homeOrigin, setHomeOrigin] = useState(0); // where an absolute child's top:0 lands (parent padding or not)
  const [keyboard, setKeyboard] = useState(0);
  const [homeHeight, setHomeHeight] = useState(0); // the menu's visible height

  const onHomeScroll = useAnimatedScrollHandler((e) => {
    homeScroll.value = e.contentOffset.y;
  });
  // Both styles read the shared value directly: Reanimated only re-runs a style for values it sees in it.
  const stageStyle = useAnimatedStyle(() => {
    const c = Math.min(1, Math.max(0, homeScroll.value / collapseRange));
    return { height: bigSize + (tinySize - bigSize) * c, marginTop: homeTop * (1 - c) };
  });
  const shekruStyle = useAnimatedStyle(() => {
    const home = bigSize + (tinySize - bigSize) * Math.min(1, Math.max(0, homeScroll.value / collapseRange));
    return { transform: [{ scale: home / bigSize }] };
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

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <Animated.View style={[styles.stage, { width: bigSize }, stageStyle]}>
        <Animated.View style={[styles.shekru, shekruStyle]}>
          <Shekru values={rig.values} size={bigSize} />
        </Animated.View>
      </Animated.View>

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
                  onPress={() => setLessonId(l.template_id)}
                  style={[styles.lessonChip, chosen && styles.lessonChosen]}>
                  <Text style={styles.lessonLetters}>{l.items.map((i) => i.display).join(' ')}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.title}>{lesson.title}</Text>
          {/* tester tool (GURU-9 gates these to test builds) until the child picker opens lessons */}
          {childId && (
            <Link
              href={{ pathname: '/lesson/[template]', params: { template: lesson.template_id, child: childId } }}
              asChild>
              <Pressable testID="start" accessibilityRole="button" style={styles.start}>
                <Text style={styles.startLabel}>▶ सुरू करूया</Text>
              </Pressable>
            </Link>
          )}
          <TestOnly>
            <View style={styles.links}>
              <Link href="/demo" testID="demo-link" style={[styles.link, styles.linkLabel]}>Shekru demo ›</Link>
            </View>
            <RecordingPanel rec={rec} />
          </TestOnly>
        </Animated.ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFF6E6', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12 },
  stage: { alignItems: 'center', paddingTop: 4 },
  shekru: { transformOrigin: 'top' },
  homeWrap: { flex: 1, alignSelf: 'stretch' },
  home: { alignItems: 'center', gap: 16, paddingHorizontal: 12 },
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
