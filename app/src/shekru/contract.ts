// States every tutor rig must provide (D-GURU-7-tutor-state-contract).
// sneeze, dropnut, dance and celebrate are silent one-shots that return to idle.
export const TUTOR_STATES = [
  'idle', 'hello', 'talking', 'listening', 'thinking', 'correct', 'tryagain', 'hint', 'nohear', 'bye',
  'sneeze', 'dropnut', 'dance', 'celebrate',
] as const;

export type TutorState = (typeof TUTOR_STATES)[number];
