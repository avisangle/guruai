import { useAudioPlayer } from 'expo-audio';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import anim from '../shekru/generated/shekru.anim.json';
import visemes from '../shekru/generated/visemes.json';
import { Shekru } from '../shekru/Shekru';
import { useShekruRig, type VisemeEvent } from '../shekru/useShekruRig';

// States, labels and lines match design/characters/shekru/anim/index.html.
const STATES: [string, string, string | null][] = [
  ['hello', 'नमस्कार', 'hello'], ['idle', 'शांत', null], ['talking', 'बोलणे', 'teach'], ['listening', 'ऐकणे', null],
  ['thinking', 'विचार', null], ['correct', 'बरोबर', 'correct'], ['tryagain', 'पुन्हा', 'tryagain'], ['hint', 'मदत', 'hint'],
  ['nohear', 'ऐकू आलं नाही', 'nohear'], ['bye', 'बाय', 'bye'],
];
const LINE_OF = Object.fromEntries(STATES.map(([s, , l]) => [s, l]));
const SILENT_CAPTION: Record<string, string> = { listening: 'तुझी पाळी! बोल…', thinking: 'हम्म…' };
// state, voice line (or null), seconds to hold when there is no line
const LESSON: [string, string | null, number?][] = [
  ['hello', 'hello'], ['talking', 'teach'], ['listening', null, 3], ['nohear', 'nohear'], ['listening', null, 3],
  ['thinking', null, 2.4], ['tryagain', 'tryagain'], ['hint', 'hint'], ['listening', null, 3], ['thinking', null, 2.4],
  ['correct', 'correct'], ['bye', 'bye'], ['idle', null, 0],
];
const CLIPS = visemes as unknown as Record<string, { text: string; events: VisemeEvent[] }>;
const STATE_DEFS = anim.states as Record<string, { loop?: boolean; duration: number }>;
const AUDIO: Record<string, number> = {
  hello: require('../../assets/audio/hello.mp3'), teach: require('../../assets/audio/teach.mp3'),
  nohear: require('../../assets/audio/nohear.mp3'), tryagain: require('../../assets/audio/tryagain.mp3'),
  hint: require('../../assets/audio/hint.mp3'), correct: require('../../assets/audio/correct.mp3'),
  bye: require('../../assets/audio/bye.mp3'),
};

// Shekru's states and the scripted demo lesson, for reviewing the character.
export default function Demo() {
  const { width, height } = useWindowDimensions();
  const size = Math.min(width, height * 0.5, 520);
  const [active, setActive] = useState('idle');
  const [caption, setCaption] = useState('');
  const [inLesson, setInLesson] = useState(false);
  const rig = useShekruRig(setActive);
  const player = useAudioPlayer(AUDIO.hello, { updateInterval: 50 });
  const onLineEnd = useRef<(() => void) | null>(null);
  const run = useRef(0); // bumping it cancels a running lesson

  const endLine = useCallback(() => {
    rig.setSpeech(null);
    onLineEnd.current?.();
    onLineEnd.current = null;
  }, [rig]);

  // Lip-sync follows the real audio position, as the web preview does.
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.didJustFinish) endLine();
      else if (s.playing) rig.syncSpeech(true, s.currentTime);
    });
    return () => sub.remove();
  }, [player, rig, endLine]);

  const stopAudio = useCallback(() => {
    player.pause();
    endLine();
  }, [player, endLine]);

  // Resolves when the line ends or is interrupted.
  const playLine = (line: string) => new Promise<void>((resolve) => {
    stopAudio();
    rig.setSpeech(CLIPS[line].events);
    setCaption(CLIPS[line].text);
    player.replace(AUDIO[line]);
    player.play();
    onLineEnd.current = resolve;
  });

  const show = (state: string) => {
    rig.setState(state);
    const line = LINE_OF[state];
    if (line) return playLine(line);
    stopAudio();
    setCaption(SILENT_CAPTION[state] ?? '');
    return Promise.resolve();
  };

  const wait = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

  const playLesson = async () => {
    const token = ++run.current;
    setInLesson(true);
    for (const [state, line, hold = 0] of LESSON) {
      const started = Date.now();
      await show(state);
      if (token !== run.current) return;
      // let one-shot gestures finish even when the line is shorter than the motion
      const def = STATE_DEFS[state];
      const min = line ? (def.loop ? 0 : def.duration) + 0.25 : hold;
      await wait(Math.max(0, min - (Date.now() - started) / 1000));
      if (token !== run.current) return;
    }
    setInLesson(false);
  };

  const stopLesson = () => {
    run.current++;
    setInLesson(false);
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.stage}>
        <Shekru values={rig.values} size={size} hintLetter="C" />
      </View>
      <Text style={styles.caption} numberOfLines={2}>{caption || ' '}</Text>
      <View style={styles.states}>
        {STATES.map(([state, label]) => (
          <Pressable
            key={state}
            testID={`state-${state}`}
            accessibilityRole="button"
            onPress={() => { stopLesson(); show(state); }}
            style={[styles.button, active === state && styles.buttonActive]}>
            <Text style={[styles.label, active === state && styles.labelActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        testID="lesson"
        accessibilityRole="button"
        onPress={() => {
          if (!inLesson) return playLesson();
          stopLesson();
          stopAudio();
          show('idle');
        }}
        style={styles.speak}>
        <Text style={styles.speakLabel}>{inLesson ? '■ थांब' : '▶ पाठ खेळ'}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFF6E6', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 12 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  states: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, maxWidth: 560 },
  button: {
    minHeight: 48, minWidth: 64, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1, borderColor: '#F0DCC0',
    backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center',
  },
  buttonActive: { backgroundColor: '#801936', borderColor: '#801936' },
  label: { fontSize: 17, fontWeight: '700', color: '#3D1420' },
  labelActive: { color: '#FFFFFF' },
  speak: {
    marginTop: 12, minHeight: 56, width: '100%', maxWidth: 560, borderRadius: 16, backgroundColor: '#ED9950',
    alignItems: 'center', justifyContent: 'center',
  },
  caption: { fontSize: 19, fontWeight: '600', color: '#3D1420', textAlign: 'center', minHeight: 52, marginBottom: 8, maxWidth: 560 },
  speakLabel: { fontSize: 22, fontWeight: '700', color: '#3D1420' },
});
