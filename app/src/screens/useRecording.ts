// The lesson's answer source and tester recording mode. With the speech model on the phone
// and mic permission, every listening turn records the child (16 kHz mono WAV), stops by
// itself (asr/endpoint.ts) and the on-device judge's verdict is the answer. Without them
// (web, no model, mic denied) the inner source answers: the tester buttons, in test builds only.
// Recording mode only decides whether takes are kept as clips: the switch starts off at
// every launch so nobody is recorded by accident; child code and age are remembered.
// The switches and mic status are process-wide: the home panel sets them, the lesson route uses them.
// Tap mode (tester switch, also off at launch): the tester's buttons decide, and with
// recording on the judge scores each clip alongside, giving tester-labelled clips.
// Outside recording mode, keep() may take a take for the consented upload queue (GURU-38).
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { judgeClip, type ClipJudge } from '../asr/lessonJudge';
import { modelAvailable } from '../asr/model';
import type { AnswerSource } from '../lesson/answerSource';
import type { Item } from '../lesson/types';
import { createMicSource, type CaptureContext, type Mic } from '../recording/capture';
import { isChildCode } from '../recording/clips';
import {
  clipSink,
  countClips,
  deleteAllClips,
  exportClips,
  loadSettings,
  RECORDING_SUPPORTED,
  saveSettings,
  type RecordingSettings,
} from '../recording/store';

const CHIME_MS = 750; // assets/audio/chime.wav is 0.73 s

export type JudgedClip = { answer: string; judge: ClipJudge; tapped: boolean };

export type MicStatus = 'unknown' | 'granted' | 'denied' | 'unsupported';

type Switches = { on: boolean; tap: boolean; mic: MicStatus };
let switches: Switches = { on: false, tap: false, mic: 'unknown' };
const listeners = new Set<() => void>();
const setSwitches = (change: Partial<Switches>) => {
  switches = { ...switches, ...change };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const setOnState = (on: boolean) => setSwitches({ on });
const setTap = (tap: boolean) => setSwitches({ tap });
const setMic = (mic: MicStatus) => setSwitches({ mic });

// Without a mic, model or tap mode and no inner source, a listen turn waits until cancelled.
const NO_ANSWERS: AnswerSource = { listen: () => new Promise(() => undefined), cancel: () => undefined };

export function useRecording(
  templateId: string,
  items: Item[],
  inner: AnswerSource = NO_ANSWERS,
  keep?: (audioUri: string, recordedAt: Date) => string | null,
) {
  const { on, tap, mic } = useSyncExternalStore(subscribe, () => switches);
  const [settings, setSettings] = useState(loadSettings);
  const [count, setCount] = useState(countClips);
  const [error, setError] = useState<string | null>(null);
  const [judged, setJudged] = useState<JudgedClip | null>(null);
  const { stream } = useAudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16' });
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const active = on && isChildCode(settings.child) && mic === 'granted';
  const context = useRef<CaptureContext | null>(null);
  context.current = active ? { child: settings.child, age: settings.age, templateId } : null;

  const update = useCallback((change: Partial<RecordingSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...change };
      saveSettings(next);
      return next;
    });
  }, []);

  // iOS needs a record-capable audio session; Android does not use this flag.
  useEffect(() => {
    if (Platform.OS === 'ios') setAudioModeAsync({ allowsRecording: mic === 'granted' }).catch(() => {});
  }, [mic]);

  const setOn = useCallback(async (want: boolean) => {
    setError(null);
    setOnState(false);
    if (!want) return;
    let granted = false;
    try {
      granted = (await requestRecordingPermissionsAsync()).granted;
    } catch {
      // treated as denied
    }
    setMic(!granted ? 'denied' : RECORDING_SUPPORTED ? 'granted' : 'unsupported');
    setOnState(granted && RECORDING_SUPPORTED);
  }, []);

  // Asks for the microphone before a lesson; the judge listens only with permission.
  const prepare = useCallback(async () => {
    if (!RECORDING_SUPPORTED || !modelAvailable()) return;
    let granted = false;
    try {
      granted = (await requestRecordingPermissionsAsync()).granted;
    } catch {
      // treated as denied
    }
    setMic(granted ? 'granted' : 'denied');
  }, []);

  const source = useMemo((): AnswerSource => {
    let filing = false;
    let sub: { remove(): void } | null = null;
    const device: Mic = {
      prepare: () => stream.start(),
      record: async (onPcm) => {
        sub = stream.addListener('audioStreamBuffer', (b) => onPcm(new Int16Array(b.data), b.sampleRate));
        await stream.startFileRecordingAsync({ directory: 'cache', format: 'wav' });
        filing = true;
      },
      stop: async () => {
        sub?.remove();
        sub = null;
        let take: { uri: string | null; durationMs: number } = { uri: null, durationMs: 0 };
        if (filing) {
          filing = false;
          const r = await stream.stopFileRecordingAsync();
          take = { uri: r.uri, durationMs: r.duration * 1000 };
        }
        stream.stop();
        return take;
      },
    };
    const judged = createMicSource(device, clipSink, {
      startDelayMs: CHIME_MS,
      judge: (uri, listen) => judgeClip(uri, listen, itemsRef.current),
      context: () => context.current,
      keep,
      tapped: () => (switches.tap ? inner : null),
      onJudged: (judge, answer, saved, tapped) => {
        if (saved) setCount(countClips());
        setJudged({ answer, judge, tapped });
      },
      onError: (e) => setError(String(e)),
    });
    const judgeReady = () => RECORDING_SUPPORTED && modelAvailable() && switches.mic === 'granted';
    // tap mode records only in recording mode, as before the judge drove lessons
    const useMic = () => (switches.tap ? context.current != null && switches.mic === 'granted' : judgeReady());
    return {
      listen: (step) => (useMic() ? judged : inner).listen(step),
      cancel: () => {
        judged.cancel();
        inner.cancel();
      },
    };
  }, [stream, inner, keep]);

  const exportAll = useCallback(async () => {
    setError(null);
    try {
      await exportClips();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const deleteAll = useCallback(() => {
    deleteAllClips();
    setCount(countClips());
  }, []);

  return { on, settings, update, setOn, tap, setTap, mic, active, count, error, source, prepare, exportAll, deleteAll, judged };
}
