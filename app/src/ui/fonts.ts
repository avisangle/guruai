// Every font face the theme uses; the root layout loads these before the first
// screen. Per-weight imports keep unused weights out of the bundle. On Android a
// custom font has no synthetic bold, so each weight is its own family name.
import { Baloo2_700Bold } from '@expo-google-fonts/baloo-2/700Bold';
import { Baloo2_800ExtraBold } from '@expo-google-fonts/baloo-2/800ExtraBold';
import { Mukta_400Regular } from '@expo-google-fonts/mukta/400Regular';
import { Mukta_500Medium } from '@expo-google-fonts/mukta/500Medium';
import { Mukta_600SemiBold } from '@expo-google-fonts/mukta/600SemiBold';
import { Mukta_700Bold } from '@expo-google-fonts/mukta/700Bold';
import { Mukta_800ExtraBold } from '@expo-google-fonts/mukta/800ExtraBold';

export const fontFiles = {
  Baloo2_700Bold,
  Baloo2_800ExtraBold,
  Mukta_400Regular,
  Mukta_500Medium,
  Mukta_600SemiBold,
  Mukta_700Bold,
  Mukta_800ExtraBold,
};

export type FontName = keyof typeof fontFiles;
