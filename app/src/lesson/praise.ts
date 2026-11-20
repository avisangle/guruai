// Which praise or closing family a moment calls for (PRD Tutor variety 2).

export type PraiseFamily = 'praise_first' | 'praise_hint' | 'praise_streak' | 'praise_comeback';

export type PraiseMoment = {
  attempt: number; // 1 = first try
  streak: number; // correct answers in a row, this one included
  previousMissed: boolean; // the previous scored item ended in a miss
};

// Precedence: comeback > after hint > streak (3, 6, 9 ...) > first try.
export function praiseFamily({ attempt, streak, previousMissed }: PraiseMoment): PraiseFamily {
  if (previousMissed && attempt === 1) return 'praise_comeback';
  if (attempt >= 2) return 'praise_hint';
  if (streak > 0 && streak % 3 === 0) return 'praise_streak';
  return 'praise_first';
}

export function endFamily(missedAny: boolean): 'end_misses' | 'end_all' {
  return missedAny ? 'end_misses' : 'end_all';
}
