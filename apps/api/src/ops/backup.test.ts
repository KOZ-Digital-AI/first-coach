import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database';
import { BACKUP_FILE_PATTERN, backupDatabase, listBackups } from './backup';

let tmp: string;
let dbFile: string;
let backupDir: string;
let opened: Database[];

function open(path: string, opts?: { readonly: true }): Database {
  const db = opts ? new Database(path, opts) : openDatabase(path);
  opened.push(db);
  return db;
}

/** Source DB opened the way the app opens it (WAL, foreign keys), with a few related tables. */
function makeSource(): Database {
  const db = open(dbFile);
  // Keep new rows in the -wal file so the test proves the backup includes uncheckpointed data.
  db.run('PRAGMA wal_autocheckpoint = 0');
  db.run('CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.run(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owners(id), label TEXT)',
  );
  db.run('CREATE TABLE empty_table (id INTEGER PRIMARY KEY)');
  for (let i = 1; i <= 3; i++) db.run('INSERT INTO owners (name) VALUES (?)', [`owner ${i}`]);
  for (let i = 1; i <= 7; i++) db.run('INSERT INTO items (owner_id, label) VALUES (?, ?)', [(i % 3) + 1, `item ${i}`]);
  return db;
}

function day(n: number): Date {
  // n = 1 -> 2026-01-01, n = 20 -> 2026-01-20, n = 40 -> 2026-02-09 (UTC)
  return new Date(Date.UTC(2026, 0, n, 12, 0, 0));
}

function fileFor(n: number): string {
  const d = day(n).toISOString().slice(0, 10);
  return `first-coach-${d}.sqlite`;
}

function tableCounts(db: Database): Record<string, number> {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    out[name] = (db.query(`SELECT count(*) AS c FROM "${name}"`).get() as { c: number }).c;
  }
  return out;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'backup-test-'));
  dbFile = join(tmp, 'app.db');
  backupDir = join(tmp, 'backups');
  opened = [];
});

afterEach(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('BACKUP_FILE_PATTERN', () => {
  test('matches only first-coach-YYYY-MM-DD.sqlite', () => {
    expect(BACKUP_FILE_PATTERN.test('first-coach-2026-03-05.sqlite')).toBe(true);
    for (const bad of [
      'notes.txt',
      'first-coach-latest.txt',
      'first-coach-2026-03-05.sqlite.bak',
      'first-coach-2026-3-5.sqlite',
      'xfirst-coach-2026-03-05.sqlite',
      '.first-coach-2026-03-05.sqlite.tmp',
      'first-coach-2026-03-05.sqlite-wal',
    ]) {
      expect(BACKUP_FILE_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('backupDatabase: consistent copy', () => {
  test('creates dir recursively and names the file by UTC date', () => {
    const source = makeSource();
    const nested = join(backupDir, 'a', 'b');
    // 2026-03-05 23:30 in UTC-05:00 is already 2026-03-06 in UTC.
    const now = new Date('2026-03-05T23:30:00-05:00');

    const result = backupDatabase(source, nested, { now });

    expect(result.path).toBe(join(nested, 'first-coach-2026-03-06.sqlite'));
    expect(existsSync(result.path)).toBe(true);
    expect(result.pruned).toEqual([]);
  });

  test('backup opens, passes integrity_check and has the same row counts as the source (WAL, uncheckpointed)', () => {
    const source = makeSource();
    expect(statSync(`${dbFile}-wal`).size).toBeGreaterThan(0);

    const { path } = backupDatabase(source, backupDir, { now: day(1) });

    const copy = open(path, { readonly: true });
    expect(copy.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(tableCounts(copy)).toEqual({ empty_table: 0, items: 7, owners: 3 });
    expect(tableCounts(copy)).toEqual(tableCounts(source));
  });

  test('the copy is a snapshot: later writes to the source do not change it', () => {
    const source = makeSource();
    const { path } = backupDatabase(source, backupDir, { now: day(1) });
    source.run("INSERT INTO owners (name) VALUES ('later')");

    const copy = open(path, { readonly: true });
    expect(tableCounts(copy).owners).toBe(3);
    expect(tableCounts(source).owners).toBe(4);
  });

  test('a directory name containing a single quote works', () => {
    const source = makeSource();
    const quoted = join(backupDir, "it's a 'dir'");

    const { path } = backupDatabase(source, quoted, { now: day(1) });

    expect(path).toBe(join(quoted, fileFor(1)));
    expect(tableCounts(open(path, { readonly: true })).items).toBe(7);
  });

  test('leaves no temp file behind after success', () => {
    const source = makeSource();
    backupDatabase(source, backupDir, { now: day(1) });
    expect(readdirSync(backupDir)).toEqual([fileFor(1)]);
  });
});

describe('backupDatabase: same-day re-run', () => {
  test('does not fail and replaces the earlier backup of that day', () => {
    const source = makeSource();
    const first = backupDatabase(source, backupDir, { now: day(1) });
    source.run("INSERT INTO owners (name) VALUES ('after first backup')");

    const second = backupDatabase(source, backupDir, { now: day(1) });

    expect(second.path).toBe(first.path);
    expect(readdirSync(backupDir)).toEqual([fileFor(1)]);
    expect(tableCounts(open(second.path, { readonly: true })).owners).toBe(4);
  });

  test('a stale temp file from a crashed run does not block the backup', () => {
    const source = makeSource();
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, `.${fileFor(1)}.tmp`), 'garbage from a crashed run');

    const { path } = backupDatabase(source, backupDir, { now: day(1) });

    expect(tableCounts(open(path, { readonly: true })).owners).toBe(3);
    expect(readdirSync(backupDir)).toEqual([fileFor(1)]);
  });

  test('a failed VACUUM leaves no temp file and keeps the earlier same-day backup intact', () => {
    const source = makeSource();
    const first = backupDatabase(source, backupDir, { now: day(1) });
    const before = readFileSync(first.path);

    source.run('BEGIN'); // VACUUM cannot run inside a transaction
    expect(() => backupDatabase(source, backupDir, { now: day(1) })).toThrow();
    source.run('ROLLBACK');

    expect(readdirSync(backupDir)).toEqual([fileFor(1)]);
    expect(readFileSync(first.path).equals(before)).toBe(true);
    expect(tableCounts(open(first.path, { readonly: true })).owners).toBe(3);
  });

  test('a closed database throws and leaves only the earlier backup', () => {
    const source = makeSource();
    const first = backupDatabase(source, backupDir, { now: day(1) });
    const before = readFileSync(first.path);
    source.close();

    expect(() => backupDatabase(source, backupDir, { now: day(1) })).toThrow();

    expect(readdirSync(backupDir)).toEqual([fileFor(1)]);
    expect(readFileSync(first.path).equals(before)).toBe(true);
  });

  test('a failed backup does not prune anything', () => {
    const source = makeSource();
    for (let n = 1; n <= 5; n++) backupDatabase(source, backupDir, { now: day(n), keep: 100 });

    source.run('BEGIN');
    expect(() => backupDatabase(source, backupDir, { now: day(6), keep: 2 })).toThrow();
    source.run('ROLLBACK');

    expect(readdirSync(backupDir)).toHaveLength(5);
  });
});

describe('backupDatabase: retention', () => {
  test('keeps the 14 newest of 20 daily backups and returns the 6 oldest as pruned', () => {
    const source = makeSource();
    let last = { path: '', pruned: [] as string[] };
    const allPruned: string[] = [];
    for (let n = 1; n <= 20; n++) {
      last = backupDatabase(source, backupDir, { now: day(n) });
      allPruned.push(...last.pruned);
    }

    const kept = readdirSync(backupDir).sort();
    expect(kept).toEqual(Array.from({ length: 14 }, (_, i) => fileFor(i + 7)));
    expect(allPruned.sort()).toEqual(Array.from({ length: 6 }, (_, i) => join(backupDir, fileFor(i + 1))));
    // day 20 was the run that pruned day 6
    expect(last.pruned).toEqual([join(backupDir, fileFor(6))]);
  });

  test('pruned lists every deleted path when many are removed at once', () => {
    const source = makeSource();
    for (let n = 1; n <= 20; n++) backupDatabase(source, backupDir, { now: day(n), keep: 100 });
    expect(readdirSync(backupDir)).toHaveLength(20);

    const { pruned } = backupDatabase(source, backupDir, { now: day(21) });

    expect(pruned.sort()).toEqual(Array.from({ length: 7 }, (_, i) => join(backupDir, fileFor(i + 1))));
    expect(readdirSync(backupDir)).toHaveLength(14);
    for (const p of pruned) expect(existsSync(p)).toBe(false);
  });

  test('exactly 14 backups are all kept by default (nothing pruned)', () => {
    const source = makeSource();
    let pruned: string[] = [];
    for (let n = 1; n <= 14; n++) pruned = backupDatabase(source, backupDir, { now: day(n) }).pruned;

    expect(pruned).toEqual([]);
    expect(readdirSync(backupDir)).toHaveLength(14);
  });

  test('a custom keep is honoured', () => {
    const source = makeSource();
    for (let n = 1; n <= 5; n++) backupDatabase(source, backupDir, { now: day(n), keep: 3 });

    expect(readdirSync(backupDir).sort()).toEqual([fileFor(3), fileFor(4), fileFor(5)]);
  });

  test('a same-day re-run counts as one backup, not two', () => {
    const source = makeSource();
    for (let n = 1; n <= 14; n++) backupDatabase(source, backupDir, { now: day(n) });

    const { pruned } = backupDatabase(source, backupDir, { now: day(14) });

    expect(pruned).toEqual([]);
    expect(readdirSync(backupDir)).toHaveLength(14);
  });

  test('order is by the date in the file name, not by mtime', () => {
    const source = makeSource();
    for (let n = 1; n <= 20; n++) backupDatabase(source, backupDir, { now: day(n), keep: 100 });
    // Make mtimes run opposite to the dates: day 1 looks newest on disk, day 20 oldest.
    for (let n = 1; n <= 20; n++) {
      const t = new Date(Date.UTC(2030, 0, 1) - n * 3_600_000);
      utimesSync(join(backupDir, fileFor(n)), t, t);
    }

    backupDatabase(source, backupDir, { now: day(21) });

    expect(readdirSync(backupDir).sort()).toEqual(Array.from({ length: 14 }, (_, i) => fileFor(i + 8)));
  });

  test('a backup dated older than the retained ones is itself pruned', () => {
    const source = makeSource();
    for (let n = 10; n <= 23; n++) backupDatabase(source, backupDir, { now: day(n) });

    const { path, pruned } = backupDatabase(source, backupDir, { now: day(1) });

    expect(pruned).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(backupDir)).toHaveLength(14);
  });

  test('unrelated files and directories are never deleted or counted', () => {
    const source = makeSource();
    mkdirSync(backupDir, { recursive: true });
    const unrelated = [
      'notes.txt',
      'first-coach-latest.txt',
      'first-coach-2019-01-01.sqlite.bak',
      'first-coach-2019-1-1.sqlite',
      'first-coach-2019-01-01.sqlite-wal',
      'app.db',
    ];
    for (const f of unrelated) writeFileSync(join(backupDir, f), 'keep me');
    // A directory that happens to carry a backup-looking name, plus an ordinary one.
    mkdirSync(join(backupDir, 'first-coach-2019-01-01.sqlite'));
    writeFileSync(join(backupDir, 'first-coach-2019-01-01.sqlite', 'inner.txt'), 'keep me');
    mkdirSync(join(backupDir, 'archive'));

    let pruned: string[] = [];
    for (let n = 1; n <= 20; n++) pruned = backupDatabase(source, backupDir, { now: day(n) }).pruned;

    for (const f of unrelated) expect(readFileSync(join(backupDir, f), 'utf8')).toBe('keep me');
    expect(readFileSync(join(backupDir, 'first-coach-2019-01-01.sqlite', 'inner.txt'), 'utf8')).toBe('keep me');
    expect(statSync(join(backupDir, 'archive')).isDirectory()).toBe(true);
    // The 14 real backups are kept exactly, unaffected by the unrelated entries.
    expect(listBackups(backupDir)).toHaveLength(14);
    expect(pruned.every((p) => BACKUP_FILE_PATTERN.test(p.split('/').pop() as string))).toBe(true);
  });

  test('rejects a keep below 1 without touching the directory', () => {
    const source = makeSource();
    backupDatabase(source, backupDir, { now: day(1) });

    for (const keep of [0, -1, 1.5, Number.NaN]) {
      expect(() => backupDatabase(source, backupDir, { now: day(2), keep })).toThrow(RangeError);
    }
    expect(readdirSync(backupDir)).toEqual([fileFor(1)]);
  });
});

describe('listBackups', () => {
  test('returns only backup file names, newest first', () => {
    mkdirSync(backupDir, { recursive: true });
    for (const f of [
      'first-coach-2026-01-02.sqlite',
      'first-coach-2026-03-01.sqlite',
      'first-coach-2025-12-31.sqlite',
      'notes.txt',
      'first-coach-latest.txt',
    ]) {
      writeFileSync(join(backupDir, f), 'x');
    }
    mkdirSync(join(backupDir, 'first-coach-2027-01-01.sqlite'));

    expect(listBackups(backupDir)).toEqual([
      'first-coach-2026-03-01.sqlite',
      'first-coach-2026-01-02.sqlite',
      'first-coach-2025-12-31.sqlite',
    ]);
  });

  test('returns an empty list for a missing or empty directory', () => {
    expect(listBackups(join(tmp, 'does-not-exist'))).toEqual([]);
    mkdirSync(backupDir);
    expect(listBackups(backupDir)).toEqual([]);
  });
});
