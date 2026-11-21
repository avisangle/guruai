// Shared tutor line families and repeat-free picking (TDD 2.4).

// Family -> minimum pool size the content validator enforces. Families TDD 2.4
// lists without a number need at least one line.
export const FAMILIES = {
  praise_first: 4,
  praise_hint: 4,
  praise_streak: 4,
  praise_comeback: 4,
  end_all: 1,
  end_misses: 1,
  tryagain: 8,
  nohear: 8,
  ask: 8,
  intro: 3,
  bye: 3,
  again: 1,
  moveon: 1,
  retry_intro: 1,
  meaning_hi_ack: 1,
  ask_mr: 1,
  surprise_line: 1,
  ready: 1,
  ask_grownup_model: 1,
  ask_grownup_mic: 1,
  ask_grownup_weak: 1,
} as const satisfies Record<string, number>;

export type Family = keyof typeof FAMILIES;

const HISTORY = 5;

/** A family's line ids in `lines`: `<family>_<n>`, or the bare family id. */
export function familyLines(family: string, lines: Record<string, string>): string[] {
  const re = new RegExp(`^${family}(_\\d+)?$`);
  return Object.keys(lines).filter((id) => re.test(id));
}

/** The family a shared line id belongs to (`praise_streak_3` -> `praise_streak`); null for other ids. */
export function familyOf(id: string): Family | null {
  const family = id.replace(/_\d+$/, '');
  return family in FAMILIES ? (family as Family) : null;
}

// Uniform pick from `available` minus the family's last 5 picks (minus only the
// last pick when the pool has 5 or fewer lines). `history` is oldest first;
// the returned history keeps at most 5. `family` names the pool for callers that
// keep one history per family.
export function pickLine(
  family: string,
  available: string[],
  history: string[],
  rng: () => number,
): { id: string; history: string[] } {
  const recent = history.slice(available.length > HISTORY ? -HISTORY : -1);
  const fresh = available.filter((id) => !recent.includes(id));
  const pool = fresh.length > 0 ? fresh : available;
  const id = pool[Math.floor(rng() * pool.length)];
  return { id, history: [...history, id].slice(-HISTORY) };
}
