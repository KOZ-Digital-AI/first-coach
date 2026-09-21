import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_DB_PATH = './data/app.db';

/**
 * Opens the application SQLite database.
 *
 * Path resolution: explicit argument, else APP_DB_PATH (read at call time; an
 * empty value counts as unset), else ./data/app.db. The parent directory of a
 * file path is created; ':memory:' is accepted as-is.
 *
 * Connection settings: WAL journal, 5s busy timeout, foreign keys enforced.
 */
export function openDatabase(path?: string): Database {
  const target = path ?? (process.env.APP_DB_PATH || DEFAULT_DB_PATH);
  if (target !== ':memory:') {
    mkdirSync(dirname(resolve(target)), { recursive: true });
  }
  const db = new Database(target);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA foreign_keys = ON');
  return db;
}
