# D-GURU-23: A pack's version follows its zip's SHA-256; publish checks R2, not the lock
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-23
**Confluence:** none

**Decision:** `build-packs.mjs` builds each pack zip deterministically (entries sorted, a fixed local-time timestamp, mp3 stored uncompressed) and uses the zip's own SHA-256 as the content hash in `content/packs.lock.json`. `nextVersions` bumps a pack's version only when that hash changes. `--publish` downloads every file the manifest lists from R2 before it uploads anything. If a file is missing, it is uploaded. If it is there with the same bytes, it is skipped. If it is there with different bytes, the publish stops and nothing is uploaded.

**Why:** The manifest's `sha256` must match the bytes already in R2 under an unchanged version, or every phone fails the checksum. When the lock hash is the zip hash, an unchanged version always means byte-identical zips. Checking R2 itself catches a lock that is behind R2, for example when one machine published and never committed its lock.

**Rejected:**
- Hashing the source mp3s and clips: a zip-format change (fflate upgrade, compression level) would change the zip's bytes but keep its version, so the published `sha256` would stop matching.
- Recording "published" in the lock: the lock in git can be behind R2, and the publish would then overwrite an immutable file.
- A UTC timestamp in the zip: fflate writes DOS times from local-time fields, so the zip's bytes would depend on the build machine's time zone.

**Impact:**
- The pack zip build must stay deterministic. Any change to how zips are written moves every pack to a new version, which is correct. Never reuse a version for different bytes.
- Every `build:packs` run writes `content/packs.lock.json`. Commit the lock after a publish, so the next build starts from the versions that are in R2.
- `--publish` downloads the model (about 137 MB) on every run to check it, because wrangler has no metadata-only `head` command for R2 objects.
