// Parent home per child (wireframes pm-home, pm-home-2). Sections in decision 23 order:
// Up next, waiting for download, Pending, Revision due, Completed (collapsed).
import type { Db } from '../data/db';
import type { ChildProfile } from '../data/types';
import { buildTodayQueue, type DueItem, type QueueInput, type TodayQueue } from '../learning/queue';
import { readQueueInput } from '../learning/queueInput';

export type HomeSection =
  | { id: 'upNext' | 'waiting' | 'pending'; lessons: string[] }
  | { id: 'revision'; items: DueItem[] }
  | { id: 'completed'; lessons: string[]; collapsed: boolean };

export type HomeInput = Pick<QueueInput, 'inProgress' | 'assignments' | 'finished' | 'due'> & { queue: TodayQueue };

/** Pending is every started or assigned lesson that is not finished and not already listed above it. */
export function homeSections({ queue, inProgress, assignments, finished, due }: HomeInput): HomeSection[] {
  const upNext = queue.stops.flatMap((s) => (s.kind === 'lesson' ? [s.template_id] : []));
  const waiting = queue.waitingForDownload;
  const listed = new Set([...upNext, ...waiting, ...finished]);
  const open = [...inProgress, ...assignments.filter((a) => a.done_at === null).map((a) => a.template_id)];
  const pending = [...new Set(open)].filter((id) => !listed.has(id));
  return [
    { id: 'upNext', lessons: upNext },
    ...(waiting.length > 0 ? [{ id: 'waiting' as const, lessons: waiting }] : []),
    { id: 'pending', lessons: pending },
    { id: 'revision', items: due },
    { id: 'completed', lessons: finished, collapsed: true },
  ];
}

export type ChildHome = {
  done: number;
  goal: number;
  sections: HomeSection[];
  /** Unfinished lessons assigned for today or carried over from earlier days. */
  assigned: string[];
};

/** Unfinished lessons assigned for `today` or carried over from earlier days. */
export const assignedToday = (assignments: QueueInput['assignments'], today: string) =>
  assignments.filter((a) => a.done_at === null && a.for_date <= today).map((a) => a.template_id);

/** The child's home on the local day `today` ('YYYY-MM-DD'). */
export function loadChildHome(db: Db, child: ChildProfile, today: string, isInstalled: (id: string) => boolean): ChildHome {
  const input = readQueueInput(db, child, today, isInstalled);
  const queue = buildTodayQueue(input);
  return {
    done: queue.done,
    goal: queue.goal,
    sections: homeSections({ ...input, queue }),
    assigned: assignedToday(input.assignments, today),
  };
}
