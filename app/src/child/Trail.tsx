// Today's trail (wireframes c-queue, l-goodbye): finished lessons first (ticked, goodbye only), then
// one stop per queue stop in queue order, ending at Shekru's home. Stops are not buttons. On the queue
// the next one is ringed and larger; on the goodbye every stop left is for tomorrow. Labels are for the adult.
import { StyleSheet, View } from 'react-native';

import lessonsJson from '../content/generated/lessons.json';
import type { Stop } from '../learning/queue';
import type { Lesson } from '../lesson/types';
import { CHECK, Icon, LOOP } from '../parent/icons';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import { theme } from '../ui/theme';

// What the child will see in a lesson: its first item's letter or word.
const FIRST_ITEM = new Map((lessonsJson as unknown as Lesson[]).map((l) => [l.template_id, l.items[0]?.display ?? '']));

const { color, radius, space, touch } = theme;
const STOP = touch.child.min;
const NEXT = Math.round(STOP * 1.25);

type Props = {
  stops: Stop[];
  /** Template ids finished today, shown ticked before the stops. */
  done?: string[];
  /** Goodbye: no next stop; every stop left is labelled for tomorrow. */
  tomorrow?: boolean;
};

export function Trail({ stops, done = [], tomorrow = false }: Props) {
  const { t } = useT();
  return (
    <View style={styles.trail}>
      {done.map((id) => (
        <View key={`done-${id}`} testID={`stop-${id}`} style={styles.stop}>
          <View style={[styles.circle, styles.done]}>
            <Text mode="child" variant="button">
              {FIRST_ITEM.get(id) ?? ''}
            </Text>
            <View testID="stop-tick" style={styles.tick}>
              <Icon d={CHECK} size={space[4]} color={color.child.onSuccess} />
            </View>
          </View>
          <Text variant="small">{t('stopLesson')}</Text>
        </View>
      ))}
      {stops.map((stop, i) => {
        const next = i === 0 && !tomorrow;
        const id = stop.kind === 'lesson' ? stop.template_id : 'revision';
        return (
          <View key={id} testID={`stop-${id}`} style={styles.stop}>
            <View testID={next ? 'next-ring' : undefined} style={[styles.circle, next ? styles.next : styles.ahead]}>
              {stop.kind === 'revision' ? (
                <View testID="revision-icon">
                  <Icon d={LOOP} size={space[5]} color={color.child.text} />
                </View>
              ) : (
                <Text mode="child" variant="button">
                  {FIRST_ITEM.get(stop.template_id) ?? ''}
                </Text>
              )}
            </View>
            <Text variant="small">{t(tomorrow ? 'stopTomorrow' : stop.kind === 'lesson' ? 'stopLesson' : 'stopRevision')}</Text>
          </View>
        );
      })}
      <View style={styles.stop}>
        <View style={[styles.circle, styles.ahead]} />
        <Text variant="small">{t('done')}</Text>
      </View>
    </View>
  );
}

const TICK = space[5];

const styles = StyleSheet.create({
  trail: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: touch.child.gap },
  stop: { alignItems: 'center', gap: space[1] },
  circle: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.child.round, backgroundColor: color.child.surface },
  ahead: { width: STOP, height: STOP, borderWidth: 2, borderStyle: 'dashed', borderColor: color.child.trailStop },
  next: { width: NEXT, height: NEXT, borderWidth: 4, borderColor: color.child.primary, backgroundColor: color.child.surfaceSelected },
  done: { width: STOP, height: STOP, borderWidth: 2, borderColor: color.child.success, backgroundColor: color.child.successSurface },
  tick: {
    position: 'absolute',
    right: -space[1],
    bottom: -space[1],
    width: TICK,
    height: TICK,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.child.round,
    backgroundColor: color.child.success,
  },
});
