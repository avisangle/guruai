# D-GURU-2: The content validator is TypeScript that Node runs directly
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-2
**Confluence:** none

**Decision:** `app/src/content/validate.ts` is imported by `app/scripts/build-content.mjs` and run by Node 22's built-in type stripping, with no build step. Its relative imports carry the `.ts` extension, which `app/tsconfig.json` allows through `allowImportingTsExtensions`.

**Why:** Jest tests and the build must run the same checks. Node's ESM loader does not resolve extensionless paths, and the app has no `tsx`, `ts-node` or bundler for scripts; type stripping needs only the Node that is already installed.

**Rejected:**
- A JavaScript copy of the validator for the build: two copies drift.
- Adding `tsx` or `esbuild` as a dev dependency: a new tool for one import.
- `"type": "module"` in `app/package.json` to silence Node's module-type warning: changes how every other `.js` config file in the app is loaded. The npm script passes `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` instead.

**Impact:**
- `validate.ts` and every file it imports at runtime use only erasable TypeScript (no `enum`, `namespace`, parameter properties) and `.ts` import paths, and import nothing that reaches React Native or Expo. Type-only imports use `import type`.
- Data the validator needs from JSON (tokens, prompts) is read by the build script and passed in, not imported by `validate.ts`.
