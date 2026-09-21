import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGE_MAX,
  AGE_MIN,
  DAYS_PER_WEEK,
  MINUTES_PER_SESSION,
  PlayerProfile,
  PlayerProfileView,
  Roadmap,
  Timestamp,
} from '../../shared/domain';
import { BaselineResult } from '../../shared/onboarding';
import { TestResult } from '../../shared/journey';
import { ClientUuid, EQUIPMENT, EXPERIENCE_LEVELS, GOALS, LOCALES, SPACES } from '../../shared/primitives';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '002_player.sql';
const COMMONS_FILE = '001_commons.sql';

/** The tables this migration owns. The "own tables" test derives them from the schema and compares. */
const PLAYER_TABLES = ['player_profiles', 'roadmaps', 'test_results'];

/** Better Auth's tables: created by its own migrator at route-register time, never by ours. */
const BETTER_AUTH_TABLES = ['user', 'session', 'account', 'verification'];

/** Contract-required columns (NOT NULL) and contract-optional columns (nullable), per table. */
const PROFILE_REQUIRED = [
  'player_id', 'age', 'level', 'goal', 'equipment', 'space', 'partner', 'days_per_week', 'minutes_per_session',
  'locale', 'created_at', 'updated_at',
];
const RESULT_REQUIRED = ['player_id', 'test_slug', 'value', 'skipped', 'recorded_at', 'client_uuid'];
const RESULT_OPTIONAL = ['attempts', 'errors']; // Count.optional() in the contract: absent = not recorded
const ROADMAP_REQUIRED = ['player_id', 'json', 'graph_version', 'created_at'];

/** Declared column types, pinned so a STRICT type cannot drift. */
const COLUMN_TYPES: Record<string, Record<string, string>> = {
  player_profiles: {
    player_id: 'TEXT', age: 'INTEGER', level: 'TEXT', goal: 'TEXT', equipment: 'TEXT', space: 'TEXT', partner: 'INTEGER',
    days_per_week: 'INTEGER', minutes_per_session: 'INTEGER', locale: 'TEXT', created_at: 'TEXT', updated_at: 'TEXT',
  },
  test_results: {
    id: 'INTEGER', player_id: 'TEXT', test_slug: 'TEXT', value: 'REAL', attempts: 'INTEGER', errors: 'INTEGER',
    skipped: 'INTEGER', recorded_at: 'TEXT', client_uuid: 'TEXT',
  },
  roadmaps: { id: 'INTEGER', player_id: 'TEXT', json: 'TEXT', graph_version: 'TEXT', created_at: 'TEXT' },
};

/** Columns that would hold personal data. The contract stores none: no name, email or birth date. */
const PII_COLUMN = /name|e.?mail|birth|dob|phone|address/i;

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';

let tmp: string;
let only001: string;
let pair: string;
let withLater: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'player-migration-'));
  only001 = join(tmp, 'only-001');
  mkdirSync(only001);
  copyFileSync(join(MIGRATIONS_DIR, COMMONS_FILE), join(only001, COMMONS_FILE));
  pair = join(tmp, 'pair'); // 001 + a copy of 002 (the runner forbids gaps, so 002 cannot sit alone)
  mkdirSync(pair);
  copyFileSync(join(MIGRATIONS_DIR, COMMONS_FILE), join(pair, COMMONS_FILE));
  withLater = join(tmp, 'with-later'); // 001 + 002 + a hypothetical 003 that only adds things
  mkdirSync(withLater);
  copyFileSync(join(MIGRATIONS_DIR, COMMONS_FILE), join(withLater, COMMONS_FILE));
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

type Which = 'all' | '001' | 'pair' | 'later';

/** Copies 002 into a scratch dir on demand, so a missing file fails the test that needs it (not every test). */
function copy002(dir: string): void {
  copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
}

/**
 * A migrated temp file database opened like production (WAL, foreign_keys ON).
 * 'all' applies the real MIGRATIONS_DIR; '001' a copy of 001 alone; 'pair' copies of 001 and 002 alone;
 * 'later' adds a hypothetical 003 that does what the 002 header allows: ALTER TABLE ... ADD COLUMN on all three
 * tables plus a new table with an FK cascading from player_profiles.
 */
function migrated(which: Which = 'all'): Database {
  const db = openDatabase(join(tmp, `${which}-${opened.length}.db`));
  opened.push(db);
  if (which === 'all') {
    migrate(db);
  } else if (which === '001') {
    migrate(db, only001);
  } else if (which === 'pair') {
    copy002(pair);
    migrate(db, pair);
  } else {
    copy002(withLater);
    writeFileSync(
      join(withLater, '003_later.sql'),
      [
        'ALTER TABLE player_profiles ADD COLUMN consent_video INTEGER;',
        'ALTER TABLE test_results ADD COLUMN note TEXT;',
        'ALTER TABLE roadmaps ADD COLUMN note TEXT;',
        'CREATE TABLE consents (player_id TEXT PRIMARY KEY REFERENCES player_profiles (player_id) ON DELETE CASCADE) STRICT;',
        '',
      ].join('\n'),
    );
    migrate(db, withLater);
  }
  return db;
}

type Cell = string | number | null;

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

function createSql(db: Database, table: string): string {
  return one<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table).sql;
}

/** The quoted literals of `<column> IN ('a', 'b', ...)` in the CREATE TABLE text of `table`. */
function checkList(db: Database, table: string, column: string): string[] {
  const match = new RegExp(`(?<![A-Za-z_])${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(createSql(db, table));
  if (!match) throw new Error(`no "${column} IN (...)" CHECK in ${table}`);
  return [...(match[1] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

/** The numeric literals of `<column> IN (10, 15, ...)`. */
function checkNumbers(db: Database, table: string, column: string): number[] {
  const match = new RegExp(`(?<![A-Za-z_])${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(createSql(db, table));
  if (!match) throw new Error(`no "${column} IN (...)" CHECK in ${table}`);
  return (match[1] as string).split(',').map((s) => Number(s.trim()));
}

/** The bounds of `<column> BETWEEN lo AND hi`. */
function checkBetween(db: Database, table: string, column: string): [number, number] {
  const match = new RegExp(`(?<![A-Za-z_])${column}\\s+BETWEEN\\s+(-?\\d+)\\s+AND\\s+(-?\\d+)`).exec(createSql(db, table));
  if (!match) throw new Error(`no "${column} BETWEEN a AND b" CHECK in ${table}`);
  return [Number(match[1]), Number(match[2])];
}

/** Base tables (not sqlite_ bookkeeping, not the runner ledger) in `db`. */
function tableNames(db: Database): string[] {
  return rows<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name",
  ).map((r) => r.name);
}

/** The tables 002 creates: what 001 + 002 have beyond 001 alone. Independent of any later migration. */
function ownTables(): string[] {
  const before = tableNames(migrated('001'));
  return tableNames(migrated('pair')).filter((t) => !before.includes(t));
}

const notNullColumns = (db: Database, table: string): string[] =>
  rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}') WHERE "notnull" = 1`).map((r) => r.name);

const nullableColumns = (db: Database, table: string): string[] =>
  rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}') WHERE "notnull" = 0 AND pk = 0`).map((r) => r.name);

// --- fixtures ------------------------------------------------------------------------------

/** A contract-valid profile, exactly as a client would send it. */
const PROFILE = PlayerProfile.parse({
  age: 12,
  level: 'basic',
  goal: 'dribbling',
  equipment: 'cones',
  space: 'yard',
  partner: true,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: 'ru',
});

/** A contract-valid roadmap (weeks is the literal 4, focus has 2..3 entries). */
const ROADMAP = Roadmap.parse({
  currentLevelLabel: 'Basic',
  tracks: [
    { skill: 'ball-control', level: 2, source: 'test' },
    { skill: 'juggling', level: 1, source: 'self' },
  ],
  goal: 'dribbling',
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: 'juggling', level: 1, targetLevel: 2, reason: 'Below your other skills' },
    { skill: 'first-touch', level: 2, targetLevel: 3, reason: 'Needed for your goal' },
  ],
});

/** A lower-case RFC 4122 v4 UUID, distinct per n. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A complete player_profiles row (column -> value); override single columns to break it. */
function profileRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    player_id: 'p1',
    age: PROFILE.age,
    level: PROFILE.level,
    goal: PROFILE.goal,
    equipment: PROFILE.equipment,
    space: PROFILE.space,
    partner: PROFILE.partner ? 1 : 0,
    days_per_week: PROFILE.daysPerWeek,
    minutes_per_session: PROFILE.minutesPerSession,
    locale: PROFILE.locale,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

/** A complete test_results row. */
function resultRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    player_id: 'p1',
    test_slug: 'juggling-30s',
    value: 12,
    attempts: 3,
    errors: 1,
    skipped: 0,
    recorded_at: T0,
    client_uuid: uuid(1),
    ...over,
  };
}

/** A complete roadmaps row. */
function roadmapRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return { player_id: 'p1', json: JSON.stringify(ROADMAP), graph_version: '1.0.0', created_at: T0, ...over };
}

function insertRow(db: Database, table: string, row: Record<string, Cell>): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...Object.values(row),
  );
}

const addProfile = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'player_profiles', profileRow(over));
const addResult = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'test_results', resultRow(over));
const addRoadmap = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'roadmaps', roadmapRow(over));

/** A profile for `id` with `n` results and 2 roadmaps, so erasure and replay tests have something to lose. */
function seedPlayer(db: Database, id: string, n = 0): void {
  addProfile(db, { player_id: id });
  for (let i = 0; i < 2; i++) addResult(db, { player_id: id, client_uuid: uuid(n + i + 1) });
  addRoadmap(db, { player_id: id });
  addRoadmap(db, { player_id: id, created_at: T1 });
}

/**
 * The schema assertions that must hold on ANY database built from the real migrations, whatever is
 * applied after 002: they inspect named tables and columns only and are POSITIVE (this column is
 * NOT NULL, that CHECK exists), never "the table has exactly these columns": a later
 * ALTER TABLE ... ADD COLUMN is legitimate and must not break them.
 */
function expectPlayerContract(db: Database): void {
  // The CHECK lists mirror the contract (parsed out of sqlite_master, not restated here).
  expect(checkList(db, 'player_profiles', 'locale')).toEqual([...LOCALES]);
  expect(checkNumbers(db, 'player_profiles', 'minutes_per_session')).toEqual([...MINUTES_PER_SESSION]);
  expect(checkBetween(db, 'player_profiles', 'days_per_week')).toEqual([DAYS_PER_WEEK[0], DAYS_PER_WEEK[DAYS_PER_WEEK.length - 1]]);
  expect(checkBetween(db, 'player_profiles', 'age')).toEqual([AGE_MIN, AGE_MAX]);
  expect(checkNumbers(db, 'player_profiles', 'partner')).toEqual([0, 1]);
  expect(checkNumbers(db, 'test_results', 'skipped')).toEqual([0, 1]);
  // STRICT, NOT NULL for the required columns, nullable for the optional ones.
  for (const table of PLAYER_TABLES) {
    expect(one<{ strict: number }>(db, 'SELECT strict FROM pragma_table_list WHERE name = ?', table).strict, `${table} STRICT`).toBe(1);
  }
  for (const column of PROFILE_REQUIRED) expect(notNullColumns(db, 'player_profiles'), `player_profiles.${column}`).toContain(column);
  for (const column of RESULT_REQUIRED) expect(notNullColumns(db, 'test_results'), `test_results.${column}`).toContain(column);
  for (const column of ROADMAP_REQUIRED) expect(notNullColumns(db, 'roadmaps'), `roadmaps.${column}`).toContain(column);
  for (const column of RESULT_OPTIONAL) expect(nullableColumns(db, 'test_results'), `test_results.${column}`).toContain(column);

  // Behaviour on all three tables: NOT NULL, enums and bounds, JSON, uuid, foreign keys.
  addProfile(db, { player_id: 'contract-player' });
  const tables: [string, string[], (over: Record<string, Cell>) => void][] = [
    ['player_profiles', PROFILE_REQUIRED, (over) => addProfile(db, { player_id: 'x', ...over })],
    ['test_results', RESULT_REQUIRED, (over) => addResult(db, { player_id: 'contract-player', ...over })],
    ['roadmaps', ROADMAP_REQUIRED, (over) => addRoadmap(db, { player_id: 'contract-player', ...over })],
  ];
  for (const [table, required, insert] of tables) {
    for (const column of required) {
      expect(thrown(() => insert({ [column]: null })).message, `${table}.${column}`).toMatch(
        new RegExp(`NOT NULL constraint failed: ${table}\\.${column}\\b`),
      );
    }
  }
  expect(thrown(() => addProfile(db, { player_id: 'x', locale: 'de' })).message).toMatch(/CHECK constraint failed: locale IN/);
  expect(thrown(() => addProfile(db, { player_id: 'x', minutes_per_session: 25 })).message).toMatch(/CHECK constraint failed: minutes_per_session IN/);
  expect(thrown(() => addProfile(db, { player_id: 'x', days_per_week: 7 })).message).toMatch(/CHECK constraint failed: days_per_week BETWEEN/);
  expect(thrown(() => addProfile(db, { player_id: 'x', age: AGE_MAX + 1 })).message).toMatch(/CHECK constraint failed: age BETWEEN/);
  expect(thrown(() => addResult(db, { player_id: 'contract-player', skipped: 2, client_uuid: uuid(50) })).message).toMatch(/CHECK constraint failed: skipped IN/);
  expect(thrown(() => addRoadmap(db, { player_id: 'contract-player', json: 'not json' })).message).toMatch(/CHECK constraint failed: json_valid\(json\)/);
  expect(thrown(() => addResult(db, { player_id: 'ghost', client_uuid: uuid(51) })).message).toMatch(/FOREIGN KEY constraint failed/);
  expect(thrown(() => addRoadmap(db, { player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
  addResult(db, { player_id: 'contract-player', client_uuid: uuid(52) });
  expect(thrown(() => addResult(db, { player_id: 'contract-player', client_uuid: uuid(52) })).message).toMatch(/UNIQUE constraint failed: test_results\.client_uuid/);
  db.run(`DELETE FROM test_results WHERE player_id = 'contract-player'`);
  db.run(`DELETE FROM player_profiles WHERE player_id = 'contract-player'`);

  // Cascade to both child tables.
  seedPlayer(db, 'cascade-player');
  db.run(`DELETE FROM player_profiles WHERE player_id = 'cascade-player'`);
  expect(count(db, 'test_results', `player_id = 'cascade-player'`)).toBe(0);
  expect(count(db, 'roadmaps', `player_id = 'cascade-player'`)).toBe(0);
}

// --- the migration ---------------------------------------------------------------------------

describe('002_player: migration', () => {
  test('applies after 001 through the real runner and MIGRATIONS_DIR, as version 2', () => {
    const db = openDatabase(join(tmp, 'real.db'));
    opened.push(db);

    const applied = migrate(db);

    expect(applied.slice(0, 2)).toEqual([1, 2]);
    expect(one<{ name: string }>(db, 'SELECT name FROM schema_migrations WHERE version = 2').name).toBe('002_player');
    for (const table of PLAYER_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('applies on top of a database that already has 001 (the upgrade path), and only 002 is applied', () => {
    const db = migrated('001');
    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(1);

    copy002(pair);
    copyFileSync(join(MIGRATIONS_DIR, COMMONS_FILE), join(pair, COMMONS_FILE));
    expect(migrate(db, pair)).toEqual([2]);
    for (const table of PLAYER_TABLES) expect(tableNames(db)).toContain(table);
  });

  test('a copy of 001 + 002 alone in a temp dir applies and passes the whole contract', () => {
    const db = migrated('pair');
    expect(rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2]);
    expectPlayerContract(db);
  });

  test('sits next to its own test, and the directory holds only NNN_name.sql migrations', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(SQL_FILE);
    expect(files).toContain('002_player.test.ts');
    expect(files.filter((f) => f.endsWith('.sql')).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test('creates exactly player_profiles, roadmaps and test_results (plus indexes and AUTOINCREMENT bookkeeping), and none of Better Auth\'s tables', () => {
    const own = ownTables();

    expect(own).toEqual([...PLAYER_TABLES].sort());
    for (const table of BETTER_AUTH_TABLES) expect(own).not.toContain(table);
    // Better Auth creates its tables after migrate(): a migrate-only database has none of them.
    const db = migrated('pair');
    expect(tableNames(db).filter((t) => BETTER_AUTH_TABLES.includes(t))).toEqual([]);
  });

  test('contains no transaction control and no PRAGMA (the runner owns the transaction)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i);
    expect(sql).not.toMatch(/\bPRAGMA\b/i);
  });

  test('the header comment documents the hazards for later authors: no FK to user, erasure, REPLACE, table rebuild', () => {
    const header = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .join('\n');
    expect(header).toMatch(/Better Auth/);
    expect(header).toMatch(/erasure/i);
    expect(header).toMatch(/INSERT OR REPLACE/);
    expect(header).toMatch(/ON CONFLICT/);
    expect(header).toMatch(/DROP TABLE/);
    expect(header).toMatch(/rebuild/i);
    expect(header).toMatch(/no (name|email)/i);
    expect(header).toMatch(/free TEXT/i);
    expect(header).toMatch(/z\.uuid/);
    expect(header).toMatch(/hour 24/i);
    expect(header).toMatch(/whitespace/i);
  });

  test('re-running is a no-op and the recorded checksum is the sha256 of the file bytes, unchanged', () => {
    const db = migrated('all');
    const before = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 2').checksum;
    const schemaBefore = rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const after = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 2').checksum;
    expect(after).toBe(before);
    expect(before).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schemaBefore);
  });

  test('a later 003 that ADDs COLUMNs to all three tables and adds a cascading table does not break the player contract', () => {
    const db = migrated('later');

    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(3);
    // the columns 003 added really are there and nullable (so a closed-world "exactly these columns" pin would fail here)
    expect(nullableColumns(db, 'player_profiles')).toContain('consent_video');
    expect(nullableColumns(db, 'test_results')).toContain('note');
    expect(nullableColumns(db, 'roadmaps')).toContain('note');

    expectPlayerContract(db);

    addProfile(db, { consent_video: 1 });
    addResult(db, { note: 'from 003' });
    addRoadmap(db, { note: 'from 003' });
    db.run(`INSERT INTO consents (player_id) VALUES ('p1')`);
    expect(one<{ note: string }>(db, 'SELECT note FROM test_results').note).toBe('from 003');
    expect(one<{ consent_video: number }>(db, 'SELECT consent_video FROM player_profiles WHERE player_id = ?', 'p1').consent_video).toBe(1);
    db.run(`DELETE FROM player_profiles WHERE player_id = 'p1'`);
    expect(count(db, 'consents')).toBe(0); // 003's own cascade works next to 002's
    expect(count(db, 'test_results')).toBe(0);
    expect(count(db, 'roadmaps')).toBe(0);
  });

  test('on the 002 file alone the three tables have exactly the contract columns, nullability, foreign keys and no extra unique index', () => {
    const db = migrated('pair');

    for (const [table, types] of Object.entries(COLUMN_TYPES)) {
      const columns = rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
      expect(columns.sort(), table).toEqual(Object.keys(types).sort());
    }
    expect(nullableColumns(db, 'player_profiles')).toEqual([]);
    expect(nullableColumns(db, 'roadmaps')).toEqual([]);
    expect(nullableColumns(db, 'test_results').sort()).toEqual([...RESULT_OPTIONAL].sort());
    for (const table of ['test_results', 'roadmaps']) {
      const fks = rows<Record<string, unknown>>(db, `SELECT * FROM pragma_foreign_key_list('${table}')`);
      expect(fks, table).toHaveLength(1);
      expect(fks[0]).toMatchObject({ table: 'player_profiles', from: 'player_id', to: 'player_id', on_delete: 'CASCADE', on_update: 'CASCADE' });
    }
    expect(rows(db, `SELECT name FROM pragma_index_list('roadmaps') WHERE "unique" = 1 AND origin <> 'pk'`)).toEqual([]);
    addProfile(db);
    const row = one<Record<string, unknown>>(db, 'SELECT * FROM player_profiles');
    expect(Object.keys(row).sort()).toEqual([...PROFILE_REQUIRED].sort());
  });

  test('the real schema passes the contract (every enum/CHECK/STRICT/NOT NULL assertion runs against the full current schema)', () => {
    expectPlayerContract(migrated('all'));
  });
});

// --- no PII ------------------------------------------------------------------------------------

describe('002_player: stores no personal data', () => {
  test('no column of any table 002 creates matches name, email, birth, dob, phone or address (enumerated from PRAGMA table_info)', () => {
    const db = migrated('all');
    const tables = ownTables();
    expect(tables.length).toBe(PLAYER_TABLES.length);

    for (const table of tables) {
      const columns = rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
      expect(columns.length, table).toBeGreaterThan(0);
      for (const column of columns) expect(column, `${table}.${column}`).not.toMatch(PII_COLUMN);
    }
  });

  test('the PII pattern itself catches the usual spellings (so the test above cannot go vacuous)', () => {
    for (const bad of ['name', 'full_name', 'display_name', 'email', 'e_mail', 'birth_date', 'date_of_birth', 'birthday', 'dob', 'phone', 'phone_number', 'address', 'email_address']) {
      expect(bad, bad).toMatch(PII_COLUMN);
    }
    for (const fine of ['player_id', 'age', 'test_slug', 'client_uuid', 'json', 'graph_version', 'created_at', 'locale']) {
      expect(fine, fine).not.toMatch(PII_COLUMN);
    }
  });

  test('the columns the contract names exist on each table (so the PII scan looks at the real tables)', () => {
    const db = migrated('all');
    for (const [table, types] of Object.entries(COLUMN_TYPES)) {
      const info = rows<{ name: string; type: string }>(db, `SELECT name, type FROM pragma_table_info('${table}')`);
      for (const [column, type] of Object.entries(types)) {
        expect(info.find((c) => c.name === column)?.type, `${table}.${column}`).toBe(type);
      }
    }
  });
});

// --- STRICT typing and NOT NULL -----------------------------------------------------------------

describe('002_player: STRICT typing', () => {
  test('every table this migration creates is STRICT (enumerated from PRAGMA table_list, not hard-coded)', () => {
    const own = ownTables();
    const db = migrated('pair');
    const tables = rows<{ name: string; strict: number }>(db, 'SELECT name, strict FROM pragma_table_list WHERE schema = \'main\' AND type = \'table\'').filter(
      (t) => own.includes(t.name),
    );

    expect(tables.map((t) => t.name).sort()).toEqual([...PLAYER_TABLES].sort());
    for (const table of tables) expect(table.strict, `${table.name} must be STRICT`).toBe(1);
  });

  test('text and fractions are rejected in INTEGER columns, a blob in a TEXT column, text in the REAL value', () => {
    const db = migrated('all');
    addProfile(db);
    const datatype = /cannot store .* value in .* column|datatype mismatch/i;
    const blob = new Uint8Array([1, 2]) as unknown as string;

    for (const column of ['age', 'partner', 'days_per_week', 'minutes_per_session']) {
      for (const bad of ['abc', 5.5]) {
        expect(thrown(() => addProfile(db, { player_id: 'x', [column]: bad })).message, `${column}=${bad}`).toMatch(datatype);
      }
    }
    for (const column of ['level', 'goal', 'equipment', 'space', 'locale', 'created_at']) {
      expect(thrown(() => addProfile(db, { player_id: 'x', [column]: blob })).message, column).toMatch(datatype);
    }
    for (const column of ['attempts', 'errors', 'skipped']) {
      for (const bad of ['abc', 1.5]) {
        expect(thrown(() => addResult(db, { [column]: bad })).message, `${column}=${bad}`).toMatch(datatype);
      }
    }
    expect(thrown(() => addResult(db, { value: 'abc' })).message).toMatch(datatype);
    expect(thrown(() => addResult(db, { test_slug: blob })).message).toMatch(datatype);
    expect(thrown(() => addRoadmap(db, { json: blob })).message).toMatch(datatype);
    expect(thrown(() => addRoadmap(db, { graph_version: blob })).message).toMatch(datatype);
    expect(count(db, 'test_results')).toBe(0);
    expect(count(db, 'roadmaps')).toBe(0);
  });
});

describe('002_player: required columns are NOT NULL', () => {
  test('PRAGMA table_info marks every contract-required column NOT NULL and every optional one nullable (positive pins)', () => {
    const db = migrated('all');

    expect(notNullColumns(db, 'player_profiles')).toEqual(expect.arrayContaining(PROFILE_REQUIRED));
    expect(notNullColumns(db, 'test_results')).toEqual(expect.arrayContaining(RESULT_REQUIRED));
    expect(notNullColumns(db, 'roadmaps')).toEqual(expect.arrayContaining(ROADMAP_REQUIRED));
    expect(nullableColumns(db, 'test_results')).toEqual(expect.arrayContaining(RESULT_OPTIONAL));
  });

  test('inserting NULL into any required column is rejected as NOT NULL, on all three tables', () => {
    const db = migrated('all');
    addProfile(db);
    const cases: [string, string[], (over: Record<string, Cell>) => void][] = [
      ['player_profiles', PROFILE_REQUIRED, (over) => addProfile(db, { player_id: 'x', ...over })],
      ['test_results', RESULT_REQUIRED, (over) => addResult(db, over)],
      ['roadmaps', ROADMAP_REQUIRED, (over) => addRoadmap(db, over)],
    ];

    for (const [table, required, insert] of cases) {
      for (const column of required) {
        const err = thrown(() => insert({ [column]: null }));
        expect(err.message, `${table}.${column}`).toMatch(new RegExp(`NOT NULL constraint failed: ${table}\\.${column}\\b`));
      }
    }
    expect(count(db, 'player_profiles')).toBe(1);
    expect(count(db, 'test_results')).toBe(0);
    expect(count(db, 'roadmaps')).toBe(0);
  });

  test('the optional counts take NULL (absent) and 0, and omitted defaulted columns get their defaults', () => {
    const db = migrated('all');
    addProfile(db);

    addResult(db, { attempts: null, errors: null });
    addResult(db, { attempts: 0, errors: 0, client_uuid: uuid(2) });
    db.query('INSERT INTO test_results (player_id, test_slug, value, client_uuid) VALUES (?, ?, ?, ?)').run('p1', 'plank', 45, uuid(3));

    const last = one<Record<string, Cell>>(db, 'SELECT * FROM test_results WHERE client_uuid = ?', uuid(3));
    expect(last.skipped).toBe(0);
    expect(last.attempts).toBeNull();
    expect(last.errors).toBeNull();
    expect(Timestamp.safeParse(last.recorded_at).success).toBe(true);
  });
});

// --- enums and bounds mirror the contract ---------------------------------------------------------

describe('002_player: CHECK lists and bounds mirror the contract', () => {
  test('the SQL parsed out of sqlite_master equals LOCALES, MINUTES_PER_SESSION, the day and age bounds (no missing, no extra)', () => {
    const db = migrated('all');

    expect(checkList(db, 'player_profiles', 'locale')).toEqual([...LOCALES]);
    expect(checkNumbers(db, 'player_profiles', 'minutes_per_session')).toEqual([...MINUTES_PER_SESSION]);
    expect(checkBetween(db, 'player_profiles', 'days_per_week')).toEqual([2, 6]);
    expect(checkBetween(db, 'player_profiles', 'days_per_week')).toEqual([DAYS_PER_WEEK[0], DAYS_PER_WEEK[DAYS_PER_WEEK.length - 1]]);
    expect(checkBetween(db, 'player_profiles', 'age')).toEqual([AGE_MIN, AGE_MAX]);
  });

  test('every contract locale is accepted; unknown ones are rejected', () => {
    const db = migrated('all');
    LOCALES.forEach((locale, i) => addProfile(db, { player_id: `loc-${i}`, locale }));
    expect(count(db, 'player_profiles')).toBe(LOCALES.length);

    for (const bad of ['de', 'RU', 'ru ', 'ru-RU', '']) {
      expect(thrown(() => addProfile(db, { player_id: `bad-${bad}`, locale: bad })).message, `"${bad}"`).toMatch(/CHECK constraint failed: locale IN/);
    }
  });

  test('every contract minutes-per-session is accepted; anything else is rejected', () => {
    const db = migrated('all');
    MINUTES_PER_SESSION.forEach((m, i) => addProfile(db, { player_id: `m-${i}`, minutes_per_session: m }));

    for (const bad of [0, 5, 12, 25, 60, -10]) {
      expect(thrown(() => addProfile(db, { player_id: `bad-${bad}`, minutes_per_session: bad })).message, `${bad}`).toMatch(
        /CHECK constraint failed: minutes_per_session IN/,
      );
    }
  });

  test('days per week and age are accepted at both contract bounds and rejected just outside them', () => {
    const db = migrated('all');
    const lo = DAYS_PER_WEEK[0];
    const hi = DAYS_PER_WEEK[DAYS_PER_WEEK.length - 1] as number;
    for (const days of DAYS_PER_WEEK) addProfile(db, { player_id: `d-${days}`, days_per_week: days });
    for (const bad of [lo - 1, hi + 1, 0, -1]) {
      expect(thrown(() => addProfile(db, { player_id: `bad-d${bad}`, days_per_week: bad })).message, `${bad}`).toMatch(
        /CHECK constraint failed: days_per_week BETWEEN/,
      );
    }

    for (const age of [AGE_MIN, AGE_MAX, 18]) addProfile(db, { player_id: `a-${age}`, age });
    for (const bad of [AGE_MIN - 1, AGE_MAX + 1, 0, -3]) {
      expect(thrown(() => addProfile(db, { player_id: `bad-a${bad}`, age: bad })).message, `${bad}`).toMatch(/CHECK constraint failed: age BETWEEN/);
    }
  });

  test('partner and skipped are 0/1 only', () => {
    const db = migrated('all');
    addProfile(db, { player_id: 'yes', partner: 1 });
    addProfile(db, { player_id: 'no', partner: 0 });
    addProfile(db); // p1 owns the results below
    for (const bad of [2, -1]) {
      expect(thrown(() => addProfile(db, { player_id: 'x', partner: bad })).message).toMatch(/CHECK constraint failed: partner IN/);
    }

    addResult(db, { skipped: 1, value: 0, client_uuid: uuid(10) });
    addResult(db, { skipped: 0, client_uuid: uuid(11) });
    for (const bad of [2, -1]) {
      expect(thrown(() => addResult(db, { skipped: bad, client_uuid: uuid(12) })).message).toMatch(/CHECK constraint failed: skipped IN/);
    }
  });

  test('level, goal, equipment and space take every contract value (they are free TEXT on purpose)', () => {
    const db = migrated('all');
    let n = 0;
    for (const level of EXPERIENCE_LEVELS) addProfile(db, { player_id: `lv-${n++}`, level });
    for (const goal of GOALS) addProfile(db, { player_id: `go-${n++}`, goal });
    for (const equipment of EQUIPMENT) addProfile(db, { player_id: `eq-${n++}`, equipment });
    for (const space of SPACES) addProfile(db, { player_id: `sp-${n++}`, space });
    addProfile(db, { player_id: 'inner space', level: 'a b' }); // blank means nothing but whitespace, not "has a space"
    expect(count(db, 'player_profiles')).toBe(n + 1);
  });

  const BLANKS = ['', ' ', '   ', '\t', '\n', '\r', '\r\n', ' \t\n ', '\t\t'];

  test('level, goal, equipment and space are never blank: empty, spaces, tab, newline and carriage return are all refused', () => {
    const db = migrated('all');

    for (const column of ['level', 'goal', 'equipment', 'space']) {
      for (const blank of BLANKS) {
        expect(thrown(() => addProfile(db, { player_id: 'blank', [column]: blank })).message, `${column}=${JSON.stringify(blank)}`).toMatch(
          new RegExp(`CHECK constraint failed: trim\\(${column}, `),
        );
      }
    }
    expect(count(db, 'player_profiles')).toBe(0);
  });

  test('player_id is never blank: empty, spaces, tab, newline and carriage return are all refused', () => {
    const db = migrated('all');

    for (const blank of BLANKS) {
      expect(thrown(() => addProfile(db, { player_id: blank })).message, JSON.stringify(blank)).toMatch(/CHECK constraint failed: trim\(player_id, /);
    }
    addProfile(db, { player_id: 'auth-user-abc123' });
    expect(count(db, 'player_profiles')).toBe(1);
  });
});

// --- constraints ---------------------------------------------------------------------------------

describe('002_player: foreign keys and cascade', () => {
  test('foreign keys are on for the application connection and results/roadmaps reference player_profiles with ON DELETE CASCADE', () => {
    const db = migrated('all');
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(1);

    for (const table of ['test_results', 'roadmaps']) {
      const fks = rows<Record<string, unknown>>(db, `SELECT * FROM pragma_foreign_key_list('${table}')`);
      expect(fks, table).toContainEqual(
        expect.objectContaining({ table: 'player_profiles', from: 'player_id', to: 'player_id', on_delete: 'CASCADE' }),
      );
    }
  });

  test('player_profiles.player_id has NO foreign key: it holds the auth user id, whose table does not exist at migrate time', () => {
    const db = migrated('pair');

    expect(rows(db, "SELECT * FROM pragma_foreign_key_list('player_profiles')")).toEqual([]);
    expect(createSql(db, 'player_profiles')).not.toMatch(/REFERENCES/i);
    expect(tableNames(db)).not.toContain('user');
    addProfile(db, { player_id: 'auth-user-abc123' }); // no "user" table needed
    expect(count(db, 'player_profiles')).toBe(1);
  });

  test('a result or roadmap for a player without a profile is rejected (an orphan)', () => {
    const db = migrated('all');
    addProfile(db);

    expect(thrown(() => addResult(db, { player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(thrown(() => addRoadmap(db, { player_id: 'ghost' })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(count(db, 'test_results')).toBe(0);
    expect(count(db, 'roadmaps')).toBe(0);
  });

  test('deleting a profile cascades to its results AND roadmaps, and leaves every other player alone', () => {
    const db = migrated('all');
    seedPlayer(db, 'p1', 0);
    seedPlayer(db, 'p2', 10);
    expect(count(db, 'test_results')).toBe(4);
    expect(count(db, 'roadmaps')).toBe(4);

    db.run(`DELETE FROM player_profiles WHERE player_id = 'p1'`);

    expect(count(db, 'player_profiles')).toBe(1);
    expect(count(db, 'test_results', `player_id = 'p1'`)).toBe(0);
    expect(count(db, 'roadmaps', `player_id = 'p1'`)).toBe(0);
    expect(count(db, 'test_results', `player_id = 'p2'`)).toBe(2);
    expect(count(db, 'roadmaps', `player_id = 'p2'`)).toBe(2);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('deleting only the roadmaps (a plan reset) keeps the profile and its results', () => {
    const db = migrated('all');
    seedPlayer(db, 'p1');

    db.run(`DELETE FROM roadmaps WHERE player_id = 'p1'`);

    expect(count(db, 'player_profiles')).toBe(1);
    expect(count(db, 'test_results')).toBe(2);
    expect(count(db, 'roadmaps')).toBe(0);
  });

  test('changing a profile\'s player_id (recovery moves the data to the new session) carries its results and roadmaps along', () => {
    const db = migrated('all');
    seedPlayer(db, 'old-session');

    db.run(`UPDATE player_profiles SET player_id = 'new-session' WHERE player_id = 'old-session'`);

    expect(count(db, 'test_results', `player_id = 'new-session'`)).toBe(2);
    expect(count(db, 'roadmaps', `player_id = 'new-session'`)).toBe(2);
    expect(count(db, 'test_results', `player_id = 'old-session'`)).toBe(0);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  test('an upsert (ON CONFLICT DO UPDATE) keeps the player\'s history; INSERT OR REPLACE wipes it (the hazard the header documents)', () => {
    const db = migrated('all');
    seedPlayer(db, 'p1');

    db.query(
      `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale, created_at, updated_at)
       VALUES ('p1', 13, 'basic', 'passing', 'ball', 'gym', 0, 4, 30, 'en', ?, ?)
       ON CONFLICT (player_id) DO UPDATE SET age = excluded.age, goal = excluded.goal, updated_at = excluded.updated_at`,
    ).run(T1, T1);
    expect(one<{ age: number; goal: string }>(db, `SELECT age, goal FROM player_profiles WHERE player_id = 'p1'`)).toEqual({ age: 13, goal: 'passing' });
    expect(count(db, 'test_results')).toBe(2);
    expect(count(db, 'roadmaps')).toBe(2);

    // a plain INSERT of an existing player is an error, not a silent replace
    expect(thrown(() => addProfile(db)).message).toMatch(/UNIQUE constraint failed: player_profiles\.player_id/);

    db.run(
      `INSERT OR REPLACE INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
       VALUES ('p1', 13, 'basic', 'passing', 'ball', 'gym', 0, 4, 30, 'en')`,
    );
    expect(count(db, 'player_profiles')).toBe(1);
    expect(count(db, 'test_results')).toBe(0); // the replaced parent row cascaded
    expect(count(db, 'roadmaps')).toBe(0);
  });
});

// --- test_results: idempotent replay ----------------------------------------------------------------

describe('002_player: test_results replay key', () => {
  test('client_uuid is UNIQUE (a unique index over exactly that column) and a duplicate is rejected, even for another player', () => {
    const db = migrated('all');
    addProfile(db, { player_id: 'p1' });
    addProfile(db, { player_id: 'p2' });
    addResult(db, { player_id: 'p1', client_uuid: uuid(1) });

    const uniques = rows<{ name: string }>(db, `SELECT name FROM pragma_index_list('test_results') WHERE "unique" = 1`).map((r) => r.name);
    const columns = uniques.map((name) => rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${name}') ORDER BY seqno`).map((c) => c.name));
    expect(columns).toContainEqual(['client_uuid']);

    const same = thrown(() => addResult(db, { player_id: 'p1', test_slug: 'plank', client_uuid: uuid(1) }));
    expect(same.message).toMatch(/UNIQUE constraint failed: test_results\.client_uuid/);
    const other = thrown(() => addResult(db, { player_id: 'p2', client_uuid: uuid(1) }));
    expect(other.message).toMatch(/UNIQUE constraint failed: test_results\.client_uuid/);
    expect(count(db, 'test_results')).toBe(1);
  });

  test('replaying a batch with ON CONFLICT (client_uuid) DO NOTHING stores each result once', () => {
    const db = migrated('all');
    addProfile(db);
    const insert = db.query(
      `INSERT INTO test_results (player_id, test_slug, value, client_uuid, recorded_at) VALUES ('p1', ?, ?, ?, ?)
       ON CONFLICT (client_uuid) DO NOTHING`,
    );
    const batch: [string, number, string][] = [['juggling-30s', 12, uuid(1)], ['plank', 45.5, uuid(2)]];

    for (let attempt = 0; attempt < 3; attempt++) for (const [slug, value, id] of batch) insert.run(slug, value, id, T0);

    expect(count(db, 'test_results')).toBe(2);
    expect(one<{ value: number }>(db, 'SELECT value FROM test_results WHERE client_uuid = ?', uuid(2)).value).toBe(45.5);
  });

  test('client_uuid is NOT NULL, a lower-case 36-character UUID shape; upper case and other shapes are rejected', () => {
    const db = migrated('all');
    addProfile(db);
    addResult(db, { client_uuid: '0190f1c2-7a3b-4c5d-8e9f-0a1b2c3d4e5f' });

    const bad = [
      '', 'not-a-uuid', uuid(3).replace(/-/g, ''), `${uuid(4)} `, ` ${uuid(5)}`, `${uuid(6)}0`,
      '0190f1c2-7a3b-4c5d-8e9f-0a1b2c3d4e5g', '0190F1C2-7A3B-4C5D-8E9F-0A1B2C3D4E5F', '0190f1c27-a3b-4c5d-8e9f-0a1b2c3d4e5f',
    ];
    for (const client_uuid of bad) {
      expect(thrown(() => addResult(db, { client_uuid })).message, `"${client_uuid}"`).toMatch(/CHECK constraint failed/);
    }
    expect(count(db, 'test_results')).toBe(1);
  });

  test('hyphens are only allowed at positions 9, 14, 19 and 24: no all-hyphen string, no hyphen in a hex position', () => {
    const db = migrated('all');
    addProfile(db);
    const bad = [
      '-'.repeat(36),
      '00000000-0000-4000-8000-00000000000-', // hyphen as the last hex digit
      '-0000000-0000-4000-8000-000000000001', // hyphen as the first hex digit
      '0000000-0-000-4000-8000-000000000001', // hyphen at position 10, none at 9
      '00000000-0000-4000-8000-0000-0000001', // group boundary moved
      '00000000-0000-4-00-8000-000000000001', // hyphen inside the version group
      '00000000-0000-4000-80-0-000000000001',
      '000000000-000-4000-8000-000000000001',
      '00000000_0000_4000_8000_000000000001', // wrong separator
    ];
    for (const client_uuid of bad) {
      expect(client_uuid).toHaveLength(36);
      expect(thrown(() => addResult(db, { client_uuid })).message, client_uuid).toMatch(/CHECK constraint failed/);
    }
    expect(count(db, 'test_results')).toBe(0);
    addResult(db, { client_uuid: '0190f1c2-7a3b-4c5d-8e9f-0a1b2c3d4e5f' }); // a real v4 is still fine
  });

  test('the shape mirrors z.uuid() (ClientUuid) exactly on lower-case input: version 1-8, variant 8/9/a/b, nil and max accepted', () => {
    const db = migrated('all');
    addProfile(db);
    const candidates = new Set([
      '00000000-0000-0000-0000-000000000000', // nil: Zod accepts
      'ffffffff-ffff-ffff-ffff-ffffffffffff', // max: Zod accepts
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-9000-000000000001',
      '00000000-0000-4000-a000-000000000001',
      '00000000-0000-4000-b000-000000000001',
      '00000000-0000-4000-c000-000000000001', // variant c: Zod refuses
      '00000000-0000-4000-0000-000000000001', // variant 0: Zod refuses
      '00000000-0000-4000-f000-000000000001',
      '00000000-0000-0000-8000-000000000001', // version 0: Zod refuses
      '00000000-0000-9000-8000-000000000001', // version 9: Zod refuses
      '00000000-0000-f000-8000-000000000001',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-ffff-ffff-ffffffffffff',
      '0190f1c2-7a3b-7c5d-8e9f-0a1b2c3d4e5f', // v7
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((v) => `00000000-0000-${v}000-8000-000000000001`),
    ]); // a Set: a repeated candidate would hit UNIQUE instead of the CHECK

    [...candidates].forEach((client_uuid, i) => {
      const zodAccepts = ClientUuid.safeParse(client_uuid).success;
      const dbAccepts = (() => {
        try {
          addResult(db, { client_uuid });
          return true;
        } catch (e) {
          expect((e as Error).message, client_uuid).toMatch(/CHECK constraint failed/);
          return false;
        }
      })();
      expect(dbAccepts, `${client_uuid} (candidate ${i})`).toBe(zodAccepts);
      // what Zod hands the server is what the column stores: the lower-cased form
      if (zodAccepts) expect(ClientUuid.parse(client_uuid)).toBe(client_uuid);
    });
    // upper case parses in Zod (it is lower-cased there) but is refused raw: the server must store the parsed form
    expect(ClientUuid.parse('0190F1C2-7A3B-4C5D-8E9F-0A1B2C3D4E5F')).toBe('0190f1c2-7a3b-4c5d-8e9f-0a1b2c3d4e5f');
    expect(thrown(() => addResult(db, { client_uuid: '0190F1C2-7A3B-4C5D-8E9F-0A1B2C3D4E5F' })).message).toMatch(/CHECK constraint failed/);
  });

  test('the same player can hold many results for one test (history); only client_uuid is unique', () => {
    const db = migrated('all');
    addProfile(db);
    for (let i = 0; i < 5; i++) addResult(db, { client_uuid: uuid(i + 1), value: i * 3, recorded_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    expect(count(db, 'test_results', `player_id = 'p1' AND test_slug = 'juggling-30s'`)).toBe(5);
  });

  test('test_slug is an EntityId-shaped string with NO foreign key (a replayed offline result must survive seed changes)', () => {
    const db = migrated('all');
    addProfile(db);

    const alone = migrated('pair'); // on the 002 file alone the only FK is to player_profiles
    expect(rows(alone, `SELECT * FROM pragma_foreign_key_list('test_results')`).map((r) => (r as { table: string }).table)).toEqual(['player_profiles']);
    addResult(db, { test_slug: 'a-test-no-seed-knows-about', client_uuid: uuid(1) }); // not in skill_tests
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(129)]) {
      expect(thrown(() => addResult(db, { test_slug: bad, client_uuid: uuid(2) })).message, `"${bad.slice(0, 20)}"`).toMatch(/CHECK constraint failed/);
    }
    addResult(db, { test_slug: 'x'.repeat(128), client_uuid: uuid(3) });
    addResult(db, { test_slug: 'Mixed_Case.slug-1', client_uuid: uuid(4) });
  });

  test('value is a REAL: fractions, zero (a skipped test) and negatives are kept exactly; NaN and infinity are refused', () => {
    const db = migrated('all');
    addProfile(db);
    const values = [12.5, 0, -1.25, 7, 1e-9, 123456789.125];

    values.forEach((value, i) => addResult(db, { value, client_uuid: uuid(i + 1) }));

    const stored = rows<{ value: number }>(db, 'SELECT value FROM test_results ORDER BY id').map((r) => r.value);
    expect(stored).toEqual(values);
    expect(thrown(() => addResult(db, { value: Infinity, client_uuid: uuid(90) })).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => addResult(db, { value: -Infinity, client_uuid: uuid(91) })).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => addResult(db, { value: Number.NaN, client_uuid: uuid(92) })).message).toMatch(/NOT NULL constraint failed: test_results\.value/);
  });

  test('attempts and errors are non-negative integers when present', () => {
    const db = migrated('all');
    addProfile(db);

    for (const column of ['attempts', 'errors']) {
      expect(thrown(() => addResult(db, { [column]: -1, client_uuid: uuid(1) })).message, column).toMatch(
        new RegExp(`CHECK constraint failed: ${column} IS NULL OR ${column} >= 0`),
      );
      addResult(db, { [column]: 0, client_uuid: uuid(column === 'attempts' ? 2 : 3) });
    }
  });
});

// --- JSON, timestamps, roadmap history ---------------------------------------------------------------------

describe('002_player: roadmaps', () => {
  test('json must be valid JSON and an object (json_valid CHECK); the graph_version must not be blank', () => {
    const db = migrated('all');
    addProfile(db);

    for (const bad of ['not json', '', '[]', '"text"', '5', 'null', '{"a":']) {
      expect(thrown(() => addRoadmap(db, { json: bad })).message, `"${bad}"`).toMatch(/CHECK constraint failed: json_valid\(json\)/);
    }
    expect(thrown(() => addRoadmap(db, { graph_version: '' })).message).toMatch(/CHECK constraint failed: graph_version <> ''/);
    addRoadmap(db, { json: '{}' });
    expect(count(db, 'roadmaps')).toBe(1);
  });

  test('a player keeps a history: several roadmaps per player are allowed, ids only increase', () => {
    const db = migrated('all');
    addProfile(db);

    addRoadmap(db, { created_at: T0 });
    addRoadmap(db, { created_at: T1 });
    addRoadmap(db, { created_at: T1 }); // same instant: the id still orders them

    const ids = rows<{ id: number }>(db, 'SELECT id FROM roadmaps ORDER BY id').map((r) => r.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const alone = migrated('pair'); // 002's own definition has no unique index besides the primary key
    const uniques = rows<{ name: string }>(alone, `SELECT name FROM pragma_index_list('roadmaps') WHERE "unique" = 1 AND origin <> 'pk'`);
    expect(uniques).toEqual([]);
  });

  test('the current roadmap is the latest by (created_at, id), including a tie on created_at', () => {
    const db = migrated('all');
    addProfile(db);
    addRoadmap(db, { created_at: T2, graph_version: '1.0.0' });
    addRoadmap(db, { created_at: T0, graph_version: '0.9.0' });
    addRoadmap(db, { created_at: T2, graph_version: '1.1.0' }); // ties with the first on created_at, inserted later

    const current = one<{ graph_version: string }>(
      db,
      'SELECT graph_version FROM roadmaps WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      'p1',
    );
    expect(current.graph_version).toBe('1.1.0');
  });
});

describe('002_player: timestamps are canonical UTC text so that text order is time order', () => {
  const GOOD = '2026-01-01T00:00:00.000Z';
  const ALSO_GOOD = ['2026-01-01T23:59:59.999Z', '2026-12-31T23:59:59.999Z', '2026-02-28T12:30:45.001Z'];
  const BAD = [
    '2026-01-01T24:00:00.000Z', // hour 24: strftime round-trips it, Zod refuses it, and it is the same instant as 01-02T00:00
    '2026-01-01T24:59:59.999Z',
    '2026-01-01T00:60:00.000Z',
    '2026-01-01T00:00:60.000Z',
    '2026-01-01T00:00:00Z', // no milliseconds
    '2026-01-01T05:00:00.000+05:00', // offset, not UTC
    '2026-01-01 00:00:00.000Z', // space instead of T
    '2026-02-30T00:00:00.000Z', // no such day
    '2026-13-45T00:00:00.000Z',
    '2026-01-01T00:00:00.0004Z',
    'yesterday',
    '',
    '1767225600',
  ];
  test('every timestamp column accepts the canonical form and rejects other spellings', () => {
    const db = migrated('all');
    addProfile(db); // p1 owns the result row below
    const cases: [string, (value: string, n: number) => void][] = [
      ['player_profiles.created_at', (value, n) => addProfile(db, { player_id: `c${n}`, created_at: value })],
      ['player_profiles.updated_at', (value, n) => addProfile(db, { player_id: `u${n}`, updated_at: value })],
      ['test_results.recorded_at', (value, n) => addResult(db, { recorded_at: value, client_uuid: uuid(n) })],
      ['roadmaps.created_at', (value) => addRoadmap(db, { created_at: value })],
    ];

    cases.forEach(([name, insert], i) => {
      const column = name.split('.')[1] as string;
      expect(() => insert(GOOD, 100 + i * 10), name).not.toThrow();
      expect(Timestamp.safeParse('2026-01-01T24:00:00.000Z').success).toBe(false); // the contract agrees hour 24 is not a time
      ALSO_GOOD.forEach((good, k) => {
        expect(() => insert(good, 101 + i * 10 + k), `${name}=${good}`).not.toThrow();
        expect(Timestamp.safeParse(good).success, good).toBe(true);
      });
      BAD.forEach((bad, j) => {
        const err = thrown(() => insert(bad, 300 + i * 20 + j));
        expect(err.message, `${name}=${JSON.stringify(bad)}`).toMatch(new RegExp(`CHECK constraint failed: strftime\\(.*\\) IS ${column}`));
      });
    });
  });

  test('a default timestamp is a valid contract Timestamp, and updated_at defaults like created_at', () => {
    const db = migrated('all');
    db.run(
      `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
       VALUES ('p1', 12, 'basic', 'control', 'ball', 'yard', 0, 3, 20, 'en')`,
    );
    db.run(`INSERT INTO test_results (player_id, test_slug, value, client_uuid) VALUES ('p1', 'plank', 30, '${uuid(1)}')`);
    db.run(`INSERT INTO roadmaps (player_id, json, graph_version) VALUES ('p1', '{}', '1.0.0')`);

    const profile = one<{ created_at: string; updated_at: string }>(db, 'SELECT created_at, updated_at FROM player_profiles');
    const result = one<{ recorded_at: string }>(db, 'SELECT recorded_at FROM test_results');
    const roadmap = one<{ created_at: string }>(db, 'SELECT created_at FROM roadmaps');
    for (const value of [profile.created_at, profile.updated_at, result.recorded_at, roadmap.created_at]) {
      expect(Timestamp.safeParse(value).success, value).toBe(true);
    }
  });
});

// --- query patterns -------------------------------------------------------------------------------------

describe('002_player: the progress queries the contracts imply are index lookups', () => {
  const plan = (db: Database, sql: string): string =>
    rows<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, ...['p1', 'juggling-30s'].slice(0, sql.split('?').length - 1))
      .map((r) => r.detail)
      .join('\n');
  const indexColumns = (db: Database, index: string): string[] =>
    rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`).map((r) => r.name);

  test('the named indexes exist over the columns those queries need', () => {
    const db = migrated('all');

    expect(indexColumns(db, 'test_results_by_player_test')).toEqual(['player_id', 'test_slug', 'recorded_at', 'id']);
    expect(indexColumns(db, 'test_results_by_player_time')).toEqual(['player_id', 'recorded_at', 'id']);
    expect(indexColumns(db, 'roadmaps_by_player')).toEqual(['player_id', 'created_at', 'id']);
  });

  test('latest result per player and test (journey latest/previous/personal best) uses test_results_by_player_test, no sort', () => {
    const db = migrated('all');
    const sql = `SELECT value, recorded_at FROM test_results WHERE player_id = ? AND test_slug = ? ORDER BY recorded_at DESC, id DESC LIMIT 1`;

    const p = plan(db, sql);
    expect(p).toMatch(/SEARCH test_results USING (COVERING )?INDEX test_results_by_player_test \(player_id=\? AND test_slug=\?\)/);
    expect(p).not.toMatch(/TEMP B-TREE|SCAN/);
  });

  test('a player\'s results in time order (history, sessions, export) use test_results_by_player_time, no sort', () => {
    const db = migrated('all');
    const sql = `SELECT test_slug, value, recorded_at FROM test_results WHERE player_id = ? ORDER BY recorded_at, id`;

    const p = plan(db, sql);
    expect(p).toMatch(/SEARCH test_results USING (COVERING )?INDEX test_results_by_player_time \(player_id=\?\)/);
    expect(p).not.toMatch(/TEMP B-TREE|SCAN/);
  });

  test('replay lookup by client_uuid uses the UNIQUE index', () => {
    const db = migrated('all');
    expect(plan(db, 'SELECT id FROM test_results WHERE client_uuid = ?')).toMatch(
      /SEARCH test_results USING (COVERING )?INDEX sqlite_autoindex_test_results_\d+ \(client_uuid=\?\)/,
    );
  });

  test('the current roadmap of a player uses roadmaps_by_player, no sort', () => {
    const db = migrated('all');
    const p = plan(db, 'SELECT json FROM roadmaps WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');

    expect(p).toMatch(/SEARCH roadmaps USING (COVERING )?INDEX roadmaps_by_player \(player_id=\?\)/);
    expect(p).not.toMatch(/TEMP B-TREE|SCAN/);
  });

  test('erasing a player (the cascade\'s child lookups) does not scan the child tables', () => {
    const db = migrated('all');
    for (const table of ['test_results', 'roadmaps']) {
      const p = plan(db, `DELETE FROM ${table} WHERE player_id = ?`);
      expect(p, table).toMatch(new RegExp(`SEARCH ${table} USING (COVERING )?INDEX \\w+ \\(player_id=\\?\\)`));
      expect(p, table).not.toMatch(/SCAN/);
    }
  });

  test('latest, previous and personal best per test come out of the rows as the journey contract needs', () => {
    const db = migrated('all');
    addProfile(db);
    [[T0, 10], [T1, 14], [T2, 12]].forEach(([at, value], i) => addResult(db, { recorded_at: at as string, value: value as number, client_uuid: uuid(i + 1) }));
    addResult(db, { test_slug: 'plank', value: 60, recorded_at: T2, client_uuid: uuid(9) });

    const history = rows<{ value: number; recorded_at: string }>(
      db,
      'SELECT value, recorded_at FROM test_results WHERE player_id = ? AND test_slug = ? ORDER BY recorded_at DESC, id DESC',
      'p1',
      'juggling-30s',
    );
    expect(history.map((h) => h.value)).toEqual([12, 14, 10]); // latest, previous, first
    expect(Math.max(...history.map((h) => h.value))).toBe(14); // personalBest for a "higher" test
    expect(count(db, 'test_results', `test_slug = 'plank'`)).toBe(1);
  });
});

// --- the schema can hold what the contracts serve --------------------------------------------------------------

describe('002_player: stores contract records and reads them back through the contract parsers', () => {
  test('a PlayerProfile round-trips: the row maps to the strict request shape and the view', () => {
    const db = migrated('all');
    addProfile(db);

    const r = one<Record<string, string | number>>(db, 'SELECT * FROM player_profiles WHERE player_id = ?', 'p1');
    const fromRow = {
      age: r.age,
      level: r.level,
      goal: r.goal,
      equipment: r.equipment,
      space: r.space,
      partner: r.partner === 1,
      daysPerWeek: r.days_per_week,
      minutesPerSession: r.minutes_per_session,
      locale: r.locale,
    };

    expect(PlayerProfile.parse(fromRow)).toEqual(PROFILE);
    expect(PlayerProfileView.parse(fromRow)).toEqual(PROFILE);
    // the row carries the contract fields plus its own key and timestamps (exact shape: see the 002-alone test)
    expect(Object.keys(r)).toEqual(expect.arrayContaining(PROFILE_REQUIRED));
  });

  test('a baseline result, a skipped one (value 0) and a retest result round-trip through BaselineResult and TestResult', () => {
    const db = migrated('all');
    addProfile(db);
    addResult(db, { test_slug: 'juggling-30s', value: 12.5, attempts: 3, errors: 1, skipped: 0, client_uuid: uuid(1) });
    addResult(db, { test_slug: 'plank', value: 0, attempts: null, errors: null, skipped: 1, client_uuid: uuid(2) });

    const stored = rows<Record<string, string | number | null>>(db, 'SELECT * FROM test_results ORDER BY id');
    const baseline = stored.map((r) =>
      BaselineResult.parse({
        testSlug: r.test_slug,
        value: r.value,
        ...(r.attempts === null ? {} : { attempts: r.attempts }),
        ...(r.errors === null ? {} : { errors: r.errors }),
        skipped: r.skipped === 1,
        clientUuid: r.client_uuid,
      }),
    );
    expect(baseline).toEqual([
      { testSlug: 'juggling-30s', value: 12.5, attempts: 3, errors: 1, skipped: false, clientUuid: uuid(1) },
      { testSlug: 'plank', value: 0, skipped: true, clientUuid: uuid(2) },
    ]);
    const first = stored[0] as Record<string, string | number>;
    expect(TestResult.parse({ testSlug: first.test_slug, value: first.value, attempts: first.attempts, errors: first.errors, clientUuid: first.client_uuid })).toEqual({
      testSlug: 'juggling-30s',
      value: 12.5,
      attempts: 3,
      errors: 1,
      clientUuid: uuid(1),
    });
  });

  test('a Roadmap round-trips through the json column byte-for-byte and parses with the contract schema', () => {
    const db = migrated('all');
    addProfile(db);
    addRoadmap(db, { graph_version: '2.3.1' });

    const row = one<{ json: string; graph_version: string }>(db, 'SELECT json, graph_version FROM roadmaps WHERE player_id = ?', 'p1');

    expect(row.json).toBe(JSON.stringify(ROADMAP));
    expect(Roadmap.parse(JSON.parse(row.json))).toEqual(ROADMAP);
    expect(row.graph_version).toBe('2.3.1');
    // the json is queryable (json_extract), e.g. for a "who is on goal X" report
    expect(one<{ goal: string }>(db, `SELECT json_extract(json, '$.goal') AS goal FROM roadmaps`).goal).toBe(ROADMAP.goal);
  });

  test('graph_version has the type of sports.graph_version (TEXT, not blank)', () => {
    const db = migrated('all');
    const type = (table: string) => one<{ type: string }>(db, `SELECT type FROM pragma_table_info('${table}') WHERE name = 'graph_version'`).type;

    expect(type('roadmaps')).toBe(type('sports'));
  });
});
