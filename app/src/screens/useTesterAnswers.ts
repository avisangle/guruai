// AnswerSource backed by the tester buttons: the tap source, plus whether a turn is waiting.
import { useMemo, useState } from 'react';

import type { AnswerSource } from '../lesson/answerSource';
import { createTapSource } from '../lesson/tapSource';
import type { Answer } from '../lesson/types';

export function useTesterAnswers() {
  const [waiting, setWaiting] = useState(false);

  const api = useMemo(() => {
    const tap = createTapSource();
    const source: AnswerSource = {
      listen: (step) => {
        setWaiting(true);
        return tap.source.listen(step);
      },
      cancel: () => {
        tap.source.cancel();
        setWaiting(false);
      },
    };
    const give = (answer: Answer) => {
      setWaiting(false);
      tap.give(answer);
    };
    return { source, give };
  }, []);

  return { ...api, waiting };
}
