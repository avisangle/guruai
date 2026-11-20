// Parent-mode session: set by a successful unlock, ended by the parent, by 2 minutes without a
// touch (after a 10 s warning, decision 13) or by the app going to the background.
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { Button } from '../ui/components/Button';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import { theme } from '../ui/theme';
import type { Gate } from './gate';
import { liveGate } from './live';

const IDLE_MS = 2 * 60 * 1000;
const WARNING_MS = 10 * 1000;

type ParentMode = {
  gate: Gate;
  unlocked: boolean;
  /** Starts a session after a successful unlock and opens parent home. */
  enter: () => void;
  /** Ends the session and returns to the child side. */
  exit: () => void;
};

const ParentModeContext = createContext<ParentMode | null>(null);

type Props = { gate?: Gate; children?: ReactNode };

export function ParentModeProvider({ gate: injected, children }: Props) {
  const { t } = useT();
  const [gate] = useState(() => injected ?? liveGate());
  const [unlocked, setUnlocked] = useState(false);
  const [warning, setWarning] = useState(false);
  // Read by the touch and AppState handlers, which must not wait for a render.
  const unlockedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const exit = useCallback(() => {
    clearTimeout(timer.current);
    unlockedRef.current = false;
    // Leave before locking, so the /parent guard never sees a locked session and redirects.
    router.dismissTo('/');
    setWarning(false);
    setUnlocked(false);
  }, []);

  /** (Re)starts the idle countdown: warning at 2 min, return 10 s later. */
  const arm = useCallback(() => {
    clearTimeout(timer.current);
    setWarning(false);
    timer.current = setTimeout(() => {
      setWarning(true);
      timer.current = setTimeout(exit, WARNING_MS);
    }, IDLE_MS);
  }, [exit]);

  const enter = useCallback(() => {
    unlockedRef.current = true;
    setUnlocked(true);
    arm();
    router.replace('/parent');
  }, [arm]);

  const onTouchStart = useCallback(() => {
    if (unlockedRef.current) arm();
  }, [arm]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && unlockedRef.current) exit();
    });
    return () => {
      sub.remove();
      clearTimeout(timer.current);
    };
  }, [exit]);

  const value = useMemo(() => ({ gate, unlocked, enter, exit }), [gate, unlocked, enter, exit]);

  return (
    <ParentModeContext.Provider value={value}>
      <View style={styles.fill} onTouchStart={onTouchStart}>
        {children}
        {warning && (
          <View style={styles.warning}>
            <Text variant="label">{t('idleTitle')}</Text>
            <Text>{t('idleBody')}</Text>
            <Button variant="parent" label={t('idleStay')} onPress={arm} />
          </View>
        )}
      </View>
    </ParentModeContext.Provider>
  );
}

export function useParentMode(): ParentMode {
  const value = useContext(ParentModeContext);
  if (!value) throw new Error('useParentMode() needs a ParentModeProvider above it');
  return value;
}

const { color, radius, space } = theme;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  warning: {
    position: 'absolute',
    left: space.screenGutterParent,
    right: space.screenGutterParent,
    bottom: space[6],
    gap: space[2],
    padding: space[4],
    backgroundColor: color.parent.accentSurface,
    borderColor: color.parent.border,
    borderWidth: 1,
    borderRadius: radius.parent.card,
  },
});
