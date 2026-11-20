// The app's database connection, opened and migrated on first use.
import { openDb, type Db } from './db';
import { migrate } from './migrations';

let db: Db | null = null;

export function appDb(): Db {
  if (!db) {
    const opened = openDb();
    migrate(opened);
    db = opened;
  }
  return db;
}
