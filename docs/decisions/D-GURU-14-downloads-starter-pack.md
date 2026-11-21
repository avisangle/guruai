# D-GURU-14: Downloads from R2 behind an owned domain; starter pack and shared lines in the app
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-14
**Confluence:** none

**Decision:** The speech model and the audio packs come from Cloudflare R2 behind an owned domain (`EXPO_PUBLIC_CDN_BASE`), as immutable files with the version in the name, listed in one `guru/v1/manifest.json` (TDD 2.7). Shared tutor lines and the `starter` lesson pack ship inside the app. The model starts downloading in the background on first open; the child's other packs follow once the class is known. Downloads wait for Wi-Fi unless the parent allows mobile data.

**Why:** A first lesson never waits for the network, and "parent helps" still works on a phone whose model download failed (PRD Happy Path, commit db93ddc). Immutable versioned files mean a cached or half-downloaded file is never stale: only `manifest.json` changes, so a resumed Range request always continues the same bytes. An owned domain lets us set cache rules and move storage without an app update.

**Rejected:**
- Downloading everything after install: the first lesson waits on the network.
- A GitHub release asset: no cache rule and no control of the domain.
- Bundling the model: it alone is 137 MB, over the 100 MB APK limit.

**Impact:**
- Never overwrite a published file in R2. A changed model or pack gets a new version and a new URL, and the manifest points at it.
- Manifest URLs are https or relative to the manifest; `parseManifest` rejects anything else, and pack ids must be safe directory names.
- A file is installed only after its SHA-256 matches the manifest. A mismatch deletes it and downloads it again, at most 3 more times, then the row is `failed`; the next app start tries again.
- Nothing downloads, the manifest included, on a metered connection unless `device.allow_mobile_data` is 1.
- Downloads start by themselves only when free space covers them plus 200,000,000 bytes (`storagePlan`); otherwise the UI offers a choice.
- Lessons whose audio ships in the app are passed as `content.bundledLessons` (`app/src/downloads/live.ts`), which must list exactly the lessons `build-content.mjs` bundles. Today that is every generated lesson; the change that makes build-content bundle only the `starter` pack (GURU-23) narrows `bundledLessons` to the starter lessons in the same PR. `packsForChild` returns the `lessonPack` packs of the child's not-bundled path lessons, so it queues nothing until then.
