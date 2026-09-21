import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_FALLBACK_CODES } from '../../shared/ai';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '008_ai_calls.sql';
const BEFORE_007 = [
  '001_commons.sql',
  '002_player.sql',
  '003_settings.sql',
  '004_test_thresholds.sql',
  '005_sessions.sql',
  '006_contributions.sql',
];
const REAL_007 = '007_privacy.sql';

/** The bead's kinds: fixed by the acceptance criteria (plan | explain | video), no shared constant exists. */
const KINDS = ['plan', 'explain', 'video'];

/** Column-name segments (split on _) that would mean a prompt, a player's words or an image is stored. None may exist. */
const FORBIDDEN_COLUMN = /(^|_)(prompt|note|text|message|content|body|response|completion|image|photo|frame|blob|file|path|url)(_|$)/i;

interface ColumnShape {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1;
}

/** The bead's columns. Positive containment only: a later ALTER TABLE ... ADD COLUMN must not break this. */
const EXPECTED_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'player_id', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'kind', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'model', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'profile_hash', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'candidate_ids', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'chosen_ids', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'validator_result', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'fallback_code', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'latency_ms', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'tokens_in', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'tokens_out', type: 'INTEGER', notnull: 0, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
];

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:05:00.000Z';

/** Timestamp spellings the created_at CHECK must refuse (only canonical ms-UTC is stored, as in 002-007). */
const BAD_TIMESTAMPS = [
  '2026-01-01T24:00:00.000Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00.000+05:00',
  '2026-01-01 00:00:00.000Z',
  '2026-02-30T00:00:00.000Z',
  '2026-01-01T00:00:00.000z',
  '2026-01-01',
  '',
  'yesterday',
];

let tmp: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'ai-calls-migration-'));
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

type Cell = string | number | null | Uint8Array;

/** A scratch migrations dir: 001-006, then `seventh` as 007, then (optionally) the real 008. */
function scratchDir(name: string, seventh: 'real' | 'stand-in' | 'none', with008: boolean): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  for (const file of BEFORE_007) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  if (seventh === 'real') copyFileSync(join(MIGRATIONS_DIR, REAL_007), join(dir, REAL_007));
  // The runner forbids gaps, so 008 cannot follow 006 directly: a stand-in 007 that creates nothing
  // proves 008 needs nothing from the real 007.
  if (seventh === 'stand-in') writeFileSync(join(dir, '007_standin.sql'), 'SELECT 1;\n');
  if (with008) copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
  return dir;
}

/** A migrated in-memory database opened like production (foreign_keys ON). */
function migrated(which: 'all' | 'seven' | 'after-006' = 'all'): Database {
  const db = openDatabase(':memory:');
  opened.push(db);
  if (which === 'all') migrate(db);
  else if (which === 'seven') migrate(db, scratchDir('seven', 'real', false));
  else migrate(db, scratchDir('after-006', 'stand-in', true));
  return db;
}

function rows<T = Record<string, unknown>>(db: Database, sql: string, ...params: Cell[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function one<T = Record<string, unknown>>(db: Database, sql: string, ...params: Cell[]): T {
  const [first] = rows<T>(db, sql, ...params);
  if (first === undefined) throw new Error(`no row for: ${sql}`);
  return first;
}

const count = (db: Database, table: string, where = '1 = 1'): number =>
  one<{ n: number }>(db, `SELECT count(*) AS n FROM ${table} WHERE ${where}`).n;

/**
 * true when `fn` succeeds, false when the database REFUSES the row (a CHECK, NOT NULL, foreign key or STRICT
 * type constraint). Any other error (a missing table, a typo) is rethrown: a refusal test must not pass
 * just because the table does not exist.
 */
function accepted(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    if (String((e as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')) return false;
    throw e;
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

function tableNames(db: Database): string[] {
  return rows<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name",
  ).map((r) => r.name);
}

const columns = (db: Database): ColumnShape[] =>
  rows<ColumnShape>(db, `SELECT name, type, "notnull" AS "notnull", pk FROM pragma_table_info('ai_calls') ORDER BY cid`);

const plan = (db: Database, sql: string, ...params: Cell[]): string =>
  rows<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(' | ');

// --- fixtures ------------------------------------------------------------------------------

/** A sha-256 hex digest, distinct per n: what profile_hash holds. */
const hash = (n: number): string => createHash('sha256').update(`profile-${n}`).digest('hex');

function insertRow(db: Database, table: string, row: Record<string, Cell>): void {
  const names = Object.keys(row);
  db.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...Object.values(row));
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

function callRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    player_id: 'p1',
    kind: 'plan',
    model: 'claude-sonnet-5',
    profile_hash: hash(1),
    candidate_ids: '["dv-1","dv-2","dv-3"]',
    chosen_ids: '["dv-1","dv-3"]',
    validator_result: 'ok',
    fallback_code: null,
    latency_ms: 1234,
    tokens_in: 800,
    tokens_out: 120,
    created_at: T0,
    ...over,
  };
}

const addCall = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'ai_calls', callRow(over));

function withProfile(): Database {
  const db = migrated();
  addProfile(db);
  return db;
}

/** A JSON array of ids of exactly `n` characters, no id longer than 128 (so only the total size is under test). */
function idsOfLength(n: number): string {
  const parts: string[] = [];
  const total = (): number => 2 + parts.reduce((t, p) => t + p.length + 2, 0) + Math.max(0, parts.length - 1);
  while (n - total() - (parts.length > 0 ? 1 : 0) - 2 > 128) parts.push('a'.repeat(100));
  parts.push('a'.repeat(n - total() - (parts.length > 0 ? 1 : 0) - 2));
  return JSON.stringify(parts);
}

/** True when a row with `over` is accepted on a fresh database with profile p1. */
const accepts = (over: Record<string, Cell>): boolean => accepted(() => addCall(withProfile(), over));

// --- the migration ---------------------------------------------------------------------------

describe('008_ai_calls: applying', () => {
  test('the real migrations apply in order 1..8 and 008 is recorded with its checksum', () => {
    const db = openDatabase(':memory:');
    opened.push(db);
    const applied = migrate(db);
    expect(applied.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const row = one<{ version: number; name: string; checksum: string }>(
      db,
      'SELECT version, name, checksum FROM schema_migrations WHERE version = 8',
    );
    expect(row.name).toBe('008_ai_calls');
    expect(row.checksum).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(migrate(db)).toEqual([]);
  });

  test('applies after 006: it needs nothing from 007 (001-006 + a stand-in 007 + 008)', () => {
    const db = migrated('after-006');
    expect(tableNames(db)).toContain('ai_calls');
    expect(tableNames(db)).not.toContain('consents');
    addProfile(db);
    addCall(db);
    expect(count(db, 'ai_calls')).toBe(1);
  });

  test('creates ai_calls and leaves every table of 001-007 exactly as it was', () => {
    const before = migrated('seven');
    const after = migrated('all');
    const added = tableNames(after).filter((t) => !tableNames(before).includes(t));
    expect(added).toEqual(['ai_calls']);
    for (const table of tableNames(before)) expect(createSql(after, table), table).toBe(createSql(before, table));
  });

  test('coexists with Better Auth: its own tables can be created next to ai_calls (no name collision)', () => {
    const db = migrated();
    expect(tableNames(db)).toContain('ai_calls');
    for (const name of ['user', 'session', 'account', 'verification']) {
      expect(accepted(() => db.run(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY) STRICT`)), name).toBe(true);
    }
  });
});

describe('008_ai_calls: shape', () => {
  test('is STRICT and has the bead\'s columns with their types and nullability', () => {
    const db = migrated();
    expect(one<{ strict: number }>(db, "SELECT strict FROM pragma_table_list WHERE name = 'ai_calls'").strict).toBe(1);
    const actual = columns(db);
    for (const want of EXPECTED_COLUMNS) expect(actual.find((c) => c.name === want.name), want.name).toEqual(want);
  });

  test('stores no prompt, no player text and no image: no such column, no BLOB column', () => {
    const actual = columns(migrated());
    expect(actual.map((c) => c.name)).toContain('kind'); // the table exists: the checks below are not vacuous
    expect(actual.filter((c) => FORBIDDEN_COLUMN.test(c.name)).map((c) => c.name)).toEqual([]);
    expect(actual.filter((c) => c.type.toUpperCase() === 'BLOB').map((c) => c.name)).toEqual([]);
  });

  test('player_id references player_profiles ON DELETE CASCADE ON UPDATE CASCADE', () => {
    const fks = rows<{ table: string; from: string; to: string; on_update: string; on_delete: string }>(
      migrated(),
      `SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list('ai_calls')`,
    );
    expect(fks).toContainEqual({ table: 'player_profiles', from: 'player_id', to: 'player_id', on_update: 'CASCADE', on_delete: 'CASCADE' });
  });

  test('has an index led by player_id that serves a player\'s calls in time order (and the cascade)', () => {
    const db = migrated();
    const named = rows<{ name: string }>(db, "SELECT name FROM pragma_index_list('ai_calls') WHERE origin = 'c'").map((i) => i.name);
    const led = named.filter((n) => rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${n}') ORDER BY seqno`)[0]?.name === 'player_id');
    expect(led.length).toBeGreaterThan(0);
    const detail = plan(db, 'SELECT * FROM ai_calls WHERE player_id = ? ORDER BY created_at DESC, id DESC', 'p1');
    expect(detail).toContain('USING INDEX ai_calls_by_player');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  test('ids autoincrement and never repeat', () => {
    const db = withProfile();
    addCall(db);
    addCall(db);
    const ids = rows<{ id: number }>(db, 'SELECT id FROM ai_calls ORDER BY id').map((r) => r.id);
    expect(ids).toEqual([1, 2]);
    db.run('DELETE FROM ai_calls WHERE id = 2');
    addCall(db);
    expect(one<{ id: number }>(db, 'SELECT max(id) AS id FROM ai_calls').id).toBe(3);
  });
});

describe('008_ai_calls: rows', () => {
  test('a complete AI-served row round-trips', () => {
    const db = withProfile();
    addCall(db);
    expect(one<Record<string, Cell>>(db, 'SELECT * FROM ai_calls')).toEqual({ id: 1, ...callRow() });
  });

  test('a fallback row is accepted: no chosen ids, no tokens, no validator, no profile hash', () => {
    const db = withProfile();
    addCall(db, { chosen_ids: '[]', fallback_code: 'timeout', validator_result: null, tokens_in: null, tokens_out: null, profile_hash: null });
    expect(one<{ fallback_code: string }>(db, 'SELECT fallback_code FROM ai_calls').fallback_code).toBe('timeout');
  });

  test('a row with no player is accepted (player_id is nullable)', () => {
    const db = migrated();
    addCall(db, { player_id: null });
    expect(count(db, 'ai_calls', 'player_id IS NULL')).toBe(1);
  });

  test('each of the bead\'s NOT NULL columns refuses NULL', () => {
    for (const column of ['kind', 'model', 'candidate_ids', 'chosen_ids', 'latency_ms', 'created_at']) {
      expect(accepts({ [column]: null }), column).toBe(false);
    }
  });

  test('a player that has no profile is refused (foreign key)', () => {
    expect(accepts({ player_id: 'ghost' })).toBe(false);
  });
});

describe('008_ai_calls: kind', () => {
  test('accepts plan, explain and video', () => {
    for (const kind of KINDS) expect(accepts({ kind }), kind).toBe(true);
  });

  test('the CHECK list is exactly plan, explain, video', () => {
    expect(checkList(migrated(), 'ai_calls', 'kind')).toEqual(KINDS);
  });

  test('refuses anything else, including other spellings', () => {
    for (const kind of ['', 'Plan', 'PLAN', 'chat', 'image', 'plan ', 'explain\n']) expect(accepts({ kind }), JSON.stringify(kind)).toBe(false);
  });
});

describe('008_ai_calls: fallback_code', () => {
  test('the CHECK list equals AI_FALLBACK_CODES (shared/ai.ts)', () => {
    expect(checkList(migrated(), 'ai_calls', 'fallback_code')).toEqual([...AI_FALLBACK_CODES]);
  });

  test('accepts every fallback code and NULL (no fallback)', () => {
    for (const code of AI_FALLBACK_CODES) expect(accepts({ fallback_code: code }), code).toBe(true);
    expect(accepts({ fallback_code: null })).toBe(true);
  });

  test('refuses other codes', () => {
    for (const code of ['', 'ok', 'Timeout', 'TIMEOUT', 'rate_limited', 'no_key ']) expect(accepts({ fallback_code: code }), JSON.stringify(code)).toBe(false);
  });
});

describe('008_ai_calls: candidate_ids and chosen_ids (JSON arrays of ids, never text)', () => {
  for (const column of ['candidate_ids', 'chosen_ids']) {
    test(`${column} accepts arrays of ids, empty arrays included`, () => {
      expect(accepts({ [column]: '[]' }), '[]').toBe(true);
      expect(accepts({ [column]: '["dv-1"]' }), 'one').toBe(true);
      expect(accepts({ [column]: '["a.b_c-9","Z"]' }), 'charset').toBe(true);
      expect(accepts({ [column]: JSON.stringify(Array.from({ length: 100 }, (_, i) => `drill-version-${i}`)) }), '100 ids').toBe(true);
    });

    test(`${column} refuses anything that is not a JSON array`, () => {
      for (const bad of ['', 'null', '{}', '{"a":"b"}', '"dv-1"', '42', 'dv-1', '["dv-1"', '[dv-1]']) {
        expect(accepts({ [column]: bad }), JSON.stringify(bad)).toBe(false);
      }
    });

    test(`${column} refuses free text hidden in the array`, () => {
      for (const bad of ['["my ankle is tired"]', '["dv-1", "x"]', '["мой"]', '["a\\u0020b"]', '[{"note":"x"}]', '["a:b"]', '["a/b"]']) {
        expect(accepts({ [column]: bad }), JSON.stringify(bad)).toBe(false);
      }
    });

    test(`${column} refuses a NUL that would hide the tail from length() and GLOB`, () => {
      expect(accepts({ [column]: `["dv-1"]${String.fromCharCode(0)}${'x'.repeat(50)}` })).toBe(false);
    });

    test(`${column} refuses a huge array (the size cap is 8192 characters)`, () => {
      expect(idsOfLength(8192).length).toBe(8192);
      expect(accepts({ [column]: idsOfLength(8192) }), 'at the cap').toBe(true);
      expect(accepts({ [column]: idsOfLength(8193) }), 'over the cap').toBe(false);
    });

    test(`${column} accepts an id of 128 characters (EntityId's longest) and refuses one of 129`, () => {
      expect(accepts({ [column]: `["${'a'.repeat(128)}"]` }), '128').toBe(true);
      expect(accepts({ [column]: `["${'a'.repeat(129)}"]` }), '129').toBe(false);
      expect(accepts({ [column]: `["${'a'.repeat(127)}","${'b'.repeat(128)}"]` }), '127 and 128').toBe(true);
      expect(accepts({ [column]: `["${'a'.repeat(128)}","${'b'.repeat(129)}"]` }), '128 and 129').toBe(false);
      expect(accepts({ [column]: `["${'a'.repeat(129)}","b"]` }), '129 first').toBe(false);
    });

    test(`${column} refuses one long unspaced run of id characters: no text over 200 characters (the hyphenated repro)`, () => {
      const hyphenated = 'my-ankle-hurts-'.repeat(20); // 300 characters, every one an id character
      expect(hyphenated.length).toBe(300);
      expect(accepts({ [column]: `["${hyphenated}"]` }), 'hyphenated 300').toBe(false);
      expect(accepts({ [column]: `["${'a'.repeat(7000)}"]` }), 'one 7000-character id').toBe(false);
      expect(accepts({ [column]: `["${'a.b_c-9'.repeat(20)}"]` }), 'mixed id characters, 140').toBe(false);
      expect(accepts({ [column]: `[${'7'.repeat(129)}]` }), 'a 129-digit number').toBe(false);
    });

    test(`${column} still accepts many ordinary ids: the cap is per element, not on the total`, () => {
      const ids = Array.from({ length: 60 }, (_, i) => `${'d'.repeat(100)}-${i}`); // 60 ids of ~103 characters
      expect(accepts({ [column]: JSON.stringify(ids) })).toBe(true);
      expect(accepts({ [column]: '["dv-1","dv-2","drill-version-3.a_b"]' })).toBe(true);
    });
  }
});

describe('008_ai_calls: model and validator_result (no long text)', () => {
  for (const column of ['model', 'validator_result']) {
    test(`${column} accepts 1 to 200 characters and refuses 201`, () => {
      expect(accepts({ [column]: 'x' }), '1').toBe(true);
      expect(accepts({ [column]: 'x'.repeat(200) }), '200').toBe(true);
      expect(accepts({ [column]: 'x'.repeat(201) }), '201').toBe(false);
      expect(accepts({ [column]: 'я'.repeat(200) }), '200 Cyrillic').toBe(true);
      expect(accepts({ [column]: 'я'.repeat(201) }), '201 Cyrillic').toBe(false);
    });

    test(`${column} refuses the empty and the whitespace-only string`, () => {
      for (const bad of ['', ' ', '\t', '\n', '\r', ' \t\r\n']) expect(accepts({ [column]: bad }), JSON.stringify(bad)).toBe(false);
    });

    test(`${column} refuses a NUL that would hide a long tail from length()`, () => {
      expect(accepts({ [column]: `ok${String.fromCharCode(0)}${'x'.repeat(500)}` })).toBe(false);
    });
  }

  test('validator_result may be NULL (no validator ran); model may not', () => {
    expect(accepts({ validator_result: null })).toBe(true);
    expect(accepts({ model: null })).toBe(false);
  });
});

describe('008_ai_calls: profile_hash', () => {
  test('accepts a sha-256 hex digest and NULL', () => {
    expect(accepts({ profile_hash: hash(7) })).toBe(true);
    expect(accepts({ profile_hash: null })).toBe(true);
  });

  test('refuses anything that is not 64 lower-case hex characters', () => {
    const good = hash(1);
    const bad = [
      '',
      good.slice(1),
      `${good}0`,
      good.toUpperCase(),
      `${'g'.repeat(64)}`,
      'age=12 level=basic goal=dribbling',
      `${good}${String.fromCharCode(0)}anything`,
      `${good.slice(0, 63)}${String.fromCharCode(0)}`,
    ];
    for (const value of bad) expect(accepts({ profile_hash: value }), JSON.stringify(value)).toBe(false);
  });
});

describe('008_ai_calls: latency_ms, tokens_in, tokens_out', () => {
  test('latency_ms accepts 0 and positive integers, refuses negatives and fractions', () => {
    expect(accepts({ latency_ms: 0 })).toBe(true);
    expect(accepts({ latency_ms: 20_000 })).toBe(true);
    expect(accepts({ latency_ms: -1 })).toBe(false);
    expect(accepts({ latency_ms: 1.5 })).toBe(false);
  });

  for (const column of ['tokens_in', 'tokens_out']) {
    test(`${column} accepts NULL, 0 and positive integers, refuses negatives and fractions`, () => {
      expect(accepts({ [column]: null }), 'null').toBe(true);
      expect(accepts({ [column]: 0 }), '0').toBe(true);
      expect(accepts({ [column]: 100_000 }), 'big').toBe(true);
      expect(accepts({ [column]: -1 }), '-1').toBe(false);
      expect(accepts({ [column]: 0.5 }), '0.5').toBe(false);
    });
  }
});

describe('008_ai_calls: created_at', () => {
  test('defaults to the server\'s canonical UTC time', () => {
    const db = withProfile();
    const { created_at: _omit, ...withoutCreatedAt } = callRow();
    insertRow(db, 'ai_calls', withoutCreatedAt);
    const at = one<{ created_at: string }>(db, 'SELECT created_at FROM ai_calls').created_at;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(at).toISOString()).toBe(at);
  });

  test('accepts canonical ms-UTC and refuses every other spelling', () => {
    expect(accepts({ created_at: T1 })).toBe(true);
    for (const bad of BAD_TIMESTAMPS) expect(accepts({ created_at: bad }), JSON.stringify(bad)).toBe(false);
  });
});

describe('008_ai_calls: erasure and re-keying', () => {
  function seed(): Database {
    const db = migrated();
    addProfile(db, 'p1');
    addProfile(db, 'p2');
    addCall(db, { player_id: 'p1', kind: 'plan' });
    addCall(db, { player_id: 'p1', kind: 'explain', created_at: T1 });
    addCall(db, { player_id: 'p2', kind: 'plan' });
    addCall(db, { player_id: null, kind: 'video' });
    return db;
  }

  test('deleting a profile deletes that player\'s calls and only theirs', () => {
    const db = seed();
    db.run("DELETE FROM player_profiles WHERE player_id = 'p1'");
    expect(count(db, 'ai_calls', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'ai_calls', "player_id = 'p2'")).toBe(1);
    expect(count(db, 'ai_calls', 'player_id IS NULL')).toBe(1);
    expect(count(db, 'ai_calls')).toBe(2);
  });

  test('re-keying a profile moves its calls to the new id (recovery)', () => {
    const db = seed();
    db.run("UPDATE player_profiles SET player_id = 'p9' WHERE player_id = 'p1'");
    expect(count(db, 'ai_calls', "player_id = 'p9'")).toBe(2);
    expect(count(db, 'ai_calls', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'ai_calls', "player_id = 'p2'")).toBe(1);
  });
});
