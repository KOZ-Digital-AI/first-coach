import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DrillDetail, SkillGraph, graphProblems } from '../../shared/commons';
import { SKILL_LEVEL_MAX, SKILL_LEVEL_MIN, SkillTest, TEST_DIRECTIONS } from '../../shared/domain';
import { DrillContent, LICENSE_IDS, TRUST_STATUSES } from '../../shared/primitives';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '001_commons.sql';

const TABLES = [
  'drill_skills',
  'drill_versions',
  'drills',
  'reviews',
  'skill_prerequisites',
  'skill_tests',
  'skills',
  'sports',
];

/** The only drill_versions column that may change after INSERT (a trust decision). */
const MUTABLE_VERSION_COLUMNS = ['status'];

let tmp: string;
let only001: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'commons-migration-'));
  only001 = join(tmp, 'only-001');
  mkdirSync(only001);
  copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(only001, SQL_FILE));
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

/** A migrated temp file database opened like production (WAL, foreign_keys ON). `all` applies the real MIGRATIONS_DIR; `001` applies a copy of 001 alone. */
function migrated(which: 'all' | '001' = 'all'): Database {
  const db = openDatabase(join(tmp, `${which}-${opened.length}.db`));
  opened.push(db);
  migrate(db, which === 'all' ? MIGRATIONS_DIR : only001);
  return db;
}

function rows<T = Record<string, unknown>>(db: Database, sql: string, ...params: (string | number)[]): T[] {
  return db.query(sql).all(...params) as T[];
}

function one<T = Record<string, unknown>>(db: Database, sql: string, ...params: (string | number)[]): T {
  const [first] = rows<T>(db, sql, ...params);
  if (first === undefined) throw new Error(`no row for: ${sql}`);
  return first;
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

/** The quoted literals of `<column> IN ('a', 'b', ...)` in the CREATE TABLE text of `table`. */
function checkList(db: Database, table: string, column: string): string[] {
  const { sql } = one<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table);
  const match = new RegExp(`(?<![A-Za-z_])${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(sql);
  if (!match) throw new Error(`no "${column} IN (...)" CHECK in ${table}`);
  return [...(match[1] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

// --- fixtures ------------------------------------------------------------------------------

const text = (en: string) => ({ kk: `${en} (kk)`, ru: `${en} (ru)`, en });

/** A full contract-valid DrillContent (defaults applied by the schema, so it is what a seeder stores). */
const CONTENT = DrillContent.parse({
  title: text('Five-Gate Slalom'),
  goal: text('Close control'),
  instructions: text('Dribble through five gates'),
  dose: { reps: 10, sets: 3, durationSec: 60 },
  mistakes: [text('Ball too far from the body')],
  progressions: [text('Time the run')],
  regressions: [text('Widen the gates')],
  conditions: { equipment: 'cones', spaces: ['yard', 'field'], partner: true, ageMin: 7, ageMax: 12 },
  safety: [text('Clear the area first')],
  media: [{ kind: 'video', url: 'https://example.org/slalom.mp4', caption: text('Demo') }],
});

function seedGraph(db: Database): void {
  db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp1', 'football', '{"en":"Football"}', '1.0.0')`);
  db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp2', 'futsal', '{"en":"Futsal"}', '1.0.0')`);
  const skill = db.query(
    `INSERT INTO skills (id, slug, sport_id, parent_id, sort_order, names, levels, age_min, age_max, equipment)
     VALUES (?, ?, ?, ?, ?, ?, '[{"en":"Level 1"}]', 5, 99, 'ball')`,
  );
  skill.run('k-ball', 'ball-control', 'sp1', null, 1, '{"en":"Ball control"}');
  skill.run('k-touch', 'first-touch', 'sp1', 'k-ball', 2, '{"en":"First touch"}');
  skill.run('k-juggle', 'juggling', 'sp1', 'k-ball', 1, '{"en":"Juggling"}');
  skill.run('k-adv', 'advanced-juggling', 'sp1', 'k-juggle', 1, '{"en":"Advanced juggling"}');
  skill.run('k-fut', 'futsal-control', 'sp2', null, 1, '{"en":"Futsal control"}');
}

interface VersionInput {
  id: string;
  drill?: string;
  semver?: string;
  parent?: string | null;
  status?: string;
  license?: string;
  createdAt?: string;
  content?: unknown;
  minutes?: number;
  changeSummary?: string | null;
}

/** Inserts a version the way a seeder would: the filter columns are derived from the content. */
function insertVersion(db: Database, v: VersionInput): void {
  const content = (v.content ?? CONTENT) as typeof CONTENT;
  const c = content.conditions;
  db.query(
    `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space,
       partner, age_min, age_max, level, minutes, license, author_name, author_user_id, source, source_url,
       origin, change_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'basic', ?, ?, 'Coach A', NULL, 'FIRST COACH Genesis',
       'https://example.org/source', 'seed', ?, ?)`,
  ).run(
    v.id,
    v.drill ?? 'd1',
    v.semver ?? '1.0.0',
    v.parent ?? null,
    v.status ?? 'COMMUNITY',
    JSON.stringify(content),
    c.equipment,
    c.spaces[0] as string,
    c.partner ? 1 : 0,
    c.ageMin ?? null,
    c.ageMax ?? null,
    v.minutes ?? 7,
    v.license ?? 'CC-BY-SA-4.0',
    v.changeSummary ?? null,
    v.createdAt ?? '2026-01-01T00:00:00.000Z',
  );
}

function seedDrill(db: Database, slug = 'five-gate-slalom', id = 'd1', versionId = 'v1'): void {
  db.query(`INSERT INTO drills (id, slug, sport_id) VALUES (?, ?, 'sp1')`).run(id, slug);
  insertVersion(db, { id: versionId, drill: id });
  db.query(`UPDATE drills SET current_version_id = ? WHERE id = ?`).run(versionId, id);
}

type Cell = string | number | null;

/** A complete, contract-consistent drill_versions row (column -> value); override single columns to break it. */
function versionRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  const c = CONTENT.conditions;
  return {
    id: 'x1',
    drill_id: 'd1',
    semver: '1.0.0',
    parent_version_id: null,
    status: 'COMMUNITY',
    content: JSON.stringify(CONTENT),
    equipment: c.equipment,
    space: c.spaces[0] as string,
    partner: c.partner ? 1 : 0,
    age_min: c.ageMin ?? null,
    age_max: c.ageMax ?? null,
    level: 'basic',
    minutes: 7,
    license: 'CC-BY-SA-4.0',
    author_name: 'Coach A',
    author_user_id: null,
    source: 'FIRST COACH Genesis',
    source_url: null,
    origin: 'seed',
    change_summary: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function insertRow(db: Database, table: string, row: Record<string, Cell>): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...Object.values(row),
  );
}

/** DrillContent JSON whose `conditions` is exactly what is passed (so tests can omit or mistype keys). */
const contentWith = (conditions: unknown): string => JSON.stringify({ ...CONTENT, conditions });

// --- the migration ---------------------------------------------------------------------------

describe('001_commons: migration', () => {
  test('applies on a temp database through the real runner and MIGRATIONS_DIR, as version 1', () => {
    const db = openDatabase(join(tmp, 'real.db'));
    opened.push(db);

    const applied = migrate(db);

    expect(applied[0]).toBe(1);
    expect(one<{ name: string }>(db, 'SELECT name FROM schema_migrations WHERE version = 1').name).toBe('001_commons');
    const names = rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  test('sits next to its own test: the runner ignores the .ts file and the directory holds only NNN_name.sql migrations', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(SQL_FILE);
    expect(files).toContain('001_commons.test.ts');
    expect(files.filter((f) => f.endsWith('.sql')).every((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
  });

  test('001 alone creates exactly the commons tables (plus the runner ledger and AUTOINCREMENT bookkeeping)', () => {
    const db = migrated('001');

    const names = rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
      (r) => r.name,
    );
    expect(names).toEqual([...TABLES, 'schema_migrations', 'sqlite_sequence'].sort());
  });

  test('contains no transaction control and no PRAGMA (the runner owns the transaction)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\b(COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i);
    expect(sql).not.toMatch(/\bPRAGMA\b/i);
    expect(sql.match(/\bBEGIN\b/gi)?.length ?? 0).toBe(sql.match(/\bCREATE\s+TRIGGER\b/gi)?.length ?? 0); // trigger bodies only
  });

  test('the header comment documents the trigger caveats and the enum-growth rule for later migration authors', () => {
    const header = readFileSync(join(MIGRATIONS_DIR, SQL_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .join('\n');
    expect(header).toMatch(/INSERT OR REPLACE/);
    expect(header).toMatch(/ALTER TABLE .*ADD COLUMN/);
    expect(header).toMatch(/rebuild/i);
  });

  test('re-running is a no-op and the recorded checksum is the sha256 of the file bytes, unchanged', () => {
    const db = migrated('all');
    const before = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 1').checksum;
    const schemaBefore = rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name');

    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);

    const after = one<{ checksum: string }>(db, 'SELECT checksum FROM schema_migrations WHERE version = 1').checksum;
    expect(after).toBe(before);
    expect(before).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(rows(db, 'SELECT type, name, sql FROM sqlite_master ORDER BY name')).toEqual(schemaBefore);
  });
});

// --- enums mirror the contract ------------------------------------------------------------------

describe('001_commons: CHECK lists mirror the contract enums', () => {
  test('the SQL lists parsed out of sqlite_master equal TRUST_STATUSES, LICENSE_IDS and TEST_DIRECTIONS (no missing, no extra)', () => {
    const db = migrated('all');

    expect(checkList(db, 'drill_versions', 'status')).toEqual([...TRUST_STATUSES]);
    expect(checkList(db, 'reviews', 'from_status')).toEqual([...TRUST_STATUSES]);
    expect(checkList(db, 'reviews', 'to_status')).toEqual([...TRUST_STATUSES]);
    expect(checkList(db, 'drill_versions', 'license')).toEqual([...LICENSE_IDS]);
    expect(checkList(db, 'skill_tests', 'direction')).toEqual([...TEST_DIRECTIONS]);
  });

  test('every contract status is accepted on a version and on both ends of a review; unknown ones are rejected', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);

    TRUST_STATUSES.forEach((status, i) => {
      insertVersion(db, { id: `ok-${status}`, semver: `1.0.${i}`, status });
      db.query(
        `INSERT INTO reviews (drill_version_id, reviewer, from_status, to_status) VALUES (?, 'R', ?, ?)`,
      ).run(`ok-${status}`, status, status);
    });
    expect(one<{ n: number }>(db, 'SELECT count(*) AS n FROM drill_versions').n).toBe(TRUST_STATUSES.length);

    for (const bad of ['DRAFT', 'community', 'Reviewed', '', 'COMMUNITY ']) {
      const version = thrown(() => insertVersion(db, { id: `bad-${bad}`, semver: '9.9.9', status: bad }));
      expect(version.message).toMatch(/CHECK constraint failed: status IN/);
      for (const column of ['from_status', 'to_status']) {
        const other = column === 'from_status' ? 'to_status' : 'from_status';
        const review = thrown(() =>
          db
            .query(`INSERT INTO reviews (drill_version_id, reviewer, ${column}, ${other}) VALUES ('ok-COMMUNITY', 'R', ?, 'COMMUNITY')`)
            .run(bad),
        );
        expect(review.message).toMatch(new RegExp(`CHECK constraint failed: ${column} IN`));
      }
    }
  });

  test('every contract licence is accepted; unknown ones are rejected', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);

    LICENSE_IDS.forEach((license, i) => insertVersion(db, { id: `lic-${i}`, semver: `1.0.${i}`, license }));

    for (const bad of ['MIT', 'CC BY-SA 4.0', 'cc0-1.0', '', 'CC0-1.0 ']) {
      const err = thrown(() => insertVersion(db, { id: `bad-${bad}`, semver: '9.9.9', license: bad }));
      expect(err.message).toMatch(/CHECK constraint failed: license IN/);
    }
  });

  test('a skill test direction outside the contract is rejected, the contract ones accepted', () => {
    const db = migrated('all');
    seedGraph(db);
    const insert = (direction: string) =>
      db
        .query(
          `INSERT INTO skill_tests (id, slug, skill_id, metric, unit, direction, protocol, equipment)
           VALUES (?, ?, 'k-ball', 'touches', 'count', ?, '{"en":"p"}', 'ball')`,
        )
        .run(`t-${direction}`, `t-${direction}`, direction);
    for (const direction of TEST_DIRECTIONS) insert(direction);
    expect(thrown(() => insert('sideways')).message).toMatch(/CHECK constraint failed: direction IN/);
  });
});

// --- immutability -------------------------------------------------------------------------------

describe('001_commons: drill_versions immutability trigger', () => {
  test('every column except the documented mutable ones rejects an UPDATE; status is allowed', () => {
    const db = migrated('001');
    seedGraph(db);
    seedDrill(db);

    const columns = rows<{ name: string }>(db, "SELECT name FROM pragma_table_info('drill_versions')").map((r) => r.name);
    expect(columns.length).toBeGreaterThan(MUTABLE_VERSION_COLUMNS.length);
    for (const mutable of MUTABLE_VERSION_COLUMNS) expect(columns).toContain(mutable);

    for (const column of columns) {
      const update = () => db.query(`UPDATE drill_versions SET ${column} = ${column} WHERE id = 'v1'`).run();
      if (MUTABLE_VERSION_COLUMNS.includes(column)) {
        expect(update).not.toThrow();
      } else {
        expect(thrown(update).message, `column ${column}`).toMatch(/drill_versions content is immutable/);
      }
    }
  });

  test('changing a content column is rejected and the stored content is byte-for-byte untouched', () => {
    const db = migrated('all');
    seedGraph(db);
    seedDrill(db);
    const before = one<{ content: string }>(db, `SELECT content FROM drill_versions WHERE id = 'v1'`).content;

    const changed = JSON.stringify({ ...CONTENT, goal: text('Something else') });
    expect(
      thrown(() => db.query(`UPDATE drill_versions SET content = ? WHERE id = 'v1'`).run(changed)).message,
    ).toMatch(/immutable/);
    expect(thrown(() => db.run(`UPDATE drill_versions SET minutes = 99 WHERE id = 'v1'`)).message).toMatch(/immutable/);
    expect(thrown(() => db.run(`UPDATE drill_versions SET license = 'CC0-1.0' WHERE id = 'v1'`)).message).toMatch(/immutable/);
    expect(thrown(() => db.run(`UPDATE drill_versions SET semver = '2.0.0' WHERE id = 'v1'`)).message).toMatch(/immutable/);

    expect(one<{ content: string }>(db, `SELECT content FROM drill_versions WHERE id = 'v1'`).content).toBe(before);
    expect(one<{ minutes: number }>(db, `SELECT minutes FROM drill_versions WHERE id = 'v1'`).minutes).toBe(7);
  });

  test('a trust decision (status change + audit row) is allowed and leaves content alone; a new version is an INSERT', () => {
    const db = migrated('all');
    seedGraph(db);
    seedDrill(db);
    const before = one<{ content: string }>(db, `SELECT content FROM drill_versions WHERE id = 'v1'`).content;

    db.run(`UPDATE drill_versions SET status = 'EXPERT_VERIFIED' WHERE id = 'v1'`);
    db.run(
      `INSERT INTO reviews (drill_version_id, reviewer, org_label, from_status, to_status, note)
       VALUES ('v1', 'Coach B', 'FC Kairat Academy', 'COMMUNITY', 'EXPERT_VERIFIED', 'checked on the pitch')`,
    );
    insertVersion(db, { id: 'v2', semver: '1.1.0', parent: 'v1', changeSummary: 'simpler variant', createdAt: '2026-02-01T00:00:00.000Z' });
    db.run(`UPDATE drills SET current_version_id = 'v2', unpublished_at = '2026-03-01T00:00:00.000Z' WHERE id = 'd1'`);

    expect(one<{ status: string; content: string }>(db, `SELECT status, content FROM drill_versions WHERE id = 'v1'`)).toEqual({
      status: 'EXPERT_VERIFIED',
      content: before,
    });
    expect(one<{ current_version_id: string }>(db, `SELECT current_version_id FROM drills WHERE id = 'd1'`).current_version_id).toBe('v2');
  });

  test('the trigger survives into the current schema (a later table rebuild must recreate it)', () => {
    const db = migrated('all');
    const triggers = rows<{ name: string; tbl_name: string }>(db, "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'");
    expect(triggers).toContainEqual({ name: 'drill_versions_immutable', tbl_name: 'drill_versions' });
    seedGraph(db);
    seedDrill(db);
    expect(thrown(() => db.run(`UPDATE drill_versions SET content = '{}' WHERE id = 'v1'`)).message).toMatch(/immutable/);
  });
});

// --- constraints --------------------------------------------------------------------------------

describe('001_commons: constraints', () => {
  test('foreign keys are enforced on the application connection', () => {
    const db = migrated('all');
    expect(one<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys').foreign_keys).toBe(1);
    seedGraph(db);

    expect(thrown(() => db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('dx', 'dx', 'no-such-sport')`)).message).toMatch(
      /FOREIGN KEY constraint failed/,
    );
    expect(thrown(() => insertVersion(db, { id: 'orphan', drill: 'no-such-drill' })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(
      thrown(() => db.run(`INSERT INTO drill_skills (drill_id, skill_id) VALUES ('no-drill', 'k-ball')`)).message,
    ).toMatch(/FOREIGN KEY constraint failed/);
    expect(
      thrown(() => db.run(`INSERT INTO reviews (drill_version_id, reviewer, from_status, to_status) VALUES ('nope', 'R', 'COMMUNITY', 'REVIEWED')`)).message,
    ).toMatch(/FOREIGN KEY constraint failed/);
  });

  test('slugs are unique per table and shaped like an EntityId', () => {
    const db = migrated('all');
    seedGraph(db);
    seedDrill(db);

    expect(thrown(() => db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('x', 'football', '{}', '1')`)).message).toMatch(/UNIQUE/);
    expect(thrown(() => db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d2', 'five-gate-slalom', 'sp1')`)).message).toMatch(/UNIQUE/);
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(129)]) {
      expect(thrown(() => db.query(`INSERT INTO drills (id, slug, sport_id) VALUES ('d3', ?, 'sp1')`).run(bad)).message).toMatch(/CHECK constraint failed/);
    }
  });

  test('(drill, semver) is unique; the same semver on another drill is fine; malformed semver is rejected', () => {
    const db = migrated('all');
    seedGraph(db);
    seedDrill(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d2', 'other', 'sp1')`);

    expect(thrown(() => insertVersion(db, { id: 'dup', semver: '1.0.0' })).message).toMatch(/UNIQUE constraint failed: drill_versions.drill_id, drill_versions.semver/);
    insertVersion(db, { id: 'other-v1', drill: 'd2', semver: '1.0.0' });
    insertVersion(db, { id: 'pre', semver: '2.0.0-beta.1' });
    for (const bad of ['', 'v1', '1.0', 'latest', '1.0.0 ', '1.0.0+build!']) {
      expect(thrown(() => insertVersion(db, { id: `bad-${bad}`, semver: bad })).message, bad).toMatch(/CHECK constraint failed/);
    }
  });

  test('current_version_id and parent_version_id must belong to the same drill', () => {
    const db = migrated('all');
    seedGraph(db);
    seedDrill(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d2', 'other', 'sp1')`);
    insertVersion(db, { id: 'other-v1', drill: 'd2' });

    expect(thrown(() => db.run(`UPDATE drills SET current_version_id = 'v1' WHERE id = 'd2'`)).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(thrown(() => insertVersion(db, { id: 'cross', drill: 'd2', semver: '1.1.0', parent: 'v1' })).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(thrown(() => insertVersion(db, { id: 'self', semver: '1.2.0', parent: 'self' })).message).toMatch(/CHECK constraint failed/);
    insertVersion(db, { id: 'child', semver: '1.1.0', parent: 'v1' });
    db.run(`UPDATE drills SET current_version_id = 'child' WHERE id = 'd1'`);
  });

  test('the content JSON must be a valid object', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);

    expect(thrown(() => insertRow(db, 'drill_versions', versionRow({ content: 'not json' }))).message).toMatch(
      /CHECK constraint failed: json_valid\(content\)/,
    );
    expect(thrown(() => insertRow(db, 'drill_versions', versionRow({ content: '[]' }))).message).toMatch(
      /CHECK constraint failed: json_valid\(content\)/,
    );
    expect(thrown(() => insertRow(db, 'drill_versions', versionRow({ content: '"text"' }))).message).toMatch(
      /CHECK constraint failed: json_valid\(content\)/,
    );
  });

  test('a fully consistent row is accepted, with or without partner and ages in the content, and with several spaces', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);

    insertRow(db, 'drill_versions', versionRow());
    insertRow(
      db,
      'drill_versions',
      versionRow({
        id: 'x2',
        semver: '1.0.1',
        content: contentWith({ equipment: 'ball', spaces: ['gym', 'yard'] }),
        equipment: 'ball',
        space: 'gym',
        partner: 0,
        age_min: null,
        age_max: null,
      }),
    );
    insertRow(
      db,
      'drill_versions',
      versionRow({
        id: 'x3',
        semver: '1.0.2',
        content: contentWith({ equipment: 'nothing', spaces: ['home_3x3'], partner: false, ageMin: 5 }),
        equipment: 'nothing',
        space: 'home_3x3',
        partner: 0,
        age_min: 5,
        age_max: null,
      }),
    );
    expect(one<{ n: number }>(db, 'SELECT count(*) AS n FROM drill_versions').n).toBe(3);
  });

  test('equipment must be present in the content, be text, and equal the column (an absent key is NOT a pass)', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    const insert = (over: Record<string, Cell>) => thrown(() => insertRow(db, 'drill_versions', versionRow(over))).message;
    const eq = /CHECK constraint failed: equipment IS /;

    expect(insert({ equipment: 'ball' })).toMatch(eq); // disagrees with content 'cones'
    expect(insert({ content: '{}', equipment: 'anything' })).toMatch(eq); // no conditions at all
    expect(insert({ content: '{"a":1}' })).toMatch(eq);
    expect(insert({ content: contentWith({}), equipment: 'anything' })).toMatch(eq); // conditions without equipment
    expect(insert({ content: contentWith({ spaces: ['yard'] }), equipment: 'cones' })).toMatch(eq);
    expect(insert({ content: contentWith({ equipment: 5, spaces: ['yard'] }), equipment: '5' })).toMatch(eq); // number, not text
    expect(insert({ content: contentWith({ equipment: null, spaces: ['yard'] }), equipment: 'cones' })).toMatch(eq);
  });

  test('space must be the first entry of a non-empty spaces list in the content, be text, and equal the column', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    const insert = (over: Record<string, Cell>) => thrown(() => insertRow(db, 'drill_versions', versionRow(over))).message;
    const sp = /CHECK constraint failed: space IS /;

    expect(insert({ space: 'field' })).toMatch(sp); // content says spaces[0] = 'yard'
    expect(insert({ content: contentWith({ equipment: 'cones' }), space: 'nowhere' })).toMatch(sp); // no spaces key
    expect(insert({ content: contentWith({ equipment: 'cones', spaces: [] }), space: 'y' })).toMatch(sp); // empty list
    expect(insert({ content: contentWith({ equipment: 'cones', spaces: [5] }), space: '5' })).toMatch(sp); // number, not text
    expect(insert({ content: contentWith({ equipment: 'cones', spaces: 'yard' }), space: 'yard' })).toMatch(sp); // not a list
  });

  test('partner must equal the content boolean (absent means false); a non-boolean in the content is rejected', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    const insert = (over: Record<string, Cell>) => thrown(() => insertRow(db, 'drill_versions', versionRow(over))).message;
    const pt = /CHECK constraint failed: partner IS /;
    const cond = (extra: Record<string, unknown>) => contentWith({ equipment: 'cones', spaces: ['yard'], ...extra });

    expect(insert({ partner: 0 })).toMatch(pt); // content partner is true
    expect(insert({ content: cond({ partner: false }), partner: 1 })).toMatch(pt);
    expect(insert({ content: cond({}), partner: 1 })).toMatch(pt); // absent = false
    expect(insert({ content: cond({ partner: 1 }), partner: 1 })).toMatch(pt); // integer, not boolean
    expect(insert({ content: cond({ partner: 'yes' }), partner: 1 })).toMatch(pt);
    expect(insert({ content: cond({ partner: null }), partner: 0 })).toMatch(pt);
    insertRow(db, 'drill_versions', versionRow({ content: cond({}), partner: 0, age_min: null, age_max: null })); // absent = 0 is fine
  });

  test('ageMin and ageMax are checked separately: NULL agrees with an absent key, a value must equal the content integer', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    const insert = (over: Record<string, Cell>) => thrown(() => insertRow(db, 'drill_versions', versionRow(over))).message;
    const base = { equipment: 'cones', spaces: ['yard'], partner: true };
    const withAges = (ages: Record<string, unknown>) => contentWith({ ...base, ...ages });

    // age_min
    expect(insert({ age_min: 8 })).toMatch(/CHECK constraint failed: age_min IS /); // content ageMin = 7
    expect(insert({ content: withAges({ ageMax: 12 }), age_min: 7 })).toMatch(/CHECK constraint failed: age_min IS /); // key absent
    expect(insert({ content: withAges({ ageMin: 7, ageMax: 12 }), age_min: null })).toMatch(/CHECK constraint failed: age_min IS /);
    expect(insert({ content: withAges({ ageMin: '7', ageMax: 12 }), age_min: 7 })).toMatch(/CHECK constraint failed: age_min IS /); // string
    expect(insert({ content: withAges({ ageMin: null, ageMax: 12 }), age_min: null })).toMatch(/CHECK constraint failed: age_min IS /);
    // age_max
    expect(insert({ age_max: 13 })).toMatch(/CHECK constraint failed: age_max IS /); // content ageMax = 12
    expect(insert({ content: withAges({ ageMin: 7 }), age_max: 12 })).toMatch(/CHECK constraint failed: age_max IS /); // key absent
    expect(insert({ age_max: null })).toMatch(/CHECK constraint failed: age_max IS /);
    expect(insert({ content: withAges({ ageMin: 7, ageMax: '12' }), age_max: 12 })).toMatch(/CHECK constraint failed: age_max IS /);
    expect(insert({ content: withAges({ ageMin: 7, ageMax: null }), age_max: null })).toMatch(/CHECK constraint failed: age_max IS /);

    // one bound alone is fine when both sides agree
    insertRow(db, 'drill_versions', versionRow({ id: 'only-max', semver: '1.0.1', content: withAges({ ageMax: 12 }), age_min: null }));
    insertRow(db, 'drill_versions', versionRow({ id: 'only-min', semver: '1.0.2', content: withAges({ ageMin: 7 }), age_max: null }));
  });

  test('numeric bounds: minutes > 0, ages ordered, source_url http(s), audit text not blank', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);

    expect(thrown(() => insertVersion(db, { id: 'm0', minutes: 0 })).message).toMatch(/CHECK constraint failed: minutes > 0/);
    const reversed = { ...CONTENT, conditions: { ...CONTENT.conditions, ageMin: 12, ageMax: 7 } };
    expect(thrown(() => insertVersion(db, { id: 'age', content: reversed })).message).toMatch(/CHECK constraint failed: age_min IS NULL OR age_max IS NULL OR age_min <= age_max/);
    const open = { ...CONTENT, conditions: { equipment: 'cones', spaces: ['yard'], partner: false } };
    insertVersion(db, { id: 'no-ages', semver: '1.0.1', content: open });
    expect(
      thrown(() =>
        db.run(
          `INSERT INTO drill_versions (id, drill_id, semver, status, content, equipment, space, level, minutes, license, author_name, source, source_url, origin)
           VALUES ('u', 'd1', '3.0.0', 'COMMUNITY', '${JSON.stringify(open)}', 'cones', 'yard', 'basic', 5, 'CC0-1.0', 'A', 'S', 'ftp://x', 'seed')`,
        ),
      ).message,
    ).toMatch(/CHECK constraint failed: source_url IS NULL/);
  });

  test('skills form a tree within one sport; prerequisites and drill tracks obey their bounds', () => {
    const db = migrated('all');
    seedGraph(db);
    seedDrill(db);

    // self parent and a parent in another sport
    expect(thrown(() => db.run(`UPDATE skills SET parent_id = 'k-touch' WHERE id = 'k-touch'`)).message).toMatch(/CHECK constraint failed/);
    expect(thrown(() => db.run(`UPDATE skills SET parent_id = 'k-fut' WHERE id = 'k-touch'`)).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(thrown(() => db.run(`UPDATE skills SET age_max = 4 WHERE id = 'k-touch'`)).message).toMatch(/CHECK constraint failed: age_max >= age_min/);

    // prerequisites: min_level bounds come from the contract, self edge refused
    const prereq = (level: number, skill = 'k-touch', prerequisite = 'k-juggle') =>
      db.query(`INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES (?, ?, ?)`).run(skill, prerequisite, level);
    for (const bad of [SKILL_LEVEL_MIN - 1, SKILL_LEVEL_MAX + 1]) {
      expect(thrown(() => prereq(bad)).message).toMatch(/CHECK constraint failed: min_level BETWEEN/);
    }
    prereq(SKILL_LEVEL_MIN);
    prereq(SKILL_LEVEL_MAX, 'k-adv', 'k-juggle');
    expect(thrown(() => prereq(2)).message).toMatch(/UNIQUE|PRIMARY KEY/);
    expect(thrown(() => prereq(2, 'k-ball', 'k-ball')).message).toMatch(/CHECK constraint failed: skill_id <> prerequisite_id/);

    // a drill has at most one primary skill (its track) but many skills
    db.run(`INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES ('d1', 'k-touch', 1)`);
    db.run(`INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES ('d1', 'k-juggle', 0)`);
    expect(thrown(() => db.run(`INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES ('d1', 'k-adv', 1)`)).message).toMatch(/UNIQUE/);
  });
});

// --- types, nullability, semver shape ------------------------------------------------------------

describe('001_commons: STRICT typing', () => {
  test('every table this migration creates is STRICT (enumerated from PRAGMA table_list, not hard-coded)', () => {
    const db = migrated('001');
    const tables = rows<{ name: string; strict: number }>(
      db,
      "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'schema_migrations'",
    );

    expect(tables.map((t) => t.name).sort()).toEqual([...TABLES].sort());
    for (const table of tables) expect(table.strict, `${table.name} must be STRICT`).toBe(1);
  });

  test('text and fractions are rejected in INTEGER columns, and a blob in a TEXT column', () => {
    const db = migrated('001');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    const datatype = /cannot store .* value in .* column|datatype mismatch/i;

    // drill_versions
    for (const bad of ['abc', 5.5]) {
      expect(thrown(() => insertRow(db, 'drill_versions', versionRow({ minutes: bad }))).message).toMatch(datatype);
    }
    expect(thrown(() => insertRow(db, 'drill_versions', versionRow({ age_min: 'abc', content: contentWith({ equipment: 'cones', spaces: ['yard'], partner: true, ageMin: 'abc', ageMax: 12 }) }))).message).toMatch(datatype);
    expect(thrown(() => insertRow(db, 'drill_versions', versionRow({ author_name: new Uint8Array([1, 2]) as unknown as string }))).message).toMatch(datatype);

    // skills
    const skill = (over: Record<string, Cell>) =>
      insertRow(db, 'skills', {
        id: 'k-new', slug: 'new-skill', sport_id: 'sp1', parent_id: null, sort_order: 0, names: '{"en":"n"}',
        age_min: 5, age_max: 9, equipment: 'ball', ...over,
      });
    expect(thrown(() => skill({ sort_order: 'abc' })).message).toMatch(datatype);
    expect(thrown(() => skill({ age_min: 5.5 })).message).toMatch(datatype);
    expect(thrown(() => skill({ age_max: 'abc' })).message).toMatch(datatype);

    // skill_prerequisites
    expect(
      thrown(() => db.query(`INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES ('k-touch', 'k-juggle', ?)`).run(3.5)).message,
    ).toMatch(datatype);

    // reviews: id is INTEGER PRIMARY KEY; note is TEXT
    insertRow(db, 'drill_versions', versionRow());
    expect(
      thrown(() => db.query(`INSERT INTO reviews (drill_version_id, reviewer, from_status, to_status, note) VALUES ('x1', 'R', 'COMMUNITY', 'REVIEWED', ?)`).run(new Uint8Array([1]))).message,
    ).toMatch(datatype);

    // sports, drills, skill_tests: TEXT columns
    expect(thrown(() => db.query(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp9', 'nine', '{}', ?)`).run(new Uint8Array([1]))).message).toMatch(datatype);
    expect(thrown(() => db.query(`INSERT INTO drills (id, slug, sport_id, unpublished_at) VALUES ('d9', 'nine', 'sp1', ?)`).run(new Uint8Array([1]))).message).toMatch(datatype);
    expect(
      thrown(() => db.query(`INSERT INTO skill_tests (id, slug, skill_id, metric, unit, direction, protocol, equipment) VALUES ('t9', 'nine', 'k-ball', ?, 'count', 'higher', '{"en":"p"}', 'ball')`).run(new Uint8Array([1]))).message,
    ).toMatch(datatype);
  });
});

describe('001_commons: required columns are NOT NULL', () => {
  /** Columns the contract REQUIRES on a version; dropping NOT NULL on any of them must turn this red. */
  const REQUIRED_VERSION_COLUMNS = [
    'id', 'drill_id', 'semver', 'status', 'content', 'equipment', 'space', 'partner', 'level', 'minutes',
    'license', 'author_name', 'source', 'origin', 'created_at',
  ];
  const REQUIRED_REVIEW_COLUMNS = ['drill_version_id', 'reviewer', 'org_label', 'from_status', 'to_status', 'note', 'reviewed_at'];

  const notNullColumns = (db: Database, table: string): string[] =>
    rows<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}') WHERE "notnull" = 1`).map((r) => r.name);

  test('PRAGMA table_info marks every required drill_versions and reviews column NOT NULL', () => {
    const db = migrated('all');
    const versions = notNullColumns(db, 'drill_versions');
    for (const column of REQUIRED_VERSION_COLUMNS) expect(versions, `drill_versions.${column}`).toContain(column);
    const reviews = notNullColumns(db, 'reviews');
    for (const column of REQUIRED_REVIEW_COLUMNS) expect(reviews, `reviews.${column}`).toContain(column);
  });

  test('inserting NULL into any required drill_versions column is rejected as NOT NULL', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);

    for (const column of REQUIRED_VERSION_COLUMNS) {
      const err = thrown(() => insertRow(db, 'drill_versions', versionRow({ [column]: null })));
      expect(err.message, `drill_versions.${column}`).toMatch(new RegExp(`NOT NULL constraint failed: drill_versions\\.${column}\\b`));
    }
    expect(one<{ n: number }>(db, 'SELECT count(*) AS n FROM drill_versions').n).toBe(0);
  });

  test('inserting NULL into any required reviews column (both statuses included) is rejected as NOT NULL', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    insertRow(db, 'drill_versions', versionRow());
    const review = (over: Record<string, Cell>): Record<string, Cell> => ({
      drill_version_id: 'x1', reviewer: 'R', reviewer_user_id: null, org_label: '', from_status: 'COMMUNITY',
      to_status: 'REVIEWED', note: '', reviewed_at: '2026-02-02T09:30:00.000Z', ...over,
    });

    insertRow(db, 'reviews', review({}));
    for (const column of REQUIRED_REVIEW_COLUMNS) {
      const err = thrown(() => insertRow(db, 'reviews', review({ [column]: null })));
      expect(err.message, `reviews.${column}`).toMatch(new RegExp(`NOT NULL constraint failed: reviews\\.${column}\\b`));
    }
  });
});

describe('001_commons: semver shape', () => {
  test('a semver is three digit-only segments plus an optional non-empty pre-release suffix', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    const insert = (semver: string) => insertRow(db, 'drill_versions', versionRow({ id: `s-${semver}`, semver }));

    for (const good of ['1.0.0', '10.20.30', '0.0.1', '2.0.0-beta.1', '1.0.0-rc-1', '1.2.3-x']) {
      expect(() => insert(good), good).not.toThrow();
    }
    for (const bad of ['1a.0.0', '1.x.0', '1.0.x', 'a.b.c', '1.0', '1', '1.0.0.0', '1..0', '.1.0.0', '1.0.', '1.0.0-', '-1.0.0', '1.0.0 ', ' 1.0.0', '1.0.0+build', '1,0,0', '1.0.0-b!', '']) {
      expect(thrown(() => insert(bad)).message, `"${bad}"`).toMatch(/CHECK constraint failed/);
    }
  });
});

// --- query patterns -------------------------------------------------------------------------------

describe('001_commons: the contracts\' query patterns', () => {
  test('walking the skill tree with a recursive CTE returns the whole subtree, siblings in sort_order, via skills_by_parent', () => {
    const db = migrated('all');
    seedGraph(db);
    const walk = `
      WITH RECURSIVE tree(id, slug, depth, path) AS (
        SELECT id, slug, 0, printf('%05d', sort_order) FROM skills WHERE parent_id IS NULL AND sport_id = ?
        UNION ALL
        SELECT s.id, s.slug, tree.depth + 1, tree.path || '/' || printf('%05d', s.sort_order)
        FROM skills s JOIN tree ON s.parent_id = tree.id
      )
      SELECT slug, depth FROM tree ORDER BY path`;

    expect(rows(db, walk, 'sp1')).toEqual([
      { slug: 'ball-control', depth: 0 },
      { slug: 'juggling', depth: 1 },
      { slug: 'advanced-juggling', depth: 2 },
      { slug: 'first-touch', depth: 1 },
    ]);
    const plan = rows<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${walk}`, 'sp1').map((r) => r.detail).join('\n');
    expect(plan).toMatch(/USING INDEX skills_by_parent \(parent_id=\?\)/);
  });

  test('detail by slug, skill filter, history and reviews are index lookups, not scans', () => {
    const db = migrated('all');
    const plan = (sql: string) => rows<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, 'x').map((r) => r.detail).join('\n');

    expect(plan('SELECT * FROM drills WHERE slug = ?')).toMatch(/SEARCH drills USING INDEX sqlite_autoindex_drills_\d \(slug=\?\)/);
    const filtered = plan(
      `SELECT d.slug FROM drill_skills ds JOIN drills d ON d.id = ds.drill_id JOIN drill_versions v ON v.id = d.current_version_id
       WHERE ds.skill_id = ? AND d.unpublished_at IS NULL AND v.status = 'REVIEWED' AND v.level = 'basic' AND v.equipment = 'ball'`,
    );
    expect(filtered).toMatch(/USING COVERING INDEX drill_skills_by_skill \(skill_id=\?\)/);
    expect(filtered).not.toMatch(/SCAN /);
    expect(plan('SELECT * FROM drill_versions WHERE drill_id = ? ORDER BY created_at')).toMatch(/USING INDEX drill_versions_by_drill \(drill_id=\?\)/);
    expect(plan('SELECT * FROM reviews WHERE drill_version_id = ? ORDER BY reviewed_at')).toMatch(/USING INDEX reviews_by_version/);
    expect(plan('SELECT skill_id FROM skill_prerequisites WHERE prerequisite_id = ?')).toMatch(/USING COVERING INDEX skill_prerequisites_by_prerequisite/);
    expect(plan('SELECT * FROM skill_tests WHERE skill_id = ?')).toMatch(/USING INDEX skill_tests_by_skill/);
  });
});

// --- the schema can hold what the contracts serve ------------------------------------------------

describe('001_commons: stores a full seed drill and a skill graph, and reads them back as contract objects', () => {
  test('a DrillDetail round-trips (content, attribution, history, reviews) and parses with the contract schema', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'five-gate-slalom', 'sp1')`);
    insertVersion(db, { id: 'v1', semver: '1.0.0', createdAt: '2026-01-01T00:00:00.000Z' });
    insertVersion(db, { id: 'v2', semver: '1.1.0', parent: 'v1', status: 'REVIEWED', changeSummary: 'simpler variant added', createdAt: '2026-02-01T00:00:00.000Z' });
    db.run(`UPDATE drills SET current_version_id = 'v2' WHERE id = 'd1'`);
    db.run(`INSERT INTO drill_skills (drill_id, skill_id, is_primary) VALUES ('d1', 'k-touch', 1)`);
    db.run(
      `INSERT INTO reviews (drill_version_id, reviewer, reviewer_user_id, org_label, from_status, to_status, note, reviewed_at)
       VALUES ('v2', 'Coach B', 'user-42', 'FC Kairat Academy', 'COMMUNITY', 'REVIEWED', 'ok on the pitch', '2026-02-02T09:30:00.000Z')`,
    );

    const current = one<Record<string, string | number | null>>(
      db,
      `SELECT d.slug, v.* FROM drills d JOIN drill_versions v ON v.id = d.current_version_id WHERE d.slug = ?`,
      'five-gate-slalom',
    );
    const history = rows<{ id: string; semver: string; created_at: string; change_summary: string | null }>(
      db,
      `SELECT id, semver, created_at, change_summary FROM drill_versions WHERE drill_id = ? AND id <> ? ORDER BY created_at`,
      'd1',
      'v2',
    );
    const reviews = rows<{ reviewer: string; org_label: string; from_status: string; to_status: string; note: string; reviewed_at: string }>(
      db,
      `SELECT r.* FROM reviews r JOIN drill_versions v ON v.id = r.drill_version_id WHERE v.drill_id = ? ORDER BY r.reviewed_at, r.id`,
      'd1',
    );

    const detail = DrillDetail.parse({
      slug: current.slug,
      versionId: current.id,
      content: JSON.parse(current.content as string),
      attribution: {
        author: current.author_name,
        source: current.source,
        sourceUrl: current.source_url ?? undefined,
        license: current.license,
        createdAt: current.created_at,
        semver: current.semver,
      },
      history: history.map((h) => ({ versionId: h.id, semver: h.semver, createdAt: h.created_at, note: h.change_summary ?? undefined })),
      reviews: reviews.map((r) => ({ reviewer: r.reviewer, orgLabel: r.org_label, from: r.from_status, to: r.to_status, note: r.note, at: r.reviewed_at })),
    });

    expect(detail.content).toEqual(CONTENT);
    expect(detail.attribution.semver).toBe('1.1.0');
    expect(detail.history).toEqual([{ versionId: 'v1', semver: '1.0.0', createdAt: '2026-01-01T00:00:00.000Z' }]);
    expect(detail.reviews[0]).toMatchObject({ reviewer: 'Coach B', orgLabel: 'FC Kairat Academy', from: 'COMMUNITY', to: 'REVIEWED' });
  });

  test('a default created_at is a valid contract Timestamp', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO drills (id, slug, sport_id) VALUES ('d1', 'drill-one', 'sp1')`);
    db.run(`INSERT INTO drill_versions (id, drill_id, semver, status, content, equipment, space, level, minutes, license, author_name, source, origin)
            VALUES ('v1', 'd1', '1.0.0', 'COMMUNITY', '${JSON.stringify({ ...CONTENT, conditions: { equipment: 'cones', spaces: ['yard'], partner: false } })}',
                    'cones', 'yard', 'basic', 5, 'CC0-1.0', 'A', 'S', 'seed')`);
    const { created_at } = one<{ created_at: string }>(db, `SELECT created_at FROM drill_versions WHERE id = 'v1'`);
    expect(DrillDetail.shape.attribution.shape.createdAt.safeParse(created_at).success).toBe(true);
  });

  test('a SkillGraph (tree, prerequisites) and a SkillTest round-trip and the graph has no integrity problems', () => {
    const db = migrated('all');
    seedGraph(db);
    db.run(`INSERT INTO skill_prerequisites (skill_id, prerequisite_id, min_level) VALUES ('k-touch', 'k-juggle', 2)`);
    db.run(
      `INSERT INTO skill_tests (id, slug, skill_id, metric, unit, direction, protocol, equipment)
       VALUES ('t1', 'juggling-30s', 'k-juggle', 'touches in 30s', 'count', 'higher', '{"kk":"a","ru":"b","en":"c"}', 'ball')`,
    );

    const sport = one<{ slug: string; graph_version: string }>(db, `SELECT slug, graph_version FROM sports WHERE id = 'sp1'`);
    const skills = rows<Record<string, string | number | null>>(db, `SELECT s.*, p.slug AS parent_slug FROM skills s LEFT JOIN skills p ON p.id = s.parent_id WHERE s.sport_id = 'sp1' ORDER BY s.sort_order, s.id`);
    const prereqs = rows<{ skill_id: string; slug: string; min_level: number }>(db, `SELECT p.skill_id, s.slug, p.min_level FROM skill_prerequisites p JOIN skills s ON s.id = p.prerequisite_id`);

    const graph = SkillGraph.parse({
      sport: sport.slug,
      version: sport.graph_version,
      nodes: skills.map((s) => ({
        slug: s.slug,
        parent: s.parent_slug,
        order: s.sort_order,
        names: JSON.parse(s.names as string),
        levels: JSON.parse(s.levels as string),
        prerequisites: prereqs.filter((p) => p.skill_id === s.id).map((p) => ({ skill: p.slug, minLevel: p.min_level })),
        ageMin: s.age_min,
        ageMax: s.age_max,
        equipment: s.equipment,
        safety: JSON.parse(s.safety as string),
        outcomes: JSON.parse(s.outcomes as string),
        mistakes: JSON.parse(s.mistakes as string),
      })),
    });
    expect(graph.nodes).toHaveLength(4);
    expect(graphProblems(graph)).toEqual([]);

    const t = one<Record<string, string>>(db, `SELECT t.*, s.slug AS skill_slug FROM skill_tests t JOIN skills s ON s.id = t.skill_id`);
    expect(
      SkillTest.parse({ slug: t.slug, skill: t.skill_slug, metric: t.metric, unit: t.unit, direction: t.direction, protocol: JSON.parse(t.protocol as string), equipment: t.equipment }),
    ).toMatchObject({ slug: 'juggling-30s', skill: 'juggling', direction: 'higher' });
  });
});
