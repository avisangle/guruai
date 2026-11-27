# D-GURU-53: The app theme makes Android break text lines by glyph advances
**Status:** Accepted
**Date:** 2026-11-27
**Issue:** GURU-53
**Confluence:** none

**Decision:** The app theme (`AppTheme`) sets `android:useBoundsForWidth` to `false` (`tools:targetApi="35"`), added at prebuild by the local config plugin `app/plugins/withTextAdvanceWidth.js`, listed in `app/app.json`. Android then breaks every `TextView` line by glyph advances, the width React Native measures.

**Why:** React Native 0.88 measures a `Text` by the sum of glyph advances (`TextLayoutManager`; its `setUseBoundsForWidth` handle is declared and never called). On Android 15 and later with targetSdk 35 or higher (this app: 36), `TextView` breaks lines by glyph ink bounds unless the attribute says otherwise. Mukta and Baloo 2 Devanagari ink is wider than the advances, so any `Text` shrunk to its content gets a box one line wide and Android moves the last word to a second line (bug.md, 2026-11-25). Every chip and every button sized by its row is exposed, and patching each one does not scale. The theme reaches the text because `ReactTextView` is an `AppCompatTextView` built with `android.R.attr.textViewStyle`, attribute lookup falls through to the activity theme, `MainActivity` sets `AppTheme`, and Android applies its ink-bounds default only when the attribute resolved to nothing. Cost accepted: ink that overhangs the advance can be clipped at a text box's edge, as on Android 14 and below (about 0.5 px a side for Mukta 700 18sp, 3 to 4 px for Baloo 2 800 32sp at density 3).

**Rejected:**
- Per-component fixes for each `Text` shrunk to its content: five known cases today, and one more for every future chip or row button.
- Lowering targetSdk below 35: Google Play's target API level requirement rules it out for uploads, and it changes many other behaviours.
- A custom `android:textViewStyle`: same effect, but it replaces any `textViewStyle` the parent theme defines. It is the fallback if the plain theme item turns out not to be read.
- `textBreakStrategy` or extra padding: neither changes which width the line breaker uses.

**Impact:** Do not add per-component width workarounds for Android 15 text wrapping; if a label wraps, check first that the plugin's item is in the built theme (`res/values/styles.xml` after prebuild). A new activity or theme must inherit from `AppTheme` or set the item too. Turning on React Native's `enablePreparedTextLayout` moves text off `TextView`, so this record must be revisited before that. Conforms to D-GURU-49-android-arm-only: the setting lives in `app/app.json` through a config plugin, with no committed `android/` directory.
