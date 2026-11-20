// Parent area: every route but the unlock needs an unlocked parent session.
import { Redirect, Stack, useSegments } from 'expo-router';

import { useParentMode } from '../../parent/ParentModeProvider';

export default function ParentLayout() {
  const { unlocked } = useParentMode();
  const segments = useSegments();
  if (!unlocked && segments.at(-1) !== 'unlock') return <Redirect href="/parent/unlock" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
