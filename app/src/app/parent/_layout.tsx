// Parent area: every screen but the unlock needs an unlocked parent session.
import { Stack } from 'expo-router';

import { useParentMode } from '../../parent/ParentModeProvider';

export default function ParentLayout() {
  const { unlocked } = useParentMode();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="unlock" />
      <Stack.Protected guard={unlocked}>
        <Stack.Screen name="index" />
      </Stack.Protected>
    </Stack>
  );
}
