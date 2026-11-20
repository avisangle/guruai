# D-GURU-18: Children's answers are judged only on the phone
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-18
**Confluence:** none

**Decision:** A child's spoken answer is judged only on the phone, by the closed-set IndicConformer judge (`app/src/asr/judge.ts`, `lessonJudge.ts`). There is no cloud judge and no third-party speech API in the lesson path.

**Why:** Answer audio is a child's voice; judging on the phone keeps it on the phone unless a parent consents to clip upload. The judge also keeps working offline and costs nothing per answer as the number of children grows.

**Rejected:** A cloud judge (PRD Architecture): free usage tiers run out as users grow, and every answer's audio would leave the phone.

**Impact:**
- `judgeClip` and anything it calls stay on-device: no network call in the answer path. A cloud speech provider may appear only in offline tooling (`tools/stt_bench`) on consented clips.
- The judge only classifies (`correct`, `meaning` with language, `wrong`, `silent`); the engine applies the language rules (D-GURU-10-language-design).
