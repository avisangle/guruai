// Child profile form (wireframes pm-profile, pm-profile-2, pm-profile-3): who and school, goals and
// language style, lessons per day and the active-time cap. With no child it adds one.
import { useAudioPlayer } from 'expo-audio';
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { LINE_AUDIO } from '../content/generated/audio';
import { liveDb } from '../data/liveDb';
import { startingStyle } from '../data/profiles';
import type { ChildProfile, Medium, StyleLevel } from '../data/types';
import { Button } from '../ui/components/Button';
import { Choice } from '../ui/components/Choice';
import { Field } from '../ui/components/Field';
import { Text } from '../ui/components/Text';
import { TickBox } from '../ui/components/TickBox';
import { useT } from '../ui/i18n';
import { PicturePicker } from '../ui/PicturePicker';
import type { StringKey } from '../ui/strings/mr';
import { theme } from '../ui/theme';
import { CLASSES, classLabel, DEFAULT_GOALS, saveProfile, STYLE_LABEL } from './profile';

const BOARDS = [
  ['msb', 'boardMsb'],
  ['cbse', 'boardCbse'],
] as const;
const GOALS: [id: string, label: StringKey, help?: StringKey][] = [
  ['mr_letters', 'goalMrLetters', 'goalMrLettersHelp'],
  ['en_letters', 'goalEnLetters', 'goalEnLettersHelp'],
  ['en_words', 'goalEnWords'],
  ['numbers', 'goalNumbers', 'goalNumbersHelp'],
];
const STYLE_HELP: Record<StyleLevel, StringKey> = { mr_led: 'styleMrLedHelp', en_led: 'styleEnLedHelp' };
const LESSONS = [1, 2, 3, 4, 5];
const CAPS = [20, 30, 45, null];
// Column defaults in migrations.ts, for a child not yet saved.
const DEFAULT_LESSONS = 3;
const DEFAULT_CAP = 30;

type Props = {
  /** null: add a child. */
  child: ChildProfile | null;
  /** Pictures other children use. */
  taken: string[];
  onSaved: (child: ChildProfile) => void;
};

export function ProfileForm({ child, taken, onSaved }: Props) {
  const { t } = useT();
  const sample = useAudioPlayer(null);
  const [nickname, setNickname] = useState(child?.nickname ?? '');
  const [picture, setPicture] = useState<string | null>(child?.picture ?? null);
  const [cls, setCls] = useState<string | null>(child?.class ?? null);
  const [board, setBoard] = useState(child?.board ?? 'msb');
  const [medium, setMedium] = useState<Medium | null>(child?.medium ?? null);
  // A new child's goals follow the class, and its style the medium, until the parent picks them.
  const [pickedGoals, setGoals] = useState<string[] | null>(child?.goals ?? null);
  const [pickedStyle, setStyle] = useState<StyleLevel | null>(child?.style_level ?? null);
  const [keep, setKeep] = useState(child?.style_locked ?? false);
  const [lessons, setLessons] = useState(child?.lessons_per_day ?? DEFAULT_LESSONS);
  const [cap, setCap] = useState<number | null>(child ? child.active_cap_min : DEFAULT_CAP);

  const goals = pickedGoals ?? (cls ? (DEFAULT_GOALS[cls] ?? []) : []);
  const style = pickedStyle ?? startingStyle(medium ?? 'mr');
  const name = nickname.trim();
  const complete = name !== '' && picture !== null && cls !== null && medium !== null;

  const toggleGoal = (id: string) => setGoals(goals.includes(id) ? goals.filter((g) => g !== id) : [...goals, id]);

  const play = (level: StyleLevel) => {
    sample.replace(LINE_AUDIO[`sample_${level}_1`]);
    sample.play();
  };

  const save = () => {
    if (!complete) return;
    onSaved(
      saveProfile(liveDb(), child?.id ?? null, {
        nickname: name,
        picture,
        class: cls,
        board,
        medium,
        goals,
        style_level: style,
        style_locked: keep,
        lessons_per_day: lessons,
        active_cap_min: cap,
      }),
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text variant="title">{t(child ? 'profileTitle' : 'addChild')}</Text>

      <Field testID="profile-nickname" label={t('nickname')} value={nickname} onChangeText={setNickname} maxLength={20} />
      <Text variant="helper">{t('nicknameHelp')}</Text>
      <Text variant="label">{t('choosePicture')}</Text>
      <PicturePicker value={picture} onChange={setPicture} taken={taken} />
      <Text variant="helper">{t('pictureHelp')}</Text>

      <Group label={t('classLabel')}>
        {CLASSES.map((c) => (
          <Choice key={c} testID={`class-${c}`} label={t(classLabel(c))} selected={cls === c} onPress={() => setCls(c)} />
        ))}
      </Group>
      <Group label={t('setupBoard')}>
        {BOARDS.map(([id, label]) => (
          <Choice key={id} testID={`board-${id}`} label={t(label)} selected={board === id} onPress={() => setBoard(id)} />
        ))}
      </Group>
      <Group label={t('mediumLabel')}>
        <Choice testID="medium-en" label={t('mediumEn')} selected={medium === 'en'} onPress={() => setMedium('en')} />
        <Choice testID="medium-mr" label={t('mediumMr')} selected={medium === 'mr'} onPress={() => setMedium('mr')} />
      </Group>

      <Text variant="section">{t('goalsTitle')}</Text>
      {GOALS.map(([id, label, help]) => (
        <TickBox
          key={id}
          testID={`goal-${id}`}
          label={t(label)}
          help={help && t(help)}
          checked={goals.includes(id)}
          onPress={() => toggleGoal(id)}
        />
      ))}
      {cls && <Text variant="helper">{t('goalsClassNote', { cls: t(classLabel(cls)) })}</Text>}

      <Text variant="section">{t('styleTitle')}</Text>
      {(['mr_led', 'en_led'] as const).map((level) => (
        <View key={level} style={styles.style}>
          <Choice
            testID={`style-${level}`}
            label={t(STYLE_LABEL[level])}
            help={t(STYLE_HELP[level])}
            selected={style === level}
            onPress={() => setStyle(level)}
          />
          {LINE_AUDIO[`sample_${level}_1`] != null && (
            <Button testID={`style-sample-${level}`} variant="parentGhost" label={t('playSample')} onPress={() => play(level)} />
          )}
        </View>
      ))}
      <TickBox testID="style-keep" label={t('styleKeep')} help={t('styleKeepHelp')} checked={keep} onPress={() => setKeep(!keep)} />
      <Text testID="style-letters-note" variant="helper">
        {t('styleLettersNote')}
      </Text>

      <Group label={t('lessonsTitle')}>
        {LESSONS.map((n) => (
          <Choice key={n} testID={`lessons-per-day-${n}`} label={String(n)} selected={lessons === n} onPress={() => setLessons(n)} />
        ))}
      </Group>
      <Text variant="helper">{t('lessonsHelp')}</Text>
      <Group label={t('capTitle')}>
        {CAPS.map((m) => (
          <Choice
            key={m ?? 'none'}
            testID={`cap-${m ?? 'none'}`}
            label={m === null ? t('capNone') : t('capMinutes', { n: m })}
            selected={cap === m}
            onPress={() => setCap(m)}
          />
        ))}
      </Group>
      <Text variant="helper">{t('capHelp')}</Text>

      <Button
        testID="profile-save"
        variant="parent"
        label={t('save')}
        disabled={!complete}
        onPress={save}
      />
    </ScrollView>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <Text variant="label">{label}</Text>
      <View style={styles.row}>{children}</View>
    </View>
  );
}

const { space, touch } = theme;

const styles = StyleSheet.create({
  body: { gap: space[3], paddingVertical: space[4] },
  group: { gap: space[2] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: touch.parent.gap },
  style: { gap: space[1] },
});
