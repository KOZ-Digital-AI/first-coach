import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Timestamp } from '../../shared/domain';
import { Consents, RECOVERY_CODE_PATTERN, normalizeRecoveryCode } from '../../shared/privacy';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '007_privacy.sql';
const FRAMEWORK_FILES = [
  '001_commons.sql',
  '002_player.sql',
  '003_settings.sql',
  '004_test_thresholds.sql',
  '005_sessions.sql',
  '006_contributions.sql',
];

/** The tables this migration owns. The "own tables" test derives them from the schema and compares. */
const PRIVACY_TABLES = ['consents', 'recovery_codes'];

/** Better Auth's tables: created by its own migrator at route-register time, never by ours. */
const BETTER_AUTH_TABLES = ['user', 'session', 'account', 'verification'];

/** 005's and 006's tables: 007 must not reuse or shadow them. */
const EARLIER_TABLES = ['sessions', 'session_events', 'contributions', 'contribution_attachments'];

/** The contract's consent kinds: the keys of Consents (shared/privacy.ts). The CHECK list must equal them. */
const CONSENT_KINDS: readonly string[] = Object.keys(Consents.shape);

interface ColumnShape {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1;
}

/** The exact shape of the two new tables, in declaration order. `id` of consents is INTEGER PRIMARY KEY (rowid). */
const CONSENTS_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'player_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'granted', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'guardian_confirmed', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'changed_at', type: 'TEXT', notnull: 1, pk: 0 },
];
const RECOVERY_COLUMNS: ColumnShape[] = [
  { name: 'player_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'code_hash', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'last_used_at', type: 'TEXT', notnull: 0, pk: 0 },
];
const CONSENTS_REQUIRED = ['player_id', 'kind', 'granted', 'guardian_confirmed', 'changed_at'];
const RECOVERY_REQUIRED = ['player_id', 'code_hash', 'created_at'];

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

let tmp: string;
let six: string;
let seven: string;
let withLater: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'privacy-migration-'));
  for (const dir of ['six', 'seven', 'with-later']) {
    mkdirSync(join(tmp, dir));
    for (const file of FRAMEWORK_FILES) copyFileSync(join(MIGRATIONS_DIR, file), join(tmp, dir, file));
  }
  six = join(tmp, 'six'); // 001-006: what exists before 007
  seven = join(tmp, 'seven'); // 001-006 + a copy of 007 (the runner forbids gaps, so 007 cannot sit alone)
  withLater = join(tmp, 'with-later'); // 001-007 + a hypothetical 008 that only adds things
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

type Which = 'all' | 'six' | 'seven' | 'later';

/** Copies 007 into a scratch dir on demand, so a missing file fails the test that needs it (not every test). */
function copy007(dir: string): void {
  copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
}

/**
 * A migrated in-memory database opened like production (foreign_keys ON). 'all' applies the real
 * MIGRATIONS_DIR; 'six' copies of 001-006 (no 007); 'seven' copies of 001-007 alone; 'later' adds a
 * hypothetical 008 that does what a later migration may do: ADD COLUMN on both tables plus a table
 * that references consents.
 */
function migrated(which: Which = 'all'): Database {
  const db = openDatabase(':memory:');
  opened.push(db);
  if (which === 'all') {
    migrate(db);
  } else if (which === 'six') {
    migrate(db, six);
  } else if (which === 'seven') {
    copy007(seven);
    migrate(db, seven);
  } else {
    copy007(withLater);
    writeFileSync(
      join(withLater, '008_later.sql'),
      [
        'ALTER TABLE consents ADD COLUMN note TEXT;',
        'ALTER TABLE recovery_codes ADD COLUMN note TEXT;',
        'CREATE TABLE consent_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, consent_id INTEGER NOT NULL REFERENCES consents (id) ON DELETE CASCADE) STRICT;',
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

/** The tables 007 creates: what 001-007 have beyond 001-006. Independent of any later migration. */
function ownTables(): string[] {
  const before = tableNames(migrated('six'));
  return tableNames(migrated('seven')).filter((t) => !before.includes(t));
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

/** The explicitly named (CREATE INDEX) indexes of `table` and their columns, autoindexes left out. */
function namedIndexes(db: Database, table: string): Record<string, string[]> {
  const list = rows<{ name: string }>(db, `SELECT name FROM pragma_index_list('${table}') WHERE origin = 'c'`);
  return Object.fromEntries(list.map((i) => [i.name, rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${i.name}') ORDER BY seqno`).map((c) => c.name)]));
}

const triggersOn = (db: Database, table: string): { name: string; sql: string }[] =>
  rows<{ name: string; sql: string }>(db, "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name", table);

const plan = (db: Database, sql: string, ...params: Cell[]): string =>
  rows<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(' | ');

const headerOf = (): string =>
  readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('--'))
    .join('\n');

// --- fixtures ------------------------------------------------------------------------------

/** A sha-256 hex digest, distinct per n: what code_hash holds (the hash of a canonical recovery code). */
const hash = (n: number): string => createHash('sha256').update(`recovery-code-${n}`).digest('hex');

function insertRow(db: Database, table: string, row: Record<string, Cell>): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
}

/** A complete player_profiles row (002's contract; only the id varies here). */
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

function consentRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return { player_id: 'p1', kind: 'videoAnalysis', granted: 1, guardian_confirmed: 0, changed_at: T0, ...over };
}

function recoveryRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return { player_id: 'p1', code_hash: hash(1), created_at: T0, last_used_at: null, ...over };
}

const addConsent = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'consents', consentRow(over));
const addRecovery = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'recovery_codes', recoveryRow(over));

/** A profile p1 ready for consents and a code. */
function withProfile(which: Which = 'all'): Database {
  const db = migrated(which);
  addProfile(db);
  return db;
}

/** Two players, each with two consent rows and a recovery code, so cascade tests have something to lose and to keep. */
function seedTwoPlayers(db: Database): void {
  for (const [p, n] of [['p1', 0], ['p2', 10]] as const) {
    addProfile(db, p);
    addConsent(db, { player_id: p, kind: 'videoAnalysis', granted: 1, changed_at: T0 });
    addConsent(db, { player_id: p, kind: 'modelImprovement', granted: 0, changed_at: T1 });
    addRecovery(db, { player_id: p, code_hash: hash(n + 1) });
  }
}

/**
 * The schema assertions that must hold on ANY database built from the real migrations, whatever is
 * applied after 007: named tables and columns only, POSITIVE (this column is NOT NULL, that CHECK
 * exists, this trigger fires), never "the table has exactly these columns": a later
 * ALTER TABLE ... ADD COLUMN is legitimate and must not break them.
 */
function expectPrivacyContract(db: Database): void {
  expect(checkList(db, 'consents', 'kind')).toEqual([...CONSENT_KINDS]);
  for (const table of PRIVACY_TABLES) {
    expect(one<{ strict: number }>(db, 'SELECT strict FROM pragma_table_list WHERE name = ?', table).strict, `${table} STRICT`).toBe(1);
  }
  for (const c of CONSENTS_REQUIRED) expect(notNullColumns(db, 'consents'), `consents.${c}`).toContain(c);
  for (const c of RECOVERY_REQUIRED) expect(notNullColumns(db, 'recovery_codes'), `recovery_codes.${c}`).toContain(c);
  expect(nullableColumns(db, 'recovery_codes')).toContain('last_used_at');

  addProfile(db, 'contract-a');
  addProfile(db, 'contract-b');
  addConsent(db, { player_id: 'contract-a', changed_at: T0 });
  addConsent(db, { player_id: 'contract-a', granted: 0, changed_at: T1 }); // history: same (player, kind) again
  expect(count(db, 'consents', "player_id = 'contract-a'")).toBe(2);
  expect(thrown(() => addConsent(db, { player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
  expect(thrown(() => addConsent(db, { player_id: 'contract-a', kind: 'nope' })).message).toMatch(/CHECK constraint failed/);
  expect(thrown(() => addConsent(db, { player_id: 'contract-a', granted: 2 })).message).toMatch(/CHECK constraint failed/);
  expect(thrown(() => db.run("UPDATE consents SET granted = 0 WHERE player_id = 'contract-a'")).message).toMatch(/append-only/);
  addRecovery(db, { player_id: 'contract-a', code_hash: hash(901) });
  expect(thrown(() => addRecovery(db, { player_id: 'contract-a', code_hash: hash(902) })).message).toMatch(/UNIQUE constraint failed: recovery_codes\.player_id/);
  expect(thrown(() => addRecovery(db, { player_id: 'contract-b', code_hash: hash(901) })).message).toMatch(/UNIQUE constraint failed: recovery_codes\.code_hash/);
  expect(thrown(() => addRecovery(db, { player_id: 'contract-b', code_hash: 'ABCD-EFGH-IJKL-MNOP' })).message).toMatch(/CHECK constraint failed/);
  expect(thrown(() => addRecovery(db, { player_id: 'ghost', code_hash: hash(903) })).message).toMatch(/FOREIGN KEY constraint failed/);
  db.run("DELETE FROM player_profiles WHERE player_id IN ('contract-a', 'contract-b')");
  expect(count(db, 'consents', "player_id LIKE 'contract-%'")).toBe(0);
  expect(count(db, 'recovery_codes', "player_id LIKE 'contract-%'")).toBe(0);
}

// --- the migration ---------------------------------------------------------------------------

describe('007_privacy: migration', () => {
  test('applies through the real runner and MIGRATIONS_DIR, as version 7, after 001-006', () => {
    const db = openDatabase(join(tmp, 'real.db'));
    opened.push(db);

    const applied = migrate(db);

    expect(applied.slice(0, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(one<{ name: string }>(db, 'SELECT name FROM schema_migrations WHERE version = 7').name).toBe('007_privacy');
    for (const table of PRIVACY_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('applies on top of a database that already has 001-006 (the upgrade path), and only 007 is applied', () => {
    const db = migrated('six');
    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(6);
    expect(tableNames(db)).not.toContain('consents');

    copy007(seven);
    expect(migrate(db, seven)).toEqual([7]);
    for (const table of PRIVACY_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('a copy of 001-007 alone in a temp dir applies and passes the whole contract', () => {
    const db = migrated('seven');
    expect(rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expectPrivacyContract(db);
  });

  test('the real MIGRATIONS_DIR database passes the same contract', () => {
    expectPrivacyContract(migrated('all'));
  });

  test('sits next to its own test, and the directory holds only NNN_name.sql migrations', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(SQL_FILE);
    expect(files).toContain('007_privacy.test.ts');
    expect(files.filter((f) => f.endsWith('.sql')).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test("creates exactly consents and recovery_codes, and none of Better Auth's tables, nor 005's / 006's", () => {
    const own = ownTables();

    expect(own).toEqual([...PRIVACY_TABLES].sort());
    const taken = new Set([...BETTER_AUTH_TABLES, ...EARLIER_TABLES].map((t) => t.toLowerCase()));
    for (const table of own) expect(taken.has(table.toLowerCase()), table).toBe(false);
    // Better Auth creates its tables after migrate(): a migrate-only database has none of them.
    const db = migrated('seven');
    expect(tableNames(db).filter((t) => BETTER_AUTH_TABLES.includes(t))).toEqual([]);
  });

  test("Better Auth's own tables can be created next to ours (no collision, no interference)", () => {
    const db = migrated('seven');
    db.run('CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT)');
    db.run('CREATE TABLE "session" (id TEXT PRIMARY KEY, token TEXT, userId TEXT REFERENCES "user" (id) ON DELETE CASCADE)');
    db.run('CREATE TABLE "account" (id TEXT PRIMARY KEY)');
    db.run('CREATE TABLE "verification" (id TEXT PRIMARY KEY)');
    expect(tableNames(db)).toEqual(expect.arrayContaining(['consents', 'recovery_codes', 'session', 'user']));
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
    const header = headerOf();
    expect(header).toMatch(/Better Auth/);
    expect(header).toMatch(/"session"/);
    expect(header).toMatch(/collide|collision/i);
    expect(header).toMatch(/erasure/i);
    expect(header).toMatch(/INSERT OR REPLACE/);
    expect(header).toMatch(/REPLACE INTO/);
    expect(header).toMatch(/ON CONFLICT/);
    expect(header).toMatch(/append-only/i);
    expect(header).toMatch(/BEFORE DELETE/);
    expect(header).toMatch(/cascade/i);
    expect(header).toMatch(/foreign_keys/);
    expect(header).toMatch(/rebuild/i);
    expect(header).toMatch(/DROP TABLE/);
    expect(header).toMatch(/ADD COLUMN/);
    expect(header).toMatch(/re-key/i);
    expect(header).toMatch(/recover/i);
    expect(header).toMatch(/hour 24/i);
    expect(header).toMatch(/whitespace/i);
    expect(header).toMatch(/shared\/privacy\.ts/);
    expect(header).toMatch(/videoAnalysis/);
    expect(header).toMatch(/modelImprovement/);
    expect(header).toMatch(/guardian_confirmed/);
  });

  test('the header documents the recovery-code hazards: hash only, one code per player, how to regenerate, REPLACE swaps or deletes silently', () => {
    const header = headerOf();
    expect(header).toMatch(/code_hash/);
    expect(header).toMatch(/sha-?256/i);
    expect(header).toMatch(/never stored|only a hash|hash only/i);
    expect(header).toMatch(/lower-case hex/i);
    expect(header).toMatch(/NUL/);
    expect(header).toMatch(/one code per player/i);
    expect(header).toMatch(/regenerat/i);
    expect(header).toMatch(/ON CONFLICT \(player_id\) DO UPDATE/);
    expect(header).toMatch(/last_used_at/);
    expect(header).toMatch(/delete[\s\S]{0,40}insert[\s\S]{0,60}transaction/i);
    expect(header).toMatch(/UPDATE OR REPLACE player_profiles/);
    expect(header).toMatch(/UPDATE OR REPLACE recovery_codes/);
    expect(header).toMatch(/silently/i);
  });

  test('the header documents the consent history rules: rows are appended, the latest per (player, kind) wins, only a re-key may UPDATE', () => {
    const header = headerOf();
    expect(header).toMatch(/latest/i);
    expect(header).toMatch(/changed_at, id/);
    expect(header).toMatch(/consents_append_only/);
    expect(header).toMatch(/under-13|isConsentUpdateAllowed/);
    expect(header).toMatch(/immutable|never edited|never updated/i);
  });

  test('re-running is a no-op and the recorded checksum is the sha256 of the file bytes, unchanged', () => {
    const db = migrated('all');
    const before = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 7').checksum;
    const schemaBefore = rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const after = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 7').checksum;
    expect(after).toBe(before);
    expect(before).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schemaBefore);
  });

  test('applies exactly once: one schema_migrations row for version 7, and a second run does not touch the data', () => {
    const db = withProfile('seven');
    addConsent(db);
    addRecovery(db);
    expect(migrate(db, seven)).toEqual([]);
    expect(count(db, 'schema_migrations', 'version = 7')).toBe(1);
    expect(count(db, 'consents')).toBe(1);
    expect(count(db, 'recovery_codes')).toBe(1);
  });

  test('the migration itself does not depend on the foreign_keys pragma (a connection with it OFF migrates to the same schema)', () => {
    const off = new Database(':memory:');
    opened.push(off);
    expect(one<{ foreign_keys: number }>(off, 'PRAGMA foreign_keys').foreign_keys).toBe(0);
    copy007(seven);
    migrate(off, seven);

    const on = migrated('seven');
    const schema = (d: Database) => rows(d, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
    expect(schema(off)).toEqual(schema(on));
  });

  test('a later 008 that ADDs COLUMNs to both tables and adds a cascading table does not break the privacy contract', () => {
    const db = migrated('later');
    expect(tableNames(db)).toEqual(expect.arrayContaining(['consents', 'recovery_codes', 'consent_audit']));
    expect(notNullColumns(db, 'consents')).toEqual(expect.arrayContaining(CONSENTS_REQUIRED));
    expect(nullableColumns(db, 'consents')).toContain('note');
    expect(nullableColumns(db, 'recovery_codes')).toContain('note');
    expectPrivacyContract(db);
  });
});

// --- exact shape (alone) -----------------------------------------------------------------------

describe('007_privacy: exact shape of the two new tables (001-007 alone)', () => {
  test('consents has exactly these columns, types and nullability', () => {
    expect(columnShape(migrated('seven'), 'consents')).toEqual(CONSENTS_COLUMNS);
  });

  test('recovery_codes has exactly these columns, types and nullability: a hash, and no column for the code itself', () => {
    const shape = columnShape(migrated('seven'), 'recovery_codes');
    expect(shape).toEqual(RECOVERY_COLUMNS);
    expect(shape.map((c) => c.name)).not.toContain('code');
  });

  test('both are STRICT and hold no personal data column', () => {
    const db = migrated('seven');
    for (const table of PRIVACY_TABLES) {
      expect(one<{ strict: number }>(db, 'SELECT strict FROM pragma_table_list WHERE name = ?', table).strict).toBe(1);
      for (const c of columnShape(db, table)) expect(c.name, `${table}.${c.name}`).not.toMatch(/name|e.?mail|birth|dob|phone|address|plain|secret/i);
    }
  });

  test('foreign keys: player_id of both tables references player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE, and nothing else', () => {
    const db = migrated('seven');
    const expected = [{ from: ['player_id'], table: 'player_profiles', to: ['player_id'], onDelete: 'CASCADE', onUpdate: 'CASCADE' }];
    expect(foreignKeys(db, 'consents')).toEqual(expected);
    expect(foreignKeys(db, 'recovery_codes')).toEqual(expected);
  });

  test('unique indexes: recovery_codes (player_id) and (code_hash); consents history is NOT unique per (player_id, kind)', () => {
    const db = migrated('seven');
    const recovery = uniqueIndexes(db, 'recovery_codes');
    expect(recovery).toContainEqual(['player_id']);
    expect(recovery).toContainEqual(['code_hash']);
    const consents = uniqueIndexes(db, 'consents');
    expect(consents).not.toContainEqual(['player_id', 'kind']);
    expect(consents).not.toContainEqual(['player_id']);
    expect(consents).not.toContainEqual(['player_id', 'kind', 'changed_at']);
  });

  test('consents has the index (player_id, kind, changed_at, id): the latest consent per (player, kind), and the erasure cascade', () => {
    const db = migrated('seven');
    expect(namedIndexes(db, 'consents')).toEqual({ consents_by_player_kind: ['player_id', 'kind', 'changed_at', 'id'] });
  });

  test('EXPLAIN QUERY PLAN: the latest consent per (player, kind) is one index seek with no sort; a player\'s consents and a code lookup by hash never scan', () => {
    const db = migrated('seven');

    const latest = plan(db, 'SELECT granted, guardian_confirmed, changed_at FROM consents WHERE player_id = ? AND kind = ? ORDER BY changed_at DESC, id DESC LIMIT 1', 'p1', 'videoAnalysis');
    expect(latest).toContain('consents_by_player_kind');
    expect(latest).toMatch(/player_id=\? AND kind=\?/);
    expect(latest).not.toMatch(/SCAN/);
    expect(latest).not.toMatch(/TEMP B-TREE/i);

    const history = plan(db, 'SELECT id, kind, granted, changed_at FROM consents WHERE player_id = ? AND kind = ? ORDER BY changed_at, id', 'p1', 'videoAnalysis');
    expect(history).toContain('consents_by_player_kind');
    expect(history).not.toMatch(/TEMP B-TREE/i);

    const ofPlayer = plan(db, 'SELECT id FROM consents WHERE player_id = ?', 'p1');
    expect(ofPlayer).toContain('consents_by_player_kind');
    expect(ofPlayer).not.toMatch(/SCAN/);

    const byHash = plan(db, 'SELECT player_id FROM recovery_codes WHERE code_hash = ?', hash(1));
    expect(byHash).toMatch(/SEARCH recovery_codes USING (COVERING )?INDEX \S+ \(code_hash=\?\)/);
    expect(byHash).not.toMatch(/SCAN/);

    const byPlayer = plan(db, 'SELECT code_hash FROM recovery_codes WHERE player_id = ?', 'p1');
    expect(byPlayer).toMatch(/SEARCH recovery_codes USING (COVERING )?INDEX \S+ \(player_id=\?\)/);
    expect(byPlayer).not.toMatch(/SCAN/);
  });

  test('consents carries exactly one trigger (BEFORE UPDATE); recovery_codes none; no DELETE trigger anywhere, so cascades and erasure work', () => {
    const db = migrated('seven');
    const triggers = triggersOn(db, 'consents');
    expect(triggers.map((t) => t.name)).toEqual(['consents_append_only']);
    expect(triggers[0]?.sql).toMatch(/BEFORE UPDATE ON consents/i);
    expect(triggers[0]?.sql).toMatch(/RAISE\s*\(\s*ABORT/i);
    expect(triggersOn(db, 'recovery_codes')).toEqual([]);
    const all = rows<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('consents', 'recovery_codes')");
    for (const t of all) expect(t.sql).not.toMatch(/DELETE/i);
  });

  test('the enum CHECK list equals the contract constant (parsed out of sqlite_master, not restated)', () => {
    const db = migrated('seven');
    expect(CONSENT_KINDS.length).toBeGreaterThan(0);
    expect(checkList(db, 'consents', 'kind')).toEqual([...CONSENT_KINDS]);
  });
});

// --- consents ----------------------------------------------------------------------------------

describe('007_privacy: consents', () => {
  test('a valid row stores every column as given; changed_at defaults to canonical now and guardian_confirmed to 0 when omitted', () => {
    const db = withProfile();
    addConsent(db, { granted: 1, guardian_confirmed: 1 });
    const { id, ...stored } = one<Record<string, Cell>>(db, 'SELECT * FROM consents');
    expect(id).toBe(1);
    expect(stored).toEqual(consentRow({ granted: 1, guardian_confirmed: 1 }));

    db.query('INSERT INTO consents (player_id, kind, granted) VALUES (?, ?, ?)').run('p1', 'modelImprovement', 0);
    const defaulted = one<{ changed_at: string; guardian_confirmed: number }>(db, "SELECT * FROM consents WHERE kind = 'modelImprovement'");
    expect(defaulted.guardian_confirmed).toBe(0);
    expect(Timestamp.safeParse(defaulted.changed_at).success).toBe(true);
    expect(defaulted.changed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test("every kind of the contract can be stored, for the same player", () => {
    const db = withProfile();
    for (const kind of CONSENT_KINDS) addConsent(db, { kind });
    expect(count(db, 'consents')).toBe(CONSENT_KINDS.length);
  });

  test('ids are assigned in insertion order and never reused (AUTOINCREMENT): the id is the tie-break of history', () => {
    const db = withProfile();
    addConsent(db);
    addConsent(db, { granted: 0 });
    db.run('DELETE FROM consents WHERE id = 2');
    addConsent(db, { granted: 1 });
    expect(rows<{ id: number }>(db, 'SELECT id FROM consents ORDER BY id').map((r) => r.id)).toEqual([1, 3]);
  });

  test('every required column is NOT NULL', () => {
    const db = withProfile();
    for (const column of CONSENTS_REQUIRED) {
      expect(thrown(() => addConsent(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: consents\\.${column}\\b`));
    }
    expect(count(db, 'consents')).toBe(0);
  });

  test('a consent needs an existing profile (foreign key), and NOT a Better Auth user', () => {
    const db = migrated();
    expect(thrown(() => addConsent(db, { player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
  });

  test("kind: only the contract's kinds; NULL, blank and other spellings are rejected, on INSERT and on the (guarded) table", () => {
    const db = withProfile();
    for (const kind of ['', ' ', 'videoanalysis', 'VideoAnalysis', 'video_analysis', 'videoAnalysis ', 'model_improvement', 'marketing', 'recovery']) {
      expect(thrown(() => addConsent(db, { kind })).message, JSON.stringify(kind)).toMatch(/CHECK constraint failed/);
    }
    expect(count(db, 'consents')).toBe(0);
  });

  test('granted and guardian_confirmed are booleans stored as 0 or 1: any other number, text or fraction is rejected', () => {
    const db = withProfile();
    for (const column of ['granted', 'guardian_confirmed']) {
      addConsent(db, { [column]: 0 });
      addConsent(db, { [column]: 1 });
      for (const bad of [2, -1, 10, 0.5, 1.5]) {
        expect(thrown(() => addConsent(db, { [column]: bad })).message, `${column} ${bad}`).toMatch(/CHECK constraint failed/);
      }
      for (const bad of ['true', 'yes', '']) {
        expect(thrown(() => addConsent(db, { [column]: bad })).message, `${column} ${JSON.stringify(bad)}`).toMatch(/cannot store TEXT|CHECK constraint failed/);
      }
    }
    expect(count(db, 'consents')).toBe(4);
  });

  test('changed_at: canonical ms-UTC text only; every other spelling is rejected, and the contract agrees on the good ones', () => {
    const db = withProfile();
    for (const good of [T0, '2026-12-31T23:59:59.999Z', '2028-02-29T12:00:00.000Z']) {
      addConsent(db, { changed_at: good });
      expect(Timestamp.safeParse(good).success).toBe(true);
    }
    for (const bad of BAD_TIMESTAMPS) {
      expect(thrown(() => addConsent(db, { changed_at: bad })).message, bad).toMatch(/CHECK constraint failed/);
    }
    expect(Timestamp.safeParse('2026-01-01T24:00:00.000Z').success).toBe(false); // the contract agrees hour 24 is not a time
    expect(count(db, 'consents')).toBe(3);
  });

  test('changed_at defaults to the server\'s current time: within 5 s of now, in UTC on a machine in another time zone too (TZ=Asia/Almaty, UTC+5)', () => {
    const db = withProfile();
    const before = Date.now();
    db.query('INSERT INTO consents (player_id, kind, granted) VALUES (?, ?, ?)').run('p1', 'videoAnalysis', 1);
    const after = Date.now();
    const stamped = Date.parse(one<{ changed_at: string }>(db, 'SELECT changed_at FROM consents').changed_at);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);

    const script = `
      const { openDatabase } = await import(${JSON.stringify(join(import.meta.dir, '..', 'database'))});
      const { migrate } = await import(${JSON.stringify(join(import.meta.dir, '..', 'migrate'))});
      const db = openDatabase(':memory:');
      migrate(db);
      db.run("INSERT INTO player_profiles VALUES ('p1', 12, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, 'ru', '${T0}', '${T0}')");
      db.run("INSERT INTO consents (player_id, kind, granted) VALUES ('p1', 'videoAnalysis', 1)");
      db.run("INSERT INTO recovery_codes (player_id, code_hash) VALUES ('p1', '${hash(1)}')");
      console.log(db.query('SELECT changed_at FROM consents').get().changed_at, db.query('SELECT created_at FROM recovery_codes').get().created_at, Date.now());
    `;
    const out = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, TZ: 'Asia/Almaty' } });
    expect(out.stderr.toString()).toBe('');
    const [changedAt, createdAt, now] = out.stdout.toString().trim().split(' ');
    expect(Math.abs(Date.parse(changedAt as string) - Number(now))).toBeLessThan(5000);
    expect(Math.abs(Date.parse(createdAt as string) - Number(now))).toBeLessThan(5000);
  });

  test('history is kept as rows: the same (player, kind) many times; the latest by (changed_at, id) is the current consent', () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addConsent(db, { kind: 'videoAnalysis', granted: 1, changed_at: T0 });
    addConsent(db, { kind: 'videoAnalysis', granted: 0, changed_at: T1 });
    addConsent(db, { kind: 'videoAnalysis', granted: 1, changed_at: T2 });
    addConsent(db, { kind: 'modelImprovement', granted: 1, changed_at: T0 });
    addConsent(db, { player_id: 'p2', kind: 'videoAnalysis', granted: 0, changed_at: T2 });
    expect(count(db, 'consents', "player_id = 'p1' AND kind = 'videoAnalysis'")).toBe(3);

    const latest = (player: string, kind: string) =>
      one<{ granted: number }>(db, 'SELECT granted FROM consents WHERE player_id = ? AND kind = ? ORDER BY changed_at DESC, id DESC LIMIT 1', player, kind).granted;
    expect(latest('p1', 'videoAnalysis')).toBe(1);
    expect(latest('p1', 'modelImprovement')).toBe(1);
    expect(latest('p2', 'videoAnalysis')).toBe(0);
    // A revocation is the newest row, never an edit of an older one.
    addConsent(db, { kind: 'videoAnalysis', granted: 0, changed_at: '2026-01-01T01:00:00.000Z' });
    expect(latest('p1', 'videoAnalysis')).toBe(0);
    expect(latest('p1', 'modelImprovement')).toBe(1); // another kind is unaffected
    expect(count(db, 'consents', "player_id = 'p1' AND kind = 'videoAnalysis'")).toBe(4);
  });

  test('two rows with the same changed_at are ordered by id (the later insert wins): a same-millisecond grant then revoke reads as revoked', () => {
    const db = withProfile();
    addConsent(db, { granted: 1, changed_at: T0 });
    addConsent(db, { granted: 0, changed_at: T0 });
    expect(one<{ granted: number }>(db, "SELECT granted FROM consents WHERE kind = 'videoAnalysis' ORDER BY changed_at DESC, id DESC LIMIT 1").granted).toBe(0);
  });

  test('STRICT refuses a wrong storage class (BLOB kind, integer kind)', () => {
    const db = withProfile();
    expect(thrown(() => addConsent(db, { kind: new TextEncoder().encode('videoAnalysis') })).message).toMatch(/cannot store BLOB value in TEXT column|CHECK constraint failed/);
    expect(thrown(() => addConsent(db, { kind: 1 })).message).toMatch(/cannot store INT|CHECK constraint failed/i);
    expect(count(db, 'consents')).toBe(0);
  });
});

// --- consents are append-only ----------------------------------------------------------------------

describe('007_privacy: consents is an append-only history', () => {
  function seeded(): Database {
    const db = withProfile();
    addProfile(db, 'p2');
    addConsent(db, { granted: 1, guardian_confirmed: 1 });
    return db;
  }

  test('an UPDATE of any content column is rejected with a clear message and the row is unchanged', () => {
    const db = seeded();
    const before = one<Record<string, Cell>>(db, 'SELECT * FROM consents');
    const updates: [string, Cell][] = [
      ['id', 99],
      ['kind', 'modelImprovement'],
      ['granted', 0],
      ['guardian_confirmed', 0],
      ['changed_at', T2],
    ];
    for (const [column, value] of updates) {
      const e = thrown(() => db.run(`UPDATE consents SET ${column} = ?`, [value]));
      expect(e.message, column).toMatch(/consents is append-only/);
    }
    expect(one<Record<string, Cell>>(db, 'SELECT * FROM consents')).toEqual(before);
  });

  test('a no-op UPDATE (setting a column to its own value) is rejected too', () => {
    const db = seeded();
    expect(thrown(() => db.run('UPDATE consents SET granted = granted')).message).toMatch(/append-only/);
    expect(thrown(() => db.run('UPDATE consents SET player_id = player_id')).message).toMatch(/append-only/);
  });

  test('a multi-row UPDATE is rejected as a whole (nothing changes)', () => {
    const db = seeded();
    addConsent(db, { kind: 'modelImprovement', granted: 0 });
    expect(thrown(() => db.run('UPDATE consents SET granted = 1')).message).toMatch(/append-only/);
    expect(rows<{ granted: number }>(db, 'SELECT granted FROM consents ORDER BY id').map((r) => r.granted)).toEqual([1, 0]);
  });

  test('ON CONFLICT DO UPDATE cannot rewrite a stored consent either (the conflict branch is an UPDATE)', () => {
    const db = seeded();
    const e = thrown(() =>
      db.run(
        `INSERT INTO consents (id, player_id, kind, granted, changed_at) VALUES (1, 'p1', 'videoAnalysis', 0, ?)
         ON CONFLICT (id) DO UPDATE SET granted = excluded.granted`,
        [T2],
      ),
    );
    expect(e.message).toMatch(/append-only/);
    expect(one<{ granted: number }>(db, 'SELECT granted FROM consents').granted).toBe(1);
  });

  test("moving a consent to another EXISTING player directly is refused (with foreign keys ON and OFF): only the profile's re-key may change player_id", () => {
    const db = seeded();
    const e = thrown(() => db.run("UPDATE consents SET player_id = 'p2'"));
    expect(e.message).toMatch(/consents is append-only/);
    expect(one<{ player_id: string }>(db, 'SELECT player_id FROM consents').player_id).toBe('p1');

    const off = new Database(':memory:');
    opened.push(off);
    copy007(seven);
    migrate(off, seven);
    addProfile(off);
    addProfile(off, 'p2');
    addConsent(off);
    expect(thrown(() => off.run("UPDATE consents SET player_id = 'p2'")).message).toMatch(/append-only/);
    expect(thrown(() => off.run("UPDATE consents SET player_id = 'nobody'")).message).toMatch(/append-only/); // p1 still has its profile
    expect(one<{ player_id: string }>(off, 'SELECT player_id FROM consents').player_id).toBe('p1');
  });

  test('the re-key exemption is exactly "player_id and nothing else": with foreign keys OFF and the profile already re-keyed, no other column may change alongside it', () => {
    const db = new Database(':memory:');
    opened.push(db);
    copy007(seven);
    migrate(db, seven);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(0);
    addProfile(db);
    addConsent(db, { kind: 'videoAnalysis', granted: 1, guardian_confirmed: 1, changed_at: T0 });
    db.run("UPDATE player_profiles SET player_id = 'p-new'"); // no cascade with foreign keys OFF: the child still says p1
    const before = rows(db, 'SELECT * FROM consents ORDER BY id');
    const alternative: Record<string, Cell> = { id: 99, kind: 'modelImprovement', granted: 0, guardian_confirmed: 0, changed_at: T2 };

    for (const column of ['id', 'kind', 'granted', 'guardian_confirmed', 'changed_at']) {
      const e = thrown(() => db.run(`UPDATE consents SET player_id = 'p-new', ${column} = ?`, [alternative[column] as Cell]));
      expect(e.message, column).toMatch(/consents is append-only/);
    }
    expect(rows(db, 'SELECT * FROM consents ORDER BY id')).toEqual(before);

    // The one allowed shape, for contrast: player_id alone, from a key that no longer has a profile.
    db.run("UPDATE consents SET player_id = 'p-new'");
    expect(one<{ player_id: string }>(db, 'SELECT player_id FROM consents').player_id).toBe('p-new');
  });

  test('INSERT stays possible, and a direct DELETE is not blocked (erasure and cascade must work; only UPDATE is guarded)', () => {
    const db = seeded();
    addConsent(db, { granted: 0, changed_at: T1 });
    expect(count(db, 'consents')).toBe(2);
    db.run('DELETE FROM consents WHERE id = 2');
    expect(count(db, 'consents')).toBe(1);
  });

  test('re-keying a profile (POST /api/player/recover, ON UPDATE CASCADE) moves consents and the recovery code without touching the content', () => {
    const db = withProfile();
    addConsent(db, { kind: 'videoAnalysis', granted: 1, guardian_confirmed: 1, changed_at: T0 });
    addConsent(db, { kind: 'videoAnalysis', granted: 0, changed_at: T1 });
    addConsent(db, { kind: 'modelImprovement', granted: 1, changed_at: T2 });
    addRecovery(db, { code_hash: hash(7), last_used_at: T2 });
    const content = 'SELECT id, kind, granted, guardian_confirmed, changed_at FROM consents ORDER BY id';
    const before = rows(db, content);

    db.run("UPDATE player_profiles SET player_id = 'p1-new' WHERE player_id = 'p1'");

    expect(rows(db, content)).toEqual(before);
    expect(rows<{ player_id: string }>(db, 'SELECT DISTINCT player_id FROM consents')).toEqual([{ player_id: 'p1-new' }]);
    expect(rows(db, 'SELECT player_id, code_hash, last_used_at FROM recovery_codes')).toEqual([{ player_id: 'p1-new', code_hash: hash(7), last_used_at: T2 }]);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
    // The history is still guarded after the re-key.
    expect(thrown(() => db.run('UPDATE consents SET granted = 0')).message).toMatch(/append-only/);
  });
});

// --- recovery_codes ----------------------------------------------------------------------------------

describe('007_privacy: recovery_codes', () => {
  test('a valid row stores every column as given; created_at defaults to canonical now and last_used_at to NULL', () => {
    const db = withProfile();
    addRecovery(db);
    expect(one<Record<string, Cell>>(db, 'SELECT * FROM recovery_codes')).toEqual(recoveryRow());
    db.run('UPDATE recovery_codes SET last_used_at = ?', [T2]);
    expect(one<{ last_used_at: string }>(db, 'SELECT last_used_at FROM recovery_codes').last_used_at).toBe(T2);

    addProfile(db, 'p2');
    db.query('INSERT INTO recovery_codes (player_id, code_hash) VALUES (?, ?)').run('p2', hash(2));
    const defaulted = one<{ created_at: string; last_used_at: null }>(db, "SELECT * FROM recovery_codes WHERE player_id = 'p2'");
    expect(defaulted.last_used_at).toBeNull();
    expect(Timestamp.safeParse(defaulted.created_at).success).toBe(true);
    expect(defaulted.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test('every required column is NOT NULL; last_used_at is nullable', () => {
    const db = withProfile();
    for (const column of RECOVERY_REQUIRED) {
      expect(thrown(() => addRecovery(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: recovery_codes\\.${column}\\b`));
    }
    expect(count(db, 'recovery_codes')).toBe(0);
    addRecovery(db, { last_used_at: null });
    expect(count(db, 'recovery_codes')).toBe(1);
  });

  test('one code per player: a second row for the same player is rejected, another player is fine', () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addRecovery(db, { code_hash: hash(1) });

    expect(thrown(() => addRecovery(db, { code_hash: hash(2) })).message).toMatch(/UNIQUE constraint failed: recovery_codes\.player_id/);
    addRecovery(db, { player_id: 'p2', code_hash: hash(2) });
    expect(count(db, 'recovery_codes')).toBe(2);
  });

  test('code_hash is UNIQUE: two players cannot hold the same hash (a lookup by hash names exactly one player)', () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addRecovery(db, { code_hash: hash(1) });
    expect(thrown(() => addRecovery(db, { player_id: 'p2', code_hash: hash(1) })).message).toMatch(/UNIQUE constraint failed: recovery_codes\.code_hash/);
    addRecovery(db, { player_id: 'p2', code_hash: hash(2) });
    expect(rows(db, 'SELECT player_id FROM recovery_codes WHERE code_hash = ?', hash(2))).toEqual([{ player_id: 'p2' }]);
    expect(rows(db, 'SELECT player_id FROM recovery_codes WHERE code_hash = ?', hash(3))).toEqual([]);
  });

  test('a code needs an existing profile (foreign key), and NOT a Better Auth user', () => {
    const db = migrated();
    expect(thrown(() => addRecovery(db, { player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
  });

  test('code_hash: exactly 64 lower-case hex characters; a sha-256 digest of a canonical recovery code fits', () => {
    const db = withProfile();
    const code = normalizeRecoveryCode('abcd efgh 1234 wxyz');
    expect(code).toMatch(RECOVERY_CODE_PATTERN);
    const digest = createHash('sha256').update(code).digest('hex');
    addRecovery(db, { code_hash: digest });
    expect(one<{ code_hash: string }>(db, 'SELECT code_hash FROM recovery_codes').code_hash).toBe(digest);
    db.run('DELETE FROM recovery_codes');

    for (const good of ['0'.repeat(64), 'f'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      db.run('DELETE FROM recovery_codes');
      addRecovery(db, { code_hash: good });
    }
    db.run('DELETE FROM recovery_codes');

    const bad: string[] = [
      '', ' ', '0'.repeat(63), '0'.repeat(65), '0'.repeat(128), 'a'.repeat(32), // wrong length
      'A'.repeat(64), `${'a'.repeat(63)}A`, `${'a'.repeat(63)}g`, `${'a'.repeat(63)}-`, // not lower-case hex
      `${'a'.repeat(63)} `, ` ${'a'.repeat(63)}`, `${'a'.repeat(63)}\n`, `${'a'.repeat(62)}\r\n`, // whitespace in the 64
      `0x${'a'.repeat(62)}`, `${'a'.repeat(32)}${'é'.repeat(16)}`, `${'é'.repeat(32)}`, // prefix, multi-byte (64 bytes, fewer characters)
      'ABCD-EFGH-IJKL-MNOP', 'ABCDEFGHIJKLMNOP', // the plaintext code itself is never stored
      `${'a'.repeat(30)}\u0000${'a'.repeat(33)}`, // NUL: 64 characters and 64 bytes, but C-string functions stop at the NUL
      `${'a'.repeat(64)}\u0000`, `${'a'.repeat(64)}\u0000g`, `${'a'.repeat(64)}\u0000${'a'.repeat(64)}`, `\u0000${'a'.repeat(63)}`,
    ];
    for (const code_hash of bad) {
      expect(thrown(() => addRecovery(db, { code_hash })).message, JSON.stringify(code_hash)).toMatch(/CHECK constraint failed/);
    }
    expect(count(db, 'recovery_codes')).toBe(0);
  });

  test('STRICT refuses a wrong storage class (BLOB code_hash, integer code_hash)', () => {
    const db = withProfile();
    expect(thrown(() => addRecovery(db, { code_hash: new TextEncoder().encode(hash(1)) })).message).toMatch(/cannot store BLOB value in TEXT column|CHECK constraint failed/);
    expect(thrown(() => addRecovery(db, { code_hash: 1 })).message).toMatch(/cannot store INT|CHECK constraint failed/i);
    expect(count(db, 'recovery_codes')).toBe(0);
  });

  test('created_at and last_used_at: canonical ms-UTC text only (last_used_at also NULL); every other spelling is rejected', () => {
    const db = withProfile();
    addRecovery(db, { created_at: '2026-12-31T23:59:59.999Z', last_used_at: '2028-02-29T12:00:00.000Z' });
    db.run('DELETE FROM recovery_codes');
    for (const column of ['created_at', 'last_used_at']) {
      for (const bad of BAD_TIMESTAMPS) {
        expect(thrown(() => addRecovery(db, { [column]: bad })).message, `${column} ${bad}`).toMatch(/CHECK constraint failed/);
      }
    }
    expect(count(db, 'recovery_codes')).toBe(0);
  });

  test('an UPDATE cannot break the CHECKs either (code_hash, created_at, last_used_at)', () => {
    const db = withProfile();
    addRecovery(db);
    for (const [column, value] of [['code_hash', 'ABCD-EFGH-IJKL-MNOP'], ['code_hash', 'a'.repeat(63)], ['created_at', '2026-01-01T24:00:00.000Z'], ['last_used_at', 'yesterday']] as const) {
      expect(thrown(() => db.run(`UPDATE recovery_codes SET ${column} = ?`, [value])).message, column).toMatch(/CHECK constraint failed/);
    }
    expect(thrown(() => db.run('UPDATE recovery_codes SET code_hash = NULL')).message).toMatch(/NOT NULL constraint failed: recovery_codes\.code_hash/);
    expect(one<Record<string, Cell>>(db, 'SELECT * FROM recovery_codes')).toEqual(recoveryRow());
  });

  test('regenerating a code (POST /api/player/recovery-code) is ONE row changed: upsert with ON CONFLICT (player_id) DO UPDATE, or UPDATE in place, or DELETE + INSERT in a transaction', () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addRecovery(db, { code_hash: hash(1), created_at: T0, last_used_at: T1 });
    addRecovery(db, { player_id: 'p2', code_hash: hash(50) });

    // 1. The upsert: the new hash and time replace the old ones, the "used" mark is cleared.
    db.query(
      `INSERT INTO recovery_codes (player_id, code_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT (player_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, last_used_at = NULL`,
    ).run('p1', hash(2), T2);
    expect(one<Record<string, Cell>>(db, "SELECT * FROM recovery_codes WHERE player_id = 'p1'")).toEqual(recoveryRow({ code_hash: hash(2), created_at: T2, last_used_at: null }));
    expect(rows(db, 'SELECT player_id FROM recovery_codes WHERE code_hash = ?', hash(1))).toEqual([]); // the old code no longer resolves

    // 2. UPDATE in place.
    db.run("UPDATE recovery_codes SET code_hash = ?, created_at = ?, last_used_at = NULL WHERE player_id = 'p1'", [hash(3), T2]);
    expect(one<{ code_hash: string }>(db, "SELECT code_hash FROM recovery_codes WHERE player_id = 'p1'").code_hash).toBe(hash(3));

    // 3. DELETE + INSERT in one transaction.
    db.transaction(() => {
      db.run("DELETE FROM recovery_codes WHERE player_id = 'p1'");
      addRecovery(db, { code_hash: hash(4) });
    })();
    expect(one<{ code_hash: string }>(db, "SELECT code_hash FROM recovery_codes WHERE player_id = 'p1'").code_hash).toBe(hash(4));

    expect(count(db, 'recovery_codes')).toBe(2);
    expect(one<{ code_hash: string }>(db, "SELECT code_hash FROM recovery_codes WHERE player_id = 'p2'").code_hash).toBe(hash(50)); // nobody else's code moved
  });

  test('a regenerated hash that collides with ANOTHER player\'s hash fails loudly (UNIQUE) instead of taking that code over', () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addRecovery(db, { code_hash: hash(1) });
    addRecovery(db, { player_id: 'p2', code_hash: hash(2) });
    const e = thrown(() =>
      db.run(
        `INSERT INTO recovery_codes (player_id, code_hash) VALUES ('p1', ?)
         ON CONFLICT (player_id) DO UPDATE SET code_hash = excluded.code_hash`,
        [hash(2)],
      ),
    );
    expect(e.message).toMatch(/UNIQUE constraint failed: recovery_codes\.code_hash/);
    expect(rows(db, 'SELECT player_id, code_hash FROM recovery_codes ORDER BY player_id')).toEqual([
      { player_id: 'p1', code_hash: hash(1) },
      { player_id: 'p2', code_hash: hash(2) },
    ]);
  });

  test('HAZARD pinned: INSERT OR REPLACE swaps a code without a word, and deletes ANOTHER player\'s code when the hash collides (REPLACE resolves both unique keys)', () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addRecovery(db, { code_hash: hash(1), last_used_at: T1 });
    addRecovery(db, { player_id: 'p2', code_hash: hash(2) });

    // Same player, new hash: no error, the row is deleted and re-inserted (created/last_used are whatever the statement says).
    db.run('INSERT OR REPLACE INTO recovery_codes (player_id, code_hash) VALUES (?, ?)', ['p1', hash(3)]);
    expect(one<Record<string, Cell>>(db, "SELECT code_hash, last_used_at FROM recovery_codes WHERE player_id = 'p1'")).toEqual({ code_hash: hash(3), last_used_at: null });

    // p1 takes p2's hash: p2's row is silently deleted. Never do this.
    db.run('INSERT OR REPLACE INTO recovery_codes (player_id, code_hash) VALUES (?, ?)', ['p1', hash(2)]);
    expect(count(db, 'recovery_codes', "player_id = 'p2'")).toBe(0);
    expect(count(db, 'recovery_codes')).toBe(1);
  });

  test('HAZARD pinned: UPDATE OR REPLACE recovery_codes SET player_id = <a player who has a code> deletes that player\'s code row', () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addRecovery(db, { code_hash: hash(1) });
    addRecovery(db, { player_id: 'p2', code_hash: hash(2) });

    expect(thrown(() => db.run("UPDATE recovery_codes SET player_id = 'p2' WHERE player_id = 'p1'")).message).toMatch(/UNIQUE constraint failed: recovery_codes\.player_id/);
    db.run("UPDATE OR REPLACE recovery_codes SET player_id = 'p2' WHERE player_id = 'p1'");
    expect(rows(db, 'SELECT player_id, code_hash FROM recovery_codes')).toEqual([{ player_id: 'p2', code_hash: hash(1) }]); // p2's own code is gone
  });
});

// --- cascade ---------------------------------------------------------------------------------------------

describe('007_privacy: cascade on profile delete (privacy erasure)', () => {
  test("foreign_keys is ON in the app's database helper, which is what the cascade tests below rely on", () => {
    const db = migrated('seven');
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(1);
  });

  test('deleting a profile deletes its consents and its recovery code, and only those', () => {
    const db = migrated();
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(1); // the test is void with the pragma off
    seedTwoPlayers(db);
    expect(count(db, 'consents')).toBe(4);
    expect(count(db, 'recovery_codes')).toBe(2);

    db.run("DELETE FROM player_profiles WHERE player_id = 'p1'");

    expect(count(db, 'consents', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'recovery_codes', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'consents', "player_id = 'p2'")).toBe(2);
    expect(count(db, 'recovery_codes', "player_id = 'p2'")).toBe(1);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('the consents cascade even though the table is append-only (there is no DELETE trigger); deleting every profile empties both tables', () => {
    const db = migrated();
    seedTwoPlayers(db);
    expect(thrown(() => db.run('UPDATE consents SET granted = 1')).message).toMatch(/append-only/);
    db.run('DELETE FROM player_profiles');
    expect(count(db, 'consents')).toBe(0);
    expect(count(db, 'recovery_codes')).toBe(0);
  });

  test('a recovery code hash is gone with the profile: the old code can no longer be looked up (erasure ends recovery)', () => {
    const db = migrated();
    seedTwoPlayers(db);
    db.run("DELETE FROM player_profiles WHERE player_id = 'p1'");
    expect(rows(db, 'SELECT player_id FROM recovery_codes WHERE code_hash = ?', hash(1))).toEqual([]);
    expect(rows(db, 'SELECT player_id FROM recovery_codes WHERE code_hash = ?', hash(11))).toEqual([{ player_id: 'p2' }]);
  });

  test('control: with foreign_keys OFF the cascade does not happen (so the tests above really depend on the pragma)', () => {
    const db = new Database(':memory:');
    opened.push(db);
    copy007(seven);
    migrate(db, seven);
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(0);
    seedTwoPlayers(db);

    db.run("DELETE FROM player_profiles WHERE player_id = 'p1'");

    expect(count(db, 'consents', "player_id = 'p1'")).toBe(2); // orphaned: nothing cascaded
    expect(count(db, 'recovery_codes', "player_id = 'p1'")).toBe(1);
  });

  test("UPDATE OR REPLACE player_profiles SET player_id = <an existing profile's id> deletes THAT profile with its consents and code (recover onto an existing profile)", () => {
    // Documented hazard, pinned so it stays visible: a re-key is an UPDATE, but with OR REPLACE the conflicting
    // profile row is DELETEd first, and that delete cascades to its consents and recovery code. Never re-key onto an
    // id that already has a profile; POST /api/player/recover must check that first.
    const db = migrated();
    seedTwoPlayers(db);

    db.run("UPDATE OR REPLACE player_profiles SET player_id = 'p2' WHERE player_id = 'p1'");

    expect(rows<{ player_id: string }>(db, 'SELECT player_id FROM player_profiles')).toEqual([{ player_id: 'p2' }]);
    expect(rows(db, 'SELECT player_id, code_hash FROM recovery_codes')).toEqual([{ player_id: 'p2', code_hash: hash(1) }]); // the old p2's code (hash 11) went with its profile; p1's moved
    expect(rows<{ player_id: string; n: number }>(db, 'SELECT player_id, count(*) AS n FROM consents GROUP BY player_id')).toEqual([{ player_id: 'p2', n: 2 }]); // only p1's, now p2's
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});
