import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useMemo, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { appDb } from '../data/appDb';
import { getDevice, updateDevice } from '../data/device';
import { listChildren } from '../data/profiles';
import { startInitialDownloads } from '../downloads/downloader';
import { FirstRunContext } from '../onboarding/firstRun';
import { fontFiles } from '../ui/fonts';
import { LanguageProvider, type UiLang } from '../ui/i18n';

// Keep the splash up until Baloo 2 and Mukta are ready.
SplashScreen.preventAutoHideAsync();

function readStart(): { lang: UiLang; hasChild: boolean } {
  try {
    const db = appDb();
    return { lang: getDevice(db).parent_lang, hasChild: listChildren(db).length > 0 };
  } catch {
    // No SQLite (component tests without a database): plain stack, never forced into onboarding.
    return { lang: 'mr', hasChild: true };
  }
}

const saveLang = (lang: UiLang) => updateDevice(appDb(), { parent_lang: lang });

export default function RootLayout() {
  const [loaded, error] = useFonts(fontFiles);
  const ready = loaded || error != null; // on a load error, render with system fonts
  const [start] = useState(readStart);
  const [hasChild, setHasChild] = useState(start.hasChild);
  const firstRun = useMemo(() => ({ childAdded: () => setHasChild(true) }), []);

  useEffect(() => {
    // Runs in the background; a missing CDN base or a bad manifest leaves the bundled content only.
    startInitialDownloads().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <LanguageProvider initial={start.lang} onChange={saveLang}>
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
      </LanguageProvider>
    </SafeAreaProvider>
  );
}
