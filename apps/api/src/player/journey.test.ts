import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { updateSettings } from '../admin/settings';
import { loadSeed } from '../commons/seed-loader';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { Journey } from '../shared/journey';
import type { JourneyTest } from '../shared/journey';
import { progressSummary } from './events';
import { buildJourney } from './journey';

// buildJourney(db, playerId, locale, now) against a real migrated :memory: database (001-006), the REAL
// football seed (config/commons) and real profile / session / event / test_results rows.
//
// Readings the criteria leave open, pinned here (each is also stated in journey.ts):
//   * Test history comes from `test_results` (002; what POST /api/player/test-results writes: test_slug,
//     value, skipped, recorded_at). session_events `result` events are NOT read: 005 documents that a
//     `result` for the session's skill test carries no item, so no event names its test.
//   * A skipped result (nothing measured) is not part of the history.
//   * changePct = (latest - previous) / |previous| * 100 for higher-is-better, (previous - latest) / |previous| * 100
//     for lower-is-better. Absent (key omitted, the contract's `.optional()`) with fewer than two results or previous 0.
//   * personalBest = max (higher) / min (lower) over the whole history.
//   * Retest interval: after the k-th result of a test (k = 1 is the baseline) the next retest is due
//     retestIntervalsDays[min(k, length) - 1] days after that result: 7, then 14, then 30 (the last repeats).
//     `retestsDue` lists the tests with retestDueAt <= now (inclusive).
//   * metrics.skillsImproving = the number of distinct skills (tracks) with a test whose latest result beats the
//     FIRST result (the baseline) strictly, in the improving direction.
//   * `name` is the localized name of the test's skill (requested -> ru -> en); tree and milestones are [].

const SEED_DIR = resolve(import.meta.dir, '../../../../config/commons');
const DAY = 86_400_000;
const NOW = new Date('2026-03-10T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (days: number): string => iso(NOW.getTime() - days * DAY);
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const items = (done: readonly boolean[]): string =>
  JSON.stringify(
    done.map((d, i) => ({
      itemId: `i${i + 1}`,
      drillVersionId: `drill-${i + 1}@1.0.0`,
      minutes: 10 * (i + 1),
      done: d,
      content: { goal: { en: 'g' } },
    })),
  );

let db: Database;
let seq: number;

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  seq = 0;
  addProfile('p1');
  addProfile('p2');
});

afterEach(() => {
  // Cascades to test_results, sessions and session_events.
  db.run('DELETE FROM player_profiles');
  db.run('DELETE FROM settings');
});

function addProfile(playerId: string): void {
  db.run(
    `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
     VALUES (?, 12, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, 'ru')`,
    [playerId],
  );
}

/** One test result row, with the real column set. */
function addResult(playerId: string, testSlug: string, value: number, recordedAt: string, over: { skipped?: boolean; attempts?: number; errors?: number } = {}): void {
  seq += 1;
  db.run(
    `INSERT INTO test_results (player_id, test_slug, value, attempts, errors, skipped, recorded_at, client_uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [playerId, testSlug, value, over.attempts ?? null, over.errors ?? null, over.skipped === true ? 1 : 0, recordedAt, uuid(seq)],
  );
}

/** Adds each value of one test, `daysAgo[i]` days before NOW (oldest first is not required). */
function addSeries(playerId: string, testSlug: string, points: ReadonlyArray<readonly [value: number, daysAgo: number]>): void {
  for (const [value, daysAgo] of points) addResult(playerId, testSlug, value, ago(daysAgo));
}

let sessionSeq = 0;
function addSession(playerId: string, date: string, done: readonly boolean[], finishedAt: string | null): string {
  sessionSeq += 1;
  const id = `s${sessionSeq}`;
  db.run('INSERT INTO sessions (id, player_id, date, planner, graph_version, items, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    playerId,
    date,
    'rules',
    '1.0.0',
    items(done),
    finishedAt,
  ]);
  return id;
}

function addEvent(playerId: string, sessionId: string, type: string, over: { itemId?: string; value?: number; at?: string } = {}): void {
  seq += 1;
  db.run('INSERT INTO session_events (player_id, session_id, client_uuid, type, item_id, value, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    playerId,
    sessionId,
    uuid(seq),
    type,
    over.itemId ?? null,
    over.value ?? null,
    over.at ?? ago(0),
  ]);
}

/** buildJourney, always through the contract's schema: the output must parse as a Journey. */
function journey(playerId = 'p1', locale: 'kk' | 'ru' | 'en' = 'en', now: Date = NOW): Journey {
  return Journey.parse(buildJourney(db, playerId, locale, now));
}

function testRow(j: Journey, slug: string): JourneyTest {
  const row = j.tests.find((t) => t.testSlug === slug);
  if (row === undefined) throw new Error(`no journey row for ${slug}`);
  return row;
}

describe('empty history', () => {
  test('a player with nothing gets empty arrays (never null) and zero metrics, and it parses as a Journey', () => {
    const raw = buildJourney(db, 'p1', 'en', NOW);
    expect(Journey.safeParse(raw).success).toBe(true);
    expect(raw.tests).toEqual([]);
    expect(raw.retestsDue).toEqual([]);
    expect(raw.tree).toEqual([]);
    expect(raw.milestones).toEqual([]);
    expect(raw.metrics).toEqual({ sessionsCompleted: 0, minutesTrained: 0, streakDays: 0, skillsImproving: 0 });
  });

  test('an id with no profile at all is the same empty journey, not an error', () => {
    const j = journey('nobody');
    expect(j.tests).toEqual([]);
    expect(j.retestsDue).toEqual([]);
  });
});

describe('changePct, previous, latest, history', () => {
  test('a higher-is-better test 14 -> 21 is +50 with previous 14, latest 21 and the ordered history', () => {
    addSeries('p1', 'juggling-max-touches', [
      [14, 10],
      [21, 3],
    ]);
    const t = testRow(journey(), 'juggling-max-touches');
    expect(t.changePct).toBe(50);
    expect(t.previous).toBe(14);
    expect(t.latest).toBe(21);
    expect(t.history).toEqual([
      { value: 14, at: ago(10) },
      { value: 21, at: ago(3) },
    ]);
    expect(t.direction).toBe('higher');
    expect(t.unit).toBe('touches');
  });

  test('a lower-is-better test (slalom) 30s -> 24s is +20: faster is a positive change', () => {
    addSeries('p1', 'slalom-time', [
      [30, 10],
      [24, 3],
    ]);
    const t = testRow(journey(), 'slalom-time');
    expect(t.direction).toBe('lower');
    expect(t.unit).toBe('s');
    expect(t.changePct).toBe(20);
    expect(t.previous).toBe(30);
    expect(t.latest).toBe(24);
  });

  test('a lower-is-better test that got slower is negative: 24s -> 30s is -25', () => {
    addSeries('p1', 'slalom-time', [
      [24, 10],
      [30, 3],
    ]);
    expect(testRow(journey(), 'slalom-time').changePct).toBe(-25);
  });

  test('a higher-is-better test that dropped is negative: 21 -> 14 is about -33.33', () => {
    addSeries('p1', 'juggling-max-touches', [
      [21, 10],
      [14, 3],
    ]);
    expect(testRow(journey(), 'juggling-max-touches').changePct).toBeCloseTo(-33.3333, 3);
  });

  test('previous and changePct compare the last two results, not the baseline', () => {
    addSeries('p1', 'juggling-max-touches', [
      [10, 20],
      [30, 10],
      [15, 3],
    ]);
    const t = testRow(journey(), 'juggling-max-touches');
    expect(t.previous).toBe(30);
    expect(t.latest).toBe(15);
    expect(t.changePct).toBe(-50);
  });

  test('one result: latest is set, previous and changePct are omitted (keys absent), personalBest is that value', () => {
    addSeries('p1', 'juggling-max-touches', [[14, 3]]);
    const t = testRow(journey(), 'juggling-max-touches');
    expect(t.latest).toBe(14);
    expect(t.personalBest).toBe(14);
    expect(Object.hasOwn(t, 'previous')).toBe(false);
    expect(Object.hasOwn(t, 'changePct')).toBe(false);
    expect(t.history).toEqual([{ value: 14, at: ago(3) }]);
  });

  test('previous 0 (a percentage of zero is undefined): changePct is omitted, the rest is intact', () => {
    addSeries('p1', 'juggling-max-touches', [
      [0, 10],
      [12, 3],
    ]);
    const t = testRow(journey(), 'juggling-max-touches');
    expect(Object.hasOwn(t, 'changePct')).toBe(false);
    expect(t.previous).toBe(0);
    expect(t.latest).toBe(12);
  });

  test('only tests with a result are listed, in slug order, each with its own history', () => {
    addSeries('p1', 'wall-passing-60s', [[20, 3]]);
    addSeries('p1', 'ball-mastery-30s', [[40, 3]]);
    const slugs = journey().tests.map((t) => t.testSlug);
    expect(slugs).toEqual(['ball-mastery-30s', 'wall-passing-60s']);
  });
});

describe('personal best', () => {
  test('higher-is-better: the maximum over the history, even when the latest is lower', () => {
    addSeries('p1', 'juggling-max-touches', [
      [14, 20],
      [25, 10],
      [20, 3],
    ]);
    expect(testRow(journey(), 'juggling-max-touches').personalBest).toBe(25);
  });

  test('lower-is-better: the minimum over the history, even when the latest is higher', () => {
    addSeries('p1', 'slalom-time', [
      [30, 20],
      [22, 10],
      [26, 3],
    ]);
    expect(testRow(journey(), 'slalom-time').personalBest).toBe(22);
  });
});

describe('history rules', () => {
  test('ordered by time then id, whatever the insertion order', () => {
    addResult('p1', 'juggling-max-touches', 30, ago(2));
    addResult('p1', 'juggling-max-touches', 10, ago(9));
    addResult('p1', 'juggling-max-touches', 21, ago(2)); // same instant as the first: the later id comes later
    const t = testRow(journey(), 'juggling-max-touches');
    expect(t.history.map((p) => p.value)).toEqual([10, 30, 21]);
    expect(t.latest).toBe(21);
    expect(t.previous).toBe(30);
  });

  test('a skipped result (nothing measured) is not part of the history', () => {
    addSeries('p1', 'juggling-max-touches', [[14, 10]]);
    addResult('p1', 'juggling-max-touches', 0, ago(3), { skipped: true });
    const t = testRow(journey(), 'juggling-max-touches');
    expect(t.history).toEqual([{ value: 14, at: ago(10) }]);
    expect(t.latest).toBe(14);
  });

  test('a test whose only results were skipped is not listed', () => {
    addResult('p1', 'juggling-max-touches', 0, ago(3), { skipped: true });
    expect(journey().tests).toEqual([]);
  });

  test('a slug that is not a test of the sport is ignored, not an error', () => {
    addResult('p1', 'removed-test', 5, ago(3));
    addSeries('p1', 'juggling-max-touches', [[14, 3]]);
    expect(journey().tests.map((t) => t.testSlug)).toEqual(['juggling-max-touches']);
  });

  test('session_events `result` events are not test history (005: a result event names no test)', () => {
    const s = addSession('p1', '2026-03-09', [true], null);
    addEvent('p1', s, 'result', { itemId: 'slalom-time', value: 99, at: ago(1) });
    addEvent('p1', s, 'result', { value: 12, at: ago(1) });
    const j = journey();
    expect(j.tests).toEqual([]);
    expect(j.retestsDue).toEqual([]);
  });
});

describe('retest due date', () => {
  test('one result: due 7 days after it; due exactly at 7 days, not before', () => {
    addSeries('p1', 'juggling-max-touches', [[14, 7]]);
    const due = journey();
    expect(testRow(due, 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime())); // 7 days ago + 7 days = now
    expect(due.retestsDue).toEqual(['juggling-max-touches']);
  });

  test('one result 6 days ago: the date is given but the test is not due yet', () => {
    addSeries('p1', 'juggling-max-touches', [[14, 6]]);
    const j = journey();
    expect(testRow(j, 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() + DAY));
    expect(j.retestsDue).toEqual([]);
  });

  test('the injected `now` decides, not the machine clock: the same data is not due an hour before, due an hour after', () => {
    addSeries('p1', 'juggling-max-touches', [[14, 7]]);
    expect(journey('p1', 'en', new Date(NOW.getTime() - 3_600_000)).retestsDue).toEqual([]);
    expect(journey('p1', 'en', new Date(NOW.getTime() + 3_600_000)).retestsDue).toEqual(['juggling-max-touches']);
  });

  test('the interval grows with the results: 1st result +7d, 2nd +14d, 3rd and later +30d', () => {
    addSeries('p1', 'juggling-max-touches', [[10, 40]]);
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 40 * DAY + 7 * DAY));
    addSeries('p1', 'juggling-max-touches', [[12, 30]]);
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 30 * DAY + 14 * DAY));
    addSeries('p1', 'juggling-max-touches', [[14, 20]]);
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 20 * DAY + 30 * DAY));
    addSeries('p1', 'juggling-max-touches', [[16, 5]]);
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 5 * DAY + 30 * DAY));
  });

  test('the configured intervals are used, not hard-coded ones', () => {
    updateSettings(db, { retestIntervalsDays: [3, 5] });
    addSeries('p1', 'juggling-max-touches', [[10, 20]]);
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 20 * DAY + 3 * DAY));
    addSeries('p1', 'juggling-max-touches', [[12, 10]]);
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 10 * DAY + 5 * DAY));
    addSeries('p1', 'juggling-max-touches', [[14, 4]]);
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 4 * DAY + 5 * DAY)); // the last interval repeats
  });

  test('retestsDue lists only the due tests, in slug order; every test row carries its retestDueAt', () => {
    addSeries('p1', 'wall-passing-60s', [[20, 8]]); // due
    addSeries('p1', 'ball-mastery-30s', [[40, 9]]); // due
    addSeries('p1', 'slalom-time', [[30, 2]]); // not due
    const j = journey();
    expect(j.retestsDue).toEqual(['ball-mastery-30s', 'wall-passing-60s']);
    for (const t of j.tests) expect(typeof t.retestDueAt).toBe('string');
  });

  test('a skipped result does not restart the retest clock', () => {
    addSeries('p1', 'juggling-max-touches', [[14, 9]]);
    addResult('p1', 'juggling-max-touches', 0, ago(1), { skipped: true });
    expect(testRow(journey(), 'juggling-max-touches').retestDueAt).toBe(iso(NOW.getTime() - 9 * DAY + 7 * DAY));
  });
});

describe('skillsImproving', () => {
  test('counts the skills whose latest result beats the baseline in the improving direction', () => {
    addSeries('p1', 'juggling-max-touches', [
      [14, 20],
      [21, 3],
    ]); // higher: better
    addSeries('p1', 'slalom-time', [
      [30, 20],
      [24, 3],
    ]); // lower: better
    addSeries('p1', 'ball-mastery-30s', [
      [40, 20],
      [35, 3],
    ]); // higher: worse
    addSeries('p1', 'wall-passing-60s', [[20, 3]]); // a baseline only
    addSeries('p1', 'weak-foot-passes', [
      [5, 20],
      [5, 3],
    ]); // unchanged
    expect(journey().metrics.skillsImproving).toBe(2);
  });

  test('a lower-is-better skill that got slower is not improving', () => {
    addSeries('p1', 'slalom-time', [
      [24, 20],
      [30, 3],
    ]);
    expect(journey().metrics.skillsImproving).toBe(0);
  });

  test('the baseline is the FIRST result, not the previous one: 10, 30, 20 is improving (20 > 10) although it fell from 30', () => {
    addSeries('p1', 'juggling-max-touches', [
      [10, 20],
      [30, 10],
      [20, 3],
    ]);
    expect(journey().metrics.skillsImproving).toBe(1);
  });

  test('the baseline is the FIRST result for lower-is-better too: 30, 20, 25 is improving (25 < 30)', () => {
    addSeries('p1', 'slalom-time', [
      [30, 20],
      [20, 10],
      [25, 3],
    ]);
    expect(journey().metrics.skillsImproving).toBe(1);
  });

  test('the latest, not the best: 10, 30, 8 is not improving even though it once was', () => {
    addSeries('p1', 'juggling-max-touches', [
      [10, 20],
      [30, 10],
      [8, 3],
    ]);
    expect(journey().metrics.skillsImproving).toBe(0);
  });
});

describe('metrics from the session log (shared with progressSummary)', () => {
  test('sessions completed, minutes trained and streak are the ones progressSummary computes, plus skillsImproving', () => {
    addSession('p1', '2026-03-09', [true, true, false], '2026-03-09T18:00:00.000Z'); // 10 + 20 minutes
    addSession('p1', '2026-03-10', [true], '2026-03-10T09:00:00.000Z'); // 10 minutes
    addSession('p1', '2026-03-08', [true, true, true], null); // unfinished: minutes count, the session does not
    const j = journey();
    expect(j.metrics).toEqual({ sessionsCompleted: 2, minutesTrained: 100, streakDays: 2, skillsImproving: 0 });
    expect(j.metrics).toEqual({ ...progressSummary(db, 'p1', { now: () => NOW }), skillsImproving: 0 });
  });

  test('the streak follows the injected now (5 days later it is broken)', () => {
    addSession('p1', '2026-03-09', [true], '2026-03-09T18:00:00.000Z');
    addSession('p1', '2026-03-10', [true], '2026-03-10T09:00:00.000Z');
    expect(journey('p1', 'en', NOW).metrics.streakDays).toBe(2);
    expect(journey('p1', 'en', new Date(NOW.getTime() + 5 * DAY)).metrics.streakDays).toBe(0);
  });
});

describe('owner isolation', () => {
  test("another player's results and sessions never appear", () => {
    addSeries('p2', 'juggling-max-touches', [
      [50, 20],
      [80, 3],
    ]);
    addSeries('p2', 'slalom-time', [[9, 3]]);
    const s = addSession('p2', '2026-03-10', [true, true], '2026-03-10T09:00:00.000Z');
    addEvent('p2', s, 'result', { itemId: 'slalom-time', value: 9 });

    const own = journey('p1');
    expect(own.tests).toEqual([]);
    expect(own.retestsDue).toEqual([]);
    expect(own.metrics).toEqual({ sessionsCompleted: 0, minutesTrained: 0, streakDays: 0, skillsImproving: 0 });
  });

  test("a player's own rows are untouched by another player's: same test, separate histories", () => {
    addSeries('p1', 'juggling-max-touches', [
      [14, 10],
      [21, 3],
    ]);
    addSeries('p2', 'juggling-max-touches', [
      [50, 10],
      [80, 3],
    ]);
    const t = testRow(journey('p1'), 'juggling-max-touches');
    expect(t.history.map((p) => p.value)).toEqual([14, 21]);
    expect(t.personalBest).toBe(21);
    expect(t.changePct).toBe(50);
    expect(testRow(journey('p2'), 'juggling-max-touches').history.map((p) => p.value)).toEqual([50, 80]);
  });
});

describe('locale', () => {
  test('the test name is the skill name in the requested locale', () => {
    addSeries('p1', 'slalom-time', [[30, 3]]);
    expect(testRow(journey('p1', 'ru'), 'slalom-time').name).toBe('Дриблинг');
    expect(testRow(journey('p1', 'kk'), 'slalom-time').name).toBe('Допты алып жүру');
    expect(testRow(journey('p1', 'en'), 'slalom-time').name).toBe('Dribbling');
  });

  test('a locale with no name falls back requested -> ru -> en; the numbers do not depend on the locale', () => {
    addSeries('p1', 'slalom-time', [
      [30, 10],
      [24, 3],
    ]);
    const before = db.query("SELECT names FROM skills WHERE slug = 'dribbling'").get() as { names: string };
    try {
      db.run("UPDATE skills SET names = json_remove(names, '$.kk') WHERE slug = 'dribbling'");
      expect(testRow(journey('p1', 'kk'), 'slalom-time').name).toBe('Дриблинг');
      db.run("UPDATE skills SET names = json_remove(names, '$.kk', '$.ru') WHERE slug = 'dribbling'");
      expect(testRow(journey('p1', 'kk'), 'slalom-time').name).toBe('Dribbling');
    } finally {
      db.run("UPDATE skills SET names = ? WHERE slug = 'dribbling'", [before.names]);
    }
    const { name: _ru, ...ru } = testRow(journey('p1', 'ru'), 'slalom-time');
    const { name: _kk, ...kk } = testRow(journey('p1', 'kk'), 'slalom-time');
    expect(kk).toEqual(ru);
  });
});
