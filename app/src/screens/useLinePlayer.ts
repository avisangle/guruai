// Plays a tutor line with lip-sync, and the listening chime.
import { useAudioPlayer } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { resolveLine } from '../content/audioResolver';
import type { ShekruRig } from '../shekru/useShekruRig';

const CHIME = require('../../assets/audio/chime.wav');

/** How a line stopped: 'interrupted' when the system paused it mid-way (Android audio focus loss, e.g. a call). */
export type LineEnd = void | 'interrupted';

export function useLinePlayer(rig: ShekruRig) {
  const player = useAudioPlayer(null, { updateInterval: 50 });
  const chime = useAudioPlayer(CHIME);
  const current = useRef<{ resolve: (how: LineEnd) => void; timer: ReturnType<typeof setTimeout>; started?: boolean } | null>(null);

  const end = useCallback((how: LineEnd) => {
    const line = current.current;
    if (!line) return;
    current.current = null;
    clearTimeout(line.timer);
    rig.setSpeech(null);
    line.resolve(how);
  }, [rig]);

  // Lip-sync follows the real audio position.
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      const line = current.current;
      if (s.didJustFinish) end();
      else if (s.playing) {
        if (line) line.started = true;
        rig.syncSpeech(true, s.currentTime);
      } else if (line?.started) end('interrupted'); // stopped by the system: stop() clears `current` first
    });
    return () => sub.remove();
  }, [player, rig, end]);

  return useMemo(() => ({
    // Resolves when the line ends or is stopped.
    play: (id: string, text: string) => new Promise<LineEnd>((resolve) => {
      end();
      const line = resolveLine(id);
      if (!line) {
        // no audio bundled or installed for this line: hold the caption for a reading-length pause
        current.current = { resolve, timer: setTimeout(end, Math.max(1200, text.length * 70)) };
        return;
      }
      const { source, clip } = line;
      rig.setSpeech(clip.events);
      player.replace(source);
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
