// /parent/report/<childId> (wireframe pm-report): the week in lessons against the daily goal,
// mastery, letters that need practice, and recent lessons (not sessions).
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { liveDb } from '../../../data/liveDb';
import { getChild } from '../../../data/profiles';
import { localDay, localDayBounds } from '../../../learning/mastery';
import { lessonTitle } from '../../../learning/queueInput';
import { loadReport, parseItemKey, type ReportLesson } from '../../../parent/report';
import { Button } from '../../../ui/components/Button';
import { Screen } from '../../../ui/components/Screen';
import { Text } from '../../../ui/components/Text';
import { useT } from '../../../ui/i18n';
import type { StringKey } from '../../../ui/strings/mr';
import { theme } from '../../../ui/theme';

function readReport(childId: string) {
  const db = liveDb();
  const child = getChild(db, childId);
  const today = localDay(new Date().toISOString());
  return { child, today, report: child && loadReport(db, child, today) };
}

const weekday = (date: string) => new Date(localDayBounds(date).from).getDay();

export default function Report() {
  const { t } = useT();
  const { child: childId } = useLocalSearchParams<{ child: string }>();
  const [{ child, today, report }] = useState(() => readReport(childId));

  if (!child || !report) return <Screen variant="parent" />;

  const lessonsThisWeek = report.days.reduce((n, d) => n + d.done, 0);
  const activeDays = report.days.filter((d) => d.done > 0).length;
  const goal = child.lessons_per_day;

  const dayLabel = (at: string) => {
    const date = localDay(at);
    if (date === today) return t('reportToday');
    return date >= report.days[0].date ? t(`reportDay${weekday(date)}` as StringKey) : date;
  };
  const lessonNote = (l: ReportLesson) =>
    [
      l.finished ? t('reportFinished') : t('reportLeft', { done: l.done, total: l.total }),
      l.practiceOnly && t('reportPracticeOnly'),
      l.parentChecked && t('reportParentChecked'),
    ]
      .filter(Boolean)
      .join(' · ');

  const done = () => (router.canGoBack() ? router.back() : router.replace('/parent'));

  return (
    <Screen variant="parent">
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.head}>
          <Text variant="section">{t('reportTitle')}</Text>
          <Text variant="helper">{child.nickname}</Text>
        </View>

        <View testID="report-week" style={styles.card}>
          <Text variant="label">{t('reportWeek', { days: activeDays, n: lessonsThisWeek })}</Text>
          <Text variant="helper">{t('reportGoal', { goal })}</Text>
          <View style={styles.week}>
            {report.days.map((d) => (
              <View key={d.date} testID={`report-day-${d.date}`} style={styles.day}>
                <Text variant="small">{d.done > 0 ? `${d.done}/${d.goal}${d.met ? ' ✓' : ''}` : '–'}</Text>
                <View style={styles.track}>
                  <View style={[styles.fill, { height: `${Math.min(1, d.done / Math.max(1, d.goal)) * 100}%` }]} />
                </View>
                <Text variant="small">{t(`reportDayShort${weekday(d.date)}` as StringKey)}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text variant="label" style={styles.grow}>
              {t('reportMastered')}
            </Text>
            <Text variant="section">{report.lettersMastered}</Text>
          </View>
          <View style={styles.row}>
            <Text variant="label" style={styles.grow}>
              {t('reportNextDay')}
            </Text>
            <Text variant="label">
              {report.nextDayRevision.total > 0
                ? t('reportOf', { n: report.nextDayRevision.correct, total: report.nextDayRevision.total })
                : '–'}
            </Text>
          </View>
          <Text variant="label">{t('reportPractice')}</Text>
          <Text variant="body">
            {report.needsPractice.length > 0 ? report.needsPractice.map((k) => parseItemKey(k).text).join('  ') : t('sectionEmpty')}
          </Text>
        </View>

        <View testID="report-lessons" style={styles.card}>
          <Text variant="label">{t('reportRecent')}</Text>
          {report.lessons.length === 0 && <Text variant="helper">{t('sectionEmpty')}</Text>}
          {report.lessons.map((l) => (
            <View key={`${l.template_id}-${l.at}`} style={styles.lesson}>
              <Text variant="body">{`${dayLabel(l.at)} · ${lessonTitle(l.template_id)}`}</Text>
              <Text variant="helper">{lessonNote(l)}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <Button variant="parent" label={t('done')} onPress={done} />
    </Screen>
  );
}

const { color, radius, space } = theme;

const styles = StyleSheet.create({
  body: { gap: space[4], paddingVertical: space[4] },
  head: { gap: space[1] },
  card: {
    gap: space[2],
    padding: space[4],
    borderRadius: radius.parent.card,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  week: { flexDirection: 'row', justifyContent: 'space-between', gap: space[1] },
  day: { flex: 1, alignItems: 'center', gap: space[1] },
  track: {
    width: space[3],
    height: space[7],
    justifyContent: 'flex-end',
    borderRadius: radius.parent.round,
    backgroundColor: color.parent.border,
    overflow: 'hidden',
  },
  fill: { width: '100%', backgroundColor: color.parent.accent },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  grow: { flex: 1 },
  lesson: { gap: space[1], paddingVertical: space[1] },
});
