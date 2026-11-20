// Where the child's answer comes from: the microphone and on-device judge, or tester buttons.
import type { Heard, Item, ListenKind } from './types';

export type AnswerSource = {
  // Resolves once with the answer to this listen turn.
  listen(item: Item, kind: ListenKind): Promise<Heard>;
  // Drops a pending listen; its promise never resolves.
  cancel(): void;
};
