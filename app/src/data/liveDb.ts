// The app's one SQLite connection, opened and migrated on first use.
import { openDb, type Db } from './db';
import { migrate } from './migrations';

let db: Db | undefined;

export function liveDb(): Db {
  if (!db) {
    db = openDb();
    migrate(db);
  }
  return db;
}
