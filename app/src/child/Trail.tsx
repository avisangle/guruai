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
  /** Goodbye only: template ids finished today, shown ticked first; every stop left is for tomorrow. */
  done?: string[];
};

type Entry = Stop | { kind: 'done'; template_id: string };

export function Trail({ stops, done }: Props) {
  const { t } = useT();
  const tomorrow = done !== undefined;
  const entries: Entry[] = [...(done ?? []).map((id) => ({ kind: 'done' as const, template_id: id })), ...stops];
  return (
    <View style={styles.trail}>
      {entries.map((entry, i) => {
        const next = !tomorrow && i === 0;
        const id = entry.kind === 'revision' ? 'revision' : entry.template_id;
        const label = entry.kind === 'done' ? 'stopLesson' : tomorrow ? 'stopTomorrow' : entry.kind === 'lesson' ? 'stopLesson' : 'stopRevision';
        const ring = entry.kind === 'done' ? styles.done : next ? styles.next : styles.ahead;
        return (
          <View key={`${entry.kind}-${id}`} testID={`stop-${id}`} style={styles.stop}>
            <View testID={next ? 'next-ring' : undefined} style={[styles.circle, ring]}>
              {entry.kind === 'revision' ? (
                <View testID="revision-icon">
                  <Icon d={LOOP} size={space[5]} color={color.child.text} />
                </View>
              ) : (
                <Text mode="child" variant="button">
                  {FIRST_ITEM.get(entry.template_id) ?? ''}
                </Text>
              )}
              {entry.kind === 'done' && (
                <View testID="stop-tick" style={styles.tick}>
                  <Icon d={CHECK} size={space[4]} color={color.child.onSuccess} />
                </View>
              )}
            </View>
            <Text variant="small">{t(label)}</Text>
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
