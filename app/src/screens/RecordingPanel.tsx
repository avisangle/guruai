// Home-screen tester controls for recording mode. Tester-only, so English is fine.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { isChildCode, parseAge, sanitizeChildCode } from '../recording/clips';
import type { useRecording } from './useRecording';

type Recording = ReturnType<typeof useRecording>;
const CONFIRM_MS = 4000;

export function RecordingPanel({ rec }: { rec: Recording }) {
  const [age, setAge] = useState(rec.settings.age?.toString() ?? '');
  const [armed, setArmed] = useState(false); // delete needs a second tap
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  const needsCode = rec.on && !isChildCode(rec.settings.child);

  return (
    <View style={styles.panel} testID="recording-panel">
      <View style={styles.row}>
        <Switch
          testID="record-toggle"
          value={rec.on}
          onValueChange={rec.setOn}
          accessibilityLabel="tester: record answers"
        />
        <Text style={styles.label}>tester: record answers</Text>
      </View>
      <View style={styles.row}>
        <Switch testID="tap-toggle" value={rec.tap} onValueChange={rec.setTap} accessibilityLabel="tester: I tap the answers" />
        <Text style={styles.label}>tester: I tap the answers{rec.tap ? ' (judge scores alongside when recording)' : ''}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>child code</Text>
        <TextInput
          testID="child-code"
          style={[styles.input, styles.code]}
          value={rec.settings.child}
          onChangeText={(t) => rec.update({ child: sanitizeChildCode(t) })}
          placeholder="C1"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={5}
        />
        <Text style={styles.label}>age</Text>
        <TextInput
          testID="child-age"
          style={[styles.input, styles.age]}
          value={age}
          onChangeText={(t) => {
            const digits = t.replace(/\D/g, '').slice(0, 2);
            setAge(digits);
            rec.update({ age: parseAge(digits) });
          }}
          placeholder="opt."
          keyboardType="number-pad"
          maxLength={2}
        />
      </View>

      {rec.mic === 'denied' && (
        <View testID="mic-denied">
          <Text style={styles.marathi}>मायक्रोफोन वापरायची परवानगी मिळाली नाही, म्हणून उत्तरं रेकॉर्ड होणार नाहीत.</Text>
          <Text style={styles.note}>
            tester: microphone permission denied. Allow Microphone for Expo Go (or GuruAI) in Android Settings › Apps ›
            Permissions, then turn the switch on again.
          </Text>
        </View>
      )}
      {rec.mic === 'unsupported' && <Text style={styles.note}>tester: recording works in the Android app, not on web.</Text>}
      {needsCode && <Text style={[styles.note, styles.warn]}>tester: enter a child code (C1, C2…) to record. Never a name.</Text>}
      {rec.active && <Text style={[styles.note, styles.ok]} testID="recording-on">● recording each answer for {rec.settings.child}</Text>}
      {rec.error && <Text style={[styles.note, styles.warn]} numberOfLines={2}>tester: {rec.error}</Text>}

      <View style={styles.row}>
        <Text style={styles.label} testID="clip-count">{rec.count} {rec.count === 1 ? 'clip' : 'clips'} saved</Text>
        <Pressable
          testID="export-clips"
          accessibilityRole="button"
          disabled={!rec.count || exporting}
          onPress={async () => {
            setExporting(true);
            await rec.exportAll();
            setExporting(false);
          }}
          style={[styles.button, (!rec.count || exporting) && styles.disabled]}>
          <Text style={styles.buttonLabel}>{exporting ? 'exporting…' : 'export clips'}</Text>
        </Pressable>
        <Pressable
          testID="delete-clips"
          accessibilityRole="button"
          disabled={!rec.count}
          onPress={() => {
            if (!armed) return setArmed(true);
            setArmed(false);
            rec.deleteAll();
          }}
          style={[styles.button, armed && styles.danger, !rec.count && styles.disabled]}>
          <Text style={[styles.buttonLabel, armed && styles.dangerLabel]}>
            {armed ? `tap again: delete ${rec.count}` : 'delete all clips'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignSelf: 'stretch', maxWidth: 420, width: '100%', gap: 4, padding: 8,
    borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: '#C9B39C',
  },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, minHeight: 48 },
  label: { fontSize: 13, color: '#7A5A45' },
  input: {
    minHeight: 40, borderWidth: 1, borderColor: '#C9B39C', borderRadius: 8, paddingHorizontal: 8,
    fontSize: 15, color: '#3D1420', backgroundColor: '#FFFFFF',
  },
  code: { width: 64 },
  age: { width: 52 },
  marathi: { fontSize: 15, color: '#3D1420' },
  note: { fontSize: 12, color: '#7A5A45' },
  warn: { color: '#B3261E' },
  ok: { color: '#2E7D4F' },
  button: {
    minHeight: 40, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: '#C9B39C',
    backgroundColor: '#FFFFFF', justifyContent: 'center',
  },
  buttonLabel: { fontSize: 13, color: '#3D1420' },
  danger: { borderColor: '#B3261E', backgroundColor: '#FBE9E7' },
  dangerLabel: { color: '#B3261E', fontWeight: '700' },
  disabled: { opacity: 0.4 },
});
