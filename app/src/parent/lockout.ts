// Wait after wrong parent PINs (D-GURU-13-parent-gate): every 3rd wrong PIN starts one.
const SEC = 1000;
const MIN = 60 * SEC;

/** Wait in ms that starts after the `failed`-th wrong PIN; 0 when none starts. */
export function lockoutFor(failed: number): number {
  if (failed <= 0 || failed % 3 !== 0) return 0;
  if (failed === 3) return 30 * SEC;
  if (failed === 6) return 5 * MIN;
  return 15 * MIN;
}
