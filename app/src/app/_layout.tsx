import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { runSpeedCheck } from '../asr/speedCheck';
import { getDevice, updateDevice } from '../data/device';
import { liveDb } from '../data/liveDb';
import { listChildren } from '../data/profiles';
import { startInitialDownloads } from '../downloads/downloader';
import { FirstRunContext } from '../onboarding/firstRun';
import { ParentModeProvider } from '../parent/ParentModeProvider';
import { fontFiles } from '../ui/fonts';
import { LanguageProvider, type UiLang } from '../ui/i18n';

// Keep the splash up until Baloo 2 and Mukta are ready.
SplashScreen.preventAutoHideAsync();

function readStart(): { lang: UiLang; hasChild: boolean } {
  try {
    const db = liveDb();
    return { lang: getDevice(db).parent_lang, hasChild: listChildren(db).length > 0 };
  } catch {
    // No SQLite (component tests without a database): plain stack, never forced into onboarding.
    return { lang: 'mr', hasChild: true };
  }
}

const saveLang = (lang: UiLang) => updateDevice(liveDb(), { parent_lang: lang });

export default function RootLayout() {
  const [loaded, error] = useFonts(fontFiles);
  const ready = loaded || error != null; // on a load error, render with system fonts
  const [start] = useState(readStart);
  const [hasChild, setHasChild] = useState(start.hasChild);
  const firstRun = useMemo(() => ({ childAdded: () => setHasChild(true) }), []);

  useEffect(() => {
    // Judge speed check (D-GURU-15): now for a model already here, again after downloads for a new one.
    const speedCheck = () => Promise.resolve().then(() => runSpeedCheck()).catch(() => undefined);
    speedCheck();
    // Runs in the background; a missing CDN base or a bad manifest leaves the bundled content only.
    startInitialDownloads().catch(() => undefined).then(speedCheck);
  }, []);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <LanguageProvider initial={start.lang} onChange={saveLang}>
        <ParentModeProvider>
          <FirstRunContext.Provider value={firstRun}>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Protected guard={hasChild} redirectTo="/onboarding/welcome">
                <Stack.Screen name="index" />
              </Stack.Protected>
              <Stack.Protected guard={!hasChild}>
                <Stack.Screen name="onboarding" />
              </Stack.Protected>
            </Stack>
          </FirstRunContext.Provider>
        </ParentModeProvider>
      </LanguageProvider>
    </SafeAreaProvider>
  );
}
