// Tests only: the Db interface over an in-memory better-sqlite3 database.
import Database from 'better-sqlite3';

import type { Db, SqlParam } from './db';

// better-sqlite3 rejects booleans; expo-sqlite binds them as 1/0.
const bind = (params: SqlParam[]) => params.map((p) => (typeof p === 'boolean' ? Number(p) : p));

export function createTestDb(): Db {
  const db = new Database(':memory:');
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      db.prepare(sql).run(bind(params));
    },
    all<T>(sql: string, params: SqlParam[] = []) {
      return db.prepare(sql).all(bind(params)) as T[];
    },
    get<T>(sql: string, params: SqlParam[] = []) {
      return (db.prepare(sql).get(bind(params)) as T | undefined) ?? null;
    },
    transaction<T>(fn: () => T) {
      return db.transaction(fn)();
    },
  };
}
