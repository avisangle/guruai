// The mic permission as screens read it (parent home's banner, the child's waiting screens).
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
