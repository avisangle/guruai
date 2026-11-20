// The one banner on parent home when Shekru cannot listen (wireframe pm-attention, decision 26).
// Priority: model missing or failed, then mic, then a phone too weak (which has no fix).
import type { JudgeReadiness } from '../asr/speedCheck';

export type MicState = { granted: boolean; canAskAgain: boolean };

export type AttentionInput = { readiness: JudgeReadiness; mic: MicState; micLastGrantedAt: string | null };

export type Banner =
  | { kind: 'model'; action: 'resumeDownload' }
  // chooseWhileUsing: granted before and not now, so "Only this time" ran out.
  | { kind: 'mic'; action: 'requestPermission' | 'openSettings'; chooseWhileUsing: boolean }
  | { kind: 'weak'; action: null };

export function attentionBanner({ readiness, mic, micLastGrantedAt }: AttentionInput): Banner | null {
  if (readiness === 'missing') return { kind: 'model', action: 'resumeDownload' };
  if (!mic.granted) {
    // Android stops showing the dialog after repeated refusals; then only the phone's settings help.
    const action = mic.canAskAgain ? 'requestPermission' : 'openSettings';
    return { kind: 'mic', action, chooseWhileUsing: micLastGrantedAt !== null };
  }
  if (readiness === 'slow' || readiness === 'oom') return { kind: 'weak', action: null };
  return null;
}
