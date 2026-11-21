# D-GURU-38: The upload queue persists deletion requests, restarts a failed pass with fresh links, and records revision intervals at answer time
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-38
**Confluence:** none

**Decision:** `app/src/upload/uploadQueue.ts` keeps a parent's "Ask to delete sent recordings" in a new `device.deletion_requested_at` column (migration 2) until the Worker accepts it. A failed link request or PUT makes the queue wait (2 s doubling, at most 60 s) and then request fresh links for what is still pending; after 6 failures in a row it stops until the next trigger (session end, app start, network change). A revision answer stores `revision_interval_days` in its event payload when it is recorded. `summary.json` names a clip only while that clip has an `upload_item` row in the same session.

**Why:** A deletion request is a privacy promise. Held only in memory, it would be lost if the app closed while the phone was offline. Retrying a single file on its old link fails once the 15-minute link expires, while fresh links always match what is pending, including items consent removed meanwhile. The interval that came due is overwritten in `item_mastery` by the same answer, so the summary cannot read it later. `upload_item` is where consent withdrawal and retention act, so checking it keeps a summary from naming a clip that will never arrive.

**Rejected:**
- An `upload_item` row of a third kind for the deletion request: TDD 2.6 fixes the kinds to `clip` and `summary`, and the request is not a file.
- Per-file retry on the existing link: breaks after link expiry, and adds a second retry path.
- Replaying events to rebuild the interval for the summary: it duplicates the mastery rules in the summary code.

**Impact:**
- Uploads stay Wi-Fi only (Ethernet counts as Wi-Fi). A deletion request may go on any connection.
- Consent is checked before each file. `consentChanged()` must be called after a consent flag is written.
- Only the device id, child code, session id and file names go in a request, key or file name. Summaries never carry a nickname, picture or age.
- The upload URL and app key are read only in `app/src/upload/client.ts` (`EXPO_PUBLIC_UPLOAD_URL`, `EXPO_PUBLIC_UPLOAD_KEY`). Without them the live queue keeps and sends nothing.
