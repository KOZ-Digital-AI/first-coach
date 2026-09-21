import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { Timestamp } from '../shared/domain';
import { TRUST_STATUSES } from '../shared/primitives';
import type { TrustStatus } from '../shared/primitives';
import { ENDPOINTS, Settings as ContractSettings } from '../shared/admin';
import {
  AGE_BANDS,
  DEFAULT_SETTINGS,
  InvalidSettingsError,
  SETTING_KEYS,
  SettingsPatch,
  SettingsSchema,
  getSettings,
  updateSettings,
} from './settings';
import type { InvalidStoredSetting, Settings } from './settings';

const SQL_FILE = '003_settings.sql';
const FRAMEWORK_FILES = ['001_commons.sql', '002_player.sql'];

/** Columns that must be NOT NULL: the contract list this test pins, not something derived from the schema. */
const SETTINGS_REQUIRED = ['key', 'value', 'updated_at'];

/** Declared column types of the 003 file alone, pinned so a STRICT type cannot drift. */
const COLUMN_TYPES: Record<string, string> = { key: 'TEXT', value: 'TEXT', updated_at: 'TEXT' };

/** What the bead's acceptance criteria give as the defaults, restated here on purpose (not imported). */
const CRITERIA_DEFAULTS: Settings = {
  minStatusByAgeBand: { u10: 'COMMUNITY', u14: 'COMMUNITY', adult: 'COMMUNITY' },
  uploadMaxMb: 50,
  aiPlannerEnabled: true,
  videoCoachEnabled: true,
  retestIntervalsDays: [7, 14, 30],
};

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const D1 = new Date(T1);
const D2 = new Date('2026-03-01T12:30:45.123Z');

let tmp: string;
let pair: string;
let trio: string;
let withLater: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'settings-migration-'));
  for (const dir of ['pair', 'trio', 'with-later']) {
    mkdirSync(join(tmp, dir));
    for (const file of FRAMEWORK_FILES) copyFileSync(join(MIGRATIONS_DIR, file), join(tmp, dir, file));
  }
  pair = join(tmp, 'pair'); // 001 + 002: what exists before 003
  trio = join(tmp, 'trio'); // 001 + 002 + a copy of 003 (the runner forbids gaps, so 003 cannot sit alone)
  withLater = join(tmp, 'with-later'); // 001 + 002 + 003 + a hypothetical 004 that only adds things
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

type Which = 'all' | 'pair' | 'trio' | 'later';

/** Copies 003 into a scratch dir on demand, so a missing file fails the test that needs it (not every test). */
function copy003(dir: string): void {
  copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
}

/**
 * A migrated in-memory database opened like production (foreign_keys ON). 'all' applies the real
 * MIGRATIONS_DIR; 'pair' copies of 001 and 002; 'trio' copies of 001, 002 and 003 alone; 'later' adds a
 * hypothetical 004 that does what a later migration may do: ALTER TABLE settings ADD COLUMN, plus a new table.
 */
function migrated(which: Which = 'all'): Database {
  const db = openDatabase(':memory:');
  opened.push(db);
  if (which === 'all') {
    migrate(db);
  } else if (which === 'pair') {
    migrate(db, pair);
  } else if (which === 'trio') {
    copy003(trio);
    migrate(db, trio);
  } else {
    copy003(withLater);
    writeFileSync(
      join(withLater, '004_later.sql'),
      [
        'ALTER TABLE settings ADD COLUMN note TEXT;',
        'CREATE TABLE settings_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, at TEXT NOT NULL) STRICT;',
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

function count(db: Database, where = '1 = 1'): number {
  return one<{ n: number }>(db, `SELECT count(*) AS n FROM settings WHERE ${where}`).n;
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

/** Everything that is stored, key -> parsed JSON value. */
function stored(db: Database): Record<string, unknown> {
  return Object.fromEntries(rows<{ key: string; value: string }>(db, 'SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]));
}

function storedRaw(db: Database): { key: string; value: string; updated_at: string }[] {
  return rows(db, 'SELECT key, value, updated_at FROM settings ORDER BY key');
}

function insertRow(db: Database, over: Record<string, Cell> = {}): void {
  const row = { key: 'someSetting', value: '1', updated_at: T0, ...over };
  const columns = Object.keys(row);
  db.query(`INSERT INTO settings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(row));
}

/** Bypasses Zod: writes `value` (any JSON text) for `key`, as an older or newer build might have. */
function putRaw(db: Database, key: string, value: string): void {
  insertRow(db, { key, value });
}

function createSql(db: Database): string {
  return one<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settings'").sql;
}

/** Base tables (not sqlite_ bookkeeping, not the runner ledger) in `db`. */
function tableNames(db: Database): string[] {
  return rows<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'schema_migrations' ORDER BY name",
  ).map((r) => r.name);
}

/** The tables 003 creates: what 001 + 002 + 003 have beyond 001 + 002. Independent of any later migration. */
function ownTables(): string[] {
  const before = tableNames(migrated('pair'));
  return tableNames(migrated('trio')).filter((t) => !before.includes(t));
}

const notNullColumns = (db: Database): string[] =>
  rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('settings') WHERE "notnull" = 1`).map((r) => r.name);

const nullableColumns = (db: Database): string[] =>
  rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('settings') WHERE "notnull" = 0 AND pk = 0`).map((r) => r.name);

const BLANKS = ['', ' ', '   ', '\t', '\n', '\r', '\r\n', ' \t\n ', '\t\t'];

/**
 * The schema assertions that must hold on ANY database built from the real migrations, whatever is
 * applied after 003: they inspect the named table and columns only and are POSITIVE (this column is
 * NOT NULL, that CHECK exists), never "the table has exactly these columns": a later
 * ALTER TABLE ... ADD COLUMN is legitimate and must not break them.
 */
function expectSettingsContract(db: Database): void {
  expect(one<{ strict: number }>(db, "SELECT strict FROM pragma_table_list WHERE name = 'settings'").strict, 'settings STRICT').toBe(1);
  expect(notNullColumns(db)).toEqual(expect.arrayContaining(SETTINGS_REQUIRED));
  for (const column of SETTINGS_REQUIRED) {
    expect(thrown(() => insertRow(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: settings\\.${column}\\b`));
  }
  expect(thrown(() => insertRow(db, { value: 'not json' })).message).toMatch(/CHECK constraint failed: json_valid\(value\)/);
  expect(thrown(() => insertRow(db, { updated_at: '2026-01-01T00:00:00Z' })).message).toMatch(/CHECK constraint failed: strftime\(.*\) IS updated_at/);
  expect(thrown(() => insertRow(db, { key: ' ' })).message).toMatch(/CHECK constraint failed: trim\(key, /);
  insertRow(db, { key: 'contract-key' });
  expect(thrown(() => insertRow(db, { key: 'contract-key' })).message).toMatch(/UNIQUE constraint failed: settings\.key/);
  db.run(`DELETE FROM settings WHERE key = 'contract-key'`);
  expect(count(db)).toBe(0);
}

// --- the settings object -------------------------------------------------------------------------

describe('settings: typed defaults', () => {
  test('DEFAULT_SETTINGS is exactly what the acceptance criteria list, and is itself valid', () => {
    expect(DEFAULT_SETTINGS).toEqual(CRITERIA_DEFAULTS);
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(CRITERIA_DEFAULTS);
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.minStatusByAgeBand)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.retestIntervalsDays)).toBe(true);
  });

  test('the age bands and setting keys are exported for consumers, and the schema has exactly those keys', () => {
    expect([...AGE_BANDS]).toEqual(['u10', 'u14', 'adult']);
    expect([...SETTING_KEYS].sort() as string[]).toEqual(Object.keys(CRITERIA_DEFAULTS).sort());
    expect(Object.keys(SettingsSchema.shape).sort()).toEqual([...SETTING_KEYS].sort() as string[]);
  });

  test('every band takes every real TrustStatus and nothing else', () => {
    for (const status of TRUST_STATUSES) {
      for (const band of AGE_BANDS) {
        expect(SettingsSchema.parse({ ...CRITERIA_DEFAULTS, minStatusByAgeBand: { ...CRITERIA_DEFAULTS.minStatusByAgeBand, [band]: status } }).minStatusByAgeBand[band]).toBe(status);
      }
    }
    for (const bad of ['community', 'GOLD', '', 'EXPERT VERIFIED', null, 1, undefined]) {
      expect(SettingsSchema.safeParse({ ...CRITERIA_DEFAULTS, minStatusByAgeBand: { u10: bad, u14: 'COMMUNITY', adult: 'COMMUNITY' } }).success, String(bad)).toBe(false);
    }
  });

  test('the field types are usable by consumers (compile-time) and Settings is the inferred object', () => {
    const db = migrated('all');
    const settings: Settings = getSettings(db);
    const status: TrustStatus = settings.minStatusByAgeBand.adult;
    const cap: number = settings.uploadMaxMb;
    const ai: boolean = settings.aiPlannerEnabled;
    const video: boolean = settings.videoCoachEnabled;
    const intervals: number[] = settings.retestIntervalsDays;
    expect([status, cap, ai, video, intervals]).toEqual(['COMMUNITY', 50, true, true, [7, 14, 30]]);
  });
});

describe('settings: getSettings', () => {
  test('an empty table yields the defaults, and reading writes nothing', () => {
    const db = migrated('all');

    expect(count(db)).toBe(0);
    expect(getSettings(db)).toEqual(CRITERIA_DEFAULTS);
    expect(count(db)).toBe(0);
  });

  test('every call returns a fresh object: mutating one never leaks into the defaults or the next read', () => {
    const db = migrated('all');
    const first = getSettings(db);
    first.uploadMaxMb = 1;
    first.minStatusByAgeBand.u10 = 'ACADEMY_VERIFIED';
    first.retestIntervalsDays.push(99);

    expect(getSettings(db)).toEqual(CRITERIA_DEFAULTS);
    expect(DEFAULT_SETTINGS).toEqual(CRITERIA_DEFAULTS);
  });

  test('keys that are stored come from the table, the missing ones from the defaults', () => {
    const db = migrated('all');
    putRaw(db, 'uploadMaxMb', '80');
    putRaw(db, 'retestIntervalsDays', '[3,9]');

    expect(getSettings(db)).toEqual({ ...CRITERIA_DEFAULTS, uploadMaxMb: 80, retestIntervalsDays: [3, 9] });
  });

  test('a stored key this build does not know is ignored: not returned, not reported', () => {
    const db = migrated('all');
    putRaw(db, 'fromANewerBuild', '{"x":1}');
    const reports: InvalidStoredSetting[] = [];

    expect(getSettings(db, { onInvalid: (r) => reports.push(r) })).toEqual(CRITERIA_DEFAULTS);
    expect(reports).toEqual([]);
  });

  test('a stored value that fails validation falls back to that key\'s default AND is reported; the other keys are unaffected', () => {
    const db = migrated('all');
    putRaw(db, 'uploadMaxMb', '"x"'); // valid JSON, wrong type
    putRaw(db, 'aiPlannerEnabled', 'false'); // fine
    putRaw(db, 'retestIntervalsDays', '[]'); // empty
    putRaw(db, 'minStatusByAgeBand', '{"u10":"REVIEWED","u14":"GOLD","adult":"COMMUNITY"}'); // one band invalid: the whole key falls back
    const reports: InvalidStoredSetting[] = [];

    const settings = getSettings(db, { onInvalid: (r) => reports.push(r) });

    expect(settings).toEqual({ ...CRITERIA_DEFAULTS, aiPlannerEnabled: false });
    expect(reports.map((r) => r.key).sort()).toEqual(['minStatusByAgeBand', 'retestIntervalsDays', 'uploadMaxMb']);
    const upload = reports.find((r) => r.key === 'uploadMaxMb');
    expect(upload?.value).toBe('"x"');
    expect(upload?.reason.length).toBeGreaterThan(0);
  });

  test('stored values that are valid JSON but structurally partial or padded are invalid too (missing band, extra band, null)', () => {
    const db = migrated('all');
    putRaw(db, 'minStatusByAgeBand', '{"u10":"REVIEWED"}');
    putRaw(db, 'uploadMaxMb', 'null');
    putRaw(db, 'videoCoachEnabled', '0');
    const reports: InvalidStoredSetting[] = [];

    expect(getSettings(db, { onInvalid: (r) => reports.push(r) })).toEqual(CRITERIA_DEFAULTS);
    expect(reports.map((r) => r.key).sort()).toEqual(['minStatusByAgeBand', 'uploadMaxMb', 'videoCoachEnabled']);

    const db2 = migrated('all');
    putRaw(db2, 'minStatusByAgeBand', '{"u10":"REVIEWED","u14":"REVIEWED","adult":"REVIEWED","u99":"REVIEWED"}');
    expect(getSettings(db2)).toEqual(CRITERIA_DEFAULTS);
  });

  test('text that is not JSON at all (only possible with CHECKs bypassed) is invalid, reported, and does not throw', () => {
    const db = migrated('all');
    db.run('PRAGMA ignore_check_constraints = ON');
    putRaw(db, 'uploadMaxMb', '{not json');
    db.run('PRAGMA ignore_check_constraints = OFF');
    const reports: InvalidStoredSetting[] = [];

    expect(getSettings(db, { onInvalid: (r) => reports.push(r) })).toEqual(CRITERIA_DEFAULTS);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ key: 'uploadMaxMb', value: '{not json' });
  });

  test('bad stored data neither throws without a callback nor writes to the console', () => {
    const db = migrated('all');
    putRaw(db, 'uploadMaxMb', '"x"');
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      expect(() => getSettings(db)).not.toThrow();
      expect(getSettings(db).uploadMaxMb).toBe(50);
      getSettings(db, { onInvalid: () => {} });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('settings: updateSettings', () => {
  test('a valid patch persists: it is returned in full and a fresh getSettings on the same database reads it back', () => {
    const db = migrated('all');

    const result = updateSettings(db, { uploadMaxMb: 80 }, D1);

    expect(result).toEqual({ ...CRITERIA_DEFAULTS, uploadMaxMb: 80 });
    expect(getSettings(db)).toEqual(result);
    expect(getSettings(db).uploadMaxMb).toBe(80);
  });

  test('it survives closing and reopening the database file (the value is really stored, not cached)', () => {
    const file = join(tmp, 'reopen.db');
    const db = openDatabase(file);
    migrate(db);
    updateSettings(db, { aiPlannerEnabled: false, retestIntervalsDays: [5, 10] });
    db.close();

    const again = openDatabase(file);
    opened.push(again);
    expect(getSettings(again)).toEqual({ ...CRITERIA_DEFAULTS, aiPlannerEnabled: false, retestIntervalsDays: [5, 10] });
  });

  test('every field type round trips: booleans (false included), integers and the array', () => {
    const db = migrated('all');

    const result = updateSettings(db, {
      uploadMaxMb: 1,
      aiPlannerEnabled: false,
      videoCoachEnabled: false,
      retestIntervalsDays: [1],
      minStatusByAgeBand: { adult: 'ACADEMY_VERIFIED' },
    });

    expect(result).toEqual({
      minStatusByAgeBand: { u10: 'COMMUNITY', u14: 'COMMUNITY', adult: 'ACADEMY_VERIFIED' },
      uploadMaxMb: 1,
      aiPlannerEnabled: false,
      videoCoachEnabled: false,
      retestIntervalsDays: [1],
    });
    expect(getSettings(db)).toEqual(result);
  });

  test('only the keys in the patch are written, as JSON text, with the caller\'s timestamp; the rest stay absent', () => {
    const db = migrated('all');

    updateSettings(db, { uploadMaxMb: 80, aiPlannerEnabled: false }, D1);

    expect(storedRaw(db)).toEqual([
      { key: 'aiPlannerEnabled', value: 'false', updated_at: T1 },
      { key: 'uploadMaxMb', value: '80', updated_at: T1 },
    ]);
  });

  test('an empty patch is valid, writes nothing and returns the current settings', () => {
    const db = migrated('all');
    updateSettings(db, { uploadMaxMb: 60 }, D1);

    expect(updateSettings(db, {}, D2)).toEqual({ ...CRITERIA_DEFAULTS, uploadMaxMb: 60 });
    expect(storedRaw(db)).toEqual([{ key: 'uploadMaxMb', value: '60', updated_at: T1 }]);
  });

  test('an explicit undefined means "absent", not "reset to default" and not a write', () => {
    const db = migrated('all');
    updateSettings(db, { uploadMaxMb: 60 }, D1);

    const result = updateSettings(db, { uploadMaxMb: undefined, aiPlannerEnabled: undefined }, D2);

    expect(result.uploadMaxMb).toBe(60);
    expect(storedRaw(db)).toEqual([{ key: 'uploadMaxMb', value: '60', updated_at: T1 }]);
  });

  test('an update changes updated_at of the keys it writes only, and keeps the row (upsert, never delete + insert)', () => {
    const db = migrated('all');
    updateSettings(db, { uploadMaxMb: 60 }, D1);
    updateSettings(db, { aiPlannerEnabled: false }, D1);
    const rowids = () => rows<{ key: string; rowid: number }>(db, 'SELECT key, rowid FROM settings ORDER BY key');
    const before = rowids();

    updateSettings(db, { uploadMaxMb: 70 }, D2);

    // INSERT OR REPLACE would delete and re-insert uploadMaxMb: it would get a new rowid (after aiPlannerEnabled's).
    expect(rowids()).toEqual(before);
    expect(storedRaw(db)).toEqual([
      { key: 'aiPlannerEnabled', value: 'false', updated_at: T1 },
      { key: 'uploadMaxMb', value: '70', updated_at: D2.toISOString() },
    ]);
  });

  test('without a `now` the timestamp is the current instant in the canonical form', () => {
    const db = migrated('all');
    const before = Date.now();
    updateSettings(db, { uploadMaxMb: 60 });
    const after = Date.now();

    const { updated_at } = one<{ updated_at: string }>(db, 'SELECT updated_at FROM settings');
    expect(Timestamp.safeParse(updated_at).success).toBe(true);
    expect(new Date(updated_at).toISOString()).toBe(updated_at);
    expect(Date.parse(updated_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(updated_at)).toBeLessThanOrEqual(after);
  });

  test('an invalid `now` throws before anything is written', () => {
    const db = migrated('all');

    expect(thrown(() => updateSettings(db, { uploadMaxMb: 60 }, new Date(Number.NaN)))).toBeInstanceOf(RangeError);
    expect(count(db)).toBe(0);
  });

  describe('nested patch: minStatusByAgeBand merges per band', () => {
    test('a partial band patch changes those bands only; the others keep their current value, defaults included', () => {
      const db = migrated('all');

      expect(updateSettings(db, { minStatusByAgeBand: { u10: 'REVIEWED' } }).minStatusByAgeBand).toEqual({ u10: 'REVIEWED', u14: 'COMMUNITY', adult: 'COMMUNITY' });
      expect(updateSettings(db, { minStatusByAgeBand: { adult: 'EXPERT_VERIFIED' } }).minStatusByAgeBand).toEqual({
        u10: 'REVIEWED',
        u14: 'COMMUNITY',
        adult: 'EXPERT_VERIFIED',
      });
      expect(getSettings(db).minStatusByAgeBand).toEqual({ u10: 'REVIEWED', u14: 'COMMUNITY', adult: 'EXPERT_VERIFIED' });
    });

    test('the stored row is always the FULL object (three bands), so a reader never needs the merge rule', () => {
      const db = migrated('all');

      updateSettings(db, { minStatusByAgeBand: { u14: 'REVIEWED' } });

      expect(stored(db)).toEqual({ minStatusByAgeBand: { u10: 'COMMUNITY', u14: 'REVIEWED', adult: 'COMMUNITY' } });
    });

    test('an empty band object is a no-op that still leaves the current bands intact', () => {
      const db = migrated('all');
      updateSettings(db, { minStatusByAgeBand: { u10: 'REVIEWED' } });

      expect(updateSettings(db, { minStatusByAgeBand: {} }).minStatusByAgeBand).toEqual({ u10: 'REVIEWED', u14: 'COMMUNITY', adult: 'COMMUNITY' });
    });

    test('a full band object replaces all three bands', () => {
      const db = migrated('all');
      updateSettings(db, { minStatusByAgeBand: { u10: 'REVIEWED' } });

      const full = { u10: 'ACADEMY_VERIFIED', u14: 'EXPERT_VERIFIED', adult: 'COMMUNITY' } as const;
      expect(updateSettings(db, { minStatusByAgeBand: full }).minStatusByAgeBand).toEqual(full);
    });

    test('merging over a stored value that is invalid starts from the default bands (and fixes the row)', () => {
      const db = migrated('all');
      putRaw(db, 'minStatusByAgeBand', '{"u10":"GOLD"}');

      const result = updateSettings(db, { minStatusByAgeBand: { adult: 'REVIEWED' } });

      expect(result.minStatusByAgeBand).toEqual({ u10: 'COMMUNITY', u14: 'COMMUNITY', adult: 'REVIEWED' });
      expect(stored(db)).toEqual({ minStatusByAgeBand: { u10: 'COMMUNITY', u14: 'COMMUNITY', adult: 'REVIEWED' } });
    });

    test('arrays are not merged: a new retestIntervalsDays replaces the old one', () => {
      const db = migrated('all');
      updateSettings(db, { retestIntervalsDays: [1, 2, 3, 4] });

      expect(updateSettings(db, { retestIntervalsDays: [9] }).retestIntervalsDays).toEqual([9]);
    });
  });

  describe('rejections write nothing', () => {
    function expectRejected(db: Database, patch: unknown, path: string): InvalidSettingsError {
      const err = thrown(() => updateSettings(db, patch, D1));
      expect(err).toBeInstanceOf(InvalidSettingsError);
      const issues = (err as InvalidSettingsError).issues;
      // an invalid element is reported at its own path ("retestIntervalsDays.0"), which still names the setting
      expect(issues.some((i) => i.path === path || i.path.startsWith(`${path}.`)), `${JSON.stringify(patch)}: ${JSON.stringify(issues)}`).toBe(true);
      expect(err.message, JSON.stringify(patch)).toContain(path);
      expect(count(db), `${JSON.stringify(patch)} left rows behind`).toBe(0);
      return err as InvalidSettingsError;
    }

    test('an invalid trust status is rejected, naming the band, and nothing is written', () => {
      const db = migrated('all');

      for (const bad of ['GOLD', 'community', '', null, 3]) {
        expectRejected(db, { minStatusByAgeBand: { u10: bad } }, 'minStatusByAgeBand.u10');
      }
      expectRejected(db, { minStatusByAgeBand: { adult: 'VERIFIED' } }, 'minStatusByAgeBand.adult');
      expect(getSettings(db)).toEqual(CRITERIA_DEFAULTS);
    });

    test('an unknown key is rejected, naming the key', () => {
      const db = migrated('all');

      const err = expectRejected(db, { uploadMaxMB: 80 }, 'uploadMaxMB');
      expect(err.message).toMatch(/uploadMaxMB.*unknown|unknown.*uploadMaxMB/i);
      expectRejected(db, { minStatusByAgeBand: { u99: 'COMMUNITY' } }, 'minStatusByAgeBand.u99');
      expectRejected(db, JSON.parse('{"__proto__":{"uploadMaxMb":1}}'), '__proto__');
      expectRejected(db, { '': 1 }, '');
    });

    test('an unknown key next to valid keys rejects the whole patch: the valid ones are not written', () => {
      const db = migrated('all');

      expectRejected(db, { uploadMaxMb: 80, aiPlannerEnabled: false, nonsense: true }, 'nonsense');
      expect(getSettings(db)).toEqual(CRITERIA_DEFAULTS);
    });

    test('a patch with one valid and one invalid key writes neither (validation happens before any write)', () => {
      const db = migrated('all');

      expectRejected(db, { uploadMaxMb: 80, aiPlannerEnabled: 'yes' }, 'aiPlannerEnabled');
      expectRejected(db, { aiPlannerEnabled: 'yes', uploadMaxMb: 80 }, 'aiPlannerEnabled');
      expectRejected(db, { minStatusByAgeBand: { u10: 'REVIEWED', u14: 'GOLD' }, videoCoachEnabled: false }, 'minStatusByAgeBand.u14');
      expect(getSettings(db)).toEqual(CRITERIA_DEFAULTS);
    });

    test('a rejected patch leaves earlier settings exactly as they were', () => {
      const db = migrated('all');
      updateSettings(db, { uploadMaxMb: 60, minStatusByAgeBand: { u10: 'REVIEWED' } }, D1);
      const before = storedRaw(db);

      expect(thrown(() => updateSettings(db, { uploadMaxMb: 70, minStatusByAgeBand: { u10: 'nope' } }, D2))).toBeInstanceOf(InvalidSettingsError);

      expect(storedRaw(db)).toEqual(before);
    });

    test('every issue is reported, not only the first', () => {
      const db = migrated('all');

      const err = thrown(() => updateSettings(db, { uploadMaxMb: 0, aiPlannerEnabled: 'x', extra: 1 })) as InvalidSettingsError;

      expect(err.issues.map((i) => i.path).sort()).toEqual(['aiPlannerEnabled', 'extra', 'uploadMaxMb']);
      expect(err.name).toBe('InvalidSettingsError');
    });

    test('uploadMaxMb must be a positive integer', () => {
      const db = migrated('all');
      for (const bad of [0, -1, -50, 1.5, 0.1, '50', null, true, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
        expectRejected(db, { uploadMaxMb: bad }, 'uploadMaxMb');
      }
    });

    test('the two switches must be real booleans', () => {
      const db = migrated('all');
      for (const key of ['aiPlannerEnabled', 'videoCoachEnabled']) {
        for (const bad of ['true', 'false', 1, 0, null, 'on', [], {}]) {
          expectRejected(db, { [key]: bad }, key);
        }
      }
    });

    test('retestIntervalsDays must be a non-empty array of positive integers', () => {
      const db = migrated('all');
      for (const bad of [[], [0], [7, 0], [-1], [1.5], ['7'], [null], 'x', 7, null, { 0: 7 }, [[7]]]) {
        expectRejected(db, { retestIntervalsDays: bad }, 'retestIntervalsDays');
      }
    });

    test('a patch that is not an object is rejected', () => {
      const db = migrated('all');

      for (const bad of [null, undefined, 'uploadMaxMb', 5, true, [], [{ uploadMaxMb: 60 }]]) {
        const err = thrown(() => updateSettings(db, bad));
        expect(err, String(bad)).toBeInstanceOf(InvalidSettingsError);
      }
      expect(count(db)).toBe(0);
    });
  });

  test('the criteria set no bounds beyond "positive integer" and "non-empty": no upper cap, no ordering, no length limit', () => {
    const db = migrated('all');

    const result = updateSettings(db, { uploadMaxMb: 100000, retestIntervalsDays: [30, 7, 7, 365] });
    expect(result.uploadMaxMb).toBe(100000);
    expect(result.retestIntervalsDays).toEqual([30, 7, 7, 365]);

    const long = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(updateSettings(db, { retestIntervalsDays: long }).retestIntervalsDays).toEqual(long);
    expect(updateSettings(db, { uploadMaxMb: Number.MAX_SAFE_INTEGER }).uploadMaxMb).toBe(Number.MAX_SAFE_INTEGER);
  });

  describe('atomic: all keys of a patch are written in one transaction or none', () => {
    /**
     * A trigger that fails the SECOND row written with one timestamp (a patch shares one timestamp). It works
     * whatever order the implementation writes the keys in, and proves the first write is rolled back.
     */
    function failSecondWriteOfAPatch(db: Database): void {
      for (const event of ['INSERT', 'UPDATE']) {
        db.run(
          `CREATE TEMP TRIGGER fail_second_${event.toLowerCase()} BEFORE ${event} ON main.settings
           WHEN (SELECT count(*) FROM main.settings WHERE updated_at = NEW.updated_at AND key <> NEW.key) >= 1
           BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`,
        );
      }
    }

    test('a database failure while inserting the second key leaves no row behind', () => {
      const db = migrated('all');
      failSecondWriteOfAPatch(db);

      const err = thrown(() => updateSettings(db, { uploadMaxMb: 80, aiPlannerEnabled: false, videoCoachEnabled: false }, D1));

      expect(err.message).toMatch(/simulated write failure/);
      expect(count(db)).toBe(0);
      expect(db.inTransaction).toBe(false);
      expect(getSettings(db)).toEqual(CRITERIA_DEFAULTS);
    });

    test('a database failure while updating the second key restores every earlier value', () => {
      const db = migrated('all');
      updateSettings(db, { uploadMaxMb: 60, aiPlannerEnabled: false }, D1);
      failSecondWriteOfAPatch(db);
      const before = storedRaw(db);

      const err = thrown(() => updateSettings(db, { uploadMaxMb: 70, aiPlannerEnabled: true }, D2));

      expect(err.message).toMatch(/simulated write failure/);
      expect(storedRaw(db)).toEqual(before);
      expect(db.inTransaction).toBe(false);
    });

    test('the database is usable and consistent after a failed patch', () => {
      const db = migrated('all');
      failSecondWriteOfAPatch(db);
      thrown(() => updateSettings(db, { uploadMaxMb: 80, aiPlannerEnabled: false }, D1));

      expect(updateSettings(db, { uploadMaxMb: 90 }, D1).uploadMaxMb).toBe(90);
      expect(stored(db)).toEqual({ uploadMaxMb: 90 });
    });

    test('called inside a caller\'s own transaction it joins it: the caller rolling back undoes the settings too', () => {
      const db = migrated('all');
      const outer = db.transaction(() => {
        updateSettings(db, { uploadMaxMb: 80 }, D1);
        expect(getSettings(db).uploadMaxMb).toBe(80);
        throw new Error('caller rolls back');
      });

      expect(thrown(() => outer()).message).toBe('caller rolls back');
      expect(count(db)).toBe(0);
    });
  });

  test('a stored bad value in another key is left alone by an update of a different key', () => {
    const db = migrated('all');
    putRaw(db, 'uploadMaxMb', '"x"');

    const result = updateSettings(db, { aiPlannerEnabled: false }, D1);

    expect(result).toEqual({ ...CRITERIA_DEFAULTS, aiPlannerEnabled: false });
    expect(stored(db)).toEqual({ uploadMaxMb: 'x', aiPlannerEnabled: false });
  });
});

describe('settings: the admin contract (shared/admin.ts, whose Settings is a loose object)', () => {
  test('the contract Settings, GET response and PUT request accept the typed object and keep every key', () => {
    const db = migrated('all');
    updateSettings(db, { uploadMaxMb: 80, minStatusByAgeBand: { u10: 'REVIEWED' } });
    const settings = getSettings(db);

    expect(ContractSettings.parse(settings)).toEqual(settings);
    expect(ENDPOINTS.getSettings.response.parse(settings)).toEqual(settings);
    expect(ENDPOINTS.putSettings.request.parse(settings)).toEqual(settings);
    expect(ENDPOINTS.putSettings.response.parse(settings)).toEqual(settings);
  });

  test('a body that went through the contract request schema (PUT) is a valid patch, and the response parses back to the stored object', () => {
    const db = migrated('all');
    const body = ENDPOINTS.putSettings.request.parse(JSON.parse('{"uploadMaxMb":75,"videoCoachEnabled":false,"minStatusByAgeBand":{"adult":"REVIEWED"}}'));

    const result = updateSettings(db, body);

    expect(ENDPOINTS.putSettings.response.parse(result)).toEqual(getSettings(db));
    expect(SettingsSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ uploadMaxMb: 75, videoCoachEnabled: false });
  });

  test('the loose contract object does NOT protect us: a key it lets through is still rejected by updateSettings', () => {
    const db = migrated('all');
    const body = ENDPOINTS.putSettings.request.parse({ uploadMaxMb: 75, surprise: 1 });

    expect(body).toEqual({ uploadMaxMb: 75, surprise: 1 });
    expect(thrown(() => updateSettings(db, body)).message).toContain('surprise');
    expect(count(db)).toBe(0);
  });

  test('SettingsPatch is the unrefined-base partial: every key optional, nested bands optional, unknown keys refused', () => {
    expect(SettingsPatch.parse({})).toEqual({});
    expect(SettingsPatch.parse({ minStatusByAgeBand: { u14: 'REVIEWED' } })).toEqual({ minStatusByAgeBand: { u14: 'REVIEWED' } });
    expect(SettingsPatch.safeParse({ nope: 1 }).success).toBe(false);
    expect(SettingsPatch.safeParse({ minStatusByAgeBand: { nope: 'COMMUNITY' } }).success).toBe(false);
    expect(SettingsPatch.safeParse({ uploadMaxMb: 0 }).success).toBe(false);
    // an empty patch must not be turned into defaults by the schema
    expect(Object.keys(SettingsPatch.parse({}))).toEqual([]);
  });
});

// --- the migration ----------------------------------------------------------------------------------

describe('003_settings: migration', () => {
  test('applies after 001 + 002 through the real runner and MIGRATIONS_DIR, as version 3', () => {
    const db = openDatabase(':memory:');
    opened.push(db);

    const applied = migrate(db);

    expect(applied.slice(0, 3)).toEqual([1, 2, 3]);
    expect(one<{ name: string }>(db, 'SELECT name FROM schema_migrations WHERE version = 3').name).toBe('003_settings');
    expect(tableNames(db)).toContain('settings');
  });

  test('applies on top of a database that already has 001 + 002 (the upgrade path), and only 003 is applied', () => {
    const db = migrated('pair');
    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(2);
    expect(tableNames(db)).not.toContain('settings');

    copy003(trio);
    expect(migrate(db, trio)).toEqual([3]);
    expect(tableNames(db)).toContain('settings');
  });

  test('a copy of 001 + 002 + 003 alone in a temp dir applies and passes the whole contract', () => {
    const db = migrated('trio');

    expect(rows<{ version: number }>(db, 'SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version)).toEqual([1, 2, 3]);
    expectSettingsContract(db);
  });

  test('the real schema passes the contract (every STRICT/NOT NULL/CHECK assertion runs against the full current schema)', () => {
    expectSettingsContract(migrated('all'));
  });

  test('the migrations directory holds 003 as a well-named NNN_name.sql file', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(SQL_FILE);
    expect(files.filter((f) => f.endsWith('.sql')).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test('creates exactly one table, settings, and touches nothing of 001 or 002', () => {
    expect(ownTables()).toEqual(['settings']);

    const schemaOf = (db: Database) => rows<{ type: string; name: string; sql: string | null }>(db, "SELECT type, name, sql FROM sqlite_master WHERE tbl_name <> 'settings' AND name <> 'schema_migrations' ORDER BY name");
    expect(schemaOf(migrated('trio'))).toEqual(schemaOf(migrated('pair')));
  });

  test('contains no transaction control and no PRAGMA (the runner owns the transaction)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i);
    expect(sql).not.toMatch(/\bPRAGMA\b/i);
  });

  test('the header comment documents the hazards for later authors and writers', () => {
    const header = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .map((line) => line.replace(/^--\s*/, ''))
      .join(' ')
      .replace(/\s+/g, ' '); // a phrase may wrap across comment lines
    expect(header).toMatch(/key\/value|key-value/i);
    expect(header).toMatch(/one row per/i);
    expect(header).toMatch(/knows no setting names/i);
    expect(header).toMatch(/needs no migration/i);
    expect(header).toMatch(/INSERT OR REPLACE/);
    expect(header).toMatch(/ON CONFLICT/);
    expect(header).toMatch(/json_valid/);
    expect(header).toMatch(/Zod/);
    expect(header).toMatch(/hour 24/i);
    expect(header).toMatch(/whitespace/i);
    expect(header).toMatch(/secret/i);
    expect(header).toMatch(/ADD COLUMN/);
  });

  test('re-running is a no-op and the recorded checksum is the sha256 of the file bytes, unchanged', () => {
    const db = migrated('all');
    const before = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 3').checksum;
    const schemaBefore = rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const after = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 3').checksum;
    expect(after).toBe(before);
    expect(before).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schemaBefore);
  });

  test('a later 004 that ADDs a COLUMN to settings and adds a table does not break the contract or the module', () => {
    const db = migrated('later');

    expect(one<{ v: number }>(db, 'SELECT max(version) AS v FROM schema_migrations').v).toBe(4);
    // the column 004 added is really there and nullable (so a closed-world "exactly these columns" pin would fail here)
    expect(nullableColumns(db)).toContain('note');

    expectSettingsContract(db);

    expect(getSettings(db)).toEqual(CRITERIA_DEFAULTS);
    expect(updateSettings(db, { uploadMaxMb: 80, minStatusByAgeBand: { u10: 'REVIEWED' } }, D1).uploadMaxMb).toBe(80);
    expect(getSettings(db).minStatusByAgeBand.u10).toBe('REVIEWED');
    expect(one<{ note: string | null }>(db, "SELECT note FROM settings WHERE key = 'uploadMaxMb'").note).toBeNull();
    expect(tableNames(db)).toContain('settings_audit');
  });

  test('on the 003 file alone (after 001 + 002) the table has exactly the contract columns, types, primary key and nothing else', () => {
    const db = migrated('trio');

    const info = rows<{ name: string; type: string; pk: number; notnull: number }>(db, `SELECT name, type, pk, "notnull" FROM pragma_table_info('settings')`);
    expect(Object.fromEntries(info.map((c) => [c.name, c.type]))).toEqual(COLUMN_TYPES);
    expect(info.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['key']);
    expect(nullableColumns(db)).toEqual([]);
    expect(rows(db, `SELECT * FROM pragma_foreign_key_list('settings')`)).toEqual([]);
    expect(rows(db, `SELECT name FROM pragma_index_list('settings') WHERE origin <> 'pk'`)).toEqual([]);
    expect(rows(db, `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'settings'`)).toEqual([]);
    insertRow(db);
    expect(Object.keys(one(db, 'SELECT * FROM settings')).sort()).toEqual([...SETTINGS_REQUIRED].sort());
  });

  test('the SQL knows no setting names: a new setting needs no migration', () => {
    const db = migrated('trio');
    const sql = createSql(db);

    for (const key of SETTING_KEYS) expect(sql, key).not.toContain(key);
    for (const status of TRUST_STATUSES) expect(sql, status).not.toContain(status);
    for (const band of AGE_BANDS) expect(sql, band).not.toMatch(new RegExp(`'${band}'`));
    // any non-blank key is storable
    for (const key of ['aSettingThatDoesNotExistYet', 'a.b.c', 'ключ', 'with space', 'x'.repeat(300), 'UPPER', '0']) {
      insertRow(db, { key });
    }
    expect(count(db)).toBe(7);
  });
});

describe('003_settings: STRICT typing', () => {
  test('every table this migration creates is STRICT (enumerated from PRAGMA table_list, not hard-coded)', () => {
    const own = ownTables();
    const db = migrated('trio');
    const tables = rows<{ name: string; strict: number }>(db, "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table'").filter((t) => own.includes(t.name));

    expect(tables.map((t) => t.name)).toEqual(['settings']);
    for (const table of tables) expect(table.strict, `${table.name} must be STRICT`).toBe(1);
  });

  test('a blob is rejected in every TEXT column', () => {
    const db = migrated('all');
    const blob = new Uint8Array([1, 2]) as unknown as string;
    const datatype = /cannot store .* value in .* column|datatype mismatch/i;

    for (const column of SETTINGS_REQUIRED) {
      expect(thrown(() => insertRow(db, { [column]: blob })).message, column).toMatch(datatype);
    }
    expect(count(db)).toBe(0);
  });
});

describe('003_settings: required columns are NOT NULL', () => {
  test('PRAGMA table_info marks every contract-required column NOT NULL (a positive pin against an explicit list)', () => {
    expect(notNullColumns(migrated('all'))).toEqual(expect.arrayContaining(SETTINGS_REQUIRED));
  });

  test('inserting NULL into any required column is rejected as NOT NULL', () => {
    const db = migrated('all');

    for (const column of SETTINGS_REQUIRED) {
      expect(thrown(() => insertRow(db, { [column]: null })).message, column).toMatch(new RegExp(`NOT NULL constraint failed: settings\\.${column}\\b`));
    }
    expect(count(db)).toBe(0);
  });

  test('omitting updated_at gets a default that is a valid contract Timestamp', () => {
    const db = migrated('all');
    db.run(`INSERT INTO settings (key, value) VALUES ('k', '1')`);

    const { updated_at } = one<{ updated_at: string }>(db, 'SELECT updated_at FROM settings');
    expect(Timestamp.safeParse(updated_at).success).toBe(true);
    expect(updated_at).toMatch(/^\d{4}-\d\d-\d\dT([01]\d|2[0-3]):\d\d:\d\d\.\d{3}Z$/);
  });
});

describe('003_settings: value is JSON', () => {
  test('text that is not RFC 8259 JSON is rejected by the json_valid CHECK', () => {
    const db = migrated('all');

    for (const bad of ['not json', '', '{', '{a:1}', "{'a':1}", '[1,]', 'undefined', 'NaN', 'Infinity', '1 2', '+5', '0x10', '{"a":1}}']) {
      expect(thrown(() => insertRow(db, { value: bad })).message, JSON.stringify(bad)).toMatch(/CHECK constraint failed: json_valid\(value\)/);
    }
    expect(count(db)).toBe(0);
  });

  test('every JSON type is storable (the SQL does not care about the shape: Zod does)', () => {
    const db = migrated('all');
    const good = ['50', 'true', 'false', 'null', '"x"', '[7,14,30]', '{}', '{"u10":"COMMUNITY"}', '1.5', '[]'];

    good.forEach((value, i) => insertRow(db, { key: `k${i}`, value }));

    expect(count(db)).toBe(good.length);
  });
});

describe('003_settings: keys are never blank', () => {
  test('empty, spaces, tab, newline and carriage return are all refused; whitespace inside a key is fine', () => {
    const db = migrated('all');

    for (const blank of BLANKS) {
      expect(thrown(() => insertRow(db, { key: blank })).message, JSON.stringify(blank)).toMatch(/CHECK constraint failed: trim\(key, /);
    }
    insertRow(db, { key: 'inner space' });
    insertRow(db, { key: ' padded ' });
    expect(count(db)).toBe(2);
  });

  test('the key is unique: a second row with the same key is refused, an upsert updates', () => {
    const db = migrated('all');
    insertRow(db, { key: 'k', value: '1' });

    expect(thrown(() => insertRow(db, { key: 'k', value: '2' })).message).toMatch(/UNIQUE constraint failed: settings\.key/);
    db.run(`INSERT INTO settings (key, value, updated_at) VALUES ('k', '3', '${T1}') ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    expect(storedRaw(db)).toEqual([{ key: 'k', value: '3', updated_at: T1 }]);
  });
});

describe('003_settings: updated_at is canonical UTC text', () => {
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

  test('the canonical form is accepted and every other spelling is rejected', () => {
    const db = migrated('all');
    let n = 0;

    expect(() => insertRow(db, { key: `t${n++}`, updated_at: GOOD })).not.toThrow();
    expect(Timestamp.safeParse('2026-01-01T24:00:00.000Z').success).toBe(false); // the contract agrees hour 24 is not a time
    for (const good of ALSO_GOOD) {
      expect(() => insertRow(db, { key: `t${n++}`, updated_at: good }), good).not.toThrow();
      expect(Timestamp.safeParse(good).success, good).toBe(true);
    }
    for (const bad of BAD) {
      expect(thrown(() => insertRow(db, { key: `t${n++}`, updated_at: bad })).message, JSON.stringify(bad)).toMatch(/CHECK constraint failed: strftime\(.*\) IS updated_at/);
    }
    expect(count(db)).toBe(1 + ALSO_GOOD.length);
  });

  test('updating a row to a non-canonical timestamp is refused as well (the CHECK is not insert-only)', () => {
    const db = migrated('all');
    insertRow(db, { key: 'k' });

    expect(thrown(() => db.run(`UPDATE settings SET updated_at = '2026-01-01T24:00:00.000Z' WHERE key = 'k'`)).message).toMatch(/CHECK constraint failed: strftime\(.*\) IS updated_at/);
    expect(thrown(() => db.run(`UPDATE settings SET value = 'nope' WHERE key = 'k'`)).message).toMatch(/CHECK constraint failed: json_valid\(value\)/);
    expect(thrown(() => db.run(`UPDATE settings SET key = '  ' WHERE key = 'k'`)).message).toMatch(/CHECK constraint failed: trim\(key, /);
  });
});
