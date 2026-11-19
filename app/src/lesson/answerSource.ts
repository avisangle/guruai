// Where the child's answer comes from. Today: tester buttons. Later:
// microphone -> speech-to-text -> Evaluator -> toAnswer().
import type { Answer, Item, ListenKind } from './types';

export type AnswerSource = {
  // Resolves once with the answer to this listen turn.
  listen(item: Item, kind: ListenKind): Promise<Answer>;
  // Drops a pending listen; its promise never resolves.
  cancel(): void;
};
