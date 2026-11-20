// The lesson's answer source and tester recording mode. With the speech model on the phone
// and mic permission, every listening turn records the child (16 kHz mono WAV), stops by
// itself (asr/endpoint.ts) and the on-device judge's verdict is the answer. Without them
// (web, no model, mic denied) the tester buttons answer instead.
// Recording mode only decides whether takes are kept as clips: the switch starts off at
// every launch so nobody is recorded by accident; child code and age are remembered.
// Tap mode (tester switch, also off at launch): the tester's buttons decide, and with
// recording on the judge scores each clip alongside, giving tester-labelled clips.
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

export function useRecording(templateId: string, items: Item[], inner: AnswerSource) {
  const [on, setOnState] = useState(false);
  const [tap, setTap] = useState(false);
  const tapRef = useRef(tap);
  tapRef.current = tap;
  const [settings, setSettings] = useState(loadSettings);
  const [mic, setMic] = useState<MicStatus>('unknown');
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

  const micRef = useRef(mic);
  micRef.current = mic;
  // Asks for the microphone before a lesson; the judge listens only with permission.
  const prepare = useCallback(async () => {
    if (!RECORDING_SUPPORTED || !modelAvailable()) return;
    let granted = false;
    try {
      granted = (await requestRecordingPermissionsAsync()).granted;
    } catch {
      // treated as denied
    }
    micRef.current = granted ? 'granted' : 'denied'; // the first listen comes before a re-render
    setMic(micRef.current);
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
      tapped: () => (tapRef.current ? inner : null),
      onJudged: (judge, answer, saved, tapped) => {
        if (saved) setCount(countClips());
        setJudged({ answer, judge, tapped });
      },
      onError: (e) => setError(String(e)),
    });
    const judgeReady = () => RECORDING_SUPPORTED && modelAvailable() && micRef.current === 'granted';
    // tap mode records only in recording mode, as before the judge drove lessons
    const useMic = () => (tapRef.current ? context.current != null && micRef.current === 'granted' : judgeReady());
    return {
      listen: (step) => (useMic() ? judged : inner).listen(step),
      cancel: () => {
        judged.cancel();
        inner.cancel();
      },
    };
  }, [stream, inner]);

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
