// What the child sees before today's queue (wireframes c-getting-ready, c-ask-mic, c-ask-weak; PRD Edge Cases).
import type { JudgeReadiness } from '../asr/speedCheck';
import type { DownloadItem } from '../downloads/downloader';
import type { MicState } from '../parent/attention';

export type Readiness = 'ready' | 'getting_ready' | 'ask_mic' | 'ask_weak';

export type ReadinessInput = {
  /** The model's download row, or null before the manifest is read. Shown as progress; not a verdict. */
  model: DownloadItem | null;
  mic: MicState;
  judge: JudgeReadiness;
  /** The parent switch (GURU-34): answers come from the parent's taps, so nothing else matters. */
  parentHelps: boolean;
};

/**
 * Priority: model, then mic, then a phone too weak. The model counts as present when the model file is
 * on the phone (judge not `missing`), whatever the download row says: a download only writes the file
 * once verified, a newer version downloads beside the working one, and a model copied over USB has no row.
 */
export function readiness({ mic, judge, parentHelps }: ReadinessInput): Readiness {
  if (parentHelps) return 'ready';
  if (judge === 'missing') return 'getting_ready';
  if (!mic.granted) return 'ask_mic';
  if (judge === 'slow' || judge === 'oom') return 'ask_weak';
  return 'ready';
}
