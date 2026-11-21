// Reward visuals of the lesson moments (wireframes l-correct, l-streak, l-finished). The
// ticks and stars here are pictures only: the star count changes once per finished stop (Decisions 5).
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import { CHECK, Icon, STAR } from '../parent/icons';
import { theme } from '../ui/theme';

const { color, radius, space, touch } = theme;

/** Tick badge in the card's corner on a correct answer. */
export function CorrectBadge() {
  return (
    <View style={styles.badge} testID="correct-tick">
      <Icon d={CHECK} size={space[6]} color={color.child.onSuccess} />
    </View>
  );
}

/** The star in the control zone on a correct answer. */
export function RewardStar() {
  return (
    <View testID="reward-star" accessibilityLabel="तारा">
      <Icon d={STAR} size={space[7]} color={color.child.onPrimary} fill={color.child.primary} />
    </View>
  );
}

/** Three ticks in place of the star on every third correct answer in a row. */
export function StreakTicks() {
  return (
    <View style={styles.ticks} testID="streak-ticks" accessibilityLabel="सलग तीन बरोबर">
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.tick}>
          <Icon d={CHECK} size={space[5]} color={color.child.onSuccess} />
        </View>
      ))}
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
      <Icon d={STAR} size={touch.child.pickerTile * 0.75} color={color.child.onPrimary} fill={color.child.primary} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute', top: space[3], right: space[3], width: touch.child.min, height: touch.child.min,
    borderRadius: radius.child.round, backgroundColor: color.child.success, alignItems: 'center', justifyContent: 'center',
  },
  ticks: { flexDirection: 'row', gap: space[3] },
  tick: {
    width: space[7], height: space[7], borderRadius: radius.child.round, backgroundColor: color.child.success,
    alignItems: 'center', justifyContent: 'center',
  },
});
