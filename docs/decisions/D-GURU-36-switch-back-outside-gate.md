# D-GURU-36: Switching back to the phone's lock is a function beside the gate, not a gate method
**Status:** Accepted; amended by D-GURU-51-switch-back-asks-pin (switching back now needs a proof)
**Date:** 2026-11-21
**Issue:** GURU-36
**Confluence:** none

**Decision:** Settings switches the parent lock from the GuruAI PIN back to the phone's screen lock with `switchToDeviceLock(deps)` in `app/src/parent/gate.ts` (live: `liveSwitchToDeviceLock()` in `parent/live.ts`), not a method on the object `createGate` returns. It refuses, changing nothing, when the phone has no screen lock. When it runs, it sets `parent_gate.mode` to `device` and clears the wrong-PIN counters, and only then deletes the secure-store PIN record.

**Why:** `parentShell.test.tsx` casts a fake gate `as Gate`. TypeScript accepts that cast only while the fake is assignable to `Gate`, so any new method on the gate fails typecheck in a test file that `/implement` may not edit. D-GURU-25-parent-session rejected adding gate methods for the same reason. The order of the two writes matters: if the delete fails after the mode change, a PIN record is left behind but nothing reads it. The other order could leave pin mode with no PIN, so no PIN would ever be accepted and only strong biometrics could open the parent area.

**Rejected:**
- A `switchToDeviceLock()` method on the gate: breaks the typecheck of `parentShell.test.tsx` (GURU-25's fake), as above.
- Deleting the PIN record before changing the mode: a failed mode write leaves pin mode without a PIN.

**Impact:**
- Code that switches the gate back to the phone's lock calls `switchToDeviceLock`. It always goes through the live dependencies, even when a `ParentModeProvider` was given an injected gate.
- The function must keep its two checks: refuse when the phone has no screen lock (wireframe decision 25, `design/wireframes/guruai-v1-wireframes.html#gap-25`), and change the mode before deleting the record.
- If the fake gate in `parentShell.test.tsx` is ever rebuilt from `Gate`, this can move onto the gate. Mark this record Superseded when that happens.
