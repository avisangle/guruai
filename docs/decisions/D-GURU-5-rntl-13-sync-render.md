# D-GURU-5: Component tests use React Native Testing Library 13 (synchronous render)
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-5
**Confluence:** none

**Decision:** The app's component tests use `@testing-library/react-native` 13 with `react-test-renderer` 19.3.0, not 14. `app/package.json` carries an `overrides` entry so expo-router's optional peer range (`>= 14.0.0`) accepts 13, and a plain `npm install` / `npm ci` resolves without flags.

**Why:**
- RNTL 14 made `render`, `fireEvent` and `renderHook` return promises. The GURU-5 tests (`app/src/ui/ui.test.tsx`, written first under TDD) call `render(...)` and then query `screen` on the next line, which only works with 13's synchronous render. With 14 every rendering test fails with "`render` function has not been called".
- Expo SDK 58's expo-router lists RNTL as an optional peer (`>= 14.0.0`), so without the override npm stops with ERESOLVE.

**Rejected:**
- RNTL 14 (the version SDK 58 pairs with): needs every component test rewritten with `await render(...)`; the tests are fixed input to /implement, so that is a /revise of GURU-5, not an implementation choice.
- `legacy-peer-deps=true` in `.npmrc`: turns off peer checks for every package, not just this one.

**Impact:** Write component tests against the RNTL 13 API (synchronous `render`, `fireEvent`, `screen`). Moving to 14 means rewriting those tests with `await` and removing the `overrides` entry and `react-test-renderer` in the same change.
