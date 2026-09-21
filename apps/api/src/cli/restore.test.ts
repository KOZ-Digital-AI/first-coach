import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../db/database';
import { backupDatabase } from '../ops/backup';
import { isServerListening, main, RestoreError, restoreDatabase } from './restore';

const NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const STAMP = '20260102T030405Z';

type Counts = { owners: number; items: number; empty_table: number };

let tmp: string;
let dataDir: string;
let dbPath: string;
let backupDir: string;
let opened: Database[];
let servers: Server[];

function open(path: string): Database {
  const db = openDatabase(path);
  opened.push(db);
  return db;
}

/**
 * A DB opened the way the app opens it (WAL, foreign keys) with `owners` owners
 * and `items` items. Rows stay in the -wal file (autocheckpoint off) so backups
 * must include uncheckpointed data.
 */
function makeDb(path: string, owners: number, items: number): Database {
  const db = open(path);
  db.run('PRAGMA wal_autocheckpoint = 0');
  db.run('CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.run(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owners(id), label TEXT)',
  );
  db.run('CREATE TABLE empty_table (id INTEGER PRIMARY KEY)');
  for (let i = 1; i <= owners; i++) db.run('INSERT INTO owners (name) VALUES (?)', [`owner ${i}`]);
  for (let i = 1; i <= items; i++) db.run('INSERT INTO items (owner_id, label) VALUES (?, ?)', [(i % owners) + 1, `item ${i}`]);
  return db;
}

function countsOf(db: Database): Counts {
  const n = (table: string): number => (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  return { owners: n('owners'), items: n('items'), empty_table: n('empty_table') };
}

function countsAt(path: string): Counts {
  const db = new Database(path, { readonly: true });
  try {
    return countsOf(db);
  } finally {
    db.close();
  }
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

/** A live DB at dbPath holding `owners`/`items` rows, closed cleanly (no sidecars). */
function makeLive(owners: number, items: number): void {
  const db = makeDb(dbPath, owners, items);
  db.close();
  expect(listing(dataDir)).toEqual(['app.db']);
}

/** A backup made by the real backupDatabase from a separate source DB. */
function makeBackup(owners: number, items: number): string {
  const src = makeDb(join(tmp, 'src', 'app.db'), owners, items);
  return backupDatabase(src, backupDir, { now: NOW }).path;
}

/** Starts a short-lived TCP listener on a kernel-assigned port. */
function listen(): Promise<number> {
  const server = createServer();
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

/** A port nothing listens on: bind a kernel-assigned one, then release it. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RestoreError) return e.code;
    throw e;
  }
  throw new Error('expected a RestoreError, but the call resolved');
}

/** Asserts the live DB is exactly as it was: bytes, directory contents and row counts. */
function snapshotLive(): { expectUnchanged: (counts: Counts) => void } {
  const hash = sha(dbPath);
  const files = listing(dataDir);
  return {
    expectUnchanged(counts) {
      expect(sha(dbPath)).toBe(hash);
      expect(listing(dataDir)).toEqual(files);
      expect(countsAt(dbPath)).toEqual(counts);
    },
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'restore-test-'));
  dataDir = join(tmp, 'data');
  mkdirSync(dataDir);
  dbPath = join(dataDir, 'app.db');
  backupDir = join(tmp, 'backups');
  opened = [];
  servers = [];
});

afterEach(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('restoreDatabase: round trip', () => {
  test('a backup made by backupDatabase restores to the same rows the source had', async () => {
    const live = makeDb(dbPath, 3, 7);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const before = live.query('SELECT * FROM items ORDER BY id').all();
    const backup = backupDatabase(live, backupDir, { now: NOW }).path;

    // Damage the live DB after the backup, then "stop the server".
    live.run('DELETE FROM items');
    live.run('DELETE FROM owners WHERE id > 1');
    live.run("INSERT INTO empty_table (id) VALUES (1)");
    live.close();

    const result = await restoreDatabase({ backupFile: backup, dbPath, isServerUp: () => false, now: NOW });

    expect(result.restored).toBe(true);
    const restored = open(dbPath);
    expect(countsOf(restored)).toEqual({ owners: 3, items: 7, empty_table: 0 });
    expect(restored.query('SELECT * FROM items ORDER BY id').all()).toEqual(before);
    expect(restored.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(restored.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('restores onto a missing live DB path (fresh volume), creating the directory', async () => {
    const backup = makeBackup(2, 5);
    const fresh = join(tmp, 'fresh-volume', 'nested', 'app.db');

    const result = await restoreDatabase({ backupFile: backup, dbPath: fresh, isServerUp: () => false, now: NOW });

    expect(result.restored).toBe(true);
    expect(result.safetyCopy).toBeNull();
    expect(listing(join(tmp, 'fresh-volume', 'nested'))).toEqual(['app.db']);
    expect(countsAt(fresh)).toEqual({ owners: 2, items: 5, empty_table: 0 });
  });

  test('keeps the replaced DB as <dbPath>.pre-restore-<UTC stamp>', async () => {
    makeLive(4, 9);
    const liveBytes = readFileSync(dbPath);
    const backup = makeBackup(1, 2);

    const result = await restoreDatabase({ backupFile: backup, dbPath, isServerUp: () => false, now: NOW });

    const safety = `${dbPath}.pre-restore-${STAMP}`;
    expect(result.safetyCopy).toBe(safety);
    expect(readFileSync(safety).equals(liveBytes)).toBe(true);
    expect(countsAt(dbPath)).toEqual({ owners: 1, items: 2, empty_table: 0 });
    expect(countsAt(safety)).toEqual({ owners: 4, items: 9, empty_table: 0 });
  });
});

describe('restoreDatabase: stale WAL sidecars', () => {
  test('a leftover -wal/-shm from the old DB is gone and is not replayed onto the restored DB', async () => {
    // Simulate a crashed server: main file + -wal + -shm copied while the writer is still open.
    const crashDir = join(tmp, 'crash');
    const crashed = makeDb(join(crashDir, 'app.db'), 4, 9);
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(join(crashDir, `app.db${suffix}`), `${dbPath}${suffix}`);
    crashed.close();
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    const backup = makeBackup(1, 2);

    await restoreDatabase({ backupFile: backup, dbPath, isServerUp: () => false, now: NOW });

    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(listing(dataDir).filter((f) => f.startsWith('app.db') && !f.includes('pre-restore'))).toEqual(['app.db']);
    const restored = open(dbPath);
    expect(countsOf(restored)).toEqual({ owners: 1, items: 2, empty_table: 0 });
    expect(restored.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
  });

  test('the safety copy keeps the old -wal so its uncheckpointed rows stay recoverable', async () => {
    const crashDir = join(tmp, 'crash');
    const crashed = makeDb(join(crashDir, 'app.db'), 4, 9);
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(join(crashDir, `app.db${suffix}`), `${dbPath}${suffix}`);
    crashed.close();
    const backup = makeBackup(1, 2);

    const result = await restoreDatabase({ backupFile: backup, dbPath, isServerUp: () => false, now: NOW });

    expect(result.safetyCopy).not.toBeNull();
    expect(countsAt(result.safetyCopy as string)).toEqual({ owners: 4, items: 9, empty_table: 0 });
  });
});

describe('restoreDatabase: atomic replacement', () => {
  test('the live file is replaced by rename, never overwritten in place', async () => {
    makeLive(3, 7);
    const oldBytes = readFileSync(dbPath);
    const fd = openSync(dbPath, 'r'); // a reader that had the old file open
    try {
      const backup = makeBackup(1, 2);

      await restoreDatabase({ backupFile: backup, dbPath, isServerUp: () => false, now: NOW });

      const still = Buffer.alloc(oldBytes.length);
      readSync(fd, still, 0, still.length, 0);
      expect(still.equals(oldBytes)).toBe(true);
      expect(countsAt(dbPath)).toEqual({ owners: 1, items: 2, empty_table: 0 });
    } finally {
      closeSync(fd);
    }
  });

  test('a failure after verification leaves the live DB byte-identical and no temp file behind', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);
    // Occupy the safety-copy path with a directory so the safety copy step fails.
    mkdirSync(`${dbPath}.pre-restore-${STAMP}`);
    const snap = snapshotLive();

    await expect(
      restoreDatabase({ backupFile: backup, dbPath, isServerUp: () => false, now: NOW }),
    ).rejects.toThrow();

    // List before expectUnchanged: its row-count check opens the DB, which creates -wal/-shm.
    expect(listing(dataDir)).toEqual(['app.db', `app.db.pre-restore-${STAMP}`]);
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });
});

describe('restoreDatabase: refuses while the server is up', () => {
  test('server_up (sync probe): live DB untouched, nothing written', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);
    const snap = snapshotLive();

    const code = await codeOf(restoreDatabase({ backupFile: backup, dbPath, isServerUp: () => true, now: NOW }));

    expect(code).toBe('server_up');
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });

  test('server_up (async probe)', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);
    const snap = snapshotLive();

    const code = await codeOf(
      restoreDatabase({ backupFile: backup, dbPath, isServerUp: async () => true, now: NOW }),
    );

    expect(code).toBe('server_up');
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });

  test('the server check comes first: a missing backup file still reports server_up', async () => {
    makeLive(3, 7);
    const code = await codeOf(
      restoreDatabase({ backupFile: join(tmp, 'nope.sqlite'), dbPath, isServerUp: () => true, now: NOW }),
    );
    expect(code).toBe('server_up');
  });
});

describe('restoreDatabase: refuses bad backup files', () => {
  async function expectRefused(backupFile: string, codes: string[]): Promise<void> {
    makeLive(3, 7);
    const snap = snapshotLive();

    const code = await codeOf(restoreDatabase({ backupFile, dbPath, isServerUp: () => false, now: NOW }));

    expect(codes).toContain(code);
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  }

  test('random bytes are refused as corrupt', async () => {
    mkdirSync(backupDir);
    const file = join(backupDir, 'random.sqlite');
    writeFileSync(file, crypto.getRandomValues(new Uint8Array(8192)));
    await expectRefused(file, ['corrupt', 'integrity_failed']);
  });

  test('a real backup truncated in half is refused', async () => {
    const good = makeBackup(3, 7);
    const file = join(backupDir, 'truncated.sqlite');
    const bytes = readFileSync(good);
    writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expectRefused(file, ['corrupt', 'integrity_failed']);
  });

  test('an empty (0 byte) file is refused even though SQLite treats it as a valid empty DB', async () => {
    mkdirSync(backupDir);
    const file = join(backupDir, 'empty.sqlite');
    writeFileSync(file, '');
    await expectRefused(file, ['corrupt', 'integrity_failed']);
  });

  test('a valid SQLite file that fails PRAGMA integrity_check is refused as integrity_failed', async () => {
    // Change an index entry so the index no longer matches its table: still opens, fails integrity_check.
    mkdirSync(backupDir);
    const file = join(backupDir, 'bad-index.sqlite');
    const db = new Database(file);
    db.run('CREATE TABLE t (a TEXT)');
    db.run('CREATE INDEX i ON t (a)');
    db.run("INSERT INTO t VALUES ('needle-alpha')");
    db.run("INSERT INTO t VALUES ('needle-omega')");
    db.close();
    const buf = readFileSync(file);
    const needle = Buffer.from('needle-omega');
    let last = -1;
    for (let p = buf.indexOf(needle); p >= 0; p = buf.indexOf(needle, p + 1)) last = p;
    expect(last).toBeGreaterThan(-1);
    buf.write('needle-omeXa', last); // last occurrence is in the index page
    writeFileSync(file, buf);
    // Precondition: SQLite opens it and integrity_check reports a problem instead of throwing.
    const probe = new Database(file, { readonly: true });
    expect(probe.query('PRAGMA integrity_check').all()).not.toEqual([{ integrity_check: 'ok' }]);
    probe.close();

    await expectRefused(file, ['integrity_failed']);
  });

  test('a missing file is not_found', async () => {
    await expectRefused(join(tmp, 'does-not-exist.sqlite'), ['not_found']);
  });

  test('a directory is not_found', async () => {
    mkdirSync(backupDir);
    await expectRefused(backupDir, ['not_found']);
  });
});

describe('server probe', () => {
  test('isServerListening is false when nothing listens on the port', async () => {
    expect(await isServerListening(await freePort())).toBe(false);
  });

  test('isServerListening is true while something listens on the port', async () => {
    expect(await isServerListening(await listen())).toBe(true);
  });

  test('restoreDatabase with the default probe restores when the port is free', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);

    await restoreDatabase({ backupFile: backup, dbPath, port: await freePort(), now: NOW });

    expect(countsAt(dbPath)).toEqual({ owners: 1, items: 2, empty_table: 0 });
  });

  test('restoreDatabase with the default probe refuses when the port has a listener', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);
    const snap = snapshotLive();

    const code = await codeOf(restoreDatabase({ backupFile: backup, dbPath, port: await listen(), now: NOW }));

    expect(code).toBe('server_up');
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });
});

describe('main (CLI seam)', () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
  }

  test('no file argument is a usage error: exit 2, one usage line on stderr, nothing touched', async () => {
    makeLive(3, 7);
    const snap = snapshotLive();
    const c = io();

    const status = await main([], { env: { APP_DB_PATH: dbPath }, isServerUp: () => false, ...c });

    expect(status).toBe(2);
    expect(c.err).toHaveLength(1);
    expect(c.err[0]).toMatch(/usage/i);
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });

  test('more than one file argument is a usage error (exit 2)', async () => {
    makeLive(3, 7);
    const snap = snapshotLive();
    const c = io();

    const status = await main(['a.sqlite', 'b.sqlite'], { env: { APP_DB_PATH: dbPath }, isServerUp: () => false, ...c });

    expect(status).toBe(2);
    expect(c.err).toHaveLength(1);
    expect(c.err[0]).toMatch(/usage/i);
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });

  test('success restores APP_DB_PATH from the file argument and exits 0', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);
    const c = io();

    const status = await main([backup], { env: { APP_DB_PATH: dbPath }, isServerUp: () => false, now: NOW, ...c });

    expect(status).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out.join('\n')).toContain(dbPath);
    expect(countsAt(dbPath)).toEqual({ owners: 1, items: 2, empty_table: 0 });
  });

  test('works under NODE_ENV=production without the server-only auth secrets', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);
    const c = io();

    const status = await main([backup], {
      env: { NODE_ENV: 'production', APP_DB_PATH: dbPath, PORT: String(await freePort()) },
      now: NOW,
      ...c,
    });

    expect(status).toBe(0);
    expect(countsAt(dbPath)).toEqual({ owners: 1, items: 2, empty_table: 0 });
  });

  test('a corrupt file exits 1 with a single stderr line and leaves the live DB unchanged', async () => {
    makeLive(3, 7);
    mkdirSync(backupDir);
    const file = join(backupDir, 'garbage.sqlite');
    writeFileSync(file, crypto.getRandomValues(new Uint8Array(4096)));
    const snap = snapshotLive();
    const c = io();

    const status = await main([file], { env: { APP_DB_PATH: dbPath }, isServerUp: () => false, now: NOW, ...c });

    expect(status).toBe(1);
    expect(c.err).toHaveLength(1);
    expect(c.out).toEqual([]);
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });

  test('refuses (exit 1) when something listens on PORT from the environment', async () => {
    makeLive(3, 7);
    const backup = makeBackup(1, 2);
    const snap = snapshotLive();
    const c = io();

    const status = await main([backup], { env: { APP_DB_PATH: dbPath, PORT: String(await listen()) }, now: NOW, ...c });

    expect(status).toBe(1);
    expect(c.err).toHaveLength(1);
    expect(c.err[0]).toMatch(/server/i);
    snap.expectUnchanged({ owners: 3, items: 7, empty_table: 0 });
  });

  test('bun apps/api/src/cli/restore.ts with no arguments exits 2 and prints usage on stderr', () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
    const proc = Bun.spawnSync([process.execPath, join('apps', 'api', 'src', 'cli', 'restore.ts')], {
      cwd: repoRoot,
      env: { ...process.env, APP_DB_PATH: dbPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toMatch(/usage/i);
    expect(existsSync(dbPath)).toBe(false);
  });
});
