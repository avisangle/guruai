# D-GURU-51: Switching back to the phone's lock needs the GuruAI PIN or strong biometrics, checked inside the switch
**Status:** Accepted
**Date:** 2026-11-27
**Issue:** GURU-51
**Confluence:** none

**Decision:** `switchToDeviceLock(deps, proof)` in `app/src/parent/gate.ts` takes a `SwitchProof`, `{ pin }` or `{ biometrics: promptMessage }`, and verifies it itself with the gate's own `verifyPin` and `recoverWithBiometrics` on the same deps before it changes anything. It returns a `PinResult`, so a wrong PIN or a wait reads the same as in Change PIN. Settings only collects the proof, in an old-PIN step laid out like Change PIN's.

**Why:** A family chooses the GuruAI PIN because the child knows the phone's pattern (D-GURU-13-parent-gate). Without a proof, a child who finds parent mode open removes the PIN with one tap and then opens parent mode with the pattern. Owner call, 2026-11-27: parity with Change PIN.

**Rejected:**
- Checking only in Settings: any other caller of `switchToDeviceLock` could remove the PIN unchecked.
- Accepting the phone's own PIN, pattern or a weak biometric: the child may know it, which is why the GuruAI PIN exists.
- Verifying first in Settings and passing a flag or token to the switch: the switch would trust its caller again, and a verify-then-switch pair counts a wrong PIN twice.

**Impact:**
- Any code that removes the GuruAI PIN goes through `switchToDeviceLock` with a proof.
- The function keeps this order: screen-lock check (no prompt, no count), pin-mode check, proof, mode write with counters cleared, record delete.
- A PIN proof follows D-GURU-13's counting and waits; a biometric proof is strong only (`disableDeviceFallback: true`, `biometricsSecurityLevel: 'strong'`) and works during a wait, as recovery does.
- Settings checks the switch-back PIN only through the switch, never also with `gate().verifyPin`.
