# D-GURU-14: One pack_install row per version; installed packs record their lessons
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-14
**Confluence:** none

**Decision:** `pack_install` holds one row per (pack id, version). A newer version downloads into its own row and folder while the installed one stays usable; when it installs, the older rows and folders are deleted. Each installed pack folder gets a `lessons.json` copied from the manifest, which `isLessonInstalled()` reads.

**Why:** With one row per pack, queueing an update resets the row and the pack's lessons disappear until the new version finishes, which can be days on a phone that waits for Wi-Fi. `isLessonInstalled()` must also work offline after a restart, when the manifest cannot be fetched, and `pack_install` (TDD 2.6) has no column for the lesson list.

**Rejected:**
- One row per pack, reset on update: lessons go missing during an update.
- A `lessons` column in a new migration: other stories in the same level may add migration 2, and the lesson list belongs to the pack version already on disk.
- Caching the whole manifest on disk: a newer manifest could list different lessons from the version actually installed.

**Impact:**
- Look up a pack's row by `pack_id` and `version`, or filter on `status = 'installed'`. Never assume one row per `pack_id`.
- `downloadStatus().items` shows the newest version of each id.
- The model's row has `path` equal to `modelFile()`'s URI; that is how a row is known to be the model when the manifest is unavailable.
- `lessons.json` is a reserved name inside a pack folder; a pack zip must not contain it.
