// "Finish setting up" card rows (wireframe pm-home): defaulted profile sections not yet saved,
// and the consent question until it is answered. The card hides when there are no rows.
import type { ChildProfile, Device } from '../data/types';

/** Profile sections the profile form marks in child.setup_done once saved. */
export const SETUP_SECTIONS = ['goals_style', 'lessons_per_day', 'board'] as const;
export type SetupSection = (typeof SETUP_SECTIONS)[number];

export type SetupRow = { kind: 'profile'; sections: SetupSection[]; href: string } | { kind: 'consent'; href: string };

export function setupRows(child: ChildProfile, device: Device): SetupRow[] {
  const rows: SetupRow[] = [];
  const sections = SETUP_SECTIONS.filter((s) => !child.setup_done.includes(s));
  if (sections.length > 0) rows.push({ kind: 'profile', sections, href: `/parent/child/${child.id}` });
  if (device.consent_answered_at === null) rows.push({ kind: 'consent', href: '/parent/consent' });
  return rows;
}
