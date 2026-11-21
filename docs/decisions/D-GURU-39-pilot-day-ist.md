# D-GURU-39: Pilot weeks count a session by its IST calendar date, and the labelling sample is drawn per session id
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-39
**Confluence:** none

**Decision:** `tools/pilot_metrics` dates a session by its `started_at` converted to IST (UTC+05:30) before working out its pilot week. The labelling sheet puts a session in the sample when a SHA-256 hash of a fixed seed and its session id falls in the lowest 20%, instead of drawing 20% of the current session list.

**Why:** Pilot families are in India, and the app's own day for mastery and revision is the phone's local day (`localDay` in `app/src/learning/mastery.ts`). Summaries store UTC (`toISOString`), so a session started before 05:30 IST would land on the previous UTC date and, at a week boundary, in the previous pilot week. The issue asks for a seeded sample that later runs keep. Drawing 20% of the whole list again re-draws it whenever new summaries arrive, and sessions already hand-labelled would drop out. A draw from the session id alone is the same on every run and does not depend on which other sessions exist.

**Rejected:**
- UTC calendar dates: shifts early-morning IST sessions into the previous day or week.
- `random.Random(seed).sample` over the session list, kept stable by reading back the previous sheet: depends on the old sheet being passed in every time, and grows a second path for the same rule.

**Impact:**
- Pilot week and "3 or more sessions in a week" use IST dates. If the pilot ever includes families outside IST, replace the fixed offset with each device's zone, which summaries do not carry today.
- Changing `SEED` or `RATE` in `tools/pilot_metrics/sheet.py` changes which sessions are sampled. A clip with a label filled in `--labels` stays in the sheet and its label counts in the report whatever the draw, so hand-labelling work is never dropped.
- `--r2` downloads clips only for sessions `sheet.sampled` picks, so a changed draw needs a fresh `--r2` run before its new sessions can be labelled.
