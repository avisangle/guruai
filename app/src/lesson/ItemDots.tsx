// One dot per lesson item plus one per revision item, under Shekru (wireframe l-talking).
// Read off the engine position, so a resumed lesson shows the same dots.
import { StyleSheet, View } from 'react-native';

import { theme } from '../ui/theme';
import { revisionRef } from './revision';
import type { FlowEntry, Lesson, Position, RevisionItem } from './types';

const { color, radius, space } = theme;

export type DotState = 'done' | 'current' | 'left';

/**
 * Per item (lesson items, then revision items): done once no turn is left for it,
 * current for the item the position points at, else left. Items refs match Position.quiz.
 */
export function dotStates(lesson: Lesson, revision: RevisionItem[], pos: Position): DotState[] {
  const refs = [...lesson.items.map((i) => i.id), ...revision.map(revisionRef)];
  const idOf = (display: string) => lesson.items.find((i) => i.display === display)?.id ?? display;
  // same item lists as the engine's itemsOf
  const turns = (e: FlowEntry): string[] => {
    if (!('phase' in e)) return [];
    if (e.phase === 'retry') return pos.retry;
    if (e.phase === 'teach') return e.order.map(idOf);
    return pos.quiz ?? [...e.order.map(idOf), ...revision.map(revisionRef)];
  };
  const left = new Set<string>();
  let current: string | undefined;
  lesson.flow.forEach((e, f) => {
    if (f < pos.flow) return;
    const rest = turns(e).slice(f === pos.flow ? pos.index : 0);
    current ??= rest[0];
    for (const ref of rest) left.add(ref);
  });
  return refs.map((ref) => (ref === current ? 'current' : left.has(ref) ? 'left' : 'done'));
}

export function ItemDots({ states }: { states: DotState[] }) {
  return (
    <View style={styles.row} testID="item-dots">
      {states.map((s, i) => (
        <View key={i} testID={`dot-${s}`} style={[styles.dot, styles[s]]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space[2], alignItems: 'center', justifyContent: 'center', marginTop: space[2] },
  dot: { width: space[3], height: space[3], borderRadius: radius.child.round, borderWidth: 2, borderColor: color.child.borderStrong },
  done: { backgroundColor: color.child.brand, borderColor: color.child.brand },
  current: { width: space[4], height: space[4], borderWidth: 4, borderColor: color.child.primary, backgroundColor: color.child.surface },
  left: { backgroundColor: color.child.surface },
});
