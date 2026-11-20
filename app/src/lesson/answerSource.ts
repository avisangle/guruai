// Where the child's answer comes from: the microphone and on-device judge, or tester buttons.
import type { Heard, Listen } from './types';

export type AnswerSource = {
  // Resolves once with the answer to this listen turn.
  listen(listen: Listen): Promise<Heard>;
  // Drops a pending listen; its promise never resolves.
  cancel(): void;
};
