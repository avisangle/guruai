// Tester-only probe screen (docs/android-sr-probe.md): Android's recognizer and the on-device
// IndicConformer judge, run over clips pushed by USB. English is fine.
// guruai://probe?run=ic&threads=2 starts the IndicConformer run without a tap (fresh=1: drop old results).
import { useKeepAwake } from 'expo-keep-awake';
import { File } from 'expo-file-system';
import { useLocalSearchParams } from 'expo-router';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import GuruAsr from '../../modules/guru-asr';
import {
  deviceInfo,
  downloadMarathi,
  LANG,
  loadManifest,
  loadResults,
  MODES,
  probeDir,
  saveResults,
  transcribe,
  type DeviceInfo,
  type ProbeManifest,
} from '../probe/androidProbe';
import { judgeClip, loadIcResults, loadModel, modelFile, saveIcResults } from '../probe/icProbe';

const mb = (kb: number) => `${Math.round(kb / 1024)} MB`;

export function ProbeScreen() {
  useKeepAwake(); // a full run takes many minutes
  const params = useLocalSearchParams<{ run?: string; threads?: string; fresh?: string }>();
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [manifest, setManifest] = useState<ProbeManifest>({ clips: [], pieces: [] });
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const autoStarted = useRef(false);
  const say = (line: string) => setLog((l) => [line, ...l].slice(0, 200));
  const clips = manifest.clips;

  const refresh = async () => {
    try {
      setInfo(await deviceInfo());
    } catch (e) {
      say(`device info failed: ${String(e)}`);
    }
    setManifest(loadManifest());
  };
  useEffect(() => {
    if (Platform.OS === 'android') refresh();
  }, []);

  const runSr = async () => {
    if (!info) return;
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) return say('microphone/speech permission denied');
    setRunning(true);
    stop.current = false;
    const results = loadResults(info);
    let n = 0;
    for (const clip of clips) {
      if (stop.current) break;
      n += 1;
      for (const mode of MODES) {
        if (results.clips[clip.id]?.[mode]) continue; // resume: already done
        const uri = new File(probeDir(), clip.file).uri;
        const r = await transcribe(uri, mode === 'biased' ? clip.hints : null);
        results.clips[clip.id] = { ...results.clips[clip.id], [mode]: r };
        saveResults(results);
        const heard = r.finals.map((f) => f[0]?.transcript ?? '').join(' ').trim();
        say(`${n}/${clips.length} ${clip.id} ${mode}: ${heard || '-'}${r.error ? ` [${r.error}]` : ''} ${r.ms} ms`);
      }
    }
    setRunning(false);
    say(stop.current ? 'stopped (results kept; run again to resume)' : 'done');
  };

  const runIc = async (threads: number, fresh: boolean) => {
    const { clips: all, pieces } = loadManifest();
    if (!all.length || !pieces.length) return say('ic: no clips with candidates; push them again');
    setRunning(true);
    stop.current = false;
    try {
      const head = await loadModel(threads);
      say(`ic: model loaded in ${head.model.loadMs} ms, ${threads} threads, PSS ${mb(head.memory.beforeLoad.pssKb)} -> ${mb(head.memory.afterLoad.pssKb)}`);
      const results = loadIcResults(head, !fresh);
      let n = 0;
      for (const clip of all) {
        if (stop.current) break;
        n += 1;
        if (results.clips[clip.id] || !clip.candidates) continue;
        try {
          results.clips[clip.id] = await judgeClip(clip.file, clip.candidates, pieces);
        } catch (e) {
          results.clips[clip.id] = { choice: '', free: '', note: '', scores: {}, frames: 0, ms: { read: 0, model: 0, judge: 0 }, error: String(e) };
        }
        results.memory.peakPssKb = Math.max(results.memory.peakPssKb, GuruAsr?.memory().pssKb ?? 0);
        saveIcResults(results);
        const r = results.clips[clip.id];
        say(`ic ${n}/${all.length} ${clip.id}: ${r.error ?? `${r.choice} (${r.free || '-'}) model ${r.ms.model} ms`}`);
      }
      say(`ic: ${stop.current ? 'stopped' : 'done'}, peak PSS ${mb(results.memory.peakPssKb)}`);
    } catch (e) {
      say(`ic failed: ${String(e)}`);
    }
    setRunning(false);
  };

  useEffect(() => {
    if (params.run !== 'ic' || autoStarted.current || !manifest.clips.length) return;
    autoStarted.current = true;
    runIc(Number(params.threads) || 2, params.fresh === '1');
  }, [params.run, manifest]);

  if (Platform.OS !== 'android') return <Text style={styles.p}>The probe runs on Android only.</Text>;

  const model = modelFile();
  return (
    <ScrollView contentContainerStyle={styles.page} testID="probe-screen">
      <Text style={styles.h}>Speech probe (on-device only)</Text>
      <Text style={styles.p}>{clips.length} clips in {probeDir().uri}</Text>

      <Text style={styles.h2}>IndicConformer (ours)</Text>
      <Text style={styles.p}>model: {model.exists ? `${Math.round((model.size ?? 0) / 2 ** 20)} MB` : 'not pushed'}</Text>
      <View style={styles.row}>
        <Button label="run IndicConformer" onPress={() => runIc(2, false)} disabled={running || !model.exists || !clips.length} />
      </View>

      <Text style={styles.h2}>Android recognizer ({LANG})</Text>
      {info && (
        <View>
          <Text style={styles.p}>
            Android API {String(info.android)} · available {String(info.available)} · on-device {String(info.onDevice)}
          </Text>
          <Text style={styles.p}>default service: {info.defaultService || '(none)'}</Text>
          {Object.entries(info.locales).map(([pkg, l]) => (
            <Text key={pkg} style={[styles.p, l.installed ? styles.ok : styles.warn]} testID={`locale-${pkg}`}>
              {pkg}: {LANG} supported {String(l.supported)}, installed offline {String(l.installed)}
              {l.error ? ` (${l.error})` : ''}
              {l.count != null ? `\n  ${l.all?.join(' ') ?? l.count}; mr*: ${l.marathi?.join(', ') || 'none'}; offline: ${l.offline?.join(', ') || 'none'}` : ''}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.row}>
        <Button label="refresh" onPress={refresh} disabled={running} />
        <Button
          label={`download ${LANG} offline`}
          disabled={running}
          onPress={async () => {
            try {
              const r = await downloadMarathi();
              say(`download: ${r.status} ${r.message ?? ''}`);
            } catch (e) {
              say(`download failed: ${String((e as Error).message ?? e)}`);
            }
          }}
        />
        <Button label="run recognizer" onPress={runSr} disabled={running || !clips.length || !info} />
      </View>

      {running && <Button label="stop" onPress={() => (stop.current = true)} />}
      {log.map((line, i) => (
        <Text key={i} style={styles.log}>{line}</Text>
      ))}
    </ScrollView>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}>
      <Text style={styles.p}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingTop: 48, gap: 8 },
  h: { fontSize: 17, fontWeight: '700', color: '#3D1420' },
  h2: { fontSize: 15, fontWeight: '700', color: '#3D1420', marginTop: 8 },
  p: { fontSize: 13, color: '#3D1420' },
  ok: { color: '#2E7D4F' },
  warn: { color: '#B3261E' },
  log: { fontSize: 12, color: '#7A5A45', fontFamily: 'monospace' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    minHeight: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: '#C9B39C',
    backgroundColor: '#FFFFFF', justifyContent: 'center', alignSelf: 'flex-start',
  },
  disabled: { opacity: 0.4 },
});
