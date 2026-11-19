// Decides when a listening turn's recording ends, from the live microphone samples:
// shortly after the child stops talking, or when nothing is said at all.
// Values set on the first child's 56 clips (D-STT-auto-stop).
import { SPEECH_DBFS } from './judge';

export const FRAME_MS = 30;
export const END_SILENCE_MS = 1500; // quiet after speech: the answer is over (he pauses up to ~1.3 s mid-answer)
export const NO_SPEECH_MS = 4000; // nothing said since the mic opened: a silent turn
export const MAX_MS = 10000; // hard cap on one answer
export const MIN_SPEECH_MS = 150; // less sound than this is a click, not speech

export type EndReason = 'end' | 'nospeech' | 'max';

/** Feed int16 PCM as it arrives; push() returns why to stop, or null to keep listening. */
export function createEndpointer(sampleRate: number) {
  const frameLen = Math.round((sampleRate * FRAME_MS) / 1000);
  let sum = 0; // sum of squares in the current frame
  let filled = 0;
  let t = 0;
  let speech = 0;
  let quiet = 0;
  let done: EndReason | null = null;

  const endFrame = (): EndReason | null => {
    t += FRAME_MS;
    const db = 10 * Math.log10(sum / frameLen + 1e-12);
    if (db > SPEECH_DBFS) {
      speech += FRAME_MS;
      quiet = 0;
    } else {
      quiet += FRAME_MS;
    }
    if (speech < MIN_SPEECH_MS) {
      if (t >= NO_SPEECH_MS) return 'nospeech';
    } else if (quiet >= END_SILENCE_MS) {
      return 'end';
    }
    return t >= MAX_MS ? 'max' : null;
  };

  return {
    push(pcm: Int16Array): EndReason | null {
      for (let i = 0; i < pcm.length && !done; i++) {
        const s = pcm[i] / 32768;
        sum += s * s;
        if (++filled === frameLen) {
          done = endFrame();
          sum = 0;
          filled = 0;
        }
      }
      return done;
    },
  };
}

export type Endpointer = ReturnType<typeof createEndpointer>;
