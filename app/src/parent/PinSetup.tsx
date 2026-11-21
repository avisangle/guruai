// Set-and-confirm rows for a new GuruAI PIN (onboarding, Settings). Saves by itself once both
// entries are 4 digits and match; a mismatch clears the second entry.
import { useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Field } from '../ui/components/Field';
import { Text } from '../ui/components/Text';
import { useT } from '../ui/i18n';
import { theme } from '../ui/theme';
import { isValidPin } from './pin';

const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4);

type Props = { strongBiometrics: boolean; onSet: (pin: string) => Promise<void> };

export function PinSetup({ strongBiometrics, onSet }: Props) {
  const { t } = useT();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const saving = useRef(false);

  function onPins(nextPin: string, nextAgain: string) {
    setPin(nextPin);
    setAgain(nextAgain);
    if (nextAgain) setMismatch(false);
    if (!isValidPin(nextPin) || !isValidPin(nextAgain)) return;
    if (nextPin !== nextAgain) {
      setMismatch(true);
      setAgain('');
      return;
    }
    if (saving.current) return;
    saving.current = true;
    onSet(nextPin).finally(() => {
      saving.current = false;
    });
  }

  return (
    <>
      <Field
        testID="pin-new"
        label={t('pinFirst')}
        value={pin}
        onChangeText={(v) => onPins(digits(v), again)}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={4}
      />
      <Field
        testID="pin-again"
        label={t('pinAgain')}
        value={again}
        onChangeText={(v) => onPins(pin, digits(v))}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={4}
      />
      {mismatch ? (
        <Text testID="pin-mismatch" style={styles.error}>
          {t('pinMismatch')}
        </Text>
      ) : null}
      <Text testID="pin-forgot-warning" variant="helper">
        {t(strongBiometrics ? 'pinForgotBiometric' : 'pinForgotReinstall')}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  error: { color: theme.color.parent.error },
});
