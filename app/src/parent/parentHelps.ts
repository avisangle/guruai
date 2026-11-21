// The "parent helps" switch ("मी उत्तरं तपासेन"), per child (D-GURU-34-parent-helps). Held in memory
// only, so closing the app turns it off. Turned on from parent home, it applies to the child's open
// session, or else to the next one started in this app run; the session's end (goodbye, Stop) clears it.
import { useCallback, useSyncExternalStore } from 'react';

const on = new Set<string>();
const helped = new Set<string>(); // on at some point since the last end, for session.parent_helps
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const parentHelps = {
  isOn: (childId: string) => on.has(childId),
  set(childId: string, value: boolean) {
    if (value) {
      on.add(childId);
      helped.add(childId);
    } else on.delete(childId);
    notify();
  },
  /** At the session's end: turns the switch off and says whether the parent helped in it. */
  end(childId: string): boolean {
    const was = helped.delete(childId);
    on.delete(childId);
    notify();
    return was;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export function useParentHelps(childId: string): boolean {
  return useSyncExternalStore(parentHelps.subscribe, useCallback(() => parentHelps.isOn(childId), [childId]));
}
