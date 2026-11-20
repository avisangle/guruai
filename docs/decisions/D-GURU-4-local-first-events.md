# D-GURU-4: Local-first SQLite with an append-only event log
**Status:** Accepted
**Date:** 2026-11-20
**Issue:** GURU-4
**Confluence:** none

**Decision:** The phone's SQLite database (`app/src/data/`) is the source of truth in M1. Each answer is stored as an append-only `event` row; mastery, revision and reports are derived from events, and M2 sync uploads events. Data-layer code is tested by running the real SQL in Jest through a `better-sqlite3` adapter behind the `Db` interface.

**Why:** The pilot must work offline with no login. Keeping events as the record means `item_mastery` can be rebuilt when the mastery rules change, and sync in M2 only has to ship new rows. Running the same SQL in tests means migrations and queries are checked against a real SQLite engine, not a mock that accepts any string.

**Rejected:**
- Backend-first Supabase in M1: it puts login and sync in front of the pilot.
- Firebase: a document store does not fit the relational model (children, paths, assignments, mastery per item and language), and it brings lock-in.
- Mocking `expo-sqlite` in tests: migrations and SQL would go untested.

**Impact:**
- Never write `UPDATE event` or `DELETE FROM event` in `app/src/data/`. A test scans that folder for both.
- Anything derived from answers (`item_mastery`, reports, revision) must be rebuildable from `event` rows.
- Every table has `id TEXT PRIMARY KEY` (random), `created_at` and `updated_at`.
- Schema changes go in a new migration appended in `migrations.ts`. Never edit a shipped one.
- Data code takes a `Db` argument. It never opens `expo-sqlite` directly, so tests can pass `createTestDb()`.
- `testDb.ts` imports a Node native addon, so only tests may import it.
