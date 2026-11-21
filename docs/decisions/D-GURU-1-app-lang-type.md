# D-GURU-1: One `AppLang` type for the app's two languages, with role aliases
**Status:** Accepted
**Date:** 2026-11-21
**Issue:** GURU-1 (level 1 integration)
**Confluence:** none

**Decision:** `AppLang = 'mr' | 'en'` in `app/src/data/types.ts` is the single spelling of the app's two languages. The role names stay as aliases of it: `ParentLang` and `Medium` (data), `UiLang` (ui/i18n), `Item.target_lang` (lesson). The answer-language tag `Lang` is `AppLang | 'hi'`, since a child may answer in Hindi even though the app never teaches or speaks it.

**Why:** Three level-1 stories (GURU-2, GURU-4, GURU-5) each wrote the `'mr' | 'en'` union themselves. They matched by luck, and `_layout.tsx` already passes a `ParentLang` straight into the `UiLang` provider. Adding a third language to one of them and not the others would type-check and break at that hand-over.

**Rejected:**
- Base type in `lesson/types.ts`: `data/` is the lowest layer, `lesson/types.ts` already imports types from it, and `ui/` and `data/` would otherwise import lesson types just for a language code.
- Replacing the role names with `AppLang` everywhere: the role says what a value means (parent's screen language, child's school medium, item's target language) at its call sites; only the value set is shared.

**Impact:**
- New code typing one of the app's languages uses `AppLang` or one of its role aliases, never a literal `'mr' | 'en'` union.
- The runtime list in `content/validate.ts` (`TARGET_LANGS`) is typed `AppLang[]`.
