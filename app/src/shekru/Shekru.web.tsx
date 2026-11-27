// Web draws no Shekru: Skia on web needs CanvasKit loaded before the first render, and that is not
// wired (docs/decisions/D-GURU-48-shekru-on-skia.md). An empty box of the same size keeps the layout.
import { memo } from 'react';
import { View } from 'react-native';

import type { PartValues } from './useShekruRig';

export const Shekru = memo(function Shekru({ size }: { values: PartValues; size: number; hintLetter?: string }) {
  return <View style={{ width: size, height: size }} accessibilityLabel="शेकरू" />;
});
