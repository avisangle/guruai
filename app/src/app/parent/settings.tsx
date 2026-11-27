// Settings (wireframes pm-settings, pm-settings-2): parent language, children, consents, downloads and
// phone status, the parent lock mode (D-GURU-13-parent-gate) and the device code.
import { router, useFocusEffect } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { judgeReadiness, rerunSpeedCheck, subscribeJudgeCheck, type JudgeReadiness } from '../../asr/speedCheck';
import { answerConsent, getDevice } from '../../data/device';
import { liveDb } from '../../data/liveDb';
import { listChildren } from '../../data/profiles';
import type { ChildProfile } from '../../data/types';
import type { DownloadStatus } from '../../downloads/downloader';
import { allInstalled, useDownloads } from '../../downloads/useDownloads';
import type { MicState } from '../../parent/attention';
import { checkProof, strongBiometricsAvailable, type GateMode, type PinResult, type SwitchProof } from '../../parent/gate';
import { liveSwitchToDeviceLock } from '../../parent/live';
import { askForMic, readMic } from '../../parent/mic';
import { useParentMode } from '../../parent/ParentModeProvider';
import { isValidPin, PIN_LENGTH, pinDigits } from '../../parent/pin';
import { PinSetup } from '../../parent/PinSetup';
import { classLabel, STYLE_LABEL } from '../../parent/profile';
import { StatusRow } from '../../parent/rows';
import { consentChanged, requestDeletion } from '../../upload/uploadQueue';
import { Button } from '../../ui/components/Button';
import { Choice } from '../../ui/components/Choice';
import { Field } from '../../ui/components/Field';
import { Screen } from '../../ui/components/Screen';
import { SwitchRow } from '../../ui/components/SwitchRow';
import { Text } from '../../ui/components/Text';
import { useT } from '../../ui/i18n';
import { CHILD_PICTURES } from '../../ui/PicturePicker';
import type { StringKey } from '../../ui/strings/mr';
import { theme } from '../../ui/theme';

const JUDGE_TEXT: Record<JudgeReadiness, StringKey> = {
  ready: 'judgeReady',
  slow: 'judgeSlow',
  oom: 'judgeOom',
  missing: 'judgeMissing',
};

function downloadsText(status: DownloadStatus): [StringKey, { done: number; total: number }?] {
  if (status.plan?.kind === 'needs_choice') return ['storageTitle']; // the prompt waits on the Downloads screen
  if (status.waitingForWifi) return ['downloadsWaitingWifi'];
  if (status.items.some((i) => i.status === 'failed')) return ['downloadsFailed'];
  if (allInstalled(status)) return ['downloadsDone'];
  const done = status.items.filter((i) => i.status === 'installed').length;
  return ['downloadsProgress', { done, total: status.items.length }];
}

export default function SettingsScreen() {
  const { t, lang, setLang } = useT();
  const { exit } = useParentMode();
  const [device] = useState(() => getDevice(liveDb()));
  const [children, setChildren] = useState<ChildProfile[]>([]); // read on focus
  const [consent, setConsent] = useState({ clips: device.consent_clips ?? false, summaries: device.consent_summaries ?? false });
  const [clipsTurnedOff, setClipsTurnedOff] = useState(false);
  const [deletionAsked, setDeletionAsked] = useState(false);
  const [mic, setMic] = useState<MicState | null>(null); // null until read
  const [readiness, setReadiness] = useState<JudgeReadiness>(() => judgeReadiness());
  const [checking, setChecking] = useState(false);

  // The first speed check may end while Settings is open.
  useEffect(() => subscribeJudgeCheck(() => setReadiness(judgeReadiness())), []);

  // A saved or added child shows on return from the profile form.
  useFocusEffect(
    useCallback(() => {
      setChildren(listChildren(liveDb()));
      readMic().then(setMic);
    }, []),
  );

  const changeConsent = (next: typeof consent) => {
    answerConsent(liveDb(), next); // at once: uploads check the flag before each file
    consentChanged(); // drops the switched-off kind's pending items and aborts its upload
    setConsent(next);
    setClipsTurnedOff(consent.clips && !next.clips);
  };

  // Allowed with both consents off: it covers what was sent before (wireframe decision 15).
  const askDeletion = () => {
    void requestDeletion();
    setDeletionAsked(true);
  };

  const micAction = async () => {
    if (!mic?.canAskAgain) return Linking.openSettings().catch(() => undefined);
    const next = await askForMic(liveDb());
    if (next) setMic(next);
  };

  const rerun = () => {
    setChecking(true);
    rerunSpeedCheck()
      .then(setReadiness)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  return (
    <Screen variant="parent">
      <ScrollView contentContainerStyle={styles.body}>
        <Text variant="title">{t('settingsTitle')}</Text>

        <Section title={t('langLabel')}>
          <View style={styles.row}>
            <Choice testID="settings-lang-mr" label={t('langMr')} selected={lang === 'mr'} onPress={() => setLang('mr')} />
            <Choice testID="settings-lang-en" label={t('langEn')} selected={lang === 'en'} onPress={() => setLang('en')} />
          </View>
        </Section>

        <Section title={t('childrenTitle')}>
          {children.map((c) => (
            <Pressable
              key={c.id}
              testID={`settings-child-${c.id}`}
              accessibilityRole="link"
              onPress={() => router.push(`/parent/child/${c.id}`)}
              style={styles.line}
            >
              <Text variant="section">{CHILD_PICTURES[c.picture] ?? ''}</Text>
              <View style={styles.grow}>
                <Text variant="label">{c.nickname}</Text>
                <Text variant="helper">
                  {t('childSummary', { cls: t(classLabel(c.class)), style: t(STYLE_LABEL[c.style_level]), n: c.lessons_per_day })}
                </Text>
              </View>
              <Text variant="label" style={styles.accent}>
                {t('edit')}
              </Text>
            </Pressable>
          ))}
          <Button testID="settings-add-child" variant="parentGhost" label={t('addChild')} onPress={() => router.push('/parent/child/new')} />
        </Section>

        <Section title={t('permissionsTitle')}>
          <SwitchRow
            testID="settings-consent-clips"
            label={t('consentClips')}
            value={consent.clips}
            onChange={(clips) => changeConsent({ ...consent, clips })}
          />
          {clipsTurnedOff && <Text variant="helper">{t('consentClipsOff')}</Text>}
          <SwitchRow
            testID="settings-consent-summaries"
            label={t('consentSummaries')}
            value={consent.summaries}
            onChange={(summaries) => changeConsent({ ...consent, summaries })}
          />
          <Pressable testID="settings-delete-sent" accessibilityRole="button" onPress={askDeletion} style={styles.line}>
            <View style={styles.grow}>
              <Text variant="label">{t('deleteSent')}</Text>
              <Text variant="helper">{t('deviceCode', { code: device.device_id })}</Text>
              {deletionAsked && <Text variant="helper">{t('deleteSentAsked')}</Text>}
            </View>
          </Pressable>
        </Section>

        <Section title={t('downloadsPhoneTitle')}>
          <DownloadsRow />
          <StatusRow testID="settings-uploads-wifi" label={t('uploadsWifiLabel')} value={t('uploadsWifiValue')} />
          <StatusRow testID="settings-mic" label={t('micLabel')} value={mic ? t(mic.granted ? 'micGiven' : 'micNotGiven') : ''}>
            {mic && !mic.granted && (
              <Button
                testID="settings-mic-action"
                variant="parentGhost"
                label={t(mic.canAskAgain ? 'bannerMicAction' : 'bannerMicSettingsAction')}
                onPress={micAction}
              />
            )}
          </StatusRow>
          <StatusRow testID="settings-judge-speed" label={t('judgeLabel')} value={t(checking ? 'judgeChecking' : JUDGE_TEXT[readiness])}>
            <Button testID="settings-judge-rerun" variant="parentGhost" label={t('judgeRerun')} disabled={checking} onPress={rerun} />
          </StatusRow>
        </Section>

        <ParentLockSection />

        <Text testID="settings-device-code" variant="small">
          {t('deviceCode', { code: device.device_id })}
        </Text>
      </ScrollView>
      <Button variant="parentGhost" label={t('backToChildren')} onPress={exit} />
    </Screen>
  );
}

/**
 * The parent lock mode. Switching to the PIN opens the onboarding set-and-confirm rows. Switching back asks
 * for the old PIN or strong biometrics, checked inside the switch, then removes the app PIN; a phone with no
 * screen lock cannot switch back. Change PIN asks for the old PIN or strong biometrics first.
 */
function ParentLockSection() {
  const { t } = useT();
  const { gate } = useParentMode();
  const [mode, setMode] = useState<GateMode | null>(null); // null until read
  const [deviceLock, setDeviceLock] = useState<boolean | null>(null);
  const [strongBiometrics, setStrongBiometrics] = useState(false);
  /**
   * pin: setting the first PIN; verify / change: Change PIN's old-PIN step and new-PIN step;
   * verifySwitch: the old-PIN step before switching back to the phone's lock.
   */
  const [step, setStep] = useState<'pin' | 'verify' | 'change' | 'verifySwitch' | null>(null);
  const [oldPin, setOldPin] = useState('');
  const [message, setMessage] = useState<StringKey | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([gate().mode(), gate().deviceLockAvailable(), strongBiometricsAvailable(LocalAuthentication)])
      .then(([m, available, strong]) => {
        if (!live) return;
        setMode(m);
        setDeviceLock(available);
        setStrongBiometrics(strong);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [gate]);

  const askOld = (next: 'verify' | 'verifySwitch') => {
    setOldPin('');
    setMessage(null);
    setStep(next);
  };

  const chooseDevice = () => (mode === 'pin' ? askOld('verifySwitch') : setStep(null));

  const setNewPin = async (pin: string) => {
    await gate().setPin(pin);
    setMode('pin');
    setStep(null);
  };

  // The old-PIN step's check and its next step. Switching back checks the proof inside the switch only, so a
  // wrong PIN counts once.
  const switching = step === 'verifySwitch';
  const askingOld = switching || step === 'verify';
  const check = (proof: SwitchProof): Promise<PinResult> =>
    switching ? liveSwitchToDeviceLock(proof) : checkProof(gate(), proof);
  const passed = () => {
    if (switching) setMode('device');
    setStep(switching ? null : 'change');
  };

  const enterOld = async (value: string) => {
    const pin = pinDigits(value);
    setOldPin(pin);
    if (!isValidPin(pin)) return;
    const result = await check({ pin });
    setOldPin('');
    if (result.ok) passed();
    else setMessage(result.waitUntil ? 'pinWaitTitle' : 'pinWrong');
  };

  const recover = async () => {
    if ((await check({ biometrics: t('unlockPrompt') })).ok) passed();
  };

  return (
    <Section title={t('lockTitle')}>
      <Choice
        testID="settings-lock-device"
        label={t('lockDevice')}
        help={t('lockDeviceHelp')}
        selected={mode === 'device' && step !== 'pin'}
        disabled={deviceLock === false}
        onPress={chooseDevice}
      />
      <Choice
        testID="settings-lock-pin"
        label={t('lockPin')}
        help={t('lockPinHelp')}
        selected={mode === 'pin' || step === 'pin'}
        onPress={() => mode === 'device' && setStep('pin')}
      />
      {deviceLock === false && <Text variant="helper">{t('pinNoScreenLock')}</Text>}
      {(step === 'pin' || step === 'change') && <PinSetup strongBiometrics={strongBiometrics} onSet={setNewPin} />}
      {mode === 'pin' && step === null && (
        <Pressable testID="settings-change-pin" accessibilityRole="button" onPress={() => askOld('verify')} style={styles.line}>
          <View style={styles.grow}>
            <Text variant="label">{t('changePin')}</Text>
            <Text variant="helper">{t('changePinHelp')}</Text>
          </View>
        </Pressable>
      )}
      {askingOld && (
        <>
          <Field
            testID="pin-old"
            label={t('pinOld')}
            value={oldPin}
            onChangeText={enterOld}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={PIN_LENGTH}
          />
          {message && <Text style={styles.error}>{t(message)}</Text>}
          {strongBiometrics && <Button variant="parentGhost" label={t('pinFingerprintKey')} onPress={recover} />}
        </>
      )}
      {(askingOld || step === 'change') && <Button variant="parentGhost" label={t('cancel')} onPress={() => setStep(null)} />}
    </Section>
  );
}

/** Its own component: download progress re-renders this row only. Opens the downloads screen. */
function DownloadsRow() {
  const { t } = useT();
  return (
    <Pressable testID="settings-downloads" accessibilityRole="link" onPress={() => router.push('/parent/downloads')}>
      <StatusRow label={t('downloadsLabel')} value={t(...downloadsText(useDownloads()))} />
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="section">{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const { color, radius, space, touch } = theme;

const styles = StyleSheet.create({
  body: { gap: space[4], paddingVertical: space[4] },
  section: { gap: space[2] },
  card: {
    gap: space[2],
    padding: space[4],
    borderRadius: radius.parent.card,
    borderWidth: 1,
    borderColor: color.parent.border,
    backgroundColor: color.parent.surface,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: touch.parent.gap },
  line: { flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: touch.parent.min },
  grow: { flex: 1 },
  accent: { color: color.parent.accent },
  error: { color: color.parent.error },
});
