// The mic in the control zone (wireframes l-talking, l-listening, l-nohear): a dashed outline
// while Shekru talks, a filled pulsing disc while listening, and an ear-and-loop badge on the
// turn reopened after "didn't hear". Shape, not only colour, tells closed from open.
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { EAR, Icon, LOOP, MIC } from '../parent/icons';
import { theme } from '../ui/theme';

const { color, radius, space, touch } = theme;
const SIZE = touch.child.min;

export function MicIndicator({ open, again = false }: { open: boolean; again?: boolean }) {
  if (!open) {
    return (
      <View style={[styles.mic, styles.closed]} testID="mic-closed">
        <Icon d={MIC} size={space[6]} color={color.child.borderStrong} />
      </View>
    );
  }
  return (
    <View style={styles.mic} testID="mic-open" accessibilityLabel="ऐकत आहे">
      <Pulse />
      <View style={styles.disc}>
        <Icon d={MIC} size={space[6]} color={color.child.onListening} />
      </View>
      {again && (
        <View style={styles.badge} testID="mic-again" accessibilityLabel="पुन्हा">
          <Icon d={EAR} size={space[5]} color={color.child.listening} />
          <Icon d={LOOP} size={space[4]} color={color.child.listening} />
        </View>
      )}
    </View>
  );
}

function Pulse() {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [pulse]);
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: 1 + 0.45 * pulse.value }], opacity: 0.5 - 0.4 * pulse.value }));
  return <Animated.View style={[styles.ring, ring]} />;
}

const styles = StyleSheet.create({
  mic: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  closed: { borderRadius: radius.child.round, borderWidth: 2, borderStyle: 'dashed', borderColor: color.child.borderStrong },
  ring: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: radius.child.round, backgroundColor: color.child.listeningRing },
  disc: {
    width: SIZE, height: SIZE, borderRadius: radius.child.round, backgroundColor: color.child.listening,
    alignItems: 'center', justifyContent: 'center',
  },
  badge: {
    position: 'absolute', left: SIZE - space[2], top: -space[2], flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: space[2], paddingVertical: space[1], borderRadius: radius.child.round, borderWidth: 2,
    borderColor: color.child.listening, backgroundColor: color.child.surface,
  },
});
