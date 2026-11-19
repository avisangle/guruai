// Tester-only probe of Android's built-in speech recognizer (docs/android-sr-probe.md).
// Always on-device (createOnDeviceSpeechRecognizer): audio never leaves the phone.
// Clips arrive over USB in <documents>/probe; results go to <documents>/probe/results.json.
import { Directory, File, Paths } from 'expo-file-system';
import { AudioEncodingAndroid, ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { Platform } from 'react-native';

import type { Candidate } from '../asr/judge';

export const LANG = 'mr-IN';
const TIMEOUT_MS = 30_000;
export const MODES = ['plain', 'biased'] as const;
export type Mode = (typeof MODES)[number];

// file: relative to probe dir, 16 kHz mono WAV; candidates: the clip's lesson answers with token ids
export type ProbeClip = { id: string; file: string; hints: string[]; candidates?: Candidate[] };
export type ProbeManifest = { clips: ProbeClip[]; pieces: string[] };
export type Heard = { transcript: string; confidence: number };
export type ClipResult = { finals: Heard[][]; error: string; ms: number }; // one entry per final result event
export type Results = {
  format: 1;
  device: DeviceInfo;
  clips: Record<string, Partial<Record<Mode, ClipResult>>>;
};
export type DeviceInfo = {
  android: string | number;
  available: boolean;
  onDevice: boolean;
  defaultService: string;
  services: string[];
  // by service package; marathi: every reported tag starting "mr", installed: all offline tags
  locales: Record<string, { supported: boolean; installed: boolean; marathi?: string[]; offline?: string[]; count?: number; all?: string[]; error?: string }>;
};

export const probeDir = () => new Directory(Paths.document, 'probe');
const manifestFile = () => new File(probeDir(), 'manifest.json');
const resultsFile = () => new File(probeDir(), 'results.json');

export function loadManifest(): ProbeManifest {
  const f = manifestFile();
  const m = f.exists ? JSON.parse(f.textSync()) : {};
  return { clips: m.clips ?? [], pieces: m.pieces ?? [] };
}

export function loadResults(device: DeviceInfo): Results {
  const f = resultsFile();
  const old = f.exists ? (JSON.parse(f.textSync()) as Results) : null;
  return { format: 1, device, clips: old?.clips ?? {} };
}

export function saveResults(r: Results) {
  resultsFile().writeSync(JSON.stringify(r));
}

const SERVICES = ['', 'com.google.android.as', 'com.google.android.tts']; // '' = the default service

export async function deviceInfo(): Promise<DeviceInfo> {
  const m = ExpoSpeechRecognitionModule;
  const locales: DeviceInfo['locales'] = {};
  for (const pkg of SERVICES) {
    try {
      const r = await m.getSupportedLocales(pkg ? { androidRecognitionServicePackage: pkg } : {});
      locales[pkg || 'default'] = {
        supported: r.locales.includes(LANG),
        installed: r.installedLocales.includes(LANG),
        marathi: [...r.locales, ...r.installedLocales].filter((l) => /^mr/i.test(l)),
        offline: r.installedLocales,
        count: r.locales.length,
        all: r.locales,
      };
    } catch (e) {
      locales[pkg || 'default'] = { supported: false, installed: false, error: String((e as Error).message ?? e) };
    }
  }
  return {
    android: Platform.Version,
    available: m.isRecognitionAvailable(),
    onDevice: m.supportsOnDeviceRecognition(),
    defaultService: m.getDefaultRecognitionService().packageName,
    services: m.getSpeechRecognitionServices(),
    locales,
  };
}

export const downloadMarathi = () => ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale: LANG });

/** Transcribes one file on-device. Resolves on "end" (or after TIMEOUT_MS); never rejects. */
export function transcribe(uri: string, hints: string[] | null): Promise<ClipResult> {
  const m = ExpoSpeechRecognitionModule;
  const t0 = Date.now();
  const out: ClipResult = { finals: [], error: '', ms: 0 };
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subs = [
      m.addListener('result', (ev) => {
        if (ev.isFinal) out.finals.push(ev.results.map((r) => ({ transcript: r.transcript, confidence: r.confidence })));
      }),
      m.addListener('nomatch', () => {
        out.error ||= 'nomatch';
      }),
      m.addListener('error', (ev) => {
        out.error = `${ev.error}${ev.code != null ? ` (${ev.code})` : ''}: ${ev.message}`;
      }),
      m.addListener('end', () => done()),
    ];
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subs.forEach((s) => s.remove());
      out.ms = Date.now() - t0;
      resolve(out);
    };
    timer = setTimeout(() => {
      out.error ||= 'timeout';
      m.abort();
      setTimeout(done, 500); // abort normally fires "end"; this is the fallback
    }, TIMEOUT_MS);
    try {
      m.start({
        lang: LANG,
        requiresOnDeviceRecognition: true,
        interimResults: false,
        maxAlternatives: 5,
        ...(hints?.length ? { contextualStrings: hints } : {}),
        audioSource: { uri, audioChannels: 1, audioEncoding: AudioEncodingAndroid.ENCODING_PCM_16BIT, sampleRate: 16000 },
      });
    } catch (e) {
      out.error = `start: ${String((e as Error).message ?? e)}`;
      done();
    }
  });
}
