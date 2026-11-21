// Parent area: every screen but the unlock needs an unlocked parent session. While the consent
// question is unanswered, the first screen of each parent-mode visit is the consent prompt (decision 12).
import { router, Stack, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';

import { getDevice } from '../../data/device';
import { liveDb } from '../../data/liveDb';
import { useParentMode } from '../../parent/ParentModeProvider';

const UNLOCK = '/parent/unlock';
const CONSENT = '/parent/consent';

/** False when SQLite is missing (component tests without it), so the visit is not redirected. */
function consentUnanswered(): boolean {
  try {
    return getDevice(liveDb()).consent_answered_at === null;
  } catch {
    return false;
  }
}

export default function ParentLayout() {
  const { unlocked } = useParentMode();
  const pathname = usePathname();
  // Set on the visit's first parent screen; cleared when parent mode ends.
  const asked = useRef(false);

  useEffect(() => {
    if (!unlocked) {
      asked.current = false;
      return;
    }
    if (asked.current || pathname === UNLOCK) return;
    asked.current = true;
    if (pathname !== CONSENT && consentUnanswered()) router.replace(CONSENT);
  }, [unlocked, pathname]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="unlock" />
      <Stack.Protected guard={unlocked}>
        <Stack.Screen name="index" />
        <Stack.Screen name="consent" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="child/[id]" />
        <Stack.Screen name="assign/[child]" />
        <Stack.Screen name="report/[child]" />
      </Stack.Protected>
    </Stack>
  );
}
