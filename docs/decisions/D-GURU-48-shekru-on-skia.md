# D-GURU-48: Shekru is drawn with Skia, bound to the rig's shared values on the UI thread
**Status:** Accepted
**Date:** 2026-11-27
**Issue:** GURU-48
**Confluence:** none

**Decision:** `app/src/shekru/Shekru.tsx` draws Shekru on one `@shopify/react-native-skia` canvas (2.14.0, the version Expo SDK 58 pins). `app/src/shekru/skiaArt.ts` walks `shekru.art.json` into a draw list, and every group a rig value drives becomes a Skia `Group` whose `matrix` and `opacity` props are derived values of that part's shared value. The `react-native-svg` renderer is deleted; it survives only at git tag `shekru-svg-v1`. On web Shekru is not drawn: `Shekru.web.tsx` renders an empty box of the same size.

**Why:**
- The SVG renderer wrote up to 78 animated native groups per rig step and redrew the whole SVG. After the 20 steps a second cap (D-GURU-44-shekru-frame-cap) the Nord CE 3 still measured child home idle at 90 to 110% CPU with 43% of frames late (`bug.md`, 2026-11-23 entry), against a bar of 60%.
- Skia takes reanimated shared and derived values as component props. It records the drawing once, and one mapper on the UI thread pushes changed values into that recording and redraws the canvas. A rig step therefore costs no React render and no per-part native view update.
- The art stays vector, so it is sharp at any `size` a host passes, and `shekru.art.json`, the rig and `useShekruRig` are used unchanged.
- A part's opacity goes on `Group opacity`, which multiplies the alpha of each paint under the group. SVG fades a group as one flattened layer, so where leaves overlap inside a part that is partly transparent, the lower leaf shows through the upper one during the fade. Only 30 fx parts ever fade (waves, think dots and cloud, hint card, sneeze, nut, notes, confetti); the body parts are always at opacity 1 or hidden. The exact SVG look needs an offscreen layer per group on every step, which is the cost this change removes.
- A hidden part (`d: 'none'`) is drawn at opacity 0. Skia multiplies nested group opacities, so a hidden part hides the bound parts inside it, as SVG `display: none` did.
- The hint letter is Skia `Text` in the system `sans-serif` at weight 800, centred by its advance width. `Text` draws with one typeface and does no shaping or font fallback, and lessons pass a picture emoji as the letter (`app/src/content/pictures.ts`). When the font has no glyph for the text, the slot draws a Skia `Paragraph`, which shapes and falls back to system fonts. `Paragraph` ignores the opacity of the groups above it, so it sits in a layer whose opacity is the product of the opacities of the parts above the slot (today only `fx-hint-card`).
- Cost: a new native dependency, and a larger app. Skia's documentation gives about 4 MB of download per arm64 device from an app bundle and about 41 MB on a release APK that carries every architecture, which is what the `preview` and `development` profiles in `app/eas.json` build. This PR builds no APK, so the change for this app is not measured here (`pending.md`).

**Rejected:**
- Parts pre-rendered to bitmaps on one flattened native layer: needs a re-export at every screen density and every `size`, and loses sharp scaling when `LessonPlayer` switches between the centre and big sizes.
- One `Animated.View` per part: keeps 78 or more native views in the hierarchy to lay out and composite on each step, and each view would still need its SVG paths drawn inside it.
- A Skia layer (`Group layer`) per part for exact SVG group opacity: one offscreen buffer per bound group on every step.
- Always drawing the hint letter with `Paragraph`: every letter would pay for the layer, and the plain letter needs neither shaping nor fallback.
- Loading CanvasKit so Skia draws on web: needs a custom entry file in place of `expo-router/entry` and a WebAssembly download of about 2.9 MB before the first render. Android is the shipped target.

**Impact:**
- Shekru's drawing reads the rig only through shared values on the UI thread, never through React state. No `useState`, `scheduleOnRN` or `runOnJS` in the drawing path; `Shekru` commits once per mount and again only when `size`, `hintLetter` or `values` change.
- A bound group's props come from `partMatrix` and `partOpacity` in `skiaArt.ts`. The rig's `[a, b, c, d, e, f]` is SVG `matrix()` order and maps to the row-major 3x3 `[a, c, e, b, d, f, 0, 0, 1]`.
- Hiding relies on opacity multiplying down the tree. Anything drawn inside a part that ignores group paint properties (`Paragraph`, `Picture`, `ImageSVG`) must take its opacity from the parts above it, as the hint letter fallback does.
- `skiaArt.ts` reads only the leaf attributes the art uses today (`d`, `fill`, `stroke`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin`, `cx`, `cy`, `r`, `rx`, `ry`) and assumes a group no rig value drives has no attributes. Art that adds an attribute (a fill rule, a gradient, a group-level paint) needs it added there and in `Shekru.test.tsx`.
- Skia paths are parsed once per module load. Do not build paths, fonts or paragraphs in a per-step path.
- A module that imports `@shopify/react-native-skia` needs a `.web.tsx` twin that does not, or the web bundle fails at load.
- D-GURU-44-shekru-frame-cap stands: the rig steps only through `frameGate`, and the renderer adds no per-frame path of its own. Only that record's sentence that Shekru stays on `react-native-svg` is overtaken by this one.
