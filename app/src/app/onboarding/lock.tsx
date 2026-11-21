// First run 2 of 3: parent lock. The phone's screen lock by default; a GuruAI PIN, set and
// confirmed here, when chosen or when the phone has no screen lock (D-GURU-13-parent-gate).
import { useRouter } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';

import { strongBiometricsAvailable, type GateMode } from '../../parent/gate';
import { liveGate } from '../../parent/live';
import { PinSetup } from '../../parent/PinSetup';
import { Button } from '../../ui/components/Button';
import { Choice } from '../../ui/components/Choice';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { OnboardingStep } from '../../ui/OnboardingStep';

export default function Lock() {
  const router = useRouter();
  const { t } = useT();
  const [deviceLock, setDeviceLock] = useState<boolean | null>(null); // null until known
  const [strongBiometrics, setStrongBiometrics] = useState(false);
  const [choice, setChoice] = useState<GateMode>('device');

  useEffect(() => {
    let live = true;
    const gate = liveGate();
    Promise.all([gate.deviceLockAvailable(), strongBiometricsAvailable(LocalAuthentication)])
      // An unreadable lock state is treated as no screen lock: the PIN is the safe side.
      .catch(() => [false, false])
      .then(([available, strong]) => {
        if (!live) return;
        setDeviceLock(available);
        setStrongBiometrics(strong);
        if (!available) setChoice('pin');
      });
    return () => {
      live = false;
    };
  }, []);

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
          {t('pinNoScreenLock')}
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
        <PinSetup
          strongBiometrics={strongBiometrics}
          onSet={(pin) => liveGate().setPin(pin).then(() => router.push('/onboarding/who'))}
        />
      )}
    </OnboardingStep>
  );
}
