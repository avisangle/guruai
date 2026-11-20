// Parent gate unlock (wireframes g-unlock, g-pin, g-pin-wrong, g-pin-wait30/5/15, p-lock-pin).
// Device mode shows only the system prompt; pin mode the keypad with waits; a phone without a
// screen lock, or a parent recovering a forgotten PIN, sets a new PIN first.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '../ui/components/Button';
import { Screen } from '../ui/components/Screen';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import type { StringKey } from '../ui/strings/mr';
import { theme } from '../ui/theme';
import type { GateState } from './gate';
import { BACKSPACE, FINGERPRINT, Icon, LOCK } from './icons';
import { lockoutFor } from './lockout';
import { PIN_LENGTH } from './pin';
import { useParentMode } from './ParentModeProvider';

const SEC = 1000;
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** null while loading; 'setup' after a forgotten PIN is recovered. */
type Mode = GateState | 'setup' | null;
type Wait = { until: number; title: StringKey; body: StringKey };

/** A wait ending at `until`, with the copy for the lockout stage it falls in (30 s, 5 min, then 15 min). */
function waitUntil(until: number): Wait {
  const ms = until - Date.now();
  if (ms > lockoutFor(6)) return { until, title: 'pinWait15Title', body: 'pinWait15' };
  return { until, title: 'pinWaitTitle', body: ms > lockoutFor(3) ? 'pinWait5' : 'pinWait30' };
}

function clock(ms: number) {
  const s = Math.ceil(ms / SEC);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function UnlockScreen() {
  const { t } = useT();
  const { gate, enter, exit } = useParentMode();
  const [mode, setMode] = useState<Mode>(null);
  const [digits, setDigits] = useState('');
  /** Setup: the PIN from the first row, once complete. */
  const [first, setFirst] = useState<string | null>(null);
  const [message, setMessage] = useState<StringKey | null>(null);
  const [wait, setWait] = useState<Wait | null>(null);
  const endWait = useCallback(() => setWait(null), []);
  const setup = mode === 'setup' || mode === 'needs_pin_setup';
  const locked = wait !== null;

  useEffect(() => {
    let live = true;
    (async () => {
      const state = await gate().state();
      if (!live) return;
      setMode(state);
      if (state !== 'device') return;
      const ok = await gate().unlockWithDevice(t('unlockPrompt'));
      if (live) (ok ? enter : exit)();
    })();
    return () => {
      live = false;
    };
  }, [gate, t, enter, exit]);

  async function submitPin(pin: string) {
    const result = await gate().verifyPin(pin);
    if (result.ok) return enter();
    if (result.waitUntil) {
      setMessage(null);
      setWait(waitUntil(result.waitUntil));
      return;
    }
    // Every 3rd wrong PIN starts a wait, so a first miss since the last one leaves two tries.
    setMessage(message ? 'pinWrongOneLeft' : 'pinWrongTwoLeft');
  }

  async function submitSetup(pin: string) {
    if (first === null) {
      setFirst(pin);
      setMessage(null);
    } else if (pin !== first) {
      setMessage('pinMismatch');
    } else {
      await gate().setPin(pin);
      enter();
    }
  }

  function press(digit: string) {
    if (locked) return;
    const next = digits + digit;
    if (next.length < PIN_LENGTH) return setDigits(next);
    setDigits('');
    (setup ? submitSetup : submitPin)(next);
  }

  async function recover() {
    if (!(await gate().recoverWithBiometrics(t('unlockPrompt')))) return;
    setWait(null);
    setMessage(null);
    setDigits('');
    setFirst(null);
    setMode('setup');
  }

  let panel: ReactNode = null;
  if (wait) {
    panel = (
      <>
        <Text variant="title" style={styles.center}>
          {t(wait.title)}
        </Text>
        <Note tone="warning">{t(wait.body)}</Note>
        <Text style={styles.center}>{t('pinWaitLessonsGoOn')}</Text>
        <Button variant="parent" label={t('pinUnlockBiometric')} onPress={recover} />
        <Countdown until={wait.until} onDone={endWait} />
      </>
    );
  } else if (mode === 'pin') {
    panel = (
      <>
        <Text variant="title" style={styles.center}>
          {t('pinEnter')}
        </Text>
        <Dots filled={digits.length} error={message !== null} />
        {message ? <Note tone="error">{t(message)}</Note> : <Text style={[styles.center, styles.muted]}>{t('pinOrFingerprint')}</Text>}
      </>
    );
  } else if (setup) {
    panel = (
      <>
        <Text variant="title" style={styles.center}>
          {t('pinSetTitle')}
        </Text>
        {mode === 'needs_pin_setup' && <Note tone="warning">{t('pinNoScreenLock')}</Note>}
        <PinRow label={t('pinFirst')} filled={first === null ? digits.length : PIN_LENGTH} active={first === null} />
        <PinRow label={t('pinAgain')} filled={first === null ? 0 : digits.length} active={first !== null} />
        {message && <Note tone="error">{t(message)}</Note>}
        <Note tone="warning">
          <Text variant="label">{t('pinRemember')}</Text> {t('pinRememberBody')}
        </Note>
      </>
    );
  }

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

      {(mode === 'pin' || setup) && (
        <View style={styles.body}>
          {panel}
          <View style={styles.grow} />
          <View style={styles.keys}>
            {DIGITS.map((d) => (
              <Key key={d} framed disabled={locked} onPress={() => press(d)}>
                <Text variant="title">{d}</Text>
              </Key>
            ))}
            {mode === 'pin' && !locked ? (
              <Key label={t('pinFingerprintKey')} onPress={recover}>
                <Icon d={FINGERPRINT} size={ICON} color={color.parent.text} />
              </Key>
            ) : (
              <View style={styles.key} />
            )}
            <Key framed disabled={locked} onPress={() => press('0')}>
              <Text variant="title">0</Text>
            </Key>
            <Key label={t('pinDelete')} disabled={locked} onPress={() => setDigits(digits.slice(0, -1))}>
              <Icon d={BACKSPACE} size={ICON} color={color.parent.text} />
            </Key>
          </View>
        </View>
      )}

      <View style={styles.footer}>
        <Button variant="parentGhost" label={t('backToChildren')} onPress={exit} />
      </View>
    </Screen>
  );
}

/** m:ss until `until`; calls onDone when it is reached. Owns the ticking, so only it re-renders. */
function Countdown({ until, onDone }: { until: number; onDone: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => {
      const at = Date.now();
      if (at >= until) onDone();
      else setNow(at);
    }, SEC);
    return () => clearInterval(id);
  }, [until, onDone]);
  return (
    <Text variant="title" style={styles.center}>
      {clock(until - now)}
    </Text>
  );
}

type KeyProps = { label?: string; framed?: boolean; disabled?: boolean; onPress: () => void; children: ReactNode };

function Key({ label, framed, disabled, onPress, children }: KeyProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.key, framed && styles.digit, disabled && styles.disabled]}
    >
      {children}
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
