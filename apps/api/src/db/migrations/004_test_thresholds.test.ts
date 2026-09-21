import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedTestThresholds, THRESHOLD_BANDS, THRESHOLD_LEVELS } from '../../commons/seed-schema';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '004_test_thresholds.sql';
const FRAMEWORK_FILES = ['001_commons.sql', '002_player.sql', '003_settings.sql'];

/** The columns skill_tests has WITHOUT 004 (001 as it stands). Pinned on the 001-004 file set only. */
const SKILL_TEST_COLUMNS_BEFORE = ['id', 'slug', 'skill_id', 'metric', 'unit', 'direction', 'protocol', 'equipment', 'created_at'];

const CHECK_FAILED = /CHECK constraint failed: .*thresholds/;

let tmp: string;
let trio: string;
let quad: string;
let withLater: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'thresholds-migration-'));
  for (const dir of ['trio', 'quad', 'with-later']) {
    mkdirSync(join(tmp, dir));
    for (const file of FRAMEWORK_FILES) copyFileSync(join(MIGRATIONS_DIR, file), join(tmp, dir, file));
  }
  trio = join(tmp, 'trio'); // 001 + 002 + 003: what exists before 004
  quad = join(tmp, 'quad'); // 001 + 002 + 003 + a copy of 004 (the runner forbids gaps, so 004 cannot sit alone)
  withLater = join(tmp, 'with-later'); // 001 + 002 + 003 + 004 + a hypothetical 005 that only adds things
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

type Which = 'all' | 'trio' | 'quad' | 'later';

/** Copies 004 into a scratch dir on demand, so a missing file fails the test that needs it (not every test). */
function copy004(dir: string): void {
  copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
}

/**
 * A migrated in-memory database opened like production (foreign_keys ON). 'all' applies the real
 * MIGRATIONS_DIR; 'trio' copies of 001-003 (no 004); 'quad' copies of 001-004 alone; 'later' adds a
 * hypothetical 005 that does what a later migration may do: ALTER TABLE skill_tests ADD COLUMN, plus a new table.
 */
function migrated(which: Which = 'all'): Database {
  const db = openDatabase(':memory:');
  opened.push(db);
  if (which === 'all') {
    migrate(db);
  } else if (which === 'trio') {
    migrate(db, trio);
  } else if (which === 'quad') {
    copy004(quad);
    migrate(db, quad);
  } else {
    copy004(withLater);
    writeFileSync(
      join(withLater, '005_later.sql'),
      [
        'ALTER TABLE skill_tests ADD COLUMN note TEXT;',
        'CREATE TABLE skill_test_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, test_id TEXT NOT NULL REFERENCES skill_tests (id), at TEXT NOT NULL) STRICT;',
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

function count(db: Database, where = '1 = 1'): number {
  return one<{ n: number }>(db, `SELECT count(*) AS n FROM skill_tests WHERE ${where}`).n;
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

/** Base tables (not sqlite_ bookkeeping, not the runner ledger) in `db`. */
function tableNames(db: Database): string[] {
  return rows<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name",
  ).map((r) => r.name);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const columnInfo = (db: Database): ColumnInfo[] => rows<ColumnInfo>(db, "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('skill_tests')");

const columnNames = (db: Database): string[] => columnInfo(db).map((c) => c.name);

const nullableColumns = (db: Database): string[] =>
  rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('skill_tests') WHERE "notnull" = 0 AND pk = 0`).map((r) => r.name);

// --- fixtures ------------------------------------------------------------------------------

function seedGraph(db: Database): void {
  db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp1', 'football', '{"en":"Football"}', '1.0.0')`);
  db.run(
    `INSERT INTO skills (id, slug, sport_id, names, age_min, age_max, equipment)
     VALUES ('k-ball', 'ball-control', 'sp1', '{"en":"Ball control"}', 5, 99, 'ball')`,
  );
}

/** One boundary set per band, built from the seed contract (THRESHOLD_BANDS x THRESHOLD_LEVELS) so it cannot drift. */
function thresholdsObject(): Record<string, number[]> {
  return Object.fromEntries(
    THRESHOLD_BANDS.map((band, b) => [band, Array.from({ length: THRESHOLD_LEVELS }, (_, level) => (level + 1) * 5 * (b + 1))]),
  );
}

const VALID_THRESHOLDS = JSON.stringify(thresholdsObject());

/** A complete skill_tests row (column -> value) WITHOUT thresholds, as 001 alone would take it. */
function testRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    id: 't1',
    slug: 'wall-pass-30s',
    skill_id: 'k-ball',
    metric: 'passes',
    unit: 'count',
    direction: 'higher',
    protocol: '{"en":"Pass against a wall for 30 seconds"}',
    equipment: 'ball',
    ...over,
  };
}

let seq = 0;

/** Inserts one skill test; `over` may set `thresholds` (or anything else). Ids and slugs are unique per call. */
function addTest(db: Database, over: Record<string, Cell> = {}): string {
  const n = seq++;
  const row = testRow({ id: `t-${n}`, slug: `test-${n}`, ...over });
  const columns = Object.keys(row);
  db.query(`INSERT INTO skill_tests (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
  return row.id as string;
}

const thresholdsOf = (db: Database, id: string): string | null => one<{ thresholds: string | null }>(db, 'SELECT thresholds FROM skill_tests WHERE id = ?', id).thresholds;

/** Text that is not an RFC 8259 object: every one is refused (also: the JSON null literal is NOT an SQL NULL). */
const REJECTED = [
  'not json', // not JSON at all
  '', // empty text
  ' ', // whitespace only (space, tab, newline, carriage return)
  '\t',
  '\n',
  '\r\n',
  '{', // truncated
  '{"a":1} x', // trailing junk
  '{"a":1}}',
  '{a:1}', // JSON5 / JS object syntax
  "{'a':1}",
  '{"a":01}', // leading zero
  '{"a":NaN}', // NaN / Infinity are not JSON
  '{"a":Infinity}',
  '[]', // valid JSON, wrong top-level type
  '[{}]',
  '1',
  '01',
  '1.5',
  '"s"',
  '"{}"', // a JSON string that merely contains an object
  'true',
  'false',
  'null', // the JSON null literal: json_type is 'null', it must NOT slip through as if it were SQL NULL
];

/**
 * The schema assertions that must hold on ANY database built from the real migrations, whatever is
 * applied after 004: they inspect the named table and column only and are POSITIVE (this column exists
 * and is nullable TEXT, that CHECK behaves), never "the table has exactly these columns": a later
 * ALTER TABLE ... ADD COLUMN is legitimate and must not break them.
 */
function expectThresholdsContract(db: Database): void {
  expect(one<{ strict: number }>(db, "SELECT strict FROM pragma_table_list WHERE name = 'skill_tests'").strict, 'skill_tests STRICT').toBe(1);
  expect(columnInfo(db)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'thresholds', type: 'TEXT', notnull: 0, pk: 0 })]));
  expect(columnNames(db)).toEqual(expect.arrayContaining(SKILL_TEST_COLUMNS_BEFORE));
  expect(rows<{ name: string }>(db, "SELECT name FROM pragma_index_info('skill_tests_by_skill')").map((r) => r.name)).toEqual(['skill_id']);

  seedGraph(db);
  const good = addTest(db, { thresholds: VALID_THRESHOLDS });
  expect(thresholdsOf(db, good)).toBe(VALID_THRESHOLDS);
  expect(thresholdsOf(db, addTest(db, { thresholds: '{}' }))).toBe('{}');
  expect(thresholdsOf(db, addTest(db, { thresholds: null }))).toBeNull();
  expect(thresholdsOf(db, addTest(db))).toBeNull();
  for (const bad of ['not json', '[]', '1', '"s"', 'null', '']) {
    expect(thrown(() => addTest(db, { thresholds: bad })).message, JSON.stringify(bad)).toMatch(CHECK_FAILED);
  }
  expect(thrown(() => addTest(db, { thresholds: new Uint8Array([1]) })).message).toMatch(/cannot store BLOB value in TEXT column skill_tests\.thresholds/);
  db.run('DELETE FROM skill_tests');
  db.run('DELETE FROM skills');
  db.run('DELETE FROM sports');
}

// --- the migration ---------------------------------------------------------------------------------

describe('004_test_thresholds: migration', () => {
  test('applies after 001-003 through the real runner and MIGRATIONS_DIR, as version 4', () => {
    const db = openDatabase(':memory:');
    opened.push(db);

    const applied = migrate(db);

    expect(applied.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(one<{ name: string }>(db, 'SELECT name FROM schema_migrations WHERE version = 4').name).toBe('004_test_thresholds');
    expect(columnNames(db)).toContain('thresholds');
  });

  test('applies on top of a database that already has 001-003 (the upgrade path), and only 004 is applied', () => {
    const db = migrated('trio');
    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(3);
    expect(columnNames(db)).not.toContain('thresholds');

    copy004(quad);
    expect(migrate(db, quad)).toEqual([4]);
    expect(columnNames(db)).toContain('thresholds');
  });

  test('a copy of 001-004 alone in a temp dir applies and passes the whole contract', () => {
    const db = migrated('quad');

    expect(rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expectThresholdsContract(db);
  });

  test('the real schema passes the contract (every STRICT/type/CHECK assertion runs against the full current schema)', () => {
    expectThresholdsContract(migrated('all'));
  });

  test('the migrations directory holds 004 as a well-named NNN_name.sql file next to its test', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(SQL_FILE);
    expect(files).toContain('004_test_thresholds.test.ts');
    expect(files.filter((f) => f.endsWith('.sql')).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test('the runner accepts the file: 001-004 apply in order with no gap and the name is recorded', () => {
    const db = migrated('quad');

    expect(rows<{ version: number; name: string }>(db, 'SELECT version, name FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1, name: '001_commons' },
      { version: 2, name: '002_player' },
      { version: 3, name: '003_settings' },
      { version: 4, name: '004_test_thresholds' },
    ]);
  });

  test('contains no transaction control and no PRAGMA (the runner owns the transaction)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i);
    expect(sql).not.toMatch(/\bPRAGMA\b/i);
    expect(sql).not.toMatch(/foreign_keys/i);
    expect(sql.trim().length).toBeGreaterThan(0);
  });

  test('the header comment documents the hazards for later authors and writers', () => {
    const header = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .map((line) => line.replace(/^--\s*/, ''))
      .join(' ')
      .replace(/\s+/g, ' '); // a phrase may wrap across comment lines
    expect(header).toMatch(/frozen/i);
    expect(header).toMatch(/ADD COLUMN/);
    expect(header).toMatch(/json_valid/);
    expect(header).toMatch(/json_type/);
    expect(header).toMatch(/JSON null/i);
    expect(header).toMatch(/nullable/i);
    expect(header).toMatch(/Zod/);
    expect(header).toMatch(/shape/i);
    expect(header).toMatch(/rebuild/i);
    expect(header).toMatch(/whitespace/i);
    expect(header).toMatch(/STRICT/);
  });

  test('re-running is a no-op and the recorded checksum is the sha256 of the file bytes, unchanged', () => {
    const db = migrated('all');
    const before = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 4').checksum;
    const schemaBefore = rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const after = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 4').checksum;
    expect(after).toBe(before);
    expect(before).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schemaBefore);
  });

  test('a later 005 that ADDs a COLUMN to skill_tests and adds a table does not break the contract', () => {
    const db = migrated('later');

    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(5);
    // the column 005 added is really there and nullable (so a closed-world "exactly these columns" pin would fail here)
    expect(nullableColumns(db)).toEqual(expect.arrayContaining(['thresholds', 'note']));
    expect(tableNames(db)).toContain('skill_test_audit');

    expectThresholdsContract(db);

    seedGraph(db);
    const id = addTest(db, { thresholds: VALID_THRESHOLDS, note: 'from 005' });
    db.query('INSERT INTO skill_test_audit (test_id, at) VALUES (?, ?)').run(id, '2026-01-01T00:00:00.000Z');
    expect(one<{ note: string; thresholds: string }>(db, 'SELECT note, thresholds FROM skill_tests WHERE id = ?', id)).toEqual({ note: 'from 005', thresholds: VALID_THRESHOLDS });
  });

  test('on the 004 file alone (after 001-003) skill_tests has exactly the old columns plus thresholds, and 004 touches nothing else', () => {
    const before = migrated('trio');
    const db = migrated('quad');

    expect(columnNames(db).sort()).toEqual([...SKILL_TEST_COLUMNS_BEFORE, 'thresholds'].sort());
    expect(columnNames(db).at(-1)).toBe('thresholds'); // ADD COLUMN appends
    const added = columnInfo(db).find((c) => c.name === 'thresholds');
    expect(added).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
    // the old columns are exactly as 001 left them
    expect(columnInfo(db).filter((c) => c.name !== 'thresholds')).toEqual(columnInfo(before));

    // no new table, index, view or trigger; every object other than skill_tests is byte-identical
    const objects = (d: Database) => rows<{ type: string; name: string }>(d, 'SELECT type, name FROM sqlite_master ORDER BY type, name');
    expect(objects(db)).toEqual(objects(before));
    const others = (d: Database) => rows<{ type: string; name: string; sql: string | null }>(d, "SELECT type, name, sql FROM sqlite_master WHERE name <> 'skill_tests' ORDER BY name");
    expect(others(db)).toEqual(others(before));
    expect(rows(db, "SELECT * FROM pragma_foreign_key_list('skill_tests')").map((r) => (r as { table: string }).table)).toEqual(['skills']);
  });
});

// --- existing rows -----------------------------------------------------------------------------------

describe('004_test_thresholds: existing rows', () => {
  test('a skill test inserted before 004 keeps its values and reads NULL thresholds after migrating', () => {
    const db = migrated('trio');
    seedGraph(db);
    const first = addTest(db);
    const second = addTest(db, { direction: 'lower', unit: 'seconds' });
    const snapshot = rows(db, `SELECT ${SKILL_TEST_COLUMNS_BEFORE.join(', ')} FROM skill_tests ORDER BY id`);
    expect(snapshot).toHaveLength(2);

    copy004(quad);
    expect(migrate(db, quad)).toEqual([4]);

    expect(rows(db, `SELECT ${SKILL_TEST_COLUMNS_BEFORE.join(', ')} FROM skill_tests ORDER BY id`)).toEqual(snapshot);
    expect(thresholdsOf(db, first)).toBeNull();
    expect(thresholdsOf(db, second)).toBeNull();
    expect(count(db, 'thresholds IS NULL')).toBe(2);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('an existing row can be given thresholds afterwards, and reset to NULL', () => {
    const db = migrated('trio');
    seedGraph(db);
    const id = addTest(db);
    copy004(quad);
    migrate(db, quad);

    db.query('UPDATE skill_tests SET thresholds = ? WHERE id = ?').run(VALID_THRESHOLDS, id);
    expect(thresholdsOf(db, id)).toBe(VALID_THRESHOLDS);
    db.query('UPDATE skill_tests SET thresholds = NULL WHERE id = ?').run(id);
    expect(thresholdsOf(db, id)).toBeNull();
  });
});

// --- the column ---------------------------------------------------------------------------------------

describe('004_test_thresholds: the thresholds column', () => {
  test('PRAGMA table_info shows a nullable TEXT column with no default (a positive pin on the full current schema)', () => {
    const db = migrated('all');

    expect(columnInfo(db)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'thresholds', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })]));
    expect(nullableColumns(db)).toContain('thresholds');
  });

  test('skill_tests is still STRICT (enumerated from PRAGMA table_list) and 004 creates no table of its own', () => {
    const before = tableNames(migrated('trio'));
    const db = migrated('quad');

    expect(tableNames(db)).toEqual(before);
    for (const which of ['quad', 'all'] as const) {
      const strict = rows<{ strict: number }>(migrated(which), "SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = 'skill_tests'");
      expect(strict, which).toEqual([{ strict: 1 }]);
    }
  });

  test('the skill_tests_by_skill index is still there, still on skill_id, and still used by the lookup by skill', () => {
    const db = migrated('all');

    expect(rows<{ name: string }>(db, "SELECT name FROM pragma_index_list('skill_tests')").map((r) => r.name)).toContain('skill_tests_by_skill');
    expect(rows<{ name: string }>(db, "SELECT name FROM pragma_index_info('skill_tests_by_skill') ORDER BY seqno").map((r) => r.name)).toEqual(['skill_id']);
    const plan = rows<{ detail: string }>(db, 'EXPLAIN QUERY PLAN SELECT * FROM skill_tests WHERE skill_id = ?', 'k-ball').map((r) => r.detail).join(' ');
    expect(plan).toMatch(/USING INDEX skill_tests_by_skill/);
  });

  test('NULL is accepted, and an omitted thresholds column reads NULL', () => {
    const db = migrated('all');
    seedGraph(db);

    expect(thresholdsOf(db, addTest(db, { thresholds: null }))).toBeNull();
    expect(thresholdsOf(db, addTest(db))).toBeNull();
  });

  test('a JSON object is accepted and stored as the exact text given: the full seed thresholds, and {}', () => {
    const db = migrated('all');
    seedGraph(db);
    expect(SeedTestThresholds.safeParse(JSON.parse(VALID_THRESHOLDS)).success).toBe(true); // the fixture is a real seed value

    const full = addTest(db, { thresholds: VALID_THRESHOLDS });
    const empty = addTest(db, { thresholds: '{}' });

    expect(thresholdsOf(db, full)).toBe(VALID_THRESHOLDS);
    expect(JSON.parse(thresholdsOf(db, full) as string)).toEqual(thresholdsObject());
    expect(thresholdsOf(db, empty)).toBe('{}');
    // SQL can read into it (a later reader may filter or project on a band)
    const [t2] = THRESHOLD_BANDS;
    expect(one<{ v: number }>(db, `SELECT json_extract(thresholds, '$.${t2}[0]') AS v FROM skill_tests WHERE id = ?`, full).v).toBe(5);
  });

  test('RFC 8259 whitespace around an object is still an object: json_valid accepts it, so it is stored as given (blank text is not)', () => {
    const db = migrated('all');
    seedGraph(db);

    for (const padded of [' {}', '{} ', '\n{"upTo9":[1,2,3,4]}\n', '\t{ "a" : 1 }\r\n']) {
      const id = addTest(db, { thresholds: padded });
      expect(thresholdsOf(db, id), JSON.stringify(padded)).toBe(padded);
      expect(() => JSON.parse(padded)).not.toThrow(); // and every reader parses it
    }
  });

  test('anything that is not a JSON object is rejected by the CHECK: invalid JSON, arrays, scalars, blank text and the JSON null literal', () => {
    const db = migrated('all');
    seedGraph(db);

    for (const bad of REJECTED) {
      expect(thrown(() => addTest(db, { thresholds: bad })).message, JSON.stringify(bad)).toMatch(CHECK_FAILED);
    }
    expect(count(db)).toBe(0);
  });

  test('the JSON null literal is refused although SQL NULL is accepted (json_type "null" must not pass as "absent")', () => {
    const db = migrated('all');
    seedGraph(db);

    expect(thrown(() => addTest(db, { thresholds: 'null' })).message).toMatch(CHECK_FAILED);
    expect(thresholdsOf(db, addTest(db, { thresholds: null }))).toBeNull();
    expect(count(db)).toBe(1);
  });

  test('numbers, booleans and blobs in the column are refused too (STRICT TEXT: a number becomes text and fails the CHECK, a blob is refused outright)', () => {
    const db = migrated('all');
    seedGraph(db);

    for (const bad of [1, 0, -1, 1.5]) {
      expect(thrown(() => addTest(db, { thresholds: bad })).message, String(bad)).toMatch(CHECK_FAILED);
    }
    expect(thrown(() => addTest(db, { thresholds: new Uint8Array([1, 2]) })).message).toMatch(/cannot store BLOB value in TEXT column skill_tests\.thresholds/);
    expect(thrown(() => addTest(db, { thresholds: new TextEncoder().encode('{}') })).message).toMatch(/cannot store BLOB value in TEXT column skill_tests\.thresholds/);
    expect(count(db)).toBe(0);
  });

  test('the SQL constrains the type, not the shape: any object is accepted (Zod at the seed boundary owns bands, lengths and ordering)', () => {
    const db = migrated('all');
    seedGraph(db);

    for (const shape of ['{"upTo9":[1]}', '{"upTo9":"x"}', '{"a":1}', '{"from14":[3,2,1,0],"extra":true}', '{"upTo9":[1,2,3,4,5]}', '{"nested":{"deep":[null]}}']) {
      expect(thresholdsOf(db, addTest(db, { thresholds: shape })), shape).toBe(shape);
    }
  });

  test('the CHECK is not insert-only: an UPDATE to a non-object is refused and leaves the row alone; a valid object or NULL is fine', () => {
    const db = migrated('all');
    seedGraph(db);
    const id = addTest(db, { thresholds: VALID_THRESHOLDS });
    const update = (value: Cell) => db.query('UPDATE skill_tests SET thresholds = ? WHERE id = ?').run(value, id);

    for (const bad of ['not json', '[]', '1', '"s"', 'null', '', '{']) {
      expect(thrown(() => update(bad)).message, JSON.stringify(bad)).toMatch(CHECK_FAILED);
      expect(thresholdsOf(db, id), JSON.stringify(bad)).toBe(VALID_THRESHOLDS);
    }
    update('{"upTo9":[9,8,7,6]}');
    expect(thresholdsOf(db, id)).toBe('{"upTo9":[9,8,7,6]}');
    update(null);
    expect(thresholdsOf(db, id)).toBeNull();
    update(VALID_THRESHOLDS);
    expect(thresholdsOf(db, id)).toBe(VALID_THRESHOLDS);
  });

  test('an unrelated UPDATE of a row still passes the CHECK, whatever its thresholds (NULL or an object)', () => {
    const db = migrated('all');
    seedGraph(db);
    const withValue = addTest(db, { thresholds: VALID_THRESHOLDS });
    const without = addTest(db);

    db.run(`UPDATE skill_tests SET unit = 'reps'`);

    expect(count(db, `unit = 'reps'`)).toBe(2);
    expect(thresholdsOf(db, withValue)).toBe(VALID_THRESHOLDS);
    expect(thresholdsOf(db, without)).toBeNull();
  });

  test('the loader can upsert: INSERT ... ON CONFLICT (id) DO UPDATE sets, replaces and clears thresholds, and keeps the row', () => {
    const db = migrated('all');
    seedGraph(db);
    const id = addTest(db);
    const rowid = () => one<{ rowid: number }>(db, 'SELECT rowid FROM skill_tests WHERE id = ?', id).rowid;
    const before = rowid();
    const upsert = (thresholds: Cell) =>
      db
        .query(
          `INSERT INTO skill_tests (id, slug, skill_id, metric, unit, direction, protocol, equipment, thresholds)
           SELECT id, slug, skill_id, metric, unit, direction, protocol, equipment, ? FROM skill_tests WHERE id = ?
           ON CONFLICT (id) DO UPDATE SET thresholds = excluded.thresholds`,
        )
        .run(thresholds, id);

    upsert(VALID_THRESHOLDS);
    expect(thresholdsOf(db, id)).toBe(VALID_THRESHOLDS);
    upsert('{"upTo9":[1,2,3,4],"from10to13":[2,3,4,5],"from14":[3,4,5,6]}');
    expect(JSON.parse(thresholdsOf(db, id) as string).from14).toEqual([3, 4, 5, 6]);
    upsert(null);
    expect(thresholdsOf(db, id)).toBeNull();
    expect(thrown(() => upsert('[]')).message).toMatch(CHECK_FAILED);
    expect(rowid()).toBe(before);
    expect(count(db)).toBe(1);
  });

  test('the other skill_tests constraints still hold next to the new column (NOT NULL, direction, foreign key, unique slug)', () => {
    const db = migrated('all');
    seedGraph(db);
    addTest(db, { slug: 'taken', thresholds: VALID_THRESHOLDS });

    expect(thrown(() => addTest(db, { slug: 'taken' })).message).toMatch(/UNIQUE constraint failed: skill_tests\.slug/);
    expect(thrown(() => addTest(db, { direction: 'sideways' })).message).toMatch(/CHECK constraint failed: direction IN/);
    expect(thrown(() => addTest(db, { skill_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(thrown(() => addTest(db, { metric: null })).message).toMatch(/NOT NULL constraint failed: skill_tests\.metric/);
    expect(count(db)).toBe(1);
  });

  test('deleting a skill test with thresholds is unaffected (nothing references skill_tests)', () => {
    const db = migrated('all');
    seedGraph(db);
    const id = addTest(db, { thresholds: VALID_THRESHOLDS });

    db.query('DELETE FROM skill_tests WHERE id = ?').run(id);

    expect(count(db)).toBe(0);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});
