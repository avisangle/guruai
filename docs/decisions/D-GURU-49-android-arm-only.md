# D-GURU-49: Android builds compile arm64-v8a and armeabi-v7a only
**Status:** Accepted
**Date:** 2026-11-27
**Issue:** GURU-49
**Confluence:** none

**Decision:** Android builds compile only arm64-v8a and armeabi-v7a, set by `expo-build-properties` `android.buildArchs` in `app/app.json`.

**Why:** The four-ABI build runs the free EAS worker out of memory compiling Skia's C++ (bug.md, 2026-11-27). x86 and x86_64 serve only emulators. armeabi-v7a stays for 32-bit Android on the 2 to 3 GB phones the PRD targets.

**Rejected:**
- arm64-only: proven to build, but drops 32-bit phones in the target range.
- A larger paid EAS worker: recurring cost to compile ABIs no target phone runs.
- Per-profile `ORG_GRADLE_PROJECT_reactNativeArchitectures` env: repeated in three profiles, and does not reach local prebuild.

**Impact:** A new ABI is added only through `buildArchs`. No `eas.json` profile sets `ORG_GRADLE_PROJECT_reactNativeArchitectures`. Emulator testing needs a temporary local override, not a config change. Conforms to D-GURU-48-shekru-on-skia.
