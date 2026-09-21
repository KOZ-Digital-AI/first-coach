import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalendarDate, Timestamp } from '../../shared/domain';
import { ClientUuid, EntityId } from '../../shared/primitives';
import { SessionEvent, TodaySession } from '../../shared/session';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '005_sessions.sql';
const FRAMEWORK_FILES = ['001_commons.sql', '002_player.sql', '003_settings.sql', '004_test_thresholds.sql'];

/** The tables this migration owns. The "own tables" test derives them from the schema and compares. */
const SESSION_TABLES = ['session_events', 'sessions'];

/** Better Auth's tables: created by its own migrator at route-register time, never by ours. */
const BETTER_AUTH_TABLES = ['user', 'session', 'account', 'verification'];

/** The contract's enums, taken from the Zod schemas (not restated): the CHECK lists must equal them. */
const EVENT_TYPES: readonly string[] = SessionEvent.shape.type.options;
const PLANNERS: readonly string[] = TodaySession.shape.planner.options;

interface ColumnShape {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1;
}

/** The exact shape of the two new tables, in declaration order. `id` of session_events is INTEGER PRIMARY KEY (rowid). */
const SESSIONS_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'player_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'date', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'planner', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'graph_version', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'items', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'finished_at', type: 'TEXT', notnull: 0, pk: 0 },
];
const EVENTS_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'player_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'client_uuid', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'type', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'item_id', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'value', type: 'REAL', notnull: 0, pk: 0 },
  { name: 'at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'received_at', type: 'TEXT', notnull: 1, pk: 0 },
];
const SESSIONS_REQUIRED = ['id', 'player_id', 'date', 'planner', 'graph_version', 'items'];
const EVENTS_REQUIRED = ['player_id', 'session_id', 'client_uuid', 'type', 'at', 'received_at'];

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:05:00.000Z';
const T2 = '2026-01-01T00:10:00.000Z';

/** Timestamp spellings the column CHECKs must refuse (the same list as 002: only canonical ms-UTC is stored). */
const BAD_TIMESTAMPS = [
  '2026-01-01T24:00:00.000Z', // hour 24: strftime round-trips it, Zod refuses it, and it is the next day's midnight
  '2026-01-01T24:59:59.999Z',
  '2026-01-01T00:00:00Z', // no milliseconds
  '2026-01-01T00:00:00.000+05:00', // an offset: must be normalised to UTC by the writer
  '2026-01-01 00:00:00.000Z', // space instead of T
  '2026-02-30T00:00:00.000Z', // no such day
  '2026-13-01T00:00:00.000Z', // no such month
  '2026-01-01T00:60:00.000Z', // no such minute
  '2026-01-01T00:00:00.000z', // lower-case z
  '2026-01-01T00:00:00.0000Z', // too many fraction digits
  '2026-01-01',
  '',
  'yesterday',
];

let tmp: string;
let four: string;
let five: string;
let withLater: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'sessions-migration-'));
  for (const dir of ['four', 'five', 'with-later']) {
    mkdirSync(join(tmp, dir));
    for (const file of FRAMEWORK_FILES) copyFileSync(join(MIGRATIONS_DIR, file), join(tmp, dir, file));
  }
  four = join(tmp, 'four'); // 001-004: what exists before 005
  five = join(tmp, 'five'); // 001-004 + a copy of 005 (the runner forbids gaps, so 005 cannot sit alone)
  withLater = join(tmp, 'with-later'); // 001-005 + a hypothetical 006 that only adds things
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

type Which = 'all' | 'four' | 'five' | 'later';

/** Copies 005 into a scratch dir on demand, so a missing file fails the test that needs it (not every test). */
function copy005(dir: string): void {
  copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
}

/**
 * A migrated in-memory database opened like production (foreign_keys ON). 'all' applies the real
 * MIGRATIONS_DIR; 'four' copies of 001-004 (no 005); 'five' copies of 001-005 alone; 'later' adds a
 * hypothetical 006 that does what a later migration may do: ADD COLUMN on both tables plus a table
 * that references sessions.
 */
function migrated(which: Which = 'all'): Database {
  const db = openDatabase(':memory:');
  opened.push(db);
  if (which === 'all') {
    migrate(db);
  } else if (which === 'four') {
    migrate(db, four);
  } else if (which === 'five') {
    copy005(five);
    migrate(db, five);
  } else {
    copy005(withLater);
    writeFileSync(
      join(withLater, '006_later.sql'),
      [
        'ALTER TABLE sessions ADD COLUMN note TEXT;',
        'ALTER TABLE session_events ADD COLUMN note TEXT;',
        'CREATE TABLE session_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE) STRICT;',
        '',
      ].join('\n'),
    );
    migrate(db, withLater);
  }
  return db;
}

type Cell = string | number | null | Uint8Array;

function rows<T = Record<string, unknown>>(db: Database, sql: string, ...params: Cell[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function one<T = Record<string, unknown>>(db: Database, sql: string, ...params: Cell[]): T {
  const [first] = rows<T>(db, sql, ...params);
  if (first === undefined) throw new Error(`no row for: ${sql}`);
  return first;
}

function count(db: Database, table: string, where = '1 = 1'): number {
  return one<{ n: number }>(db, `SELECT count(*) AS n FROM ${table} WHERE ${where}`).n;
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

function accepted(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

function createSql(db: Database, table: string): string {
  return one<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).sql;
}

/** The quoted literals of `<column> IN ('a', 'b', ...)` in the CREATE TABLE text of `table`. */
function checkList(db: Database, table: string, column: string): string[] {
  const match = new RegExp(`(?<![A-Za-z_])${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(createSql(db, table));
  if (!match) throw new Error(`no "${column} IN (...)" CHECK in ${table}`);
  return [...(match[1] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

/** Base tables (not sqlite_ bookkeeping, not the runner ledger) in `db`. */
function tableNames(db: Database): string[] {
  return rows<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name",
  ).map((r) => r.name);
}

/** The tables 005 creates: what 001-005 have beyond 001-004. Independent of any later migration. */
function ownTables(): string[] {
  const before = tableNames(migrated('four'));
  return tableNames(migrated('five')).filter((t) => !before.includes(t));
}

const columnShape = (db: Database, table: string): ColumnShape[] =>
  rows<ColumnShape>(db, `SELECT name, type, "notnull" AS "notnull", pk FROM pragma_table_info('${table}') ORDER BY cid`);

const notNullColumns = (db: Database, table: string): string[] =>
  rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}') WHERE "notnull" = 1`).map((r) => r.name);

const nullableColumns = (db: Database, table: string): string[] =>
  rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}') WHERE "notnull" = 0 AND pk = 0`).map((r) => r.name);

interface ForeignKey {
  from: string[];
  table: string;
  to: string[];
  onDelete: string;
  onUpdate: string;
}

/** The foreign keys of `table`, one entry per constraint (composite keys grouped). */
function foreignKeys(db: Database, table: string): ForeignKey[] {
  const raw = rows<{ id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string }>(
    db,
    `SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`,
  );
  const byId = new Map<number, ForeignKey>();
  for (const r of raw) {
    const fk = byId.get(r.id) ?? { from: [], table: r.table, to: [], onDelete: r.on_delete, onUpdate: r.on_update };
    fk.from.push(r.from);
    fk.to.push(r.to);
    byId.set(r.id, fk);
  }
  return [...byId.values()];
}

/** The column lists of the UNIQUE indexes (autoindexes included) of `table`; the rowid/PK alias is not an index. */
function uniqueIndexes(db: Database, table: string): string[][] {
  const list = rows<{ name: string }>(db, `SELECT name FROM pragma_index_list('${table}') WHERE "unique" = 1`);
  return list.map((i) => rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${i.name}') ORDER BY seqno`).map((c) => c.name));
}

/** The column lists of ALL indexes of `table`. */
function allIndexes(db: Database, table: string): string[][] {
  const list = rows<{ name: string }>(db, `SELECT name FROM pragma_index_list('${table}')`);
  return list.map((i) => rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${i.name}') ORDER BY seqno`).map((c) => c.name));
}

const triggersOn = (db: Database, table: string): { name: string; sql: string }[] =>
  rows<{ name: string; sql: string }>(db, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name", table);

// --- fixtures ------------------------------------------------------------------------------

/** A lower-case RFC 4122 v4 UUID, distinct per n. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The items a session holds: each references a drill VERSION id (JSON, so no SQL foreign key). */
const ITEMS = JSON.stringify([
  { itemId: 'i1', drillVersionId: 'drill-a@1.0.0', minutes: 10, done: false },
  { itemId: 'i2', drillVersionId: 'drill-b@1.2.0', minutes: 10, done: false },
]);

function insertRow(db: Database, table: string, row: Record<string, Cell>): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
}

/** A complete player_profiles row (002's contract; only the columns this test needs to vary are parameters). */
function addProfile(db: Database, playerId = 'p1'): void {
  insertRow(db, 'player_profiles', {
    player_id: playerId,
    age: 12,
    level: 'basic',
    goal: 'dribbling',
    equipment: 'cones',
    space: 'yard',
    partner: 1,
    days_per_week: 3,
    minutes_per_session: 20,
    locale: 'ru',
    created_at: T0,
    updated_at: T0,
  });
}

function sessionRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    id: 's1',
    player_id: 'p1',
    date: '2026-01-05',
    planner: 'rules',
    graph_version: '1.0.0',
    items: ITEMS,
    finished_at: null,
    ...over,
  };
}

function eventRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    player_id: 'p1',
    session_id: 's1',
    client_uuid: uuid(1),
    type: 'drill_done',
    item_id: 'i1',
    value: null,
    at: T0,
    received_at: T1,
    ...over,
  };
}

const addSession = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'sessions', sessionRow(over));
const addEvent = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'session_events', eventRow(over));

/** A profile p1 with session s1 (2026-01-05) ready for events. */
function withSession(which: Which = 'all'): Database {
  const db = migrated(which);
  addProfile(db);
  addSession(db);
  return db;
}

/** Two players, each with one session and two events, so cascade tests have something to lose and to keep. */
function seedTwoPlayers(db: Database): void {
  for (const [p, s, n] of [['p1', 's1', 0], ['p2', 's2', 10]] as const) {
    addProfile(db, p);
    addSession(db, { id: s, player_id: p });
    addEvent(db, { player_id: p, session_id: s, client_uuid: uuid(n + 1), item_id: 'i1' });
    addEvent(db, { player_id: p, session_id: s, client_uuid: uuid(n + 2), type: 'session_finished', item_id: null, at: T1 });
  }
}

/**
 * The schema assertions that must hold on ANY database built from the real migrations, whatever is
 * applied after 005: named tables and columns only, POSITIVE (this column is NOT NULL, that CHECK
 * exists, this trigger fires), never "the table has exactly these columns": a later
 * ALTER TABLE ... ADD COLUMN is legitimate and must not break them.
 */
function expectSessionsContract(db: Database): void {
  expect(checkList(db, 'session_events', 'type')).toEqual([...EVENT_TYPES]);
  expect(checkList(db, 'sessions', 'planner')).toEqual([...PLANNERS]);
  for (const table of SESSION_TABLES) {
    expect(one<{ strict: number }>(db, 'SELECT strict FROM pragma_table_list WHERE name = ?', table).strict, `${table} STRICT`).toBe(1);
  }
  for (const c of SESSIONS_REQUIRED) expect(notNullColumns(db, 'sessions'), `sessions.${c}`).toContain(c);
  for (const c of EVENTS_REQUIRED) expect(notNullColumns(db, 'session_events'), `session_events.${c}`).toContain(c);
  expect(nullableColumns(db, 'sessions')).toContain('finished_at');
  expect(nullableColumns(db, 'session_events')).toContain('item_id');
  expect(nullableColumns(db, 'session_events')).toContain('value');

  addProfile(db, 'contract-a');
  addProfile(db, 'contract-b');
  addSession(db, { id: 'ca', player_id: 'contract-a' });
  addSession(db, { id: 'cb', player_id: 'contract-b' });
  expect(thrown(() => addSession(db, { id: 'ca2', player_id: 'contract-a' })).message).toMatch(/UNIQUE constraint failed: sessions\.player_id, sessions\.date/);
  expect(thrown(() => addSession(db, { id: 'cx', player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
  expect(thrown(() => addSession(db, { id: 'cy', date: '2026-02-30', player_id: 'contract-a' })).message).toMatch(/CHECK constraint failed/);
  addEvent(db, { player_id: 'contract-a', session_id: 'ca', client_uuid: uuid(900) });
  expect(thrown(() => addEvent(db, { player_id: 'contract-a', session_id: 'ca', client_uuid: uuid(900) })).message).toMatch(/UNIQUE constraint failed: session_events\.client_uuid/);
  expect(thrown(() => addEvent(db, { player_id: 'contract-a', session_id: 'cb', client_uuid: uuid(901) })).message).toMatch(/FOREIGN KEY constraint failed/);
  expect(thrown(() => addEvent(db, { player_id: 'contract-a', session_id: 'ca', client_uuid: uuid(902), type: 'nope' })).message).toMatch(/CHECK constraint failed/);
  expect(thrown(() => db.run("UPDATE session_events SET value = 1 WHERE player_id = 'contract-a'")).message).toMatch(/append-only/);
  db.run("DELETE FROM player_profiles WHERE player_id IN ('contract-a', 'contract-b')");
  expect(count(db, 'sessions', "player_id LIKE 'contract-%'")).toBe(0);
  expect(count(db, 'session_events', "player_id LIKE 'contract-%'")).toBe(0);
}

// --- the migration ---------------------------------------------------------------------------

describe('005_sessions: migration', () => {
  test('applies through the real runner and MIGRATIONS_DIR, as version 5, after 001-004', () => {
    const db = openDatabase(join(tmp, 'real.db'));
    opened.push(db);

    const applied = migrate(db);

    expect(applied.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(one<{ name: string }>(db, 'SELECT name FROM schema_migrations WHERE version = 5').name).toBe('005_sessions');
    for (const table of SESSION_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('applies on top of a database that already has 001-004 (the upgrade path), and only 005 is applied', () => {
    const db = migrated('four');
    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(4);
    expect(tableNames(db)).not.toContain('sessions');

    copy005(five);
    expect(migrate(db, five)).toEqual([5]);
    for (const table of SESSION_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('a copy of 001-005 alone in a temp dir applies and passes the whole contract', () => {
    const db = migrated('five');
    expect(rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
    expectSessionsContract(db);
  });

  test('sits next to its own test, and the directory holds only NNN_name.sql migrations', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(SQL_FILE);
    expect(files).toContain('005_sessions.test.ts');
    expect(files.filter((f) => f.endsWith('.sql')).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test('creates exactly sessions and session_events, and none of Better Auth\'s tables (nor a name that differs from one only by case)', () => {
    const own = ownTables();

    expect(own).toEqual([...SESSION_TABLES].sort());
    const taken = new Set(BETTER_AUTH_TABLES.map((t) => t.toLowerCase()));
    for (const table of own) expect(taken.has(table.toLowerCase()), table).toBe(false);
    // SQLite table names are case-insensitive: "sessions" (ours) and "session" (Better Auth's) are two names.
    expect('sessions'.toLowerCase()).not.toBe('session');
    // Better Auth creates its tables after migrate(): a migrate-only database has none of them.
    const db = migrated('five');
    expect(tableNames(db).filter((t) => BETTER_AUTH_TABLES.includes(t))).toEqual([]);
  });

  test('Better Auth\'s own "session" table can be created next to ours (no collision, no interference)', () => {
    const db = migrated('five');
    db.run('CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT)');
    db.run('CREATE TABLE "session" (id TEXT PRIMARY KEY, token TEXT, userId TEXT REFERENCES "user" (id) ON DELETE CASCADE)');
    db.run('CREATE TABLE "account" (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE "verification" (id TEXT PRIMARY KEY)');
    expect(tableNames(db)).toEqual(expect.arrayContaining(['sessions', 'session_events', 'session', 'user']));
  });

  test('contains no transaction control and no PRAGMA (the runner owns the transaction)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
      .replace(/--.*$/gm, '')
      .replace(/CREATE TRIGGER[\s\S]*?\bEND\s*;/gi, ''); // a trigger body is BEGIN ... END: not transaction control
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i);
    expect(sql).not.toMatch(/\bPRAGMA\b/i);
  });

  test('never uses INSERT OR REPLACE / REPLACE INTO in executable SQL', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bREPLACE\b/i);
  });

  test('the header comment documents the hazards for later authors', () => {
    const header = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .join('\n');
    expect(header).toMatch(/Better Auth/);
    expect(header).toMatch(/"session"/); // the singular Better Auth table this file's plural name must not collide with
    expect(header).toMatch(/collide|collision/i);
    expect(header).toMatch(/erasure/i);
    expect(header).toMatch(/INSERT OR REPLACE/);
    expect(header).toMatch(/ON CONFLICT/);
    expect(header).toMatch(/append-only/i);
    expect(header).toMatch(/BEFORE DELETE/);
    expect(header).toMatch(/cascade/i);
    expect(header).toMatch(/foreign_keys/);
    expect(header).toMatch(/drill_versions/);
    expect(header).toMatch(/rebuild/i);
    expect(header).toMatch(/DROP TABLE/);
    expect(header).toMatch(/ADD COLUMN/);
    expect(header).toMatch(/re-key|recover/i);
    expect(header).toMatch(/hour 24/i);
    expect(header).toMatch(/whitespace/i);
    expect(header).toMatch(/z\.uuid/);
  });

  test('re-running is a no-op and the recorded checksum is the sha256 of the file bytes, unchanged', () => {
    const db = migrated('all');
    const before = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 5').checksum;
    const schemaBefore = rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const after = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 5').checksum;
    expect(after).toBe(before);
    expect(before).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schemaBefore);
  });

  test('applies exactly once: one schema_migrations row for version 5, and a second run does not touch the data', () => {
    const db = withSession('five');
    addEvent(db);
    expect(migrate(db, five)).toEqual([]);
    expect(count(db, 'schema_migrations', 'version = 5')).toBe(1);
    expect(count(db, 'sessions')).toBe(1);
    expect(count(db, 'session_events')).toBe(1);
  });

  test('the migration itself does not depend on the foreign_keys pragma (a connection with it OFF migrates to the same schema)', () => {
    const off = new Database(':memory:');
    opened.push(off);
    expect(one<{ foreign_keys: number }>(off, 'PRAGMA foreign_keys').foreign_keys).toBe(0);
    copy005(five);
    migrate(off, five);

    const on = migrated('five');
    const schema = (d: Database) => rows(d, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
    expect(schema(off)).toEqual(schema(on));
  });

  test('a later 006 that ADDs COLUMNs to both tables and adds a cascading table does not break the sessions contract', () => {
    const db = migrated('later');
    expect(tableNames(db)).toEqual(expect.arrayContaining(['sessions', 'session_events', 'session_audit']));
    expect(notNullColumns(db, 'sessions')).toEqual(expect.arrayContaining(SESSIONS_REQUIRED));
    expect(nullableColumns(db, 'sessions')).toContain('note');
    expectSessionsContract(db);
  });
});

// --- exact shape (alone) -----------------------------------------------------------------------

describe('005_sessions: exact shape of the two new tables (001-005 alone)', () => {
  test('sessions has exactly these columns, types and nullability', () => {
    expect(columnShape(migrated('five'), 'sessions')).toEqual(SESSIONS_COLUMNS);
  });

  test('session_events has exactly these columns, types and nullability', () => {
    const shape = columnShape(migrated('five'), 'session_events');
    expect(shape).toEqual(EVENTS_COLUMNS);
  });

  test('both are STRICT and hold no personal data column', () => {
    const db = migrated('five');
    for (const table of SESSION_TABLES) {
      expect(one<{ strict: number }>(db, 'SELECT strict FROM pragma_table_list WHERE name = ?', table).strict).toBe(1);
      for (const c of columnShape(db, table)) expect(c.name, `${table}.${c.name}`).not.toMatch(/name|e.?mail|birth|dob|phone|address/i);
    }
  });

  test('foreign keys: sessions.player_id and session_events.player_id to player_profiles, and the composite (session_id, player_id) to sessions, all CASCADE', () => {
    const db = migrated('five');
    expect(foreignKeys(db, 'sessions')).toEqual([
      { from: ['player_id'], table: 'player_profiles', to: ['player_id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' },
    ]);
    const events = foreignKeys(db, 'session_events');
    expect(events).toHaveLength(2);
    expect(events).toContainEqual({ from: ['player_id'], table: 'player_profiles', to: ['player_id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' });
    expect(events).toContainEqual({ from: ['session_id', 'player_id'], table: 'sessions', to: ['id', 'player_id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' });
  });

  test('unique indexes: sessions (player_id, date) and (id, player_id); session_events client_uuid', () => {
    const db = migrated('five');
    const sessions = uniqueIndexes(db, 'sessions');
    expect(sessions).toContainEqual(['player_id', 'date']);
    expect(sessions).toContainEqual(['id', 'player_id']);
    expect(uniqueIndexes(db, 'session_events')).toContainEqual(['client_uuid']);
  });

  test('indexes serve the lookups: events by session_id and by player_id', () => {
    const db = migrated('five');
    const leading = allIndexes(db, 'session_events').map((cols) => cols[0]);
    expect(leading).toContain('session_id');
    expect(leading).toContain('player_id');
  });

  test('session_events carries exactly one trigger (BEFORE UPDATE); no DELETE trigger anywhere, so cascades and erasure work', () => {
    const db = migrated('five');
    const triggers = triggersOn(db, 'session_events');
    expect(triggers.map((t) => t.name)).toEqual(['session_events_append_only']);
    expect(triggers[0]?.sql).toMatch(/BEFORE UPDATE ON session_events/i);
    expect(triggers[0]?.sql).toMatch(/RAISE\s*\(\s*ABORT/i);
    expect(triggersOn(db, 'sessions')).toEqual([]);
    const all = rows<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('sessions', 'session_events')");
    for (const t of all) expect(t.sql).not.toMatch(/DELETE/i);
  });

  test('the enum CHECK lists equal the contract constants (parsed out of sqlite_master, not restated)', () => {
    const db = migrated('five');
    expect(EVENT_TYPES.length).toBeGreaterThan(0);
    expect(PLANNERS.length).toBeGreaterThan(0);
    expect(checkList(db, 'session_events', 'type')).toEqual([...EVENT_TYPES]);
    expect(checkList(db, 'sessions', 'planner')).toEqual([...PLANNERS]);
  });
});

// --- sessions ---------------------------------------------------------------------------------

describe('005_sessions: sessions', () => {
  test('a valid session stores every column as given, finished_at NULL until finished', () => {
    const db = withSession();
    expect(one<Record<string, Cell>>(db, 'SELECT * FROM sessions WHERE id = ?', 's1')).toEqual(sessionRow());
    db.run('UPDATE sessions SET finished_at = ? WHERE id = ?', [T2, 's1']);
    expect(one<{ finished_at: string }>(db, 'SELECT finished_at FROM sessions').finished_at).toBe(T2);
  });

  test('UNIQUE (player_id, date): a second session the same day is rejected; another player or another day is fine', () => {
    const db = withSession();
    addProfile(db, 'p2');

    const dup = thrown(() => addSession(db, { id: 's-dup' }));
    expect(dup.message).toMatch(/UNIQUE constraint failed: sessions\.player_id, sessions\.date/);

    addSession(db, { id: 's-other-player', player_id: 'p2' }); // same date, other player
    addSession(db, { id: 's-next-day', date: '2026-01-06' }); // same player, other day
    expect(count(db, 'sessions')).toBe(3);
  });

  test('the id is the primary key: a duplicate id is rejected even for another player and day', () => {
    const db = withSession();
    addProfile(db, 'p2');
    expect(thrown(() => addSession(db, { player_id: 'p2', date: '2026-02-02' })).message).toMatch(/UNIQUE constraint failed: sessions\.id/);
  });

  test('the id is an EntityId: 1-128 characters of [A-Za-z0-9._-] (parity with the contract)', () => {
    const db = migrated();
    addProfile(db);
    const candidates = ['s1', 'a', 'A_b.c-d', '-x', '_y', 'x'.repeat(128), 'x'.repeat(129), '', ' s1', 's 1', 's/1', 's1\n', 'sé', 's1;'];
    let n = 0;
    for (const id of candidates) {
      n += 1;
      const ok = accepted(() => addSession(db, { id, date: `2027-01-${String(n).padStart(2, '0')}` }));
      expect(ok, JSON.stringify(id)).toBe(EntityId.safeParse(id).success);
    }
  });

  test('every required column is NOT NULL (NULL date, planner, items, graph_version, player_id, id are all rejected)', () => {
    const db = migrated();
    addProfile(db);
    for (const column of SESSIONS_REQUIRED) {
      expect(thrown(() => addSession(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: sessions\\.${column}\\b`));
    }
    expect(count(db, 'sessions')).toBe(0);
    addSession(db, { finished_at: null }); // the one nullable column
  });

  test('a session needs an existing profile (foreign key), and NOT a Better Auth user', () => {
    const db = migrated();
    expect(thrown(() => addSession(db, { player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
  });

  test('planner: only the contract\'s values; NULL, blank and other spellings are rejected', () => {
    const db = migrated();
    addProfile(db);
    let n = 0;
    for (const planner of PLANNERS) addSession(db, { id: `ok-${planner}`, planner, date: `2026-03-0${++n}` });
    for (const planner of ['', ' ', 'Rules', 'AI', 'rules ', 'human', 'manual']) {
      expect(thrown(() => addSession(db, { id: 'bad', planner, date: '2026-04-01' })).message, JSON.stringify(planner)).toMatch(/CHECK constraint failed/);
    }
  });

  test('graph_version is never blank (whitespace is space, tab, newline, carriage return)', () => {
    const db = migrated();
    addProfile(db);
    addSession(db, { graph_version: '2026.01-a' });
    for (const [i, graph_version] of ['', ' ', '  ', '\t', '\n', '\r', ' \t\r\n '].entries()) {
      expect(thrown(() => addSession(db, { id: `b${i}`, date: `2026-05-0${i + 1}`, graph_version })).message, JSON.stringify(graph_version)).toMatch(/CHECK constraint failed/);
    }
  });

  test('date: only real calendar dates YYYY-MM-DD; agrees with the contract\'s CalendarDate on every candidate', () => {
    const db = migrated();
    addProfile(db);
    const good = ['2026-01-01', '2026-12-31', '2028-02-29', '2000-02-29', '2026-02-28', '2026-04-30'];
    const bad = [
      '2026-02-30', '2026-02-29', '2100-02-29', '2026-04-31', '2026-06-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32',
      '2026-1-1', '26-01-01', '20260101', '2026/01/01', '01-01-2026', '2026-01-01T00:00:00.000Z', '2026-01-01 00:00:00', ' 2026-01-01',
      '2026-01-01 ', '', 'today', 'now', '2460000', '2026-W01-1', '2026-001',
    ];
    let n = 0;
    for (const date of good) {
      addSession(db, { id: `g${++n}`, date });
      expect(CalendarDate.safeParse(date).success, date).toBe(true);
    }
    for (const date of bad) {
      expect(thrown(() => addSession(db, { id: `x${++n}`, date })).message, JSON.stringify(date)).toMatch(/CHECK constraint failed/);
      expect(CalendarDate.safeParse(date).success, `contract refuses ${date}`).toBe(false);
    }
    expect(count(db, 'sessions')).toBe(good.length);
  });

  test('items: a JSON array only; text that is not JSON, or another JSON type (object, string, number, null, bool), is rejected', () => {
    const db = migrated();
    addProfile(db);
    let n = 0;
    const add = (items: Cell) => addSession(db, { id: `i${++n}`, date: `2026-06-${String(n).padStart(2, '0')}`, items });
    add('[]');
    add('[{"itemId":"i1","drillVersionId":"v1"}]');
    for (const bad of ['', 'not json', '{}', '{"a":1}', '"x"', '1', 'null', 'true', '[', '[1,]', "['a']", '[NaN]']) {
      expect(thrown(() => add(bad)).message, JSON.stringify(bad)).toMatch(/CHECK constraint failed/);
    }
    expect(count(db, 'sessions')).toBe(2);
  });

  test('STRICT refuses a wrong storage class (BLOB items, integer date, integer planner)', () => {
    const db = migrated();
    addProfile(db);
    expect(thrown(() => addSession(db, { items: new TextEncoder().encode('[]') })).message).toMatch(/cannot store BLOB value in TEXT column|CHECK constraint failed/);
    expect(thrown(() => addSession(db, { id: 'x2', date: 20260105 })).message).toMatch(/cannot store INT|CHECK constraint failed/i);
    expect(thrown(() => addSession(db, { id: 'x3', planner: 1 })).message).toMatch(/cannot store INT|CHECK constraint failed/i);
    expect(count(db, 'sessions')).toBe(0);
  });

  test('finished_at: NULL or canonical ms-UTC text; every other spelling is rejected, and the contract agrees', () => {
    const db = migrated();
    addProfile(db);
    let n = 0;
    const add = (finished_at: Cell) => addSession(db, { id: `f${++n}`, date: `2026-07-${String(n).padStart(2, '0')}`, finished_at });
    add(null);
    add(T0);
    add('2026-12-31T23:59:59.999Z');
    add('2028-02-29T12:00:00.000Z');
    for (const bad of BAD_TIMESTAMPS) {
      expect(thrown(() => add(bad)).message, bad).toMatch(/CHECK constraint failed/);
    }
    for (const canonical of [T0, '2026-12-31T23:59:59.999Z', '2028-02-29T12:00:00.000Z']) expect(Timestamp.safeParse(canonical).success).toBe(true);
    expect(Timestamp.safeParse('2026-01-01T24:00:00.000Z').success).toBe(false); // the contract agrees hour 24 is not a time
    expect(count(db, 'sessions')).toBe(4);
  });

  test('sessions can be updated (finished_at, items on a swap) and deleted: only the events are append-only', () => {
    const db = withSession();
    db.run('UPDATE sessions SET items = ? WHERE id = ?', ['[]', 's1']);
    db.run('UPDATE sessions SET finished_at = ? WHERE id = ?', [T2, 's1']);
    expect(one<{ items: string }>(db, 'SELECT items FROM sessions').items).toBe('[]');
    db.run("DELETE FROM sessions WHERE id = 's1'");
    expect(count(db, 'sessions')).toBe(0);
  });

  test('an UPDATE cannot break the CHECKs either (date, planner, items, finished_at)', () => {
    const db = withSession();
    for (const [column, value] of [['date', '2026-02-30'], ['planner', 'x'], ['items', '{}'], ['finished_at', '2026-01-01T24:00:00.000Z']] as const) {
      expect(thrown(() => db.run(`UPDATE sessions SET ${column} = ? WHERE id = 's1'`, [value])).message, column).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => db.run("UPDATE sessions SET date = NULL WHERE id = 's1'")).message).toMatch(/NOT NULL constraint failed: sessions\.date/);
  });
});

// --- session_events ------------------------------------------------------------------------------

describe('005_sessions: session_events', () => {
  test('a valid event stores every column as given; received_at defaults to canonical now when omitted', () => {
    const db = withSession();
    addEvent(db, { value: 42.5 });
    expect(one<Record<string, Cell>>(db, 'SELECT player_id, session_id, client_uuid, type, item_id, value, at, received_at FROM session_events')).toEqual(
      eventRow({ value: 42.5 }),
    );

    db.query('INSERT INTO session_events (player_id, session_id, client_uuid, type, at) VALUES (?, ?, ?, ?, ?)').run('p1', 's1', uuid(2), 'result', T0);
    const defaulted = one<{ received_at: string; item_id: null; value: null }>(db, 'SELECT * FROM session_events WHERE client_uuid = ?', uuid(2));
    expect(defaulted.item_id).toBeNull();
    expect(defaulted.value).toBeNull();
    expect(Timestamp.safeParse(defaulted.received_at).success).toBe(true);
    expect(defaulted.received_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test('ids are assigned in insertion order and never reused (AUTOINCREMENT)', () => {
    const db = withSession();
    addEvent(db, { client_uuid: uuid(1) });
    addEvent(db, { client_uuid: uuid(2) });
    db.run("DELETE FROM session_events WHERE client_uuid = ?", [uuid(2)]);
    addEvent(db, { client_uuid: uuid(3) });
    expect(rows<{ id: number }>(db, 'SELECT id FROM session_events ORDER BY id').map((r) => r.id)).toEqual([1, 3]);
  });

  test('every required column is NOT NULL; item_id and value are nullable', () => {
    const db = withSession();
    for (const column of EVENTS_REQUIRED) {
      expect(thrown(() => addEvent(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: session_events\\.${column}\\b`));
    }
    expect(count(db, 'session_events')).toBe(0);
    addEvent(db, { item_id: null, value: null });
    expect(count(db, 'session_events')).toBe(1);
  });

  test('a duplicate client_uuid is rejected: same session, another session of the same player, and another player', () => {
    const db = withSession();
    addProfile(db, 'p2');
    addSession(db, { id: 's1b', date: '2026-01-06' });
    addSession(db, { id: 's2', player_id: 'p2' });
    addEvent(db, { client_uuid: uuid(1) });

    const overs: Record<string, Cell>[] = [{}, { session_id: 's1b' }, { player_id: 'p2', session_id: 's2' }, { type: 'session_finished', item_id: null }];
    for (const over of overs) {
      expect(thrown(() => addEvent(db, { client_uuid: uuid(1), ...over })).message, JSON.stringify(over)).toMatch(/UNIQUE constraint failed: session_events\.client_uuid/);
    }
    expect(count(db, 'session_events')).toBe(1);
  });

  test('replaying a batch with ON CONFLICT (client_uuid) DO NOTHING stores each event once', () => {
    const db = withSession();
    const replay = db.query(
      `INSERT INTO session_events (player_id, session_id, client_uuid, type, item_id, at)
       VALUES ('p1', 's1', ?, ?, ?, ?) ON CONFLICT (client_uuid) DO NOTHING`,
    );
    const batch: [string, string, string | null, string][] = [
      [uuid(1), 'drill_done', 'i1', T0],
      [uuid(2), 'drill_done', 'i2', T1],
      [uuid(3), 'session_finished', null, T2],
    ];
    for (let pass = 0; pass < 3; pass++) for (const [u, type, item, at] of batch) replay.run(u, type, item, at);
    expect(count(db, 'session_events')).toBe(3);
  });

  test('client_uuid: a lower-case UUID exactly as ClientUuid (z.uuid) accepts it; blank and other shapes are rejected', () => {
    const db = withSession();
    const bad = ['', ' ', 'not-a-uuid', uuid(3).replace(/-/g, ''), `${uuid(4)} `, ` ${uuid(5)}`, `${uuid(6)}0`, '0190F1C2-7A3B-4C5D-8E9F-0A1B2C3D4E5F', '-'.repeat(36)];
    for (const client_uuid of bad) {
      expect(thrown(() => addEvent(db, { client_uuid })).message, JSON.stringify(client_uuid)).toMatch(/CHECK constraint failed/);
    }
    addEvent(db, { client_uuid: '0190f1c2-7a3b-4c5d-8e9f-0a1b2c3d4e5f' });

    // Every version (0-f) and variant (0-f) nibble: the CHECK agrees with the contract.
    const hex = '0123456789abcdef';
    let inserted = 0;
    for (const v of hex) {
      for (const variant of hex) {
        const candidate = `00000000-0000-${v}000-${variant}000-000000000001`;
        const ok = accepted(() => addEvent(db, { client_uuid: candidate }));
        expect(ok, candidate).toBe(ClientUuid.safeParse(candidate).success);
        if (ok) inserted += 1;
      }
    }
    expect(inserted).toBeGreaterThan(0);
    for (const special of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff']) {
      expect(accepted(() => addEvent(db, { client_uuid: special })), special).toBe(ClientUuid.safeParse(special).success);
    }
  });

  test('the session must exist and belong to the same player: an event cannot reference another player\'s session (composite FK)', () => {
    const db = migrated();
    addProfile(db, 'p1');
    addProfile(db, 'p2');
    addSession(db, { id: 's1', player_id: 'p1' });
    addSession(db, { id: 's2', player_id: 'p2' });

    addEvent(db, { player_id: 'p1', session_id: 's1', client_uuid: uuid(1) });
    addEvent(db, { player_id: 'p2', session_id: 's2', client_uuid: uuid(2) });

    // p2 writing into p1's session, and p1 into p2's: both players exist, both sessions exist.
    expect(thrown(() => addEvent(db, { player_id: 'p2', session_id: 's1', client_uuid: uuid(3) })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(thrown(() => addEvent(db, { player_id: 'p1', session_id: 's2', client_uuid: uuid(4) })).message).toMatch(/FOREIGN KEY constraint failed/);
    // A session that does not exist, and a player without a profile.
    expect(thrown(() => addEvent(db, { session_id: 'ghost', client_uuid: uuid(5) })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(thrown(() => addEvent(db, { player_id: 'ghost', client_uuid: uuid(6) })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(count(db, 'session_events')).toBe(2);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('type: only the contract\'s event types; blank, NULL and other spellings are rejected', () => {
    const db = withSession();
    let n = 0;
    for (const type of EVENT_TYPES) addEvent(db, { type, client_uuid: uuid(++n) });
    expect(count(db, 'session_events')).toBe(EVENT_TYPES.length);
    for (const type of ['', ' ', 'Drill_Done', 'drill_done ', 'finished', 'session_started', 'skip', 'drill-done']) {
      expect(thrown(() => addEvent(db, { type, client_uuid: uuid(++n) })).message, JSON.stringify(type)).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => addEvent(db, { type: null, client_uuid: uuid(++n) })).message).toMatch(/NOT NULL constraint failed: session_events\.type/);
  });

  test('item_id: NULL, or an EntityId (1-128 characters of [A-Za-z0-9._-]); agrees with the contract', () => {
    const db = withSession();
    let n = 0;
    for (const item_id of ['i1', 'a.b_c-d', 'x'.repeat(128), 'x'.repeat(129), '', ' ', 'i 1', 'i/1', 'ié']) {
      const ok = accepted(() => addEvent(db, { item_id, client_uuid: uuid(++n) }));
      expect(ok, JSON.stringify(item_id)).toBe(EntityId.safeParse(item_id).success);
    }
    addEvent(db, { item_id: null, client_uuid: uuid(++n) });
  });

  test('value: NULL or any finite number (fractions, zero, negatives); infinity is refused', () => {
    const db = withSession();
    let n = 0;
    for (const value of [null, 0, 1, -3, 12.5, 1e300, -1e300]) addEvent(db, { value, client_uuid: uuid(++n) });
    expect(thrown(() => db.run(`INSERT INTO session_events (player_id, session_id, client_uuid, type, at, value) VALUES ('p1', 's1', ?, 'result', ?, 9e999)`, [uuid(++n), T0])).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => db.run(`INSERT INTO session_events (player_id, session_id, client_uuid, type, at, value) VALUES ('p1', 's1', ?, 'result', ?, -9e999)`, [uuid(++n), T0])).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => addEvent(db, { value: 'fast', client_uuid: uuid(++n) })).message).toMatch(/cannot store TEXT value in REAL column|CHECK constraint failed/);
    expect(count(db, 'session_events')).toBe(7);
  });

  test('at and received_at: canonical ms-UTC text only; every other spelling is rejected', () => {
    const db = withSession();
    let n = 0;
    for (const column of ['at', 'received_at']) {
      addEvent(db, { [column]: '2026-12-31T23:59:59.999Z', client_uuid: uuid(++n) });
      for (const bad of BAD_TIMESTAMPS) {
        expect(thrown(() => addEvent(db, { [column]: bad, client_uuid: uuid(++n) })).message, `${column} ${bad}`).toMatch(/CHECK constraint failed/);
      }
    }
    expect(count(db, 'session_events')).toBe(2);
  });

  test('an event\'s client time may differ from its server time (offline replay: at is older than received_at)', () => {
    const db = withSession();
    addEvent(db, { at: '2026-01-01T08:00:00.000Z', received_at: '2026-01-20T09:00:00.000Z' });
    const row = one<{ at: string; received_at: string }>(db, 'SELECT at, received_at FROM session_events');
    expect(row.at < row.received_at).toBe(true);
  });
});

// --- append-only -----------------------------------------------------------------------------------

describe('005_sessions: session_events is an append-only log', () => {
  function seeded(): Database {
    const db = withSession();
    addProfile(db, 'p2');
    addSession(db, { id: 's1b', date: '2026-01-06' });
    addEvent(db, { value: 1 });
    return db;
  }

  test('an UPDATE of any content column is rejected with a clear message and the row is unchanged', () => {
    const db = seeded();
    const before = one<Record<string, Cell>>(db, 'SELECT * FROM session_events');
    const updates: [string, Cell][] = [
      ['id', 99],
      ['session_id', 's1b'],
      ['client_uuid', uuid(77)],
      ['type', 'drill_undone'],
      ['item_id', 'i2'],
      ['value', 2],
      ['at', T2],
      ['received_at', T2],
    ];
    for (const [column, value] of updates) {
      const e = thrown(() => db.run(`UPDATE session_events SET ${column} = ?`, [value]));
      expect(e.message, column).toMatch(/session_events is append-only/);
    }
    expect(one<Record<string, Cell>>(db, 'SELECT * FROM session_events')).toEqual(before);
  });

  test('a no-op UPDATE (setting a column to its own value) is rejected too, and so is an UPDATE that only sets NULL', () => {
    const db = seeded();
    expect(thrown(() => db.run('UPDATE session_events SET value = value')).message).toMatch(/append-only/);
    expect(thrown(() => db.run('UPDATE session_events SET item_id = NULL')).message).toMatch(/append-only/);
    expect(thrown(() => db.run("UPDATE session_events SET player_id = player_id")).message).toMatch(/append-only/);
  });

  test('a multi-row UPDATE is rejected as a whole (nothing changes)', () => {
    const db = seeded();
    addEvent(db, { client_uuid: uuid(2), value: 5 });
    expect(thrown(() => db.run('UPDATE session_events SET value = 0')).message).toMatch(/append-only/);
    expect(rows<{ value: number }>(db, 'SELECT value FROM session_events ORDER BY id').map((r) => r.value)).toEqual([1, 5]);
  });

  test('ON CONFLICT DO UPDATE cannot rewrite a stored event either (the conflict branch is an UPDATE)', () => {
    const db = seeded();
    const e = thrown(() =>
      db.run(
        `INSERT INTO session_events (player_id, session_id, client_uuid, type, at, value) VALUES ('p1', 's1', ?, 'result', ?, 99)
         ON CONFLICT (client_uuid) DO UPDATE SET value = excluded.value`,
        [uuid(1), T2],
      ),
    );
    expect(e.message).toMatch(/append-only/);
    expect(one<{ value: number }>(db, 'SELECT value FROM session_events').value).toBe(1);
  });

  test('moving an event to another player directly is refused by the foreign key (it never leaves its own player\'s session)', () => {
    const db = seeded();
    const e = thrown(() => db.run("UPDATE session_events SET player_id = 'p2'"));
    expect(e.message).toMatch(/FOREIGN KEY constraint failed/);
    expect(one<{ player_id: string }>(db, 'SELECT player_id FROM session_events').player_id).toBe('p1');
  });

  test('the re-key exemption is exactly "player_id and nothing else": with foreign keys OFF (the trigger alone answers) no other column may change alongside it', () => {
    const db = new Database(':memory:');
    opened.push(db);
    copy005(five);
    migrate(db, five);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(0);
    addProfile(db);
    addSession(db);
    addEvent(db, { client_uuid: uuid(1), item_id: 'i1', value: 1 }); // every column set
    addEvent(db, { client_uuid: uuid(2), item_id: null, value: null }); // the nullable columns NULL
    const alternative: Record<string, Cell> = {
      id: 99, session_id: 's1b', client_uuid: uuid(77), type: 'drill_undone', at: T2, received_at: T2,
    };
    const before = rows(db, 'SELECT * FROM session_events ORDER BY id');

    for (const column of ['id', 'session_id', 'client_uuid', 'type', 'item_id', 'value', 'at', 'received_at']) {
      for (const [uuidOf, nullable] of [[uuid(1), false], [uuid(2), true]] as const) {
        // A NULL column becomes a value and a value becomes NULL: the comparison must be NULL-safe.
        const next: Cell = column in alternative ? (alternative[column] as Cell) : nullable ? (column === 'item_id' ? 'i9' : 2) : null;
        const e = thrown(() => db.run(`UPDATE session_events SET player_id = 'p-other', ${column} = ? WHERE client_uuid = ?`, [next, uuidOf]));
        expect(e.message, `${column} on ${uuidOf}`).toMatch(/session_events is append-only/);
      }
    }
    expect(rows(db, 'SELECT * FROM session_events ORDER BY id')).toEqual(before);

    // The one allowed shape, for contrast: player_id alone.
    db.run("UPDATE session_events SET player_id = 'p-other' WHERE client_uuid = ?", [uuid(1)]);
    expect(one<{ player_id: string }>(db, 'SELECT player_id FROM session_events WHERE client_uuid = ?', uuid(1)).player_id).toBe('p-other');
  });

  test('INSERT stays possible, and a direct DELETE is not blocked (erasure and cascade must work; only UPDATE is guarded)', () => {
    const db = seeded();
    addEvent(db, { client_uuid: uuid(2) });
    expect(count(db, 'session_events')).toBe(2);
    db.run('DELETE FROM session_events WHERE client_uuid = ?', [uuid(2)]);
    expect(count(db, 'session_events')).toBe(1);
  });

  test('re-keying a profile (POST /api/player/recover, ON UPDATE CASCADE) moves the sessions and events without touching the content', () => {
    const db = seeded();
    addEvent(db, { client_uuid: uuid(2), value: 7 });
    const contentBefore = rows(db, 'SELECT id, session_id, client_uuid, type, item_id, value, at, received_at FROM session_events ORDER BY id');

    db.run("UPDATE player_profiles SET player_id = 'p1-new' WHERE player_id = 'p1'");

    expect(rows(db, 'SELECT id, session_id, client_uuid, type, item_id, value, at, received_at FROM session_events ORDER BY id')).toEqual(contentBefore);
    expect(rows<{ player_id: string }>(db, 'SELECT DISTINCT player_id FROM session_events')).toEqual([{ player_id: 'p1-new' }]);
    expect(rows<{ player_id: string }>(db, "SELECT DISTINCT player_id FROM sessions WHERE id IN ('s1', 's1b')")).toEqual([{ player_id: 'p1-new' }]);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
    // The log is still guarded after the re-key.
    expect(thrown(() => db.run('UPDATE session_events SET value = 0')).message).toMatch(/append-only/);
  });
});

// --- cascade ---------------------------------------------------------------------------------------------

describe('005_sessions: cascade on profile delete (privacy erasure)', () => {
  test('foreign_keys is ON in the app\'s database helper, which is what the cascade tests below rely on', () => {
    const db = migrated('five');
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(1);
  });

  test('deleting a profile deletes its sessions and all their events, and only those', () => {
    const db = migrated();
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(1); // the test is void with the pragma off
    seedTwoPlayers(db);
    expect(count(db, 'sessions')).toBe(2);
    expect(count(db, 'session_events')).toBe(4);

    db.run("DELETE FROM player_profiles WHERE player_id = 'p1'");

    expect(count(db, 'sessions', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'session_events', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'sessions', "player_id = 'p2'")).toBe(1);
    expect(count(db, 'session_events', "player_id = 'p2'")).toBe(2);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('deleting a session deletes its events (composite FK ON DELETE CASCADE) and no other session\'s', () => {
    const db = migrated();
    seedTwoPlayers(db);
    addSession(db, { id: 's1b', date: '2026-01-06' });
    addEvent(db, { session_id: 's1b', client_uuid: uuid(50) });

    db.run("DELETE FROM sessions WHERE id = 's1'");

    expect(count(db, 'session_events', "session_id = 's1'")).toBe(0);
    expect(count(db, 'session_events', "session_id = 's1b'")).toBe(1);
    expect(count(db, 'session_events', "session_id = 's2'")).toBe(2);
  });

  test('the events cascade even though session_events is append-only (there is no DELETE trigger)', () => {
    const db = migrated();
    seedTwoPlayers(db);
    expect(thrown(() => db.run('UPDATE session_events SET value = 1')).message).toMatch(/append-only/);
    db.run('DELETE FROM player_profiles');
    expect(count(db, 'session_events')).toBe(0);
    expect(count(db, 'sessions')).toBe(0);
  });

  test('control: with foreign_keys OFF the cascade does not happen (so the tests above really depend on the pragma)', () => {
    const db = new Database(':memory:');
    opened.push(db);
    copy005(five);
    migrate(db, five);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(0);
    seedTwoPlayers(db);

    db.run("DELETE FROM player_profiles WHERE player_id = 'p1'");

    expect(count(db, 'sessions', "player_id = 'p1'")).toBe(1); // orphaned: nothing cascaded
    expect(count(db, 'session_events', "player_id = 'p1'")).toBe(2);
  });

  test('INSERT OR REPLACE on a session deletes the old row first and so wipes its events; ON CONFLICT DO UPDATE keeps them', () => {
    const db = migrated();
    seedTwoPlayers(db);

    db.run(
      `INSERT INTO sessions (id, player_id, date, planner, graph_version, items) VALUES ('s1', 'p1', '2026-01-05', 'ai', '1.0.0', '[]')
       ON CONFLICT (id) DO UPDATE SET planner = excluded.planner, items = excluded.items`,
    );
    expect(one<{ planner: string }>(db, "SELECT planner FROM sessions WHERE id = 's1'").planner).toBe('ai');
    expect(count(db, 'session_events', "session_id = 's1'")).toBe(2);

    // The hazard the header warns about: REPLACE is DELETE + INSERT, and the DELETE cascades.
    db.run(`INSERT OR REPLACE INTO sessions (id, player_id, date, planner, graph_version, items) VALUES ('s1', 'p1', '2026-01-05', 'rules', '1.0.0', '[]')`);
    expect(count(db, 'session_events', "session_id = 's1'")).toBe(0);
  });
});
