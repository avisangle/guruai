// AnswerSource backed by the "parent helps" buttons: the parent's tap is the answer.
import type { AnswerSource } from './answerSource';
import type { Answer, Heard } from './types';

export function createTapSource() {
  let pending: ((heard: Heard) => void) | null = null;
  const source: AnswerSource = {
    listen: () => new Promise((resolve) => {
      pending = resolve;
    }),
    cancel: () => {
      pending = null;
    },
  };
  const give = (answer: Answer) => {
    const resolve = pending;
    pending = null;
    resolve?.({ kind: answer, by: 'tap' });
  };
  return { source, give };
}
