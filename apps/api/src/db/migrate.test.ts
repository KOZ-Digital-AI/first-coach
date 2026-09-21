import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from './database';
import { MIGRATIONS_DIR, migrate } from './migrate';

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

let tmp: string;
let dir: string;
let dbFile: string;
let opened: Database[];
let savedEnv: string | undefined;
let savedCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'migrate-test-'));
  dir = join(tmp, 'migrations');
  mkdirSync(dir);
  dbFile = join(tmp, 'test.db');
  opened = [];
  savedEnv = process.env.APP_DB_PATH;
  savedCwd = process.cwd();
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedEnv === undefined) delete process.env.APP_DB_PATH;
  else process.env.APP_DB_PATH = savedEnv;
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

function open(path: string = dbFile): Database {
  const db = openDatabase(path);
  opened.push(db);
  return db;
}

function write(name: string, content: string | Uint8Array): void {
  writeFileSync(join(dir, name), content);
}

function all<T>(db: Database, sql: string): T[] {
  return db.query(sql).all() as T[];
}

function tableNames(db: Database): string[] {
  return all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
}

function migrationRows(db: Database): MigrationRow[] {
  return all<MigrationRow>(
    db,
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`non-Error thrown: ${String(e)}`);
  }
  throw new Error('expected function to throw, but it returned normally');
}

const CREATE_A = 'CREATE TABLE a (id INTEGER PRIMARY KEY);\n';
const CREATE_B = 'CREATE TABLE b (id INTEGER PRIMARY KEY);\n';
const CREATE_C = 'CREATE TABLE c (id INTEGER PRIMARY KEY);\n';

describe('migrate', () => {
  test('applies sample migrations written out of numeric order and records them', () => {
    write('002_b.sql', CREATE_B);
    write('001_a.sql', CREATE_A);
    write('README.md', 'not a migration');
    write('notes.txt', 'also not a migration');
    const db = open();

    const applied = migrate(db, dir);

    expect(applied).toEqual([1, 2]);
    expect(tableNames(db)).toEqual(['a', 'b', 'schema_migrations']);
    const rows = migrationRows(db);
    expect(rows.map((r) => [r.version, r.name])).toEqual([
      [1, '001_a'],
      [2, '002_b'],
    ]);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.applied_at.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(row.applied_at))).toBe(false);
    }
  });

  test('stores the sha256 of the raw file bytes as the checksum', () => {
    write('001_a.sql', CREATE_A);
    const db = open();

    migrate(db, dir);

    const expected = createHash('sha256')
      .update(readFileSync(join(dir, '001_a.sql')))
      .digest('hex');
    expect(migrationRows(db)[0]?.checksum).toBe(expected);
  });

  test('re-running applies nothing and returns []', () => {
    write('001_a.sql', CREATE_A);
    write('002_b.sql', CREATE_B);
    const db = open();
    migrate(db, dir);

    expect(migrate(db, dir)).toEqual([]);
    expect(migrationRows(db)).toHaveLength(2);
  });

  test('re-running after closing and reopening the file database is a no-op', () => {
    write('001_a.sql', CREATE_A);
    write('002_b.sql', CREATE_B);
    const first = open();
    migrate(first, dir);
    first.close();

    const second = open();

    expect(migrate(second, dir)).toEqual([]);
    expect(migrationRows(second).map((r) => r.version)).toEqual([1, 2]);
  });

  test('a migration added later is the only one applied', () => {
    write('001_a.sql', CREATE_A);
    write('002_b.sql', CREATE_B);
    const db = open();
    migrate(db, dir);
    write('003_c.sql', CREATE_C);

    expect(migrate(db, dir)).toEqual([3]);
    expect(tableNames(db)).toEqual(['a', 'b', 'c', 'schema_migrations']);
    expect(migrationRows(db).map((r) => r.version)).toEqual([1, 2, 3]);
  });

  test('throws when an applied file content was edited', () => {
    write('001_a.sql', CREATE_A);
    const db = open();
    migrate(db, dir);
    write('001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);\n');

    expect(() => migrate(db, dir)).toThrow(
      'checksum mismatch for applied migration 001_a.sql: file was edited after it was applied',
    );
  });

  test('throws when an applied file differs only by bytes (LF to CRLF)', () => {
    write('001_a.sql', CREATE_A);
    const db = open();
    migrate(db, dir);
    write('001_a.sql', CREATE_A.replace('\n', '\r\n'));

    expect(() => migrate(db, dir)).toThrow(
      'checksum mismatch for applied migration 001_a.sql: file was edited after it was applied',
    );
  });

  test('throws on a gap in the version sequence', () => {
    write('001_a.sql', CREATE_A);
    write('003_c.sql', CREATE_C);
    const db = open();

    expect(() => migrate(db, dir)).toThrow(
      'migration gap: expected version 2 but found 003_c.sql',
    );
  });

  test('throws when the sequence does not start at 001', () => {
    write('002_b.sql', CREATE_B);
    const db = open();

    expect(() => migrate(db, dir)).toThrow(
      'migration gap: expected version 1 but found 002_b.sql',
    );
  });

  test('throws when an unapplied lower version exists although a higher one was applied', () => {
    write('001_a.sql', CREATE_A);
    write('002_b.sql', CREATE_B);
    write('003_c.sql', CREATE_C);
    const db = open();
    migrate(db, dir);
    db.run('DELETE FROM schema_migrations WHERE version = 2');

    expect(() => migrate(db, dir)).toThrow(
      'applied migrations are not contiguous: missing version 2 before 3',
    );
  });

  test('throws on a duplicate version', () => {
    write('001_a.sql', CREATE_A);
    write('001_other.sql', CREATE_B);
    const db = open();

    expect(() => migrate(db, dir)).toThrow(
      'duplicate migration version 1: 001_a.sql and 001_other.sql',
    );
  });

  test('throws when the file of an applied version is missing', () => {
    write('001_a.sql', CREATE_A);
    write('002_b.sql', CREATE_B);
    const db = open();
    migrate(db, dir);
    unlinkSync(join(dir, '002_b.sql'));

    expect(() => migrate(db, dir)).toThrow(
      `applied migration 002_b has no file in ${dir}`,
    );
  });

  test('throws when an applied migration is renamed with identical bytes', () => {
    write('001_a.sql', CREATE_A);
    const db = open();
    migrate(db, dir);
    renameSync(join(dir, '001_a.sql'), join(dir, '001_b.sql'));

    expect(() => migrate(db, dir)).toThrow(
      'applied migration 1 was renamed from 001_a to 001_b',
    );
  });

  test('throws on a non-conforming *.sql file name', () => {
    write('001_a.sql', CREATE_A);
    write('2_bad.sql', CREATE_B);
    const db = open();

    expect(() => migrate(db, dir)).toThrow(
      'migration file name "2_bad.sql" does not match NNN_name.sql',
    );
  });

  test('throws on an empty file and names it', () => {
    write('001_x.sql', '');
    const db = open();

    expect(() => migrate(db, dir)).toThrow('migration 001_x.sql is empty');
    expect(tableNames(db)).toEqual(['schema_migrations']);
    expect(migrationRows(db)).toEqual([]);
  });

  test('throws on a whitespace-only file and names it', () => {
    write('001_x.sql', '  \n\t\n');
    const db = open();

    expect(() => migrate(db, dir)).toThrow('migration 001_x.sql is empty');
  });

  test('applies migrations in numeric order, not directory order (12 files written in reverse)', () => {
    for (let n = 12; n >= 1; n--) {
      const name = `${String(n).padStart(3, '0')}_step${n}.sql`;
      write(
        name,
        n === 1
          ? 'CREATE TABLE applied_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL);\n' +
              'INSERT INTO applied_log (n) VALUES (1);\n'
          : `INSERT INTO applied_log (n) VALUES (${n});\n`,
      );
    }
    const db = open();

    const applied = migrate(db, dir);

    const expected = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(applied).toEqual(expected);
    expect(
      all<{ n: number }>(db, 'SELECT n FROM applied_log ORDER BY seq').map((r) => r.n),
    ).toEqual(expected);
    expect(migrationRows(db).map((r) => r.version)).toEqual(expected);
  });

  test('a migration containing BEGIN/COMMIT fails with a wrapped error and records nothing', () => {
    write('001_a.sql', CREATE_A);
    write(
      '002_tx.sql',
      'CREATE TABLE t (x INTEGER);\nBEGIN;\nINSERT INTO t (x) VALUES (1);\nCOMMIT;\n',
    );
    const db = open();

    const err = thrown(() => migrate(db, dir));

    expect(err.message).toContain('migration 002_tx.sql failed: ');
    expect(err.message).toContain('002_tx.sql');
    expect(err.message.toLowerCase()).toContain('ended the surrounding transaction');
    expect(err.cause).toBeDefined();
    expect(migrationRows(db).map((r) => r.version)).toEqual([1]);
    expect(migrationRows(db).some((r) => r.version === 2)).toBe(false);
  });

  test('a failing migration rolls back completely and keeps earlier data intact', () => {
    write(
      '001_seed.sql',
      'CREATE TABLE seed (id INTEGER PRIMARY KEY, label TEXT NOT NULL);\n' +
        "INSERT INTO seed (label) VALUES ('kept');\n",
    );
    write(
      '002_bad.sql',
      'CREATE TABLE new_t (id INTEGER PRIMARY KEY);\n' +
        'INSERT INTO new_t (id) VALUES (1);\n' +
        'INSERT INTO missing_table (id) VALUES (1);\n',
    );
    const db = open();

    const err = thrown(() => migrate(db, dir));

    expect(err.message).toContain('migration 002_bad.sql failed: ');
    expect(err.message).toContain('missing_table');
    expect(err.cause).toBeInstanceOf(Error);
    expect(tableNames(db)).toEqual(['schema_migrations', 'seed']);
    expect(all<{ label: string }>(db, 'SELECT label FROM seed')).toEqual([{ label: 'kept' }]);
    expect(migrationRows(db).map((r) => r.version)).toEqual([1]);
  });

  test('a failed migration can be corrected and applied on the next run', () => {
    write('001_a.sql', 'INSERT INTO nowhere (id) VALUES (1);\n');
    const db = open();
    expect(() => migrate(db, dir)).toThrow('migration 001_a.sql failed: ');

    write('001_a.sql', CREATE_A);

    expect(migrate(db, dir)).toEqual([1]);
    expect(tableNames(db)).toEqual(['a', 'schema_migrations']);
  });

  test('an empty directory returns [] and creates only schema_migrations', () => {
    const db = open();

    expect(migrate(db, dir)).toEqual([]);
    expect(tableNames(db)).toEqual(['schema_migrations']);
  });

  test('a missing directory returns [] and creates only schema_migrations', () => {
    const db = open();

    expect(migrate(db, join(tmp, 'does-not-exist'))).toEqual([]);
    expect(tableNames(db)).toEqual(['schema_migrations']);
  });

  test('MIGRATIONS_DIR is src/db/migrations next to the runner', () => {
    expect(MIGRATIONS_DIR).toBe(resolve(import.meta.dir, 'migrations'));
    expect(MIGRATIONS_DIR.endsWith('src/db/migrations')).toBe(true);
  });
});

describe('openDatabase', () => {
  test('a file database reads back foreign_keys, busy_timeout and WAL journal mode', () => {
    const db = open();

    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  test('foreign key enforcement rejects an orphan insert', () => {
    const db = open();
    db.run('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    db.run('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))');

    expect(() => db.run('INSERT INTO child (parent_id) VALUES (999)')).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  test(':memory: works and enforces foreign keys', () => {
    const db = open(':memory:');

    expect(db.query('SELECT 1 AS one').get()).toEqual({ one: 1 });
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  test('APP_DB_PATH is honoured (read at call time) and its parent directory is created', () => {
    const envPath = join(tmp, 'nested', 'deeper', 'env.db');
    process.env.APP_DB_PATH = envPath;

    const db = openDatabase();
    opened.push(db);

    expect(existsSync(envPath)).toBe(true);
    db.run('CREATE TABLE probe (id INTEGER)');
    expect(tableNames(db)).toEqual(['probe']);
  });

  test('an explicit path argument wins over APP_DB_PATH', () => {
    const envPath = join(tmp, 'from-env', 'env.db');
    const explicit = join(tmp, 'from-arg', 'arg.db');
    process.env.APP_DB_PATH = envPath;

    opened.push(openDatabase(explicit));

    expect(existsSync(explicit)).toBe(true);
    expect(existsSync(envPath)).toBe(false);
  });

  for (const [label, value] of [
    ['unset', undefined],
    ['empty', ''],
  ] as const) {
    test(`defaults to ./data/app.db relative to the cwd when APP_DB_PATH is ${label}`, () => {
      if (value === undefined) delete process.env.APP_DB_PATH;
      else process.env.APP_DB_PATH = value;
      process.chdir(tmp);

      opened.push(openDatabase());

      expect(existsSync(join(tmp, 'data', 'app.db'))).toBe(true);
    });
  }
});
