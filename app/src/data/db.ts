// Synchronous SQLite access behind a small interface, so tests run the same SQL
// through better-sqlite3 (testDb.ts).
import { openDatabaseSync } from 'expo-sqlite';

export type SqlParam = string | number | boolean | null;

export type Db = {
  exec(sql: string): void;
  run(sql: string, params?: SqlParam[]): void;
  all<T>(sql: string, params?: SqlParam[]): T[];
  get<T>(sql: string, params?: SqlParam[]): T | null;
  /** Runs fn in one transaction and returns its result; rolls back if it throws. */
  transaction<T>(fn: () => T): T;
};

export function openDb(): Db {
  const db = openDatabaseSync('guru.db');
  return {
    exec(sql) {
      db.execSync(sql);
    },
    run(sql, params = []) {
      db.runSync(sql, params);
    },
    all<T>(sql: string, params: SqlParam[] = []) {
      return db.getAllSync<T>(sql, params);
    },
    get<T>(sql: string, params: SqlParam[] = []) {
      return db.getFirstSync<T>(sql, params);
    },
    transaction<T>(fn: () => T) {
      let result!: T;
      db.withTransactionSync(() => {
        result = fn();
      });
      return result;
    },
  };
}

export function now(): string {
  return new Date().toISOString();
}
