# D-GURU-15: A failed speed check that is not out of memory stores nothing
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-15
**Confluence:** none

**Decision:** `runSpeedCheck` (`app/src/asr/speedCheck.ts`) stops at the first judge run that reports an error. If the error text reads as out of memory (Java `OutOfMemoryError`, ONNX Runtime "Failed to allocate", `bad_alloc`, "out of memory"), it stores `oom` with no p90. Any other error stores nothing: `judge_check` stays null, the phone reads as `ready`, and the next app start measures again. The p90 is nearest-rank over 5 timed runs, so with 5 runs it is the slowest one.

**Why:** `oom` and `slow` are verdicts about the phone and are never re-measured without the Settings rerun, so they must only be stored when the phone itself is the cause. A non-memory failure ("model not loaded", a bad model file, a missing clip) says nothing about the phone, and storing a verdict would lock a capable phone into "parent helps". Nearest-rank keeps one slow run in five enough to fail the 1 s target for 90% of answers, which is the PRD constraint.

**Rejected:**
- Store `slow` on any failure: would push a working phone to "parent helps" over a transient fault, with no automatic retry.
- Skip failed runs and time the rest: timings next to a failing judge do not describe the phone, and a run that fails fast would pull the p90 down.
- Interpolated percentile: with 5 runs it would let a single 1.5 s run pass under 1 s.

**Impact:** Only an out-of-memory error text may store `oom`; a new failure kind that should mark the phone must extend the `OOM` pattern in `speedCheck.ts`, not store a verdict from the generic error path. Code that reads `judge_check` must treat null as "not measured yet", never as a failure. The root layout (`app/src/app/_layout.tsx`) calls `runSpeedCheck` at every app start and again once the start-up downloads settle; it is a no-op without the model or once a result is stored. A screen that shows `judgeReadiness()` also subscribes with `subscribeJudgeCheck`, which fires whenever a result is stored, because the first check usually ends after the screen's first read.
