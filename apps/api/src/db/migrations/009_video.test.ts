import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIDENCE_LEVELS, PoseFeatures, VideoAnalysis } from '../../shared/video';
import { openDatabase } from '../database';
import { MIGRATIONS_DIR, migrate } from '../migrate';

const SQL_FILE = '009_video.sql';
const THROUGH_007 = [
  '001_commons.sql',
  '002_player.sql',
  '003_settings.sql',
  '004_test_thresholds.sql',
  '005_sessions.sql',
  '006_contributions.sql',
  '007_privacy.sql',
];
const REAL_008 = '008_ai_calls.sql';

/** Column-name segments (split on _) that would mean a video, a frame or an image is stored. None may exist. */
const FORBIDDEN_COLUMN = /(^|_)(video|clip|frame|frames|keyframe|keyframes|image|images|photo|jpeg|jpg|blob|bytes|data|file|path|url|thumbnail|thumb|base64)(_|$)/i;

/** Column-name segments that would be the "you play at 63/100" overall number the contract forbids. */
const OVERALL_COLUMN = /(^|_)(overall|total|grade|rating|rank|percent|percentage)(_|$)/i;

interface ColumnShape {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1;
}

/** The bead's columns. Positive containment only: a later ALTER TABLE ... ADD COLUMN must not break this. */
const EXPECTED_COLUMNS: ColumnShape[] = [
  { name: 'id', type: 'TEXT', notnull: 1, pk: 1 },
  { name: 'player_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'skill_slug', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'rubric_version', type: 'INTEGER', notnull: 1, pk: 0 },
  { name: 'confidence', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'scores', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'focus_next', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'recommended', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'features_summary', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'client_uuid', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
];

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:05:00.000Z';

/** Timestamp spellings the created_at CHECK must refuse (only canonical ms-UTC is stored, as in 002-008). */
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
  `2026-01-01T00:00:00.000Z${String.fromCharCode(0)}anything`,
];

const NUL = String.fromCharCode(0);

let tmp: string;
let opened: Database[];

beforeEach(() => {
  opened = [];
  tmp = mkdtempSync(join(tmpdir(), 'video-migration-'));
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

/** A scratch migrations dir: 001-007, then `eighth` as 008, then (optionally) the real 009. */
function scratchDir(name: string, eighth: 'real' | 'stand-in', with009: boolean): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  for (const file of THROUGH_007) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
  // The runner forbids gaps, so 009 cannot follow 007 directly: a stand-in 008 that creates nothing
  // proves 009 needs nothing from the real 008.
  if (eighth === 'real') copyFileSync(join(MIGRATIONS_DIR, REAL_008), join(dir, REAL_008));
  else writeFileSync(join(dir, '008_standin.sql'), 'SELECT 1;\n');
  if (with009) copyFileSync(join(MIGRATIONS_DIR, SQL_FILE), join(dir, SQL_FILE));
  return dir;
}

/** A migrated in-memory database opened like production (foreign_keys ON). */
function migrated(which: 'all' | 'eight' | 'after-007' = 'all'): Database {
  const db = openDatabase(':memory:');
  opened.push(db);
  if (which === 'all') migrate(db);
  else if (which === 'eight') migrate(db, scratchDir('eight', 'real', false));
  else migrate(db, scratchDir('after-007', 'stand-in', true));
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
 * true when `fn` succeeds, false when the database REFUSES the row (a CHECK, NOT NULL, UNIQUE, foreign key or STRICT
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
  rows<ColumnShape>(db, `SELECT name, type, "notnull" AS "notnull", pk FROM pragma_table_info('video_analyses') ORDER BY cid`);

const plan = (db: Database, sql: string, ...params: Cell[]): string =>
  rows<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail).join(' | ');

// --- fixtures ------------------------------------------------------------------------------

/** A lower-case v4 uuid, distinct per n: what client_uuid holds. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

const SCORES = [
  { key: 'first-touch', label: 'First touch', score: 7, note: 'Soft control, ball stays close.' },
  { key: 'balance', label: 'Balance', score: 5, note: 'Trunk leans forward on turns.' },
];
const RECOMMENDED = [{ drillVersionId: 'dv-1', slug: 'wall-passes', title: 'Wall passes', reason: 'Trains the first touch.' }];
const FEATURES = { cadencePerMin: 112.5, leftRightBalance: 0.4, meanVisibility: 0.91, framesAnalysed: 240 };

function videoRow(over: Record<string, Cell> = {}): Record<string, Cell> {
  return {
    id: 'va-1',
    player_id: 'p1',
    skill_slug: 'first-touch',
    rubric_version: 1,
    confidence: 'medium',
    scores: JSON.stringify(SCORES),
    focus_next: 'Keep the trunk upright when you turn.',
    recommended: JSON.stringify(RECOMMENDED),
    features_summary: JSON.stringify(FEATURES),
    client_uuid: uuid(1),
    created_at: T0,
    ...over,
  };
}

const addVideo = (db: Database, over: Record<string, Cell> = {}) => insertRow(db, 'video_analyses', videoRow(over));

function withProfile(): Database {
  const db = migrated();
  addProfile(db);
  return db;
}

/** True when a row with `over` is accepted on a fresh database with profile p1. */
const accepts = (over: Record<string, Cell>): boolean => accepted(() => addVideo(withProfile(), over));

/** A scores array whose one note is `note`. */
const scoresWithNote = (note: string): string => JSON.stringify([{ key: 'balance', label: 'Balance', score: 5, note }]);

/** A base64-looking blob of `n` characters that starts like a JPEG ("/9j/"): what an embedded frame looks like. */
const jpegLike = (n: number): string => `/9j/${'A1b2C3d4+E5f6G7h8'.repeat(Math.ceil(n / 18)).slice(0, n - 4)}`;

// --- the migration ---------------------------------------------------------------------------

describe('009_video: applying', () => {
  test('the real migrations apply in order 1..9 and 009 is recorded with its checksum', () => {
    const db = openDatabase(':memory:');
    opened.push(db);
    const applied = migrate(db);
    expect(applied.slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const row = one<{ version: number; name: string; checksum: string }>(
      db,
      'SELECT version, name, checksum FROM schema_migrations WHERE version = 9',
    );
    expect(row.name).toBe('009_video');
    expect(row.checksum).toBe(createHash('sha256').update(readFileSync(join(MIGRATIONS_DIR, SQL_FILE))).digest('hex'));
    expect(migrate(db)).toEqual([]);
  });

  test('applies after 007: it needs nothing from 008 (001-007 + a stand-in 008 + 009)', () => {
    const db = migrated('after-007');
    expect(tableNames(db)).toContain('video_analyses');
    expect(tableNames(db)).toContain('consents'); // 007 is really there
    expect(tableNames(db)).not.toContain('ai_calls'); // 008 is not
    addProfile(db);
    addVideo(db);
    expect(count(db, 'video_analyses')).toBe(1);
  });

  test('creates video_analyses and leaves every table of 001-008 exactly as it was', () => {
    const before = migrated('eight');
    const after = migrated('all');
    const added = tableNames(after).filter((t) => !tableNames(before).includes(t));
    expect(added).toEqual(['video_analyses']);
    for (const table of tableNames(before)) expect(createSql(after, table), table).toBe(createSql(before, table));
  });

  test('coexists with Better Auth: its own tables can be created next to video_analyses (no name collision)', () => {
    const db = migrated();
    expect(tableNames(db)).toContain('video_analyses');
    for (const name of ['user', 'session', 'account', 'verification']) {
      expect(accepted(() => db.run(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY) STRICT`)), name).toBe(true);
    }
  });
});

describe('009_video: shape', () => {
  test("is STRICT and has the bead's columns with their types and nullability", () => {
    const db = migrated();
    expect(one<{ strict: number }>(db, "SELECT strict FROM pragma_table_list WHERE name = 'video_analyses'").strict).toBe(1);
    const actual = columns(db);
    for (const want of EXPECTED_COLUMNS) expect(actual.find((c) => c.name === want.name), want.name).toEqual(want);
  });

  test('has NO blob or image column: no BLOB-typed column, no column named after a video, frame, image or file', () => {
    const actual = columns(migrated());
    expect(actual.map((c) => c.name)).toContain('features_summary'); // the table exists: the checks below are not vacuous
    expect(actual.filter((c) => c.type.toUpperCase() === 'BLOB').map((c) => c.name)).toEqual([]);
    expect(actual.filter((c) => FORBIDDEN_COLUMN.test(c.name)).map((c) => c.name)).toEqual([]);
  });

  test('stores no overall number: no column is a total, an overall, a grade or a rating (the per-criterion scores are JSON)', () => {
    const actual = columns(migrated());
    expect(actual.map((c) => c.name)).toContain('scores');
    expect(actual.filter((c) => OVERALL_COLUMN.test(c.name)).map((c) => c.name)).toEqual([]);
    expect(actual.filter((c) => c.name === 'score').map((c) => c.name)).toEqual([]);
  });

  test('player_id references player_profiles ON DELETE CASCADE ON UPDATE CASCADE', () => {
    const fks = rows<{ table: string; from: string; to: string; on_update: string; on_delete: string }>(
      migrated(),
      `SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list('video_analyses')`,
    );
    expect(fks).toContainEqual({ table: 'player_profiles', from: 'player_id', to: 'player_id', on_update: 'CASCADE', on_delete: 'CASCADE' });
  });

  test("has an index led by player_id that serves a player's analyses in time order (and the cascade)", () => {
    const db = migrated();
    const named = rows<{ name: string }>(db, "SELECT name FROM pragma_index_list('video_analyses') WHERE origin = 'c'").map((i) => i.name);
    const led = named.filter((n) => rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${n}') ORDER BY seqno`)[0]?.name === 'player_id');
    expect(led.length).toBeGreaterThan(0);
    const detail = plan(db, 'SELECT * FROM video_analyses WHERE player_id = ? ORDER BY created_at DESC, id DESC', 'p1');
    expect(detail).toContain('USING INDEX video_analyses_by_player');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  test('client_uuid has a UNIQUE index of its own (the idempotency key: one column, all players)', () => {
    const db = migrated();
    const unique = rows<{ name: string }>(db, "SELECT name FROM pragma_index_list('video_analyses') WHERE \"unique\" = 1").map((i) => i.name);
    const onClientUuid = unique.filter((n) => {
      const cols = rows<{ name: string }>(db, `SELECT name FROM pragma_index_info('${n}') ORDER BY seqno`).map((c) => c.name);
      return cols.length === 1 && cols[0] === 'client_uuid';
    });
    expect(onClientUuid.length).toBe(1);
  });
});

describe('009_video: rows', () => {
  test('a complete row round-trips', () => {
    const db = withProfile();
    addVideo(db);
    expect(one<Record<string, Cell>>(db, 'SELECT * FROM video_analyses')).toEqual(videoRow());
  });

  test('a row built from a contract-valid VideoAnalysis and PoseFeatures is accepted and reads back as a VideoAnalysis', () => {
    const features = PoseFeatures.parse({
      cadencePerMin: 1e-7,
      leftRightBalance: 0.5,
      kneeAngleStats: { mean: 95.5, min: 60, max: 130.25, stdDev: 12.125 },
      trunkLeanStats: { mean: -3.5, min: -20, max: 4, stdDev: 5 },
      meanVisibility: 0.88,
      framesAnalysed: 300,
    });
    const analysis = VideoAnalysis.parse({
      id: 'va-77',
      skillSlug: 'first-touch',
      createdAt: T0,
      beta: true,
      confidence: 'high',
      scores: [
        { key: 'balance', label: 'Баланс', score: 6, note: 'Дене тік тұрсын, денені тік ұста.' },
        { key: 'first-touch', label: 'First touch', score: 10, note: '' },
      ],
      focusNext: 'Сақтау: тік тұру.',
      recommended: RECOMMENDED,
      repeatAfterSessions: 3,
      limitations: [],
    });
    const db = withProfile();
    addVideo(db, {
      id: analysis.id,
      skill_slug: analysis.skillSlug,
      confidence: analysis.confidence,
      scores: JSON.stringify(analysis.scores),
      focus_next: analysis.focusNext,
      recommended: JSON.stringify(analysis.recommended),
      features_summary: JSON.stringify(features),
      created_at: analysis.createdAt,
    });
    const stored = one<{ id: string; skill_slug: string; created_at: string; confidence: string; scores: string; focus_next: string; recommended: string }>(
      db,
      'SELECT * FROM video_analyses',
    );
    const readBack = VideoAnalysis.parse({
      id: stored.id,
      skillSlug: stored.skill_slug,
      createdAt: stored.created_at,
      beta: true,
      confidence: stored.confidence,
      scores: JSON.parse(stored.scores),
      focusNext: stored.focus_next,
      recommended: JSON.parse(stored.recommended),
      repeatAfterSessions: 3,
      limitations: [],
    });
    expect(readBack).toEqual(analysis);
    expect(PoseFeatures.parse(JSON.parse(one<{ f: string }>(db, 'SELECT features_summary AS f FROM video_analyses').f))).toEqual(features);
  });

  test("each of the bead's columns refuses NULL", () => {
    for (const { name } of EXPECTED_COLUMNS) {
      expect(accepts({ [name]: null }), name).toBe(false);
    }
  });

  test('a player that has no profile is refused (foreign key)', () => {
    expect(accepts({ player_id: 'ghost' })).toBe(false);
  });

  test('a repeated primary key id is refused', () => {
    const db = withProfile();
    addVideo(db);
    expect(accepted(() => addVideo(db, { client_uuid: uuid(2) }))).toBe(false);
    expect(accepted(() => addVideo(db, { id: 'va-2', client_uuid: uuid(2) }))).toBe(true);
  });
});

describe('009_video: id and skill_slug (EntityId: 1-128 characters of A-Za-z0-9 . _ -)', () => {
  for (const column of ['id', 'skill_slug']) {
    test(`${column} accepts EntityId shapes, 128 characters included`, () => {
      expect(accepts({ [column]: 'x' }), '1').toBe(true);
      expect(accepts({ [column]: 'A.b_c-9' }), 'charset').toBe(true);
      expect(accepts({ [column]: 'a'.repeat(128) }), '128').toBe(true);
    });

    test(`${column} refuses anything else`, () => {
      const bad = ['', 'a'.repeat(129), 'a b', 'a/b', 'a:b', 'ключ', ' ', '\n', `a${NUL}b`, `ok${NUL}${'x'.repeat(200)}`];
      for (const value of bad) expect(accepts({ [column]: value }), JSON.stringify(value)).toBe(false);
    });
  }
});

describe('009_video: rubric_version', () => {
  test('accepts positive integers', () => {
    expect(accepts({ rubric_version: 1 })).toBe(true);
    expect(accepts({ rubric_version: 12 })).toBe(true);
  });

  test('refuses zero, negatives and fractions', () => {
    for (const bad of [0, -1, 1.5, 0.5]) expect(accepts({ rubric_version: bad }), String(bad)).toBe(false);
  });
});

describe('009_video: confidence', () => {
  test('the CHECK list equals CONFIDENCE_LEVELS (shared/video.ts)', () => {
    expect(checkList(migrated(), 'video_analyses', 'confidence')).toEqual([...CONFIDENCE_LEVELS]);
  });

  test('accepts every level', () => {
    for (const level of CONFIDENCE_LEVELS) expect(accepts({ confidence: level }), level).toBe(true);
  });

  test('refuses anything else, including other spellings', () => {
    for (const bad of ['', 'Low', 'HIGH', 'very_high', 'medium ', 'none', '1']) expect(accepts({ confidence: bad }), JSON.stringify(bad)).toBe(false);
  });
});

describe('009_video: client_uuid (the offline outbox idempotency key)', () => {
  test('accepts lower-case uuids of every version 1-8 and variant 8/9/a/b, and the nil and max uuid', () => {
    for (const version of '12345678') {
      for (const variant of '89ab') {
        const value = `01234567-89ab-${version}def-${variant}123-0123456789ab`;
        expect(accepts({ client_uuid: value }), value).toBe(true);
      }
    }
    expect(accepts({ client_uuid: '00000000-0000-0000-0000-000000000000' })).toBe(true);
    expect(accepts({ client_uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' })).toBe(true);
  });

  test('refuses upper case, the wrong version or variant, and anything that is not a uuid', () => {
    const good = uuid(5);
    const bad = [
      '01234567-89AB-4DEF-8ABC-0123456789AB', // upper case (uuid(5) is all digits, so upper-casing it would change nothing)
      '01234567-89ab-4DEF-8abc-0123456789ab', // one upper-case run
      '01234567-89ab-4def-8abc-0123456789aB',
      '01234567-89ab-0def-8123-0123456789ab',
      '01234567-89ab-9def-8123-0123456789ab',
      '01234567-89ab-4def-c123-0123456789ab',
      '01234567-89ab-4def-0123-0123456789ab',
      good.replaceAll('-', ''),
      `${good}0`,
      good.slice(1),
      `${good}\n`,
      `${good}${NUL}${'x'.repeat(50)}`,
      '',
      'not-a-uuid',
    ];
    for (const value of bad) expect(accepts({ client_uuid: value }), JSON.stringify(value)).toBe(false);
  });

  test("is UNIQUE across ALL players: a replay, or another player's uuid, is refused", () => {
    const db = withProfile();
    addProfile(db, 'p2');
    addVideo(db);
    expect(accepted(() => addVideo(db, { id: 'va-2' })), 'same player').toBe(false);
    expect(accepted(() => addVideo(db, { id: 'va-2', player_id: 'p2' })), 'other player').toBe(false);
    expect(count(db, 'video_analyses')).toBe(1);
  });

  test('the idempotent insert ON CONFLICT (client_uuid) DO NOTHING keeps the first row', () => {
    const db = withProfile();
    addVideo(db);
    db.run('INSERT INTO video_analyses (id, player_id, skill_slug, rubric_version, confidence, scores, focus_next, recommended, features_summary, client_uuid) ' +
      "VALUES ('va-2', 'p1', 'x', 1, 'low', '[{}]', 'again', '[]', '{}', ?) ON CONFLICT (client_uuid) DO NOTHING", [uuid(1)]);
    expect(count(db, 'video_analyses')).toBe(1);
    expect(one<{ id: string }>(db, 'SELECT id FROM video_analyses').id).toBe('va-1');
  });
});

describe('009_video: scores (JSON array of per-criterion scores; never an image)', () => {
  test('accepts a non-empty array, ordinary text with spaces, punctuation and Kazakh / Russian included', () => {
    expect(accepts({ scores: JSON.stringify(SCORES) })).toBe(true);
    expect(accepts({ scores: scoresWithNote('Дене тік тұрсын, тізе қатты бүгілмесін: жақсы!') })).toBe(true);
    expect(accepts({ scores: scoresWithNote('Keep the ball close (about 1 m), then push off; 5/10 is fine.') })).toBe(true);
  });

  test('refuses anything that is not a JSON array', () => {
    for (const bad of ['', 'null', '{}', '{"a":1}', '"x"', '42', '[{"key":"a"}', 'scores']) {
      expect(accepts({ scores: bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  test('refuses an empty array: an analysis has at least one criterion score (a rerecord verdict is never stored)', () => {
    expect(accepts({ scores: '[]' })).toBe(false);
  });

  test('refuses a NUL that would hide a tail from length() and GLOB', () => {
    expect(accepts({ scores: `${scoresWithNote('ok')}${NUL}${'x'.repeat(500)}` })).toBe(false);
  });

  test('is capped at 16384 characters', () => {
    const upTo = (n: number): string => {
      const base = scoresWithNote('');
      const filler = 'words and more words '.repeat(Math.ceil(n / 21));
      return scoresWithNote(filler.slice(0, n - base.length));
    };
    expect(upTo(16384).length).toBe(16384);
    expect(accepts({ scores: upTo(16384) }), 'at the cap').toBe(true);
    expect(accepts({ scores: upTo(16385) }), 'over the cap').toBe(false);
  });

  test('refuses an embedded image: a base64 run of 256 characters or more, a whole 200 KB frame, a data: image', () => {
    expect(accepts({ scores: scoresWithNote(jpegLike(255)) }), 'run of 255').toBe(true);
    expect(accepts({ scores: scoresWithNote(jpegLike(256)) }), 'run of 256').toBe(false);
    expect(accepts({ scores: scoresWithNote(jpegLike(4000)) }), 'run of 4000').toBe(false);
    expect(accepts({ scores: scoresWithNote(jpegLike(200 * 1024)) }), 'a 200 KB frame').toBe(false);
    expect(accepts({ scores: scoresWithNote(`data:image/jpeg;base64,${jpegLike(4000)}`) }), 'data URL').toBe(false);
    expect(accepts({ scores: scoresWithNote('x'.repeat(256)) }), 'a run of one letter').toBe(false);
    expect(accepts({ scores: scoresWithNote(`${'A'.repeat(200)}\\/${'B'.repeat(100)}`) }), 'run across a backslash and a slash').toBe(false);
  });
});

describe('009_video: recommended (JSON array of drills; never an image)', () => {
  test('accepts arrays of drills, an empty one included', () => {
    expect(accepts({ recommended: '[]' })).toBe(true);
    expect(accepts({ recommended: JSON.stringify(RECOMMENDED) })).toBe(true);
  });

  test('refuses anything that is not a JSON array', () => {
    for (const bad of ['', 'null', '{}', '"x"', '7', '[{"slug":"a"}', 'dv-1']) expect(accepts({ recommended: bad }), JSON.stringify(bad)).toBe(false);
  });

  test('refuses a NUL, an over-long value and an embedded image', () => {
    const drill = (reason: string): string => JSON.stringify([{ drillVersionId: 'dv-1', slug: 'a', title: 'A', reason }]);
    expect(accepts({ recommended: `[]${NUL}${'x'.repeat(500)}` }), 'NUL').toBe(false);
    expect(accepts({ recommended: drill('why '.repeat(5000)) }), 'over 16384').toBe(false);
    expect(accepts({ recommended: drill(jpegLike(255)) }), 'run of 255').toBe(true);
    expect(accepts({ recommended: drill(jpegLike(256)) }), 'run of 256').toBe(false);
    expect(accepts({ recommended: drill(jpegLike(200 * 1024)) }), 'a 200 KB frame').toBe(false);
  });
});

describe('009_video: features_summary (JSON object of numbers: landmark summaries, never frames)', () => {
  test('accepts the contract PoseFeatures spelt compactly, and an empty object', () => {
    expect(accepts({ features_summary: JSON.stringify(FEATURES) })).toBe(true);
    expect(accepts({ features_summary: '{}' })).toBe(true);
    expect(accepts({ features_summary: JSON.stringify({ a: { mean: -1.5e-7, max: 1e21, min: -2e21 }, meanVisibility: 0, framesAnalysed: 1 }) })).toBe(true);
  });

  test('refuses anything that is not a JSON object', () => {
    for (const bad of ['', 'null', '[]', '[1,2]', '"x"', '42', '{"a":1', 'features']) expect(accepts({ features_summary: bad }), JSON.stringify(bad)).toBe(false);
  });

  test('refuses text, spaces and any character outside JSON numbers, keys and punctuation', () => {
    for (const bad of ['{"note":"my knee hurts"}', '{"a": 1}', '{"a":"x/y"}', '{"a":"\\n"}', '{"игра":1}', '{"a":"é"}']) {
      expect(accepts({ features_summary: bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  test('refuses a NUL that would hide a tail from length() and GLOB', () => {
    expect(accepts({ features_summary: `{"a":1}${NUL}${'x'.repeat(500)}` })).toBe(false);
  });

  test('is capped at 2048 characters and refuses a run of 65 key or number characters', () => {
    /** A features object of exactly n characters: fixed-width keys, the first value padded with digits (a run of at most 64). */
    const featuresOfLength = (n: number): string => {
      const m = Math.floor((n - 20) / 9);
      const entries = Array.from({ length: m }, (_, i) => `"k${String(i).padStart(3, '0')}":1`);
      const extra = n - (2 + entries.join(',').length);
      entries[0] = `${entries[0]}${'1'.repeat(extra)}`;
      return `{${entries.join(',')}}`;
    };
    expect(featuresOfLength(2048).length).toBe(2048);
    expect(accepts({ features_summary: featuresOfLength(2048) }), 'at the cap').toBe(true);
    expect(accepts({ features_summary: featuresOfLength(2049) }), 'over the cap').toBe(false);
    expect(accepts({ features_summary: `{"${'a'.repeat(63)}":1}` }), 'run of 63').toBe(true);
    expect(accepts({ features_summary: `{"${'a'.repeat(64)}":1}` }), 'run of 64').toBe(true);
    expect(accepts({ features_summary: `{"${'a'.repeat(65)}":1}` }), 'run of 65').toBe(false);
    expect(accepts({ features_summary: `{"a":${'1'.repeat(65)}}` }), 'a 65-digit number').toBe(false);
    expect(accepts({ features_summary: `{"a":${'1'.repeat(64)}}` }), 'a 64-digit number').toBe(true);
  });

  test('refuses an embedded image: base64 of a frame, at any length', () => {
    expect(accepts({ features_summary: `{"frame":"${jpegLike(120)}"}` }), 'with slash, 120').toBe(false);
    expect(accepts({ features_summary: `{"frame":"${jpegLike(4000)}"}` }), '4000').toBe(false);
    expect(accepts({ features_summary: `{"frame":"${'A1b2C3d4E5f6'.repeat(200)}"}` }), 'slash-free 2400').toBe(false);
  });
});

describe('009_video: focus_next (one short piece of advice)', () => {
  test('accepts 1 to 2000 characters and refuses 2001', () => {
    const words = 'word '.repeat(401);
    expect(accepts({ focus_next: 'x' }), '1').toBe(true);
    expect(accepts({ focus_next: words.slice(0, 2000) }), '2000').toBe(true);
    expect(accepts({ focus_next: words.slice(0, 2001) }), '2001').toBe(false);
    expect(accepts({ focus_next: 'я'.repeat(2000) }), '2000 Cyrillic').toBe(true);
    expect(accepts({ focus_next: 'я'.repeat(2001) }), '2001 Cyrillic').toBe(false);
  });

  test('refuses the empty and the whitespace-only string', () => {
    for (const bad of ['', ' ', '\t', '\n', '\r', ' \t\r\n']) expect(accepts({ focus_next: bad }), JSON.stringify(bad)).toBe(false);
  });

  test('refuses a NUL that would hide a long tail from length()', () => {
    expect(accepts({ focus_next: `ok${NUL}${'x'.repeat(500)}` })).toBe(false);
  });

  test('refuses an embedded image: a base64 run of 256 characters or more', () => {
    expect(accepts({ focus_next: jpegLike(255) }), 'run of 255').toBe(true);
    expect(accepts({ focus_next: jpegLike(256) }), 'run of 256').toBe(false);
    expect(accepts({ focus_next: `Keep going ${jpegLike(1000)}` }), 'after a sentence').toBe(false);
  });
});

describe('009_video: created_at', () => {
  test("defaults to the server's canonical UTC time", () => {
    const db = withProfile();
    const { created_at: _omit, ...withoutCreatedAt } = videoRow();
    insertRow(db, 'video_analyses', withoutCreatedAt);
    const at = one<{ created_at: string }>(db, 'SELECT created_at FROM video_analyses').created_at;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(at).toISOString()).toBe(at);
  });

  test('accepts canonical ms-UTC and refuses every other spelling', () => {
    expect(accepts({ created_at: T1 })).toBe(true);
    for (const bad of BAD_TIMESTAMPS) expect(accepts({ created_at: bad }), JSON.stringify(bad)).toBe(false);
  });
});

describe('009_video: erasure and re-keying', () => {
  function seed(): Database {
    const db = migrated();
    addProfile(db, 'p1');
    addProfile(db, 'p2');
    addVideo(db, { id: 'va-1', player_id: 'p1', client_uuid: uuid(1) });
    addVideo(db, { id: 'va-2', player_id: 'p1', client_uuid: uuid(2), created_at: T1 });
    addVideo(db, { id: 'va-3', player_id: 'p2', client_uuid: uuid(3) });
    return db;
  }

  test("deleting a profile deletes that player's analyses and only theirs", () => {
    const db = seed();
    db.run("DELETE FROM player_profiles WHERE player_id = 'p1'");
    expect(count(db, 'video_analyses', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'video_analyses', "player_id = 'p2'")).toBe(1);
    expect(count(db, 'video_analyses')).toBe(1);
  });

  test('re-keying a profile moves its analyses to the new id (recovery)', () => {
    const db = seed();
    db.run("UPDATE player_profiles SET player_id = 'p9' WHERE player_id = 'p1'");
    expect(count(db, 'video_analyses', "player_id = 'p9'")).toBe(2);
    expect(count(db, 'video_analyses', "player_id = 'p1'")).toBe(0);
    expect(count(db, 'video_analyses', "player_id = 'p2'")).toBe(1);
  });

  test('a stored analysis can be read back in time order for one player', () => {
    const db = seed();
    const ids = rows<{ id: string }>(db, "SELECT id FROM video_analyses WHERE player_id = 'p1' ORDER BY created_at DESC, id DESC").map((r) => r.id);
    expect(ids).toEqual(['va-2', 'va-1']);
  });
});
