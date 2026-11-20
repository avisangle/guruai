// Today's trail (wireframe c-queue): one stop per queue stop in queue order, ending at Shekru's home.
// Stops are not buttons. The next one is ringed and larger; the stop labels are for the adult.
import { StyleSheet, View } from 'react-native';

import lessonsJson from '../content/generated/lessons.json';
import type { Stop } from '../learning/queue';
import type { Lesson } from '../lesson/types';
import { Icon, LOOP } from '../parent/icons';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import { theme } from '../ui/theme';

// What the child will see in a lesson: its first item's letter or word.
const FIRST_ITEM = new Map((lessonsJson as unknown as Lesson[]).map((l) => [l.template_id, l.items[0]?.display ?? '']));

const { color, radius, space, touch } = theme;
const STOP = touch.child.min;
const NEXT = Math.round(STOP * 1.25);

export function Trail({ stops }: { stops: Stop[] }) {
  const { t } = useT();
  return (
    <View style={styles.trail}>
      {stops.map((stop, i) => {
        const next = i === 0;
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
            <Text variant="small">{t(stop.kind === 'lesson' ? 'stopLesson' : 'stopRevision')}</Text>
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

const styles = StyleSheet.create({
  trail: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: touch.child.gap },
  stop: { alignItems: 'center', gap: space[1] },
  circle: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.child.round, backgroundColor: color.child.surface },
  ahead: { width: STOP, height: STOP, borderWidth: 2, borderStyle: 'dashed', borderColor: color.child.trailStop },
  next: { width: NEXT, height: NEXT, borderWidth: 4, borderColor: color.child.primary, backgroundColor: color.child.surfaceSelected },
});
