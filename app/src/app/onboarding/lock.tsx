// First run 2 of 3: parent lock. The phone's screen lock by default; a GuruAI PIN, set and
// confirmed here, when chosen or when the phone has no screen lock (D-GURU-13-parent-gate).
import { getEnrolledLevelAsync, SecurityLevel } from 'expo-local-authentication';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import type { GateMode } from '../../parent/gate';
import { appGate } from '../../parent/appGate';
import { Button } from '../../ui/components/Button';
import { Choice } from '../../ui/components/Choice';
import { Field } from '../../ui/components/Field';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { OnboardingStep } from '../../ui/OnboardingStep';
import { theme } from '../../ui/theme';

const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4);

export default function Lock() {
  const router = useRouter();
  const { t } = useT();
  const [deviceLock, setDeviceLock] = useState<boolean | null>(null); // null until known
  const [strongBiometrics, setStrongBiometrics] = useState(false);
  const [choice, setChoice] = useState<GateMode>('device');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const saving = useRef(false);

  useEffect(() => {
    let live = true;
    Promise.all([appGate().deviceLockAvailable(), getEnrolledLevelAsync()])
      // An unreadable lock state is treated as no screen lock: the PIN is the safe side.
      .catch((): [boolean, number] => [false, SecurityLevel.NONE])
      .then(([available, level]) => {
        if (!live) return;
        setDeviceLock(available);
        setStrongBiometrics(level >= SecurityLevel.BIOMETRIC_STRONG);
        if (!available) setChoice('pin');
      });
    return () => {
      live = false;
    };
  }, []);

  // The screen moves on by itself once both entries are 4 digits and match.
  function onPins(nextPin: string, nextAgain: string) {
    setPin(nextPin);
    setAgain(nextAgain);
    if (nextAgain) setMismatch(false);
    if (nextPin.length < 4 || nextAgain.length < 4) return;
    if (nextPin !== nextAgain) {
      setMismatch(true);
      setAgain('');
      return;
    }
    if (saving.current) return;
    saving.current = true;
    appGate()
      .setPin(nextPin)
      .then(() => router.push('/onboarding/who'))
      .finally(() => {
        saving.current = false;
      });
  }

  return (
    <OnboardingStep step={2}>
      <Text variant="title">{t('lockTitle')}</Text>
      <Text variant="section">{t('lockQuestion')}</Text>
      <Text>{t('lockWhy')}</Text>
      <Choice
        testID="lock-device"
        label={t('lockDevice')}
        help={choice === 'device' ? t('lockDeviceHelp') : undefined}
        selected={choice === 'device'}
        disabled={deviceLock === false}
        onPress={() => setChoice('device')}
      />
      <Choice
        testID="lock-pin"
        label={t('lockPin')}
        help={t('lockPinHelp')}
        selected={choice === 'pin'}
        onPress={() => setChoice('pin')}
      />
      {deviceLock === false ? (
        <Text testID="lock-no-screen-lock-note" variant="helper">
          {t('lockNoScreenLock')}
        </Text>
      ) : null}
      {choice === 'device' ? (
        <Button
          testID="lock-next"
          variant="parent"
          label={t('next')}
          disabled={deviceLock !== true}
          onPress={() => router.push('/onboarding/who')}
        />
      ) : (
        <>
          <Field
            testID="pin-new"
            label={t('pinNew')}
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
      )}
    </OnboardingStep>
  );
}

const styles = StyleSheet.create({
  error: { color: theme.color.parent.error },
});
