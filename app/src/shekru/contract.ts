// States every tutor rig must provide (D-GURU-7-tutor-state-contract).
// The surprises: silent one-shots that return to idle.
export const SURPRISE_STATES = ['sneeze', 'dropnut', 'dance', 'celebrate'] as const;
export const TUTOR_STATES = [
  'idle', 'hello', 'talking', 'listening', 'thinking', 'correct', 'tryagain', 'hint', 'nohear', 'bye',
  ...SURPRISE_STATES,
] as const;

export type TutorState = (typeof TUTOR_STATES)[number];
