# D-GURU-6: Uploads go through a Worker that hands out 15-minute presigned PUT links, gated by an app key and a per-device rate limit
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-6
**Confluence:** none

**Decision:** M1 has no accounts. The upload Worker (`workers/upload/`) trusts a random device id plus the `x-guru-app` header matching the `APP_KEY` secret, limits each device id to 30 requests a minute, and only hands out presigned R2 PUT links valid 15 minutes. It never reads, lists or returns stored objects. A presigned link signs only the method, key and expiry (`host` is the one signed header); `bytes` and `type` are checked when the link is issued.

**Why:** A pilot needs uploads before there is any login. Presigned PUTs let the phone write straight to R2 while the Worker stays tiny and never sees a child's audio, and a write-only Worker cannot leak what is already stored. The app key ships inside the APK, so it only keeps casual traffic out; the real limits are the short link life, the per-device rate, the fixed key layout and the file caps. The device id is chosen by the client, so someone holding the key can rotate ids to get past the per-device rate; accepted for a closed pilot, and the reason to replace this trust model when accounts arrive. Signing `content-length` and `content-type` would make R2 enforce the caps, but GURU-6's tests re-sign links with aws4fetch defaults, which drop those headers, so links sign `host` only.

**Rejected:**
- A public-write bucket: anyone could fill it.
- Supabase (or any login) in M1: a login and a backend before the pilot.
- Long-lived links: a leaked link stays usable.
- Signing `content-length`/`content-type` into the link: stronger caps, but conflicts with the GURU-6 test contract; revisit with the tests if abuse appears.

**Impact:**
- No Worker endpoint reads, lists or heads the bucket, or returns stored contents; admin reads happen in the Cloudflare dashboard or with `wrangler r2`.
- Upload keys stay `uploads/<device_id>/<child_code>/<session_id>/<name>`, built only from validated ids, the 4-letter child code and a `[a-z0-9-]+.(wav|json)` name. Nothing with a child's name goes in a key or body.
- Links stay presigned PUTs with at most a 15-minute expiry.
- When accounts arrive (M2), replace the app key and device-id trust rather than adding to them.
