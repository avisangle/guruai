// Placeholder until parent home (GURU-30).
import { Button } from '../../ui/components/Button';
import { Screen } from '../../ui/components/Screen';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { useParentMode } from '../../parent/ParentModeProvider';

export default function ParentHome() {
  const { t } = useT();
  const { exit } = useParentMode();
  return (
    <Screen variant="parent">
      <Text variant="title">{t('forParents')}</Text>
      <Button variant="parentGhost" label={t('backToChildren')} onPress={exit} />
    </Screen>
  );
}
