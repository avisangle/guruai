# D-GURU-13: Parent gate is the phone's screen lock by default, with an optional GuruAI PIN
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-13
**Confluence:** none

**Decision:** Parent mode opens with Android's system unlock prompt, device credential allowed (fingerprint, face, or the phone's PIN or pattern). A parent whose child knows the phone's lock can choose a separate 4-digit GuruAI PIN; a phone with no screen lock must use one (`state()` is `needs_pin_setup`). The PIN is stored only in expo-secure-store as `{salt, rounds, hash}`: 16 random salt bytes, SHA-256 of salt then PIN, re-hashed to 1000 digests. Every 3rd wrong PIN starts a wait: 30 s at 3, 5 min at 6, 15 min at 9 and each further 3, never longer. A forgotten PIN is recovered by strong biometrics only, which works during a wait. Code: `app/src/parent/`.

**Why:** The phone's lock gives the parent nothing new to remember. Children often know the phone's pattern, so the app PIN exists for those families, and the same reason keeps the phone's PIN or pattern out of PIN recovery. Waits capped at 15 min slow a guessing child without ever locking out the "parent helps" switch for a day. A 4-digit PIN has 10,000 values, so the hash cannot stop an attacker who reads the record; secure store (Android Keystore-backed) protects the record, and the salt and rounds stop a copied record from being looked up in a precomputed table.

**Rejected:**
- App PIN only: one more PIN for the parent to remember.
- Phone lock only: children often know the pattern.
- A 24-hour lock after repeated wrong PINs: it would block lessons that need the parent switch for a day.
- Storing the hash or salt in SQLite (as the PRD's schema sketch lists): SQLite is plain storage and M2 syncs it; secure store keeps the record off both.

**Impact:**
- Nothing PIN-related (PIN, hash, salt) goes to SQLite; `parent_gate` holds only mode and counters.
- Lockout state lives in `parent_gate` (`failed`, `lockout_until`), so closing the app does not end a wait.
- During a wait `verifyPin` returns `waitUntil` without hashing or counting.
- `recoverWithBiometrics` must keep `disableDeviceFallback: true` and `biometricsSecurityLevel: 'strong'`, and must not prompt when the phone has no strong biometrics.
- `lockoutFor` never returns more than 15 min.
