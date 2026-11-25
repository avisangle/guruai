# D-GURU-44: Shekru's rig steps at most 20 times a second and stops off screen; Skia is deferred
**Status:** Accepted
**Date:** 2026-11-25
**Issue:** GURU-44
**Confluence:** none

**Decision:** `SHEKRU_FPS` in `app/src/shekru/frameGate.ts` is 20. `frameGate` steps the rig once the time waiting since the last step reaches 1/20 s (with 1 ms of slack for frame-time jitter), hands the rig all of that waiting time, capped at 0.1 s, and starts again from zero. `useShekruRig`'s frame callback is inactive (`setActive(false)`) unless its screen is focused and `AppState` is `active`. Shekru stays on `react-native-svg`; moving him to Skia or one flattened native layer is deferred (`pending.md`).

**Why:**
- Each rig step writes up to 78 animated SVG groups and the whole SVG is drawn again. On the Nord CE 3 the 2026-11-25 baseline was 258 of 258 frames late, median 73 ms, 122% CPU on child home with nothing happening (`bug.md`, 2026-11-23 entry). The cost is per step, so the lowest value the issue allows (20 to 30) removes the most work: two of every three steps on a 60 Hz panel, against one of two at 30.
- 20 divides 60 Hz and 120 Hz evenly (every 3rd and every 6th display frame), so steps are evenly spaced on both. The Nord CE 3 panel is 120 Hz.
- The value was picked from the baseline, not from a measurement of the capped loop: there is no device in the build pipeline. The owner's Nord CE 3 check (GURU-44 acceptance criteria) decides whether it stays.
- Known limit: a 73 ms median frame means that phone was already stepping about 14 times a second, below any cap in the allowed range. The cap only saves work where a step takes less than 50 ms, so on that phone the idle saving may be small; the off-screen stop is what halves the work in a lesson, where child home's rig used to run underneath.
- `setActive(false)` unregisters the callback from reanimated's frame loop, so a stopped rig costs nothing. Reanimated reports no elapsed time on the first frame after `setActive(true)`, so the time spent stopped never reaches the rig.

**Rejected:**
- 30 steps a second: smoother, but half the saving on the phone that prompted the story.
- 24 or 25: not a whole number of 60 Hz frames, so steps would alternate between 2 and 3 frames apart (visible judder), or settle at 20 anyway.
- Carrying the leftover time between steps so the average rate is exactly `SHEKRU_FPS` on any panel: gives uneven spacing on 90 Hz. The simple gate steps every 5th frame there (18 a second), evenly.
- Returning early from the frame callback while off screen: the UI thread would still wake for it every display frame.
- `useIsFocused` for the focus signal: it re-renders the host screen on every focus change; `useFocusEffect` does not.
- Skia or a flattened layer now: a rewrite of the renderer and the rig's output path, not justified until the capped loop has been measured.

**Impact:**
- The rig is stepped only through `frameGate`. Do not add a second per-frame path that calls `rig.update`, and do not raise `SHEKRU_FPS` above 30 or make the gate step on every display frame without a new device measurement.
- A rig on an unfocused screen or in a backgrounded app is frozen: `setState` and `setSpeech` calls made meanwhile take effect on the first step after it resumes, and `onState` does not fire until then. Code must not wait on `onState` from a screen that may be blurred.
- `useShekruRig` calls expo-router's `useFocusEffect`, which throws outside a navigator. Every host must be rendered inside a route; a test that renders a host bare must mock the hook.
- The 0.1 s clamp lives in `frameGate`. Time beyond it is dropped, never replayed.
