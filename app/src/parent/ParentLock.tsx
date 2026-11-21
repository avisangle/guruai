// The only way into parent mode (wireframe g-longpress): a small, low-contrast lock in a
// 48 dp hit area; a 2 s hold opens the unlock, a shorter press does nothing.
import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { theme } from '../ui/theme';
import { Icon, LOCK } from './icons';

const { hitArea, visual, holdMs } = theme.touch.parentGate;

/** `onOpen` runs before the unlock opens, e.g. to pause a lesson. */
export function ParentLock({ onOpen }: { onOpen?: () => void }) {
  return (
    <Pressable
      testID="parent-lock"
      delayLongPress={holdMs}
      onLongPress={() => {
        onOpen?.();
        router.push('/parent/unlock');
      }}
      style={styles.hit}
    >
      <Icon d={LOCK} size={visual} color={theme.color.child.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: { width: hitArea, height: hitArea, alignItems: 'center', justifyContent: 'center' },
});
