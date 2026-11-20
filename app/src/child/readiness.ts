// What the child sees before today's queue (wireframes c-getting-ready, c-ask-mic, c-ask-weak; PRD Edge Cases).
import type { JudgeReadiness } from '../asr/speedCheck';
import type { DownloadItem } from '../downloads/downloader';
import { attentionBanner, type Banner, type MicState } from '../parent/attention';

export type Readiness = 'ready' | 'getting_ready' | 'ask_mic' | 'ask_weak';

export type ReadinessInput = {
  /** The model's download row, or null before the manifest is read. Shown as progress; not a verdict. */
  model: DownloadItem | null;
  mic: MicState;
  judge: JudgeReadiness;
  /** The parent switch (GURU-34): answers come from the parent's taps, so nothing else matters. */
  parentHelps: boolean;
};

const BY_BANNER: Record<Banner['kind'], Readiness> = { model: 'getting_ready', mic: 'ask_mic', weak: 'ask_weak' };

/**
 * The child's side of parent home's banner, so both follow one priority: model, then mic, then a phone
 * too weak. The model counts as present when its file is on the phone (judge not `missing`), whatever
 * the download row says (D-GURU-29-model-present-from-file).
 */
export function readiness({ mic, judge, parentHelps }: ReadinessInput): Readiness {
  if (parentHelps) return 'ready';
  const banner = attentionBanner({ readiness: judge, mic, micLastGrantedAt: null });
  return banner ? BY_BANNER[banner.kind] : 'ready';
}
