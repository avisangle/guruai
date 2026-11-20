# D-GURU-29: The child waits for the model file, not for the model's download row
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-29
**Confluence:** none

**Decision:** `readiness()` (`app/src/child/readiness.ts`) shows "Shekru is getting ready" only when `judgeReadiness()` is `missing`, meaning the model file is not on the phone. It takes the model's `DownloadItem` (the contract GURU-34 calls) but uses it only for the progress bar, never for the verdict.

**Why:** The file is the thing the judge needs. The downloader writes to a `.part` file and moves it into place only after the SHA-256 matches, so the file exists exactly when a usable model does. The download row says less: a newer model version shows `downloading` or `failed` while the older file keeps working, and a model copied over USB (`docs/android-sr-probe.md`) or present before the manifest is read has no row at all (`null`). Parent home's banner (`attentionBanner`) already keys on `missing`, so the child screen and the parent banner agree.

**Rejected:**
- `getting_ready` while the row is not `installed`: would hold a working phone on the waiting screen during a model upgrade, after a failed upgrade, or forever on a phone with a sideloaded model and no CDN.

**Impact:** Code that decides whether the child can start must read model presence from `judgeReadiness()` (or `modelAvailable()`), not from `downloadStatus()`. The download row is for progress and for parent-facing download state only.
