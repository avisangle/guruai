# D-STT: The on-device judge drives the lesson; tester buttons removed
**Status:** Accepted
**Date:** 2026-11-16
**Issue:** none (owner request)
**Confluence:** none

**Decision:** When the speech model is on the phone and the mic is allowed, the judge's verdict is the child's answer (`correct`, `wrong`; `unclear` and judge errors count as `silent`). The बरोबर/चूक/शांत buttons appear only in tester tap mode (a home-screen switch, off at every launch) or when the judge cannot run (web, no model, mic denied). Clips saved while the judge decides carry `label_by: "judge"`; in tap mode the tester's tap ends the take and labels it, and the judge scores it alongside, as before.

**Why:**
- The owner asked to drop the buttons and the waiting they caused.
- Two sessions with the first child: 0 false accepts on 5 wrong quiz answers; with the everyday-word variants 7 of 8 quiz answers agree with the tester.

**Rejected:** buttons on every turn (the owner asked to remove them); two installed app versions to switch between (stale lessons in the old one, separate clip stores); a hidden "judge was wrong" tap (not asked for).

**Impact:** Clips from judge-driven sessions have no human label, so `tools/stt_bench` agreement on them only compares the bench with the phone (the bench warns). To measure the judge, run a session in tap mode with recording on. Wrong praise risk: a false accept now praises the child; watch for it in sessions.
