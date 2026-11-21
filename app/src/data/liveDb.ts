// The app's one SQLite connection, opened and migrated on first use.
import { openDb, type Db } from './db';
import { migrate } from './migrations';

let db: Db | undefined;

export function liveDb(): Db {
  if (!db) {
    const opened = openDb();
    migrate(opened); // cached only once migrated, so a failure retries
    db = opened;
  }
  return db;
}
