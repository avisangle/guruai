// Parent gate unlock (wireframes g-unlock, g-pin, g-pin-wrong, g-pin-wait30/5/15, p-lock-pin).
// Device mode shows only the system prompt; pin mode the keypad with waits; a phone without a
// screen lock, or a parent recovering a forgotten PIN, sets a new PIN first.
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '../ui/components/Button';
import { Screen } from '../ui/components/Screen';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import type { StringKey } from '../ui/strings/mr';
import { theme } from '../ui/theme';
import { BACKSPACE, FINGERPRINT, Icon, LOCK } from './icons';
import { useParentMode } from './ParentModeProvider';

const PIN_LENGTH = 4;
const SEC = 1000;
const MIN = 60 * SEC;
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

type Mode = 'loading' | 'device' | 'pin' | 'setup';
type Wait = { until: number; title: StringKey; body: StringKey };

/** Copy for a wait of `ms` (the gate gives 30 s, 5 min, then 15 min). */
function waitCopy(ms: number): Pick<Wait, 'title' | 'body'> {
  if (ms > 5 * MIN) return { title: 'pinWait15Title', body: 'pinWait15' };
  return { title: 'pinWaitTitle', body: ms > 30 * SEC ? 'pinWait5' : 'pinWait30' };
}

function clock(ms: number) {
  const s = Math.ceil(ms / SEC);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function UnlockScreen() {
  const { t } = useT();
  const { gate, enter, exit } = useParentMode();
  const [mode, setMode] = useState<Mode>('loading');
  const [noScreenLock, setNoScreenLock] = useState(false);
  const [digits, setDigits] = useState('');
  /** Setup: the PIN from the first row, once complete. */
  const [first, setFirst] = useState<string | null>(null);
  const [message, setMessage] = useState<StringKey | null>(null);
  /** Wrong PINs since the last wait; the gate keeps the real count. */
  const [fails, setFails] = useState(0);
  const [wait, setWait] = useState<Wait | null>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let live = true;
    (async () => {
      const state = await gate.state();
      if (!live) return;
      if (state !== 'device') {
        setNoScreenLock(state === 'needs_pin_setup');
        setMode(state === 'pin' ? 'pin' : 'setup');
        return;
      }
      setMode('device');
      const ok = await gate.unlockWithDevice(t('unlockPrompt'));
      if (live) (ok ? enter : exit)();
    })();
    return () => {
      live = false;
    };
  }, [gate, t, enter, exit]);

  useEffect(() => {
    if (!wait) return;
    const id = setInterval(() => {
      const at = Date.now();
      if (at >= wait.until) setWait(null);
      else setNow(at);
    }, SEC);
    return () => clearInterval(id);
  }, [wait]);

  async function submitPin(pin: string) {
    const result = await gate.verifyPin(pin);
    if (result.ok) return enter();
    if (result.waitUntil) {
      const at = Date.now();
      setFails(0);
      setMessage(null);
      setNow(at);
      setWait({ until: result.waitUntil, ...waitCopy(result.waitUntil - at) });
      return;
    }
    setFails(fails + 1);
    setMessage(fails === 0 ? 'pinWrongTwoLeft' : 'pinWrongOneLeft');
  }

  async function submitSetup(pin: string) {
    if (first === null) {
      setFirst(pin);
      setMessage(null);
    } else if (pin !== first) {
      setMessage('pinMismatch');
    } else {
      await gate.setPin(pin);
      enter();
    }
  }

  function press(digit: string) {
    if (wait) return;
    const next = digits + digit;
    if (next.length < PIN_LENGTH) return setDigits(next);
    setDigits('');
    (mode === 'setup' ? submitSetup : submitPin)(next);
  }

  async function recover() {
    if (!(await gate.recoverWithBiometrics(t('unlockPrompt')))) return;
    setWait(null);
    setFails(0);
    setMessage(null);
    setDigits('');
    setFirst(null);
    setNoScreenLock(false);
    setMode('setup');
  }

  const fingerprintKey = (
    <Pressable accessibilityRole="button" accessibilityLabel={t('pinFingerprintKey')} onPress={recover} style={styles.key}>
      <Icon d={FINGERPRINT} size={ICON} color={color.parent.text} />
    </Pressable>
  );

  return (
    <Screen variant="parent">
      <View style={styles.bar}>
        <Icon d={LOCK} size={ICON} color={color.parent.text} />
        <View>
          <Text variant="small" style={styles.muted}>
            {t('parentAreaLocked')}
          </Text>
          <Text variant="section">{t('forParents')}</Text>
        </View>
      </View>

      {(mode === 'pin' || mode === 'setup') && (
        <View style={styles.body}>
          {wait ? (
            <>
              <Text variant="title" style={styles.center}>
                {t(wait.title)}
              </Text>
              <Note tone="warning">{t(wait.body)}</Note>
              <Text style={styles.center}>{t('pinWaitLessonsGoOn')}</Text>
              <Button variant="parent" label={t('pinUnlockBiometric')} onPress={recover} />
              <Text variant="title" style={styles.center}>
                {clock(wait.until - now)}
              </Text>
            </>
          ) : mode === 'pin' ? (
            <>
              <Text variant="title" style={styles.center}>
                {t('pinEnter')}
              </Text>
              <Dots filled={digits.length} error={message !== null} />
              {message ? <Note tone="error">{t(message)}</Note> : <Text style={[styles.center, styles.muted]}>{t('pinOrFingerprint')}</Text>}
            </>
          ) : (
            <>
              <Text variant="title" style={styles.center}>
                {t('pinSetTitle')}
              </Text>
              {noScreenLock && <Note tone="warning">{t('pinNoScreenLock')}</Note>}
              <PinRow label={t('pinFirst')} filled={first === null ? digits.length : PIN_LENGTH} active={first === null} />
              <PinRow label={t('pinAgain')} filled={first === null ? 0 : digits.length} active={first !== null} />
              {message && <Note tone="error">{t(message)}</Note>}
              <Note tone="warning">
                <Text variant="label">{t('pinRemember')}</Text> {t('pinRememberBody')}
              </Note>
            </>
          )}

          <View style={styles.grow} />
          <View style={styles.keys}>
            {DIGITS.map((d) => (
              <Key key={d} digit={d} disabled={!!wait} onPress={press} />
            ))}
            {mode === 'pin' && !wait ? fingerprintKey : <View style={styles.key} />}
            <Key digit="0" disabled={!!wait} onPress={press} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('pinDelete')}
              disabled={!!wait}
              onPress={() => setDigits(digits.slice(0, -1))}
              style={[styles.key, !!wait && styles.disabled]}
            >
              <Icon d={BACKSPACE} size={ICON} color={color.parent.text} />
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.footer}>
        <Button variant="parentGhost" label={t('backToChildren')} onPress={exit} />
      </View>
    </Screen>
  );
}

function Key({ digit, disabled, onPress }: { digit: string; disabled: boolean; onPress: (digit: string) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={() => onPress(digit)}
      style={[styles.key, styles.digit, disabled && styles.disabled]}
    >
      <Text variant="title">{digit}</Text>
    </Pressable>
  );
}

function Dots({ filled, error }: { filled: number; error?: boolean }) {
  return (
    <View style={styles.dots}>
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <View key={i} style={[styles.dot, i < filled && styles.dotFilled, error && styles.dotError]} />
      ))}
    </View>
  );
}

function PinRow({ label, filled, active }: { label: string; filled: number; active: boolean }) {
  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <Text variant="label">{label}</Text>
      <Dots filled={filled} />
    </View>
  );
}

function Note({ tone, children }: { tone: 'warning' | 'error'; children: ReactNode }) {
  return (
    <View style={[styles.note, { borderColor: theme.color.parent[tone] }]}>
      <Text>{children}</Text>
    </View>
  );
}

const { color, radius, space, touch } = theme;
const DOT = 16;
const ICON = 24;

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space[3], paddingVertical: space[3] },
  body: { flex: 1, gap: space[4], paddingTop: space[5] },
  grow: { flex: 1 },
  center: { textAlign: 'center' },
  muted: { color: color.parent.textMuted },
  footer: { paddingVertical: space[3] },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space[4] },
  dot: { width: DOT, height: DOT, borderRadius: radius.parent.round, borderWidth: 2, borderColor: color.parent.borderStrong },
  dotFilled: { backgroundColor: color.parent.accent, borderColor: color.parent.accent },
  dotError: { borderColor: color.parent.error },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.parent.min,
    paddingHorizontal: space[4],
    borderRadius: radius.parent.control,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  rowActive: { borderColor: color.parent.accent, borderWidth: 2 },
  note: {
    padding: space[3],
    borderLeftWidth: 4,
    borderRadius: radius.parent.control,
    backgroundColor: color.parent.surface,
  },
  keys: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: touch.parent.gap },
  key: {
    width: touch.parent.keypadKey * 1.5,
    height: touch.parent.keypadKey,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.parent.control,
  },
  digit: { backgroundColor: color.parent.surface, borderWidth: 1, borderColor: color.parent.border },
  disabled: { opacity: 0.4 },
});
