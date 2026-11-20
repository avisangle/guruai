// Storage plan: start downloads by themselves only when free space covers the files plus a reserve.

/** Kept free for the OS and the child's recordings; decimal bytes, like the manifest sizes. */
export const RESERVE_BYTES = 200_000_000;

export type PlanFile = { id: string; bytes: number };

export type StoragePlan =
  | { kind: 'start' }
  | { kind: 'needs_choice'; needed: number; free: number; fits: string[] };

export function storagePlan(files: PlanFile[], freeBytes: number): StoragePlan {
  const needed = files.reduce((sum, f) => sum + f.bytes, 0) + RESERVE_BYTES;
  if (freeBytes >= needed) return { kind: 'start' };
  // The files that fit, in order, in the space left after the reserve.
  let room = freeBytes - RESERVE_BYTES;
  const fits: string[] = [];
  for (const f of files) {
    if (f.bytes <= room) {
      fits.push(f.id);
      room -= f.bytes;
    }
  }
  return { kind: 'needs_choice', needed, free: freeBytes, fits };
}
