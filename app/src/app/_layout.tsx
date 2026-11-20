import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { startInitialDownloads } from '../downloads/downloader';
import { fontFiles } from '../ui/fonts';

// Keep the splash up until Baloo 2 and Mukta are ready.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts(fontFiles);
  const ready = loaded || error != null; // on a load error, render with system fonts

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
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
