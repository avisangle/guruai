// /parent/assign/<childId> (wireframe pm-assign): lessons grouped by skill path with a search box.
// Assigning puts a lesson in today's queue (decision 14 carries what does not fit); a lesson whose
// pack is not on the phone starts its download and waits on parent home (PRD Edge Cases).
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import lessonsJson from '../../../content/generated/lessons.json';
import pathsJson from '../../../content/generated/paths.json';
import { liveDb } from '../../../data/liveDb';
import { listChildren } from '../../../data/profiles';
import { isLessonInstalled, queuePacks } from '../../../downloads/downloader';
import { assignLesson } from '../../../learning/assignments';
import { localDay } from '../../../learning/mastery';
import { lessonTitle, readQueueInput } from '../../../learning/queueInput';
import type { Lesson } from '../../../lesson/types';
import { searchLessons } from '../../../parent/searchLessons';
import { Button } from '../../../ui/components/Button';
import { Field } from '../../../ui/components/Field';
import { Screen } from '../../../ui/components/Screen';
import { Text } from '../../../ui/components/Text';
import { useT } from '../../../ui/i18n';
import type { StringKey } from '../../../ui/strings/mr';
import { theme } from '../../../ui/theme';

const LESSONS = lessonsJson as unknown as Lesson[];
const LESSON_PACK: Record<string, string | undefined> = pathsJson.lessonPack;
// Skill paths only: class paths repeat the same lessons.
const GROUPS = pathsJson.paths
  .filter((p) => p.kind === 'skill')
  .map((p) => ({ id: p.path_id, title: p.title, lessons: p.units.flatMap((u) => u.lessons) }))
  .filter((g) => g.lessons.length > 0);

const STATE_WORD = { new: 'stateNew', pending: 'statePending', completed: 'stateCompleted' } satisfies Record<string, StringKey>;

const today = () => localDay(new Date().toISOString());

function readChild(childId: string) {
  const db = liveDb();
  const child = listChildren(db).find((c) => c.id === childId) ?? null;
  return { child, input: child && readQueueInput(db, child, today(), isLessonInstalled) };
}

export default function AssignLesson() {
  const { t, lang } = useT();
  const { child: childId } = useLocalSearchParams<{ child: string }>();
  const [{ child, input }, setData] = useState(() => readChild(childId));
  const [query, setQuery] = useState('');

  const shown = useMemo(() => new Set(searchLessons(LESSONS, query)), [query]);
  const groups = GROUPS.map((g) => ({ ...g, lessons: g.lessons.filter((id) => shown.has(id)) })).filter((g) => g.lessons.length > 0);

  if (!child || !input) return <Screen variant="parent" />;

  // Unfinished assignments for today, carried ones included: they all come first in today's queue.
  const assigned = new Set(input.assignments.filter((a) => a.for_date <= input.today).map((a) => a.template_id));
  const finished = new Set(input.finished);
  const started = new Set([...input.inProgress, ...input.assignments.map((a) => a.template_id)]);
  const stateOf = (id: string) => (finished.has(id) ? 'completed' : started.has(id) ? 'pending' : 'new');
  const left = Math.max(0, input.goal - input.doneToday);

  const assign = (id: string) => {
    if (assigned.has(id)) return;
    assignLesson(liveDb(), child.id, id, input.today);
    const pack = LESSON_PACK[id];
    if (pack && !isLessonInstalled(id)) queuePacks([pack]).catch(() => undefined);
    setData(readChild(child.id));
  };

  const done = () => (router.canGoBack() ? router.back() : router.replace('/parent'));

  return (
    <Screen variant="parent">
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.head}>
          <Text variant="section">{t('assignTitle')}</Text>
          <Text variant="helper">{t('assignFor', { name: child.nickname })}</Text>
        </View>

        <View style={styles.head}>
          <Field testID="assign-search" label={t('assignSearch')} value={query} onChangeText={setQuery} autoCorrect={false} />
          <Text variant="helper">{t('assignSearchHelp')}</Text>
        </View>

        {groups.length === 0 && <Text variant="helper">{t('assignNone')}</Text>}
        {groups.map((g) => (
          <View key={g.id} testID={`assign-group-${g.id}`} style={styles.group}>
            <Text variant="section">{g.title[lang]}</Text>
            <View style={styles.card}>
              {g.lessons.map((id) => (
                <View key={id} testID={`assign-row-${id}`} style={styles.row}>
                  <View style={styles.grow}>
                    <Text variant="label">{lessonTitle(id)}</Text>
                    <Text testID={`assign-state-${id}`} variant="helper">
                      {t(STATE_WORD[stateOf(id)])}
                    </Text>
                  </View>
                  <Button
                    testID={`assign-button-${id}`}
                    variant={assigned.has(id) ? 'parentGhost' : 'parent'}
                    label={t(assigned.has(id) ? 'assignedButton' : 'assignButton')}
                    disabled={assigned.has(id)}
                    onPress={() => assign(id)}
                  />
                </View>
              ))}
            </View>
          </View>
        ))}

        <Text testID="assign-note" variant="helper">
          {t('assignNote', { n: assigned.size, left, goal: input.goal })}
          {assigned.size > left ? ` ${t('assignNoteOverflow')}` : ''}
        </Text>
      </ScrollView>
      <Button variant="parent" label={t('assignDone')} onPress={done} />
    </Screen>
  );
}

const { color, radius, space } = theme;

const styles = StyleSheet.create({
  body: { gap: space[4], paddingVertical: space[4] },
  head: { gap: space[1] },
  group: { gap: space[2] },
  card: {
    gap: space[2],
    padding: space[4],
    borderRadius: radius.parent.card,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  grow: { flex: 1, gap: space[1] },
});
