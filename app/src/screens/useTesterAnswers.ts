// AnswerSource backed by the tester buttons.
import { useMemo, useRef, useState } from 'react';

import type { AnswerSource } from '../lesson/answerSource';
import type { Answer, Heard } from '../lesson/types';

export function useTesterAnswers() {
  const pending = useRef<((heard: Heard) => void) | null>(null);
  const [waiting, setWaiting] = useState(false);

  const api = useMemo(() => {
    const source: AnswerSource = {
      listen: () => new Promise((resolve) => {
        pending.current = resolve;
        setWaiting(true);
      }),
      cancel: () => {
        pending.current = null;
        setWaiting(false);
      },
    };
    const give = (answer: Answer) => {
      const resolve = pending.current;
      source.cancel();
      resolve?.({ kind: answer, by: 'tap' });
    };
    return { source, give };
  }, []);

  return { ...api, waiting };
}
