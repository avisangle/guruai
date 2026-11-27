# D-GURU-55: Check new takes against the existing takes' 5th percentile of pitch
**Status:** Accepted
**Date:** 2026-11-27
**Issue:** GURU-55
**Confluence:** none

**Decision:** `tools/pitch_check.py` measures each take's median voiced pitch (autocorrelation, 40 ms frames, 80 to 600 Hz) and flags a new take only when it is below the 5th percentile of the existing takes' pitch. Low side only.

**Why:** GURU-40 found 7 of 114 new takes pitched like an adult, all below the existing takes' range (206 Hz); none were found above it.

**Rejected:**
- A fixed Hz band: drifts if the catalogue's voice is ever re-measured.
- Listening alone: in GURU-40 the owner heard that some takes sounded adult but could not name which.
- librosa pYIN: not in the venv. The owner approved the 7 takes re-voiced after this method flagged them.

**Impact:** The cut is relative to the shipped takes. A flagged take is re-voiced and listened to, never shipped on the number alone, and an unflagged take still gets the listen-through.
