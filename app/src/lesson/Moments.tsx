// Reward visuals of the lesson moments (wireframes l-correct, l-streak, l-finished). The
// ticks and stars here are pictures only: the star count changes once per finished stop (Decisions 5).
import { useEffect } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import { CHECK, Icon, STAR } from '../parent/icons';
import { theme } from '../ui/theme';

const { color, radius, space, touch } = theme;

const Star = ({ size }: { size: number }) => <Icon d={STAR} size={size} color={color.child.onPrimary} fill={color.child.primary} />;

const TickDisc = ({ size, style, testID }: { size: number; style?: ViewStyle; testID?: string }) => (
  <View style={[styles.disc, { width: size, height: size }, style]} testID={testID}>
    <Icon d={CHECK} size={size / 2} color={color.child.onSuccess} />
  </View>
);

/** Tick badge in the card's corner on a correct answer. */
export function CorrectBadge() {
  return <TickDisc size={touch.child.min} style={styles.badge} testID="correct-tick" />;
}

/** The star in the control zone on a correct answer. */
export function RewardStar() {
  return (
    <View testID="reward-star" accessibilityLabel="तारा">
      <Star size={space[7]} />
    </View>
  );
}

/** Three ticks in place of the star on every third correct answer in a row. */
export function StreakTicks() {
  return (
    <View style={styles.ticks} testID="streak-ticks" accessibilityLabel="सलग तीन बरोबर">
      {[0, 1, 2].map((i) => <TickDisc key={i} size={space[7]} />)}
    </View>
  );
}

/** The finished stop's star: grows in, then flies up. */
export function FinishedStar() {
  const grow = useSharedValue(0);
  const rise = useSharedValue(0);
  useEffect(() => {
    grow.value = withTiming(1, { duration: 500 });
    rise.value = withDelay(900, withTiming(1, { duration: 700 }));
  }, [grow, rise]);
  const fly = useAnimatedStyle(() => ({
    opacity: 1 - 0.6 * rise.value,
    transform: [{ translateY: -space[7] * 4 * rise.value }, { scale: (0.3 + 0.7 * grow.value) * (1 - 0.5 * rise.value) }],
  }));
  return (
    <Animated.View style={fly} testID="finished-star" accessibilityLabel="तारा">
      <Star size={touch.child.pickerTile * 0.75} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  disc: { borderRadius: radius.child.round, backgroundColor: color.child.success, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: space[3], right: space[3] },
  ticks: { flexDirection: 'row', gap: space[3] },
});
