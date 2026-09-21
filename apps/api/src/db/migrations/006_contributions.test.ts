import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_STATES,
  ContributionPayloadRequest,
  ContributionPayloadView,
  IMPROVEMENT_KINDS,
} from '../../shared/contributions';
import { EntityId, MEDIA_KINDS } from '../../shared/primitives';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '006_contributions.sql';
const FRAMEWORK_FILES = ['001_commons.sql', '002_player.sql', '003_settings.sql', '004_test_thresholds.sql', '005_sessions.sql'];

/** The tables this migration owns. The "own tables" test derives them from the schema and compares. */
const CONTRIBUTION_TABLES = ['contribution_attachments', 'contributions'];

/** Better Auth's tables: created by its own migrator at route-register time, never by ours. */
const BETTER_AUTH_TABLES = ['user', 'session', 'account', 'verification'];

/** 005's tables: 006 must not reuse or shadow them. */
const SESSION_TABLES = ['sessions', 'session_events'];

/** The contract's enums, taken from the contract constants (not restated): the CHECK lists must equal them. */
const STATES: readonly string[] = CONTRIBUTION_STATES;
const KINDS: readonly string[] = CONTRIBUTION_KINDS;
const IMPROVEMENTS: readonly string[] = IMPROVEMENT_KINDS;
const MEDIA: readonly string[] = MEDIA_KINDS;

interface ColumnShape {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1;
}

/** The exact shape of the two new tables, in declaration order. */
const CONTRIBUTIONS_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'target_drill_id', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'improvement_kind', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'payload', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'origin', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'submitter_user_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'reviewer_note', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'content_hash', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'resulting_drill_id', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
];
const ATTACHMENTS_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'contribution_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'stored_path', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'mime', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'bytes', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'original_name', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
];
const CONTRIBUTIONS_REQUIRED = ['id', 'kind', 'payload', 'state', 'origin', 'submitter_user_id', 'content_hash', 'created_at', 'updated_at'];
const CONTRIBUTIONS_NULLABLE = ['target_drill_id', 'improvement_kind', 'reviewer_note', 'resulting_drill_id'];
const ATTACHMENTS_REQUIRED = ['id', 'contribution_id', 'kind', 'stored_path', 'mime', 'bytes', 'original_name', 'created_at'];

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:05:00.000Z';
const T2 = '2026-01-01T00:10:00.000Z';

/** Timestamp spellings the column CHECKs must refuse (the same list as 002/005: only canonical ms-UTC is stored). */
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

/** Text that is nothing but whitespace, whitespace being space, tab, newline and carriage return. */
const BLANKS = ['', ' ', '  ', '\t', '\n', '\r', ' \t\r\n '];

let tmp: string;
let five: string;
let six: string;
let withLater: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'contributions-migration-'));
  for (const dir of ['five', 'six', 'with-later']) {
    mkdirSync(join(tmp, dir));
    for (const file of FRAMEWORK_FILES) copyFileSync(join(MIGRATIONS_DIR, file), join(tmp, dir, file));
  }
  five = join(tmp, 'five'); // 001-005: what exists before 006
  six = join(tmp, 'six'); // 001-005 + a copy of 006 (the runner forbids gaps, so 006 cannot sit alone)
  withLater = join(tmp, 'with-later'); // 001-006 + a hypothetical 007 that only adds things
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

type Which = 'all' | 'five' | 'six' | 'later';

/** Copies 006 into a scratch dir on demand, so a missing file fails the test that needs it (not every test). */
function copy006(dir: string): void {
  copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
}

/**
 * A migrated in-memory database opened like production (foreign_keys ON). 'all' applies the real
 * MIGRATIONS_DIR; 'five' copies of 001-005 (no 006); 'six' copies of 001-006 alone; 'later' adds a
 * scratch 007_x.sql that does what a later migration may do: ADD COLUMN on both tables plus a table
 * that references contributions.
 */
function migrated(which: Which = 'all'): Database {
  const db = openDatabase(':memory:');
  opened.push(db);
  if (which === 'all') {
    migrate(db);
  } else if (which === 'five') {
    migrate(db, five);
  } else if (which === 'six') {
    copy006(six);
    migrate(db, six);
  } else {
    copy006(withLater);
    writeFileSync(
      join(withLater, '007_x.sql'),
      [
        'ALTER TABLE contributions ADD COLUMN note TEXT;',
        'ALTER TABLE contribution_attachments ADD COLUMN note TEXT;',
        'CREATE TABLE contribution_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, contribution_id TEXT NOT NULL REFERENCES contributions (id) ON DELETE CASCADE) STRICT;',
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

/** The tables 006 creates: what 001-006 have beyond 001-005. Independent of any later migration. */
function ownTables(): string[] {
  const before = tableNames(migrated('five'));
  return tableNames(migrated('six')).filter((t) => !before.includes(t));
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

/** The named (non-auto) indexes of `table`: name -> column list. */
function namedIndexes(db: Database, table: string): Record<string, string[]> {
  const list = rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite\\_autoindex%' ESCAPE '\\' ORDER BY name", table);
  return Object.fromEntries(list.map((i) => [i.name, rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${i.name}') ORDER BY seqno`).map((c) => c.name)]));
}

const triggersOn = (db: Database, table: string): { name: string; sql: string }[] =>
  rows<{ name: string; sql: string }>(db, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name", table);

const plan = (db: Database, sql: string, ...params: Cell[]): string =>
  rows<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, ...params)
    .map((r) => r.detail)
    .join(' | ');

const headerOf = (): string =>
  readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('--'))
    .join('\n');

// --- fixtures ------------------------------------------------------------------------------

/** A sha256 hex digest, distinct per n: what content_hash holds (sha256 of the canonical payload). */
const hash = (n: number): string => createHash('sha256').update(`payload-${n}`).digest('hex');

const PAYLOAD = JSON.stringify({ kind: 'new', name: 'Wall passing', locale: 'ru' });

function insertRow(db: Database, table: string, row: Record<string, Cell>): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
}

/** A sport and drills d1, d2 (published) and d3 (unpublished: soft-deleted, still a row). */
function addDrills(db: Database): void {
  db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp1', 'football', '{"en":"Football"}', '1.0.0')`);
  db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
  db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d2', 'drill-two', 'sp1')`);
  db.run(`INSERT INTO drills (id, slug, sport_id, unpublished_at) VALUES ('d3', 'drill-three', 'sp1', '${T0}')`);
}

/** A complete 'new' contribution row; override any column. */
function contributionRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    id: 'c1',
    kind: 'new',
    target_drill_id: null,
    improvement_kind: null,
    payload: PAYLOAD,
    state: 'pending',
    origin: 'form',
    submitter_user_id: 'user-1',
    reviewer_note: null,
    content_hash: hash(1),
    resulting_drill_id: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

function attachmentRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    id: 'a1',
    contribution_id: 'c1',
    kind: 'video',
    stored_path: 'contributions/c1/a1.mp4',
    mime: 'video/mp4',
    bytes: 1048576,
    original_name: 'my drill.mp4',
    created_at: T0,
    ...over,
  };
}

const addContribution = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'contributions', contributionRow(over));
const addAttachment = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'contribution_attachments', attachmentRow(over));

/** An improvement of d1 (needs the drills). */
const improvement = (over: Record<string, Cell> = {}): Record<string, Cell> => ({ kind: 'improvement', target_drill_id: 'd1', ...over });

/** Drills plus contribution c1 (by user-1). */
function withContribution(which: Which = 'all'): Database {
  const db = migrated(which);
  addDrills(db);
  addContribution(db);
  return db;
}

/** Two contributions, each with two attachments, so cascade tests have something to lose and to keep. */
function seedTwo(db: Database): void {
  addDrills(db);
  for (const [c, n] of [['c1', 0], ['c2', 10]] as const) {
    addContribution(db, { id: c, content_hash: hash(n) });
    addAttachment(db, { id: `${c}-a1`, contribution_id: c, stored_path: `contributions/${c}/1.mp4` });
    addAttachment(db, { id: `${c}-a2`, contribution_id: c, stored_path: `contributions/${c}/2.png`, kind: 'image', mime: 'image/png' });
  }
}

/**
 * The schema assertions that must hold on ANY database built from the real migrations, whatever is
 * applied after 006: named tables and columns only, POSITIVE (this column is NOT NULL, that CHECK
 * exists, this trigger fires), never "the table has exactly these columns": a later
 * ALTER TABLE ... ADD COLUMN is legitimate and must not break them.
 */
function expectContributionsContract(db: Database): void {
  expect(checkList(db, 'contributions', 'kind')).toEqual([...KINDS]);
  expect(checkList(db, 'contributions', 'state')).toEqual([...STATES]);
  expect(checkList(db, 'contributions', 'improvement_kind')).toEqual([...IMPROVEMENTS]);
  expect(checkList(db, 'contribution_attachments', 'kind')).toEqual([...MEDIA]);
  for (const table of CONTRIBUTION_TABLES) {
    expect(one<{ strict: number }>(db, 'SELECT strict FROM pragma_table_list WHERE name = ?', table).strict, `${table} STRICT`).toBe(1);
  }
  expect(notNullColumns(db, 'contributions')).toEqual(expect.arrayContaining(CONTRIBUTIONS_REQUIRED));
  expect(notNullColumns(db, 'contribution_attachments')).toEqual(expect.arrayContaining(ATTACHMENTS_REQUIRED));
  expect(nullableColumns(db, 'contributions')).toEqual(expect.arrayContaining(CONTRIBUTIONS_NULLABLE));

  addDrills(db);
  addContribution(db, { id: 'k1' });
  addContribution(db, improvement({ id: 'k2' }));
  expect(thrown(() => addContribution(db, { id: 'k3', kind: 'improvement' })).message).toMatch(/CHECK constraint failed/);
  expect(thrown(() => addContribution(db, { id: 'k4', target_drill_id: 'd1' })).message).toMatch(/CHECK constraint failed/);
  expect(thrown(() => addContribution(db, { id: 'k5', state: 'archived' })).message).toMatch(/CHECK constraint failed/);
  expect(thrown(() => addContribution(db, { id: 'k6', resulting_drill_id: 'd1' })).message).toMatch(/CHECK constraint failed/);
  addAttachment(db, { id: 'ka', contribution_id: 'k1', stored_path: 'contract/1' });
  expect(thrown(() => addAttachment(db, { id: 'kb', contribution_id: 'k1', stored_path: 'contract/1' })).message).toMatch(
    /UNIQUE constraint failed: contribution_attachments\.stored_path/,
  );
  expect(thrown(() => addAttachment(db, { id: 'kc', contribution_id: 'ghost', stored_path: 'contract/2' })).message).toMatch(/FOREIGN KEY constraint failed/);
  expect(thrown(() => db.run("UPDATE contributions SET submitter_user_id = 'someone-else' WHERE id = 'k1'")).message).toMatch(/immutable/i);
  db.run("DELETE FROM contributions WHERE id = 'k1'");
  expect(count(db, 'contribution_attachments', "contribution_id = 'k1'")).toBe(0);
}

// --- the migration ---------------------------------------------------------------------------

describe('006_contributions: migration', () => {
  test('applies through the real runner and MIGRATIONS_DIR, as version 6, after 001-005', () => {
    const db = openDatabase(join(tmp, 'real.db'));
    opened.push(db);

    const applied = migrate(db);

    expect(applied.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(one<{ name: string }>(db, 'SELECT name FROM schema_migrations WHERE version = 6').name).toBe('006_contributions');
    for (const table of CONTRIBUTION_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('applies on top of a database that already has 001-005 (the upgrade path), and only 006 is applied', () => {
    const db = migrated('five');
    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(5);
    expect(tableNames(db)).not.toContain('contributions');

    copy006(five);
    expect(migrate(db, five)).toEqual([6]);
    for (const table of CONTRIBUTION_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('a copy of 001-006 alone in a temp dir applies and passes the whole contract', () => {
    const db = migrated('six');
    expect(rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expectContributionsContract(db);
  });

  test('the real migrations also pass the contract', () => {
    expectContributionsContract(migrated('all'));
  });

  test('sits next to its own test, and every .sql in the directory is an NNN_name.sql migration', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(SQL_FILE);
    expect(files).toContain('006_contributions.test.ts');
    expect(files.filter((f) => f.endsWith('.sql')).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test("creates exactly contributions and contribution_attachments, and none of Better Auth's or 005's names (nor one that differs only by case)", () => {
    const own = ownTables();

    expect(own).toEqual([...CONTRIBUTION_TABLES].sort());
    const taken = new Set([...BETTER_AUTH_TABLES, ...SESSION_TABLES].map((t) => t.toLowerCase()));
    for (const table of own) expect(taken.has(table.toLowerCase()), table).toBe(false);
    // Better Auth creates its tables after migrate(): a migrate-only database has none of them.
    const db = migrated('six');
    expect(tableNames(db).filter((t) => BETTER_AUTH_TABLES.includes(t))).toEqual([]);
  });

  test("Better Auth's tables can be created next to ours (no collision, no interference), and no column links to them", () => {
    const db = migrated('six');
    db.run('CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT)');
    db.run('CREATE TABLE "session" (id TEXT PRIMARY KEY, token TEXT, userId TEXT REFERENCES "user" (id) ON DELETE CASCADE)');
    db.run('CREATE TABLE "account" (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE "verification" (id TEXT PRIMARY KEY)');
    expect(tableNames(db)).toEqual(expect.arrayContaining(['contributions', 'contribution_attachments', 'sessions', 'session', 'user']));
    // Our tables reference each other and drills, never Better Auth's user.
    const targets = [...foreignKeys(db, 'contributions'), ...foreignKeys(db, 'contribution_attachments')].map((fk) => fk.table);
    expect(targets.every((t) => ['drills', 'contributions'].includes(t))).toBe(true);
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
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/\bREPLACE\b/i);
  });

  test('the header comment documents the conventions and the hazards for later authors', () => {
    const header = headerOf();
    expect(header.length).toBeGreaterThan(0);
    expect(header).toMatch(/Better Auth/);
    expect(header).toMatch(/submitter_user_id/);
    expect(header).toMatch(/NO (foreign key|FK)/i);
    expect(header).toMatch(/erasure/i);
    expect(header).toMatch(/collide|collision/i);
    expect(header).toMatch(/INSERT OR REPLACE/);
    expect(header).toMatch(/UPDATE OR REPLACE/);
    expect(header).toMatch(/ON CONFLICT/);
    expect(header).toMatch(/cascade/i);
    expect(header).toMatch(/foreign_keys/);
    expect(header).toMatch(/DROP TABLE/);
    expect(header).toMatch(/rebuild/i);
    expect(header).toMatch(/ADD COLUMN/);
    expect(header).toMatch(/hour 24/i);
    expect(header).toMatch(/whitespace/i);
    expect(header).toMatch(/\bIS\b/);
    expect(header).toMatch(/contributions_immutable/);
    expect(header).toMatch(/drills/);
    expect(header).toMatch(/NO ACTION/);
    expect(header).toMatch(/origin/);
    expect(header).toMatch(/content_hash/);
    expect(header).toMatch(/sha256/i);
    expect(header).toMatch(/stored_path/);
    expect(header).toMatch(/orphan|sweep/i);
  });

  test('the header documents the mutable-table hazards: UPDATE OR REPLACE on attachments, and INSERT OR REPLACE bypassing the trigger', () => {
    const header = headerOf();
    expect(header).toMatch(/UPDATE OR REPLACE contribution_attachments/);
    expect(header).toMatch(/bypass/i);
    expect(header).toMatch(/mutable/i);
  });

  test('re-running is a no-op and the recorded checksum is the sha256 of the file bytes, unchanged', () => {
    const db = migrated('all');
    const before = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 6').checksum;
    const schemaBefore = rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const after = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 6').checksum;
    expect(after).toBe(before);
    expect(before).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schemaBefore);
  });

  test('applies exactly once: one schema_migrations row for version 6, and a second run does not touch the data', () => {
    const db = withContribution('six');
    addAttachment(db);
    expect(migrate(db, six)).toEqual([]);
    expect(count(db, 'schema_migrations', 'version = 6')).toBe(1);
    expect(count(db, 'contributions')).toBe(1);
    expect(count(db, 'contribution_attachments')).toBe(1);
  });

  test('the migration itself does not depend on the foreign_keys pragma (a connection with it OFF migrates to the same schema)', () => {
    const off = new Database(':memory:');
    opened.push(off);
    expect(one<{ foreign_keys: number }>(off, 'PRAGMA foreign_keys').foreign_keys).toBe(0);
    copy006(six);
    migrate(off, six);

    const on = migrated('six');
    const schema = (d: Database) => rows(d, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
    expect(schema(off)).toEqual(schema(on));
  });

  test('a later 007_x.sql that ADDs COLUMNs to both tables and adds a cascading table does not break the contributions contract', () => {
    const db = migrated('later');
    expect(tableNames(db)).toEqual(expect.arrayContaining(['contributions', 'contribution_attachments', 'contribution_audit']));
    expect(nullableColumns(db, 'contributions')).toContain('note');
    expect(notNullColumns(db, 'contributions')).toEqual(expect.arrayContaining(CONTRIBUTIONS_REQUIRED));
    expectContributionsContract(db);
  });
});

// --- exact shape (alone) -----------------------------------------------------------------------

describe('006_contributions: exact shape of the two new tables (001-006 alone)', () => {
  test('contributions has exactly these columns, types and nullability', () => {
    expect(columnShape(migrated('six'), 'contributions')).toEqual(CONTRIBUTIONS_COLUMNS);
  });

  test('contribution_attachments has exactly these columns, types and nullability', () => {
    expect(columnShape(migrated('six'), 'contribution_attachments')).toEqual(ATTACHMENTS_COLUMNS);
  });

  test('both are STRICT', () => {
    const db = migrated('six');
    for (const table of CONTRIBUTION_TABLES) {
      expect(one<{ strict: number }>(db, 'SELECT strict FROM pragma_table_list WHERE name = ?', table).strict).toBe(1);
    }
  });

  test('foreign keys: target_drill_id and resulting_drill_id to drills(id) with NO ACTION (drills are never hard-deleted); attachments cascade from contributions', () => {
    const db = migrated('six');
    const fks = foreignKeys(db, 'contributions');
    expect(fks).toHaveLength(2);
    expect(fks).toContainEqual({ from: ['target_drill_id'], table: 'drills', to: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
    expect(fks).toContainEqual({ from: ['resulting_drill_id'], table: 'drills', to: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
    expect(foreignKeys(db, 'contribution_attachments')).toEqual([
      { from: ['contribution_id'], table: 'contributions', to: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' },
    ]);
  });

  test('submitter_user_id has NO foreign key (Better Auth\'s user table does not exist at migrate time)', () => {
    const db = migrated('six');
    expect(foreignKeys(db, 'contributions').flatMap((fk) => fk.from)).not.toContain('submitter_user_id');
    expect(tableNames(db)).not.toContain('user');
  });

  test('unique indexes: attachments stored_path (the sweep matches files by path); contributions content_hash is NOT unique', () => {
    const db = migrated('six');
    expect(uniqueIndexes(db, 'contribution_attachments')).toContainEqual(['stored_path']);
    expect(uniqueIndexes(db, 'contributions')).not.toContainEqual(['content_hash']);
    expect(namedIndexes(db, 'contributions').contributions_by_content_hash).toEqual(['content_hash']);
  });

  test('the named indexes are exactly these (positive on the tables alone)', () => {
    const db = migrated('six');
    expect(namedIndexes(db, 'contributions')).toEqual({
      contributions_by_content_hash: ['content_hash'],
      contributions_by_state: ['state', 'created_at', 'id'],
      contributions_by_submitter: ['submitter_user_id', 'created_at', 'id'],
    });
    expect(namedIndexes(db, 'contribution_attachments')).toEqual({
      contribution_attachments_by_contribution: ['contribution_id', 'created_at', 'id'],
    });
  });

  test('the indexes exist by name on any database built from the real migrations (positive, later migrations may add more)', () => {
    const db = migrated('later');
    const names = rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'contributions_by_submitter',
        'contributions_by_state',
        'contributions_by_content_hash',
        'contribution_attachments_by_contribution',
      ]),
    );
  });

  test('the obvious queries use their index with no temp b-tree: my contributions, the moderation queue, duplicate lookup, attachments of one contribution', () => {
    const db = migrated('six');

    const mine = plan(db, 'SELECT id, state FROM contributions WHERE submitter_user_id = ? ORDER BY created_at DESC, id DESC', 'u1');
    expect(mine).toContain('contributions_by_submitter');
    expect(mine).not.toMatch(/TEMP B-TREE/i);

    const mineAsc = plan(db, 'SELECT id FROM contributions WHERE submitter_user_id = ? ORDER BY created_at', 'u1');
    expect(mineAsc).toContain('contributions_by_submitter');
    expect(mineAsc).not.toMatch(/TEMP B-TREE/i);

    const queue = plan(db, 'SELECT id FROM contributions WHERE state = ? ORDER BY created_at, id', 'pending');
    expect(queue).toContain('contributions_by_state');
    expect(queue).not.toMatch(/TEMP B-TREE/i);

    const dup = plan(db, 'SELECT id FROM contributions WHERE content_hash = ?', hash(1));
    expect(dup).toContain('contributions_by_content_hash');

    const files = plan(db, 'SELECT id FROM contribution_attachments WHERE contribution_id = ? ORDER BY created_at, id', 'c1');
    expect(files).toContain('contribution_attachments_by_contribution');
    expect(files).not.toMatch(/TEMP B-TREE/i);
  });

  test('contributions carries exactly one trigger (BEFORE UPDATE, ABORT); the attachments none; no DELETE trigger anywhere, so cascades and erasure work', () => {
    const db = migrated('six');
    const triggers = triggersOn(db, 'contributions');
    expect(triggers.map((t) => t.name)).toEqual(['contributions_immutable']);
    expect(triggers[0]?.sql).toMatch(/BEFORE UPDATE/i);
    expect(triggers[0]?.sql).toMatch(/RAISE\s*\(\s*ABORT/i);
    expect(triggersOn(db, 'contribution_attachments')).toEqual([]);
    const all = rows<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('contributions', 'contribution_attachments')");
    for (const t of all) expect(t.sql).not.toMatch(/DELETE/i);
  });

  test('the enum CHECK lists equal the contract constants (parsed out of sqlite_master, not restated)', () => {
    const db = migrated('six');
    expect(KINDS.length).toBeGreaterThan(0);
    expect(STATES.length).toBeGreaterThan(0);
    expect(IMPROVEMENTS.length).toBeGreaterThan(0);
    expect(MEDIA.length).toBeGreaterThan(0);
    expect(checkList(db, 'contributions', 'kind')).toEqual([...KINDS]);
    expect(checkList(db, 'contributions', 'state')).toEqual([...STATES]);
    expect(checkList(db, 'contributions', 'improvement_kind')).toEqual([...IMPROVEMENTS]);
    expect(checkList(db, 'contribution_attachments', 'kind')).toEqual([...MEDIA]);
  });

  test('origin has no enum CHECK: it is free text on purpose (the seam for later ingestion sources)', () => {
    const db = migrated('six');
    expect(createSql(db, 'contributions')).toMatch(/\borigin\b/); // the column exists (a missing table must not pass this test)
    expect(() => checkList(db, 'contributions', 'origin')).toThrow(/no "origin IN/);
  });
});

// --- contributions -----------------------------------------------------------------------------

describe('006_contributions: contributions', () => {
  test('a valid row stores every column as given', () => {
    const db = migrated();
    addDrills(db);
    const row = contributionRow(improvement({ improvement_kind: 'translation', reviewer_note: 'please add kk', state: 'changes_requested', origin: 'form', updated_at: T1 }));
    insertRow(db, 'contributions', row);
    expect(one(db, 'SELECT * FROM contributions WHERE id = ?', 'c1')).toEqual(row);
  });

  test('state defaults to pending and origin to form when omitted; the other defaults are absent', () => {
    const db = migrated();
    insertRow(db, 'contributions', { id: 'c1', kind: 'new', payload: PAYLOAD, submitter_user_id: 'user-1', content_hash: hash(1) });
    const row = one<Record<string, unknown>>(db, 'SELECT * FROM contributions WHERE id = ?', 'c1');
    expect(row.state).toBe('pending');
    expect(row.origin).toBe('form');
    expect(row.target_drill_id).toBeNull();
    expect(row.improvement_kind).toBeNull();
    expect(row.reviewer_note).toBeNull();
    expect(row.resulting_drill_id).toBeNull();
  });

  test('the column defaults are declared: state = pending, origin = form', () => {
    const db = migrated();
    const defaults = Object.fromEntries(
      rows<{ name: string; dflt_value: string | null }>(db, "SELECT name, dflt_value FROM pragma_table_info('contributions')").map((r) => [r.name, r.dflt_value]),
    );
    expect(defaults.state).toBe("'pending'");
    expect(defaults.origin).toBe("'form'");
  });

  test('created_at and updated_at default to the server\'s canonical UTC now, within 5 s, and updated_at is not before created_at', () => {
    const db = migrated();
    insertRow(db, 'contributions', { id: 'c1', kind: 'new', payload: PAYLOAD, submitter_user_id: 'user-1', content_hash: hash(1) });
    const row = one<{ created_at: string; updated_at: string }>(db, 'SELECT created_at, updated_at FROM contributions');
    for (const value of [row.created_at, row.updated_at]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Math.abs(Date.now() - new Date(value).getTime())).toBeLessThan(5000);
    }
    expect(row.updated_at >= row.created_at).toBe(true);
  });

  test('the id is the primary key: a duplicate id is rejected', () => {
    const db = withContribution();
    expect(thrown(() => addContribution(db, { content_hash: hash(2) })).message).toMatch(/UNIQUE constraint failed: contributions\.id/);
  });

  test('the id is an EntityId: 1-128 characters of [A-Za-z0-9._-] (parity with the contract)', () => {
    const db = migrated();
    const candidates = ['c1', 'a', 'A_b.c-d', '-x', '_y', 'x'.repeat(128), 'x'.repeat(129), '', ' c1', 'c 1', 'c/1', 'c1\n', 'cé', 'c1;'];
    for (const id of candidates) {
      const ok = accepted(() => addContribution(db, { id }));
      expect(ok, JSON.stringify(id)).toBe(EntityId.safeParse(id).success);
    }
  });

  test('every required column is NOT NULL', () => {
    const db = migrated();
    for (const column of CONTRIBUTIONS_REQUIRED) {
      expect(thrown(() => addContribution(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: contributions\\.${column}\\b`));
    }
    expect(count(db, 'contributions')).toBe(0);
    addContribution(db); // the four nullable columns are NULL here
  });

  test('kind: only the contract\'s values; NULL, blank and other spellings are rejected', () => {
    const db = withContribution();
    let n = 10;
    for (const kind of KINDS) {
      const over = kind === 'improvement' ? improvement({ id: `k-${kind}` }) : { id: `k-${kind}` };
      addContribution(db, { ...over, content_hash: hash(++n) });
    }
    for (const kind of ['', ' ', 'New', 'IMPROVEMENT', 'improve', 'update', 'new ']) {
      expect(thrown(() => addContribution(db, { id: 'bad', kind })).message, JSON.stringify(kind)).toMatch(/CHECK constraint failed/);
    }
  });

  test('kind and target_drill_id agree, in both directions: an improvement names a drill, a new one names none', () => {
    const db = migrated();
    addDrills(db);
    addContribution(db, { id: 'new-ok' }); // new, no target
    addContribution(db, improvement({ id: 'imp-ok' })); // improvement, with target
    // improvement without a target
    expect(thrown(() => addContribution(db, { id: 'imp-no-target', kind: 'improvement', target_drill_id: null })).message).toMatch(/CHECK constraint failed/);
    // new with a target (the drill exists, so only the CHECK can refuse it)
    expect(thrown(() => addContribution(db, { id: 'new-target', kind: 'new', target_drill_id: 'd1' })).message).toMatch(/CHECK constraint failed/);
    expect(count(db, 'contributions')).toBe(2);
    // an unpublished drill is still a row and can be improved
    addContribution(db, improvement({ id: 'imp-unpublished', target_drill_id: 'd3' }));
  });

  test('the kind/target rule also holds on UPDATE (an edit cannot turn an improvement into a target-less one, or the reverse)', () => {
    const db = migrated();
    addDrills(db);
    addContribution(db, { id: 'n' });
    addContribution(db, improvement({ id: 'i' }));
    expect(thrown(() => db.run("UPDATE contributions SET target_drill_id = 'd2' WHERE id = 'n'")).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => db.run("UPDATE contributions SET target_drill_id = NULL WHERE id = 'i'")).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => db.run("UPDATE contributions SET kind = 'new' WHERE id = 'i'")).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => db.run("UPDATE contributions SET kind = 'improvement' WHERE id = 'n'")).message).toMatch(/CHECK constraint failed/);
    db.run("UPDATE contributions SET target_drill_id = 'd2' WHERE id = 'i'"); // re-pointing an improvement is fine
    expect(one<{ target_drill_id: string }>(db, "SELECT target_drill_id FROM contributions WHERE id = 'i'").target_drill_id).toBe('d2');
  });

  test('target_drill_id must be an existing drill (foreign key on drills.id), and the drill cannot be hard-deleted while contributions point at it', () => {
    const db = migrated();
    addDrills(db);
    expect(thrown(() => addContribution(db, improvement({ target_drill_id: 'ghost' }))).message).toMatch(/FOREIGN KEY constraint failed/);
    addContribution(db, improvement());
    expect(thrown(() => db.run("DELETE FROM drills WHERE id = 'd1'")).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(count(db, 'contributions')).toBe(1);
    db.run("DELETE FROM drills WHERE id = 'd2'"); // an unreferenced drill deletes as before: 006 changes nothing about drills
  });

  test('improvement_kind: only for an improvement and optional there; only the contract\'s values', () => {
    const db = migrated();
    addDrills(db);
    let n = 10;
    addContribution(db, improvement({ id: 'imp-null', improvement_kind: null, content_hash: hash(++n) })); // optional
    for (const improvement_kind of IMPROVEMENTS) {
      addContribution(db, improvement({ id: `imp-${improvement_kind}`, improvement_kind, content_hash: hash(++n) }));
    }
    for (const bad of ['', ' ', 'Translation', 'other', 'translation ', 'new']) {
      expect(thrown(() => addContribution(db, improvement({ id: 'bad', improvement_kind: bad }))).message, JSON.stringify(bad)).toMatch(/CHECK constraint failed/);
    }
    // a kind='new' contribution has no improvement kind, even a valid one
    for (const improvement_kind of IMPROVEMENTS) {
      expect(thrown(() => addContribution(db, { id: 'bad-new', kind: 'new', improvement_kind })).message, improvement_kind).toMatch(/CHECK constraint failed/);
    }
    addContribution(db, { id: 'new-null', improvement_kind: null, content_hash: hash(++n) });
  });

  test('state: only the contract\'s values (all five); unknown, other-case, blank and NULL are rejected, on INSERT and on UPDATE', () => {
    const db = migrated();
    let n = 10;
    for (const state of STATES) addContribution(db, { id: `s-${state}`, state, content_hash: hash(++n) });
    expect(count(db, 'contributions')).toBe(STATES.length);
    for (const state of ['archived', 'Pending', 'PENDING', 'pending ', 'draft', 'approve', 'changes-requested', '', ' ']) {
      expect(thrown(() => addContribution(db, { id: 'bad', state })).message, JSON.stringify(state)).toMatch(/CHECK constraint failed/);
      expect(thrown(() => db.query("UPDATE contributions SET state = ? WHERE id = 's-pending'").run(state)).message, `update ${JSON.stringify(state)}`).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => addContribution(db, { id: 'bad', state: null })).message).toMatch(/NOT NULL constraint failed: contributions\.state/);
    expect(one<{ state: string }>(db, "SELECT state FROM contributions WHERE id = 's-pending'").state).toBe('pending');
  });

  test('a moderation transition is a plain UPDATE and works for every legal move of the state machine', () => {
    const db = withContribution();
    db.query("UPDATE contributions SET state = 'changes_requested', reviewer_note = 'add safety', updated_at = ? WHERE id = 'c1'").run(T1);
    db.query("UPDATE contributions SET state = 'pending', updated_at = ? WHERE id = 'c1'").run(T2);
    const row = one<{ state: string; reviewer_note: string; updated_at: string; created_at: string }>(db, "SELECT state, reviewer_note, updated_at, created_at FROM contributions WHERE id = 'c1'");
    expect(row).toEqual({ state: 'pending', reviewer_note: 'add safety', updated_at: T2, created_at: T0 });
  });

  test('resulting_drill_id only when approved: any other state with a resulting drill is rejected (INSERT and UPDATE); NULL is fine in every state', () => {
    const db = migrated();
    addDrills(db);
    let n = 10;
    for (const state of STATES) {
      addContribution(db, { id: `null-${state}`, state, resulting_drill_id: null, content_hash: hash(++n) });
      const ok = accepted(() => addContribution(db, { id: `res-${state}`, state, resulting_drill_id: 'd1', content_hash: hash(++n) }));
      expect(ok, state).toBe(state === 'approved');
    }
    // UPDATE: attaching a resulting drill without approving, and un-approving a row that has one
    expect(thrown(() => db.run("UPDATE contributions SET resulting_drill_id = 'd1' WHERE id = 'null-pending'")).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => db.run("UPDATE contributions SET state = 'pending' WHERE id = 'res-approved'")).message).toMatch(/CHECK constraint failed/);
    db.run("UPDATE contributions SET state = 'approved', resulting_drill_id = 'd2' WHERE id = 'null-pending'"); // approve and link in one UPDATE
    expect(one<{ resulting_drill_id: string }>(db, "SELECT resulting_drill_id FROM contributions WHERE id = 'null-pending'").resulting_drill_id).toBe('d2');
  });

  test('resulting_drill_id must be an existing drill (foreign key), and an improvement may resolve to the drill it improved', () => {
    const db = migrated();
    addDrills(db);
    expect(thrown(() => addContribution(db, { state: 'approved', resulting_drill_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
    addContribution(db, improvement({ id: 'imp', state: 'approved', resulting_drill_id: 'd1' }));
    expect(thrown(() => db.run("DELETE FROM drills WHERE id = 'd1'")).message).toMatch(/FOREIGN KEY constraint failed/);
  });

  test('origin: free text, non-blank; the seam for later ingestion sources (no enum beyond non-blank)', () => {
    const db = migrated();
    let n = 10;
    for (const origin of ['form', 'ai_ingest', 'anything at all', 'x']) {
      addContribution(db, { id: `o-${origin.length}`, origin, content_hash: hash(++n) });
    }
    for (const origin of BLANKS) {
      expect(thrown(() => addContribution(db, { id: 'bad', origin })).message, JSON.stringify(origin)).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => addContribution(db, { id: 'bad', origin: null })).message).toMatch(/NOT NULL constraint failed: contributions\.origin/);
  });

  test('submitter_user_id: non-blank text; NO foreign key, so it works on a migrate-only database with no "user" table', () => {
    const db = migrated();
    expect(tableNames(db)).not.toContain('user');
    addContribution(db, { submitter_user_id: 'RLJ3w9yZ0tQ7kEwq' }); // a Better Auth style id
    for (const [i, value] of BLANKS.entries()) {
      expect(thrown(() => addContribution(db, { id: `b${i}`, submitter_user_id: value })).message, JSON.stringify(value)).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => addContribution(db, { id: 'nul', submitter_user_id: null })).message).toMatch(/NOT NULL constraint failed: contributions\.submitter_user_id/);
    expect(thrown(() => db.run("UPDATE contributions SET submitter_user_id = ' ' WHERE id = 'c1'")).message).toMatch(/CHECK constraint failed|immutable/i);
  });

  test('reviewer_note: NULL, or non-blank text (whitespace-only is refused)', () => {
    const db = migrated();
    addContribution(db, { id: 'n1', reviewer_note: null });
    addContribution(db, { id: 'n2', reviewer_note: 'Add a safety note, then resubmit.' });
    addContribution(db, { id: 'n3', reviewer_note: ' padded ' });
    for (const [i, value] of BLANKS.entries()) {
      expect(thrown(() => addContribution(db, { id: `b${i}`, reviewer_note: value })).message, JSON.stringify(value)).toMatch(/CHECK constraint failed/);
    }
  });

  test('content_hash: exactly 64 lower-case hex characters (a sha256 digest); other lengths, upper case, non-hex, prefixes and blank are rejected', () => {
    const db = migrated();
    addContribution(db, { id: 'h1', content_hash: hash(1) });
    addContribution(db, { id: 'h2', content_hash: 'a'.repeat(64) });
    addContribution(db, { id: 'h3', content_hash: '0'.repeat(64) });
    const bad = [
      hash(1).slice(1), // 63
      `${hash(1)}0`, // 65
      hash(1).toUpperCase(),
      `${hash(1).slice(0, 63)}g`,
      `sha256:${hash(1)}`,
      ` ${hash(1).slice(1)}`, // 64 characters with a leading space
      `${hash(1).slice(0, 63)}\n`, // 64 characters, one a newline
      hash(1).replace(/^./, 'é'),
      '',
      ' ',
      'not-a-hash',
    ];
    for (const [i, content_hash] of bad.entries()) {
      expect(thrown(() => addContribution(db, { id: `bad${i}`, content_hash })).message, JSON.stringify(content_hash)).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => db.query("UPDATE contributions SET content_hash = ? WHERE id = 'h1'").run('xyz')).message).toMatch(/CHECK constraint failed/);
  });

  test('content_hash is NOT unique: a duplicate is stored (and flagged to the admin by the app), and a PUT may change the hash', () => {
    const db = migrated();
    addContribution(db, { id: 'dup1', content_hash: hash(7) });
    addContribution(db, { id: 'dup2', content_hash: hash(7), submitter_user_id: 'user-2' });
    expect(count(db, 'contributions', `content_hash = '${hash(7)}'`)).toBe(2);
    db.query("UPDATE contributions SET content_hash = ? WHERE id = 'dup2'").run(hash(8));
    expect(one<{ content_hash: string }>(db, "SELECT content_hash FROM contributions WHERE id = 'dup2'").content_hash).toBe(hash(8));
  });

  test('payload: a JSON object only; text that is not JSON, or another JSON type (array, string, number, null, bool), is rejected', () => {
    const db = migrated();
    addContribution(db, { id: 'p1', payload: '{}' });
    addContribution(db, { id: 'p2', payload: PAYLOAD });
    for (const [i, payload] of ['not json', '', ' ', '[]', '[{}]', '"text"', '1', 'null', 'true', '{', '{"a":1,}', "{'a':1}"].entries()) {
      expect(thrown(() => addContribution(db, { id: `bad${i}`, payload })).message, JSON.stringify(payload)).toMatch(/CHECK constraint failed/);
    }
  });

  test('a real ContributionPayloadRequest is stored verbatim and reads back through the contract\'s ContributionPayloadView', () => {
    const db = migrated();
    const request = ContributionPayloadRequest.parse({
      kind: 'new',
      locale: 'ru',
      name: 'Wall passing',
      sport: 'football',
      skill: 'passing',
      ageMin: 8,
      ageMax: 12,
      level: 'basic',
      goal: 'passing',
      instructions: 'Pass against the wall with the inside of the foot.',
      durationMin: 10,
      equipment: 'ball_wall',
      mistakes: '',
      progression: '',
      regression: '',
      safety: '',
      source: 'own practice',
      author: 'Coach A',
      rightsAttested: true,
      noCommercialContent: true,
    });
    const text = JSON.stringify(request);
    addContribution(db, { payload: text, content_hash: createHash('sha256').update(text).digest('hex') });
    const stored = one<{ payload: string }>(db, 'SELECT payload FROM contributions').payload;
    expect(stored).toBe(text);
    expect(ContributionPayloadView.parse(JSON.parse(stored)).name).toBe('Wall passing');
  });

  test('STRICT refuses a wrong storage class (BLOB payload, integer state, blob id)', () => {
    const db = migrated();
    expect(thrown(() => addContribution(db, { payload: new Uint8Array([123, 125]) })).message).toMatch(/cannot store BLOB value in TEXT column contributions\.payload|CHECK constraint failed|datatype mismatch/i);
    expect(thrown(() => addContribution(db, { id: 'i1', state: 1 })).message).toMatch(/cannot store INT.* value in TEXT column contributions\.state|datatype mismatch/i);
    expect(thrown(() => addContribution(db, { id: 'i2', submitter_user_id: 5 })).message).toMatch(/cannot store INT.* value in TEXT column|datatype mismatch/i);
    expect(count(db, 'contributions')).toBe(0);
  });

  test('created_at and updated_at: canonical ms-UTC text only; every other spelling is rejected (INSERT and UPDATE)', () => {
    const db = migrated();
    addContribution(db, { id: 'ok', created_at: '2026-12-31T23:59:59.999Z', updated_at: '2026-12-31T23:59:59.999Z' });
    for (const [i, value] of BAD_TIMESTAMPS.entries()) {
      // the other timestamp is chosen so that updated_at >= created_at holds: only the spelling can refuse the row
      expect(thrown(() => addContribution(db, { id: `c${i}`, created_at: value, updated_at: '2099-01-01T00:00:00.000Z' })).message, `created_at ${JSON.stringify(value)}`).toMatch(/CHECK constraint failed/);
      expect(thrown(() => addContribution(db, { id: `u${i}`, created_at: T0, updated_at: value })).message, `updated_at ${JSON.stringify(value)}`).toMatch(/CHECK constraint failed/);
      expect(thrown(() => db.query("UPDATE contributions SET updated_at = ? WHERE id = 'ok'").run(value)).message, `update ${JSON.stringify(value)}`).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => addContribution(db, { id: 'nul1', created_at: null })).message).toMatch(/NOT NULL constraint failed: contributions\.created_at/);
    expect(thrown(() => addContribution(db, { id: 'nul2', updated_at: null })).message).toMatch(/NOT NULL constraint failed: contributions\.updated_at/);
  });

  test('updated_at is never before created_at (equal and later are fine; a millisecond earlier is not), on INSERT and UPDATE', () => {
    const db = migrated();
    addContribution(db, { id: 'eq', created_at: T1, updated_at: T1 });
    addContribution(db, { id: 'later', created_at: T1, updated_at: T2 });
    addContribution(db, { id: 'ms', created_at: '2026-01-01T00:00:00.001Z', updated_at: '2026-01-01T00:00:00.002Z' });
    expect(thrown(() => addContribution(db, { id: 'early', created_at: T1, updated_at: T0 })).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => addContribution(db, { id: 'early-ms', created_at: '2026-01-01T00:00:00.001Z', updated_at: '2026-01-01T00:00:00.000Z' })).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => db.query("UPDATE contributions SET updated_at = ? WHERE id = 'later'").run(T0)).message).toMatch(/CHECK constraint failed/);
    expect(count(db, 'contributions')).toBe(3);
  });

  test('a contribution can be deleted (a withdraw may be a hard delete or a state change: both are possible)', () => {
    const db = withContribution();
    db.run("DELETE FROM contributions WHERE id = 'c1'");
    expect(count(db, 'contributions')).toBe(0);
  });
});

// --- the immutable-columns trigger ------------------------------------------------------------

describe('006_contributions: contributions_immutable (id, submitter_user_id, created_at never change)', () => {
  function seedForTrigger(): Database {
    const db = withContribution();
    addContribution(db, { id: 'c2', content_hash: hash(2), submitter_user_id: 'user-2' });
    addAttachment(db);
    return db;
  }

  const snapshot = (db: Database) => rows(db, 'SELECT * FROM contributions ORDER BY id');

  test('an UPDATE of id, submitter_user_id or created_at is aborted with a clear message and nothing changes', () => {
    const db = seedForTrigger();
    const before = snapshot(db);
    for (const sql of [
      "UPDATE contributions SET id = 'renamed' WHERE id = 'c1'",
      "UPDATE contributions SET submitter_user_id = 'someone-else' WHERE id = 'c1'",
      `UPDATE contributions SET created_at = '${T2}', updated_at = '${T2}' WHERE id = 'c1'`,
      "UPDATE contributions SET state = 'rejected', submitter_user_id = 'someone-else' WHERE id = 'c1'", // a legal change alongside an illegal one
    ]) {
      expect(thrown(() => db.run(sql)).message, sql).toMatch(/immutable/i);
    }
    expect(snapshot(db)).toEqual(before);
    expect(count(db, 'contribution_attachments', "contribution_id = 'c1'")).toBe(1);
  });

  test('a multi-row UPDATE that touches an immutable column is aborted as a whole', () => {
    const db = seedForTrigger();
    const before = snapshot(db);
    expect(thrown(() => db.run("UPDATE contributions SET submitter_user_id = 'shared'")).message).toMatch(/immutable/i);
    expect(snapshot(db)).toEqual(before);
  });

  test('every other column can change: state, payload, content_hash, reviewer_note, origin, improvement fields, resulting drill, updated_at', () => {
    const db = seedForTrigger();
    const newPayload = JSON.stringify({ kind: 'new', name: 'Edited' });
    db.query(
      "UPDATE contributions SET state = 'approved', payload = ?, content_hash = ?, reviewer_note = 'ok', origin = 'ai_ingest', resulting_drill_id = 'd1', updated_at = ? WHERE id = 'c1'",
    ).run(newPayload, hash(9), T2);
    const row = one<Record<string, unknown>>(db, "SELECT * FROM contributions WHERE id = 'c1'");
    expect(row).toMatchObject({ id: 'c1', submitter_user_id: 'user-1', created_at: T0, state: 'approved', payload: newPayload, content_hash: hash(9), reviewer_note: 'ok', origin: 'ai_ingest', resulting_drill_id: 'd1', updated_at: T2 });
  });

  test('a no-op assignment of the same value is allowed (NULL-safe IS NOT comparison, not "named in SET")', () => {
    const db = seedForTrigger();
    const before = snapshot(db);
    db.run("UPDATE contributions SET id = 'c1', submitter_user_id = 'user-1', created_at = '2026-01-01T00:00:00.000Z' WHERE id = 'c1'");
    expect(snapshot(db)).toEqual(before);
  });

  test('ON CONFLICT (id) DO UPDATE is an UPDATE: it may change content, and is refused when it would change the submitter or created_at', () => {
    const db = seedForTrigger();
    const upsert = (over: Record<string, Cell>): void => {
      const row = contributionRow(over);
      db.query(
        `INSERT INTO contributions (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})
         ON CONFLICT (id) DO UPDATE SET submitter_user_id = excluded.submitter_user_id, created_at = excluded.created_at,
           content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
      ).run(...Object.values(row));
    };
    upsert({ content_hash: hash(5), updated_at: T1 }); // same submitter, same created_at: fine
    expect(one<{ content_hash: string }>(db, "SELECT content_hash FROM contributions WHERE id = 'c1'").content_hash).toBe(hash(5));
    expect(thrown(() => upsert({ submitter_user_id: 'intruder' })).message).toMatch(/immutable/i);
    expect(thrown(() => upsert({ created_at: T1, updated_at: T2 })).message).toMatch(/immutable/i);
    expect(one<{ submitter_user_id: string }>(db, "SELECT submitter_user_id FROM contributions WHERE id = 'c1'").submitter_user_id).toBe('user-1');
  });

  test('UPDATE OR REPLACE contributions SET id = <an existing id> is refused by the trigger before any row is replaced: nothing and no attachment is lost', () => {
    const db = seedForTrigger();
    const before = snapshot(db);
    expect(thrown(() => db.run("UPDATE OR REPLACE contributions SET id = 'c2' WHERE id = 'c1'")).message).toMatch(/immutable/i);
    expect(snapshot(db)).toEqual(before);
    expect(count(db, 'contribution_attachments')).toBe(1);
  });

  test('HAZARD (documented in the header): INSERT OR REPLACE is not an UPDATE, so it bypasses the trigger, rewrites the submitter and wipes the attachments by cascade', () => {
    const db = seedForTrigger();
    expect(count(db, 'contribution_attachments', "contribution_id = 'c1'")).toBe(1);
    db.query(
      'INSERT OR REPLACE INTO contributions (id, kind, payload, submitter_user_id, content_hash) VALUES (?, ?, ?, ?, ?)',
    ).run('c1', 'new', PAYLOAD, 'intruder', hash(1));
    expect(one<{ submitter_user_id: string }>(db, "SELECT submitter_user_id FROM contributions WHERE id = 'c1'").submitter_user_id).toBe('intruder');
    expect(count(db, 'contribution_attachments', "contribution_id = 'c1'")).toBe(0);
  });
});

// --- contribution_attachments ------------------------------------------------------------------

describe('006_contributions: contribution_attachments', () => {
  test('a valid attachment stores every column as given', () => {
    const db = withContribution();
    const row = attachmentRow({ created_at: T1 });
    insertRow(db, 'contribution_attachments', row);
    expect(one(db, 'SELECT * FROM contribution_attachments WHERE id = ?', 'a1')).toEqual(row);
  });

  test('created_at defaults to the canonical UTC now when omitted', () => {
    const db = withContribution();
    const { created_at: _omitted, ...row } = attachmentRow();
    insertRow(db, 'contribution_attachments', row);
    const { created_at } = one<{ created_at: string }>(db, 'SELECT created_at FROM contribution_attachments');
    expect(created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.now() - new Date(created_at).getTime())).toBeLessThan(5000);
  });

  test('the id is the primary key and an EntityId (1-128 characters of [A-Za-z0-9._-])', () => {
    const db = withContribution();
    addAttachment(db);
    expect(thrown(() => addAttachment(db, { stored_path: 'other/path' })).message).toMatch(/UNIQUE constraint failed: contribution_attachments\.id/);
    let n = 0;
    for (const id of ['x1', '-x', 'A_b.c-d', 'x'.repeat(128), 'x'.repeat(129), '', ' a', 'a b', 'a/b', 'é']) {
      n += 1;
      const ok = accepted(() => addAttachment(db, { id, stored_path: `paths/${n}` }));
      expect(ok, JSON.stringify(id)).toBe(EntityId.safeParse(id).success);
    }
  });

  test('every required column is NOT NULL', () => {
    const db = withContribution();
    for (const column of ATTACHMENTS_REQUIRED) {
      expect(thrown(() => addAttachment(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: contribution_attachments\\.${column}\\b`));
    }
    expect(count(db, 'contribution_attachments')).toBe(0);
  });

  test('contribution_id must reference an existing contribution (foreign key)', () => {
    const db = withContribution();
    expect(thrown(() => addAttachment(db, { contribution_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(count(db, 'contribution_attachments')).toBe(0);
  });

  test('kind: only the contract\'s MediaKind values; NULL, blank and other spellings are rejected', () => {
    const db = withContribution();
    let n = 0;
    for (const kind of MEDIA) addAttachment(db, { id: `k-${kind}`, kind, stored_path: `p/${++n}` });
    for (const kind of ['', ' ', 'Video', 'audio', 'pdf', 'video ', 'file']) {
      expect(thrown(() => addAttachment(db, { id: 'bad', kind, stored_path: 'p/bad' })).message, JSON.stringify(kind)).toMatch(/CHECK constraint failed/);
    }
  });

  test('stored_path is UNIQUE (the sweep matches files by path): the same path twice is rejected, for the same and for another contribution', () => {
    const db = withContribution();
    addContribution(db, { id: 'c2', content_hash: hash(2) });
    addAttachment(db, { id: 'a1', stored_path: 'contributions/x.mp4' });
    expect(thrown(() => addAttachment(db, { id: 'a2', stored_path: 'contributions/x.mp4' })).message).toMatch(/UNIQUE constraint failed: contribution_attachments\.stored_path/);
    expect(thrown(() => addAttachment(db, { id: 'a3', contribution_id: 'c2', stored_path: 'contributions/x.mp4' })).message).toMatch(/UNIQUE constraint failed: contribution_attachments\.stored_path/);
    expect(count(db, 'contribution_attachments')).toBe(1);
    addAttachment(db, { id: 'a4', stored_path: 'contributions/X.mp4' }); // paths are compared exactly (case matters on the disk)
  });

  test('stored_path, mime and original_name are never blank (whitespace is space, tab, newline, carriage return)', () => {
    const db = withContribution();
    for (const column of ['stored_path', 'mime', 'original_name']) {
      for (const [i, value] of BLANKS.entries()) {
        expect(thrown(() => addAttachment(db, { id: `b${column}${i}`, stored_path: `p/${column}/${i}`, [column]: value })).message, `${column} ${JSON.stringify(value)}`).toMatch(/CHECK constraint failed/);
      }
    }
    addAttachment(db, { original_name: 'my drill (final) v2.mp4', mime: 'video/quicktime' });
  });

  test('bytes: a non-negative integer; zero is fine, negatives, fractions and text are rejected', () => {
    const db = withContribution();
    let n = 0;
    for (const bytes of [0, 1, 1048576, 2 ** 40]) addAttachment(db, { id: `b${++n}`, stored_path: `p/${n}`, bytes });
    for (const bytes of [-1, -1048576, 1.5, 'abc', '10']) {
      expect(accepted(() => addAttachment(db, { id: `bad${++n}`, stored_path: `p/${n}`, bytes })), JSON.stringify(bytes)).toBe(false);
    }
    expect(thrown(() => addAttachment(db, { id: 'neg', stored_path: 'p/neg', bytes: -1 })).message).toMatch(/CHECK constraint failed/);
    expect(count(db, 'contribution_attachments')).toBe(4);
  });

  test('created_at: canonical ms-UTC text only; every other spelling is rejected', () => {
    const db = withContribution();
    addAttachment(db, { id: 'ok', stored_path: 'p/ok', created_at: '2026-12-31T23:59:59.999Z' });
    for (const [i, value] of BAD_TIMESTAMPS.entries()) {
      expect(thrown(() => addAttachment(db, { id: `t${i}`, stored_path: `p/t${i}`, created_at: value })).message, JSON.stringify(value)).toMatch(/CHECK constraint failed/);
    }
  });

  test('STRICT refuses a wrong storage class (BLOB stored_path, integer mime)', () => {
    const db = withContribution();
    expect(accepted(() => addAttachment(db, { id: 'x1', stored_path: new Uint8Array([1, 2]) }))).toBe(false);
    expect(accepted(() => addAttachment(db, { id: 'x2', stored_path: 'p/x2', mime: 7 }))).toBe(false);
    expect(count(db, 'contribution_attachments')).toBe(0);
  });

  test('attachments can be added, changed and deleted one by one while the contribution is untouched', () => {
    const db = withContribution();
    addAttachment(db);
    addAttachment(db, { id: 'a2', stored_path: 'p/2' });
    db.run("UPDATE contribution_attachments SET original_name = 'renamed.mp4' WHERE id = 'a1'");
    db.run("DELETE FROM contribution_attachments WHERE id = 'a2'");
    expect(count(db, 'contribution_attachments')).toBe(1);
    expect(count(db, 'contributions')).toBe(1);
  });

  test('UPDATE OR REPLACE on an attachment SET stored_path = <another attachment\'s path> silently deletes that other attachment (HAZARD, documented)', () => {
    const db = withContribution();
    addAttachment(db, { id: 'a1', stored_path: 'p/1' });
    addAttachment(db, { id: 'a2', stored_path: 'p/2' });
    db.run("UPDATE OR REPLACE contribution_attachments SET stored_path = 'p/1' WHERE id = 'a2'");
    expect(rows<{ id: string }>(db, 'SELECT id FROM contribution_attachments').map((r) => r.id)).toEqual(['a2']);
  });
});

// --- cascade ------------------------------------------------------------------------------------

describe('006_contributions: cascade on contribution delete', () => {
  test("foreign_keys is ON in the app's database helper, which is what the cascade tests below rely on", () => {
    const db = openDatabase(':memory:');
    opened.push(db);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(1);
  });

  test('deleting a contribution deletes its attachments, and only those', () => {
    const db = migrated();
    seedTwo(db);
    expect(count(db, 'contribution_attachments')).toBe(4);

    db.run("DELETE FROM contributions WHERE id = 'c1'");

    expect(rows<{ id: string }>(db, 'SELECT id FROM contribution_attachments ORDER BY id').map((r) => r.id)).toEqual(['c2-a1', 'c2-a2']);
    expect(count(db, 'contributions')).toBe(1);
  });

  test('a delete of every contribution empties the attachments (erasure of a submitter: delete by submitter_user_id, the cascade follows)', () => {
    const db = migrated();
    seedTwo(db);
    db.run("UPDATE contributions SET submitter_user_id = submitter_user_id"); // no-op: the trigger allows it
    db.run("DELETE FROM contributions WHERE submitter_user_id = 'user-1'");
    expect(count(db, 'contributions')).toBe(0);
    expect(count(db, 'contribution_attachments')).toBe(0);
  });

  test('deleting an attachment does not delete its contribution', () => {
    const db = migrated();
    seedTwo(db);
    db.run("DELETE FROM contribution_attachments WHERE contribution_id = 'c1'");
    expect(count(db, 'contributions')).toBe(2);
    expect(count(db, 'contribution_attachments')).toBe(2);
  });

  test('a contribution in any state cascades (approved with a resulting drill, withdrawn, rejected)', () => {
    const db = migrated();
    addDrills(db);
    let n = 0;
    for (const state of STATES) {
      const id = `c-${state}`;
      addContribution(db, { id, state, resulting_drill_id: state === 'approved' ? 'd1' : null, content_hash: hash(++n) });
      addAttachment(db, { id: `a-${state}`, contribution_id: id, stored_path: `p/${state}` });
    }
    db.run('DELETE FROM contributions');
    expect(count(db, 'contribution_attachments')).toBe(0);
  });

  test('the cascade runs on a real file database opened like production, and a re-opened connection sees it', () => {
    const path = join(tmp, 'cascade.db');
    const db = openDatabase(path);
    opened.push(db);
    migrate(db);
    seedTwo(db);
    db.run("DELETE FROM contributions WHERE id = 'c2'");
    db.close();
    const again = openDatabase(path);
    opened.push(again);
    expect(count(again, 'contribution_attachments')).toBe(2);
  });

  test('control: with foreign_keys OFF the cascade does not happen (so the tests above really depend on the pragma)', () => {
    const db = migrated();
    seedTwo(db);
    db.run('PRAGMA foreign_keys = OFF');
    db.run("DELETE FROM contributions WHERE id = 'c1'");
    expect(count(db, 'contribution_attachments', "contribution_id = 'c1'")).toBe(2);
  });

  test('INSERT OR REPLACE of a contribution wipes its attachments (HAZARD); ON CONFLICT DO UPDATE keeps them', () => {
    const db = migrated();
    seedTwo(db);
    db.query("INSERT INTO contributions (id, kind, payload, submitter_user_id, content_hash) VALUES ('c1', 'new', ?, 'user-1', ?) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload").run(PAYLOAD, hash(1));
    expect(count(db, 'contribution_attachments', "contribution_id = 'c1'")).toBe(2);
    db.query("INSERT OR REPLACE INTO contributions (id, kind, payload, submitter_user_id, content_hash) VALUES ('c1', 'new', ?, 'user-1', ?)").run(PAYLOAD, hash(1));
    expect(count(db, 'contribution_attachments', "contribution_id = 'c1'")).toBe(0);
    expect(count(db, 'contribution_attachments', "contribution_id = 'c2'")).toBe(2);
  });
});
