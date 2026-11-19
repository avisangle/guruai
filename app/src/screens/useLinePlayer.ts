// Plays a tutor line with lip-sync, and the listening chime.
import { useAudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { LINE_AUDIO } from '../content/generated/audio';
import clipsJson from '../content/generated/clips.json';
import type { ShekruRig, VisemeEvent } from '../shekru/useShekruRig';

const CLIPS = clipsJson as unknown as Record<string, { duration: number; events: VisemeEvent[] }>;
const CHIME = require('../../assets/audio/chime.wav');

export function useLinePlayer(rig: ShekruRig) {
  const player = useAudioPlayer(null, { updateInterval: 50 });
  const chime = useAudioPlayer(CHIME);
  const current = useRef<{ resolve: () => void; timer: ReturnType<typeof setTimeout> } | null>(null);

  const end = useCallback(() => {
    const line = current.current;
    if (!line) return;
    current.current = null;
    clearTimeout(line.timer);
    rig.setSpeech(null);
    line.resolve();
  }, [rig]);

  // Lip-sync follows the real audio position.
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.didJustFinish) end();
      else if (s.playing) rig.syncSpeech(true, s.currentTime);
    });
    return () => sub.remove();
  }, [player, rig, end]);

  return useMemo(() => ({
    // Resolves when the line ends or is stopped.
    play: (id: string, text: string) => new Promise<void>((resolve) => {
      end();
      const clip = CLIPS[id];
      if (!clip) {
        // no audio built for this line yet: hold the caption for a reading-length pause
        current.current = { resolve, timer: setTimeout(end, Math.max(1200, text.length * 70)) };
        return;
      }
      rig.setSpeech(clip.events);
      player.replace(LINE_AUDIO[id]);
      player.play();
      // never hang the lesson if the player fails to report the end
      current.current = { resolve, timer: setTimeout(end, (clip.duration + 1.5) * 1000) };
    }),
    stop: () => {
      player.pause();
      end();
    },
    chime: () => {
      chime.seekTo(0);
      chime.play();
    },
  }), [player, chime, rig, end]);
}
