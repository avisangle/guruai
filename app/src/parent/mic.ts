// The mic permission as screens read it (parent home's banner, the child's waiting screens).
import { now, type Db } from '../data/db';
import { updateDevice } from '../data/device';
import type { MicState } from './attention';

// Lazy: loading expo-audio touches its native module, which tests without an audio mock lack.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const audio = () => require('expo-audio') as typeof import('expo-audio');

export async function readMic(): Promise<MicState> {
  try {
    const { granted, canAskAgain } = await audio().getRecordingPermissionsAsync();
    return { granted, canAskAgain };
  } catch {
    return { granted: true, canAskAgain: true }; // unknown: no banner, no waiting screen
  }
}

/** The system mic prompt; a grant is stamped on the device row. Null when the dialog failed to open. */
export async function askForMic(db: Db): Promise<MicState | null> {
  try {
    const { granted, canAskAgain } = await audio().requestRecordingPermissionsAsync();
    if (granted) updateDevice(db, { mic_last_granted_at: now() });
    return { granted, canAskAgain };
  } catch {
    return null;
  }
}
