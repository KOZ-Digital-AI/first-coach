import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../app';
import type { AppDeps } from '../app';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { ENDPOINTS, ImpactMetrics } from '../shared/admin';
import { computeImpact } from './impact';

// Two halves in one file, both on real, migrated :memory: databases (001-006, no mocks):
//   1. computeImpact(db, now): the definitions of spec section 26, pinned with rows inserted by hand.
//      `now` is injected, so every time window is exact and no test reads the clock.
//   2. GET /api/admin/impact through the real createApp with the REAL Better Auth handler: real
//      sessions, the admin promoted by a direct UPDATE of the user row (as admin-settings.routes.test.ts).

const DAY = 86_400_000;
/** A Tuesday. Its week (Monday, UTC) starts 2026-03-09; the 12-week series starts 2025-12-22. */
const NOW = new Date('2026-03-10T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ago = (ms: number): string => iso(NOW.getTime() - ms);

let db: Database;

beforeEach(() => {
  seq = clock = dateCounter = drillCounter = 0;
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
});

// --- fixtures ---------------------------------------------------------------------------------

let seq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

function addPlayer(id: string): void {
  db.run(
    `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
     VALUES (?, 12, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, 'ru')`,
    [id],
  );
}

/** Two skill tests: `sprint` (higher is better) and `slalom` (lower is better). */
function addTests(): void {
  db.run(`INSERT INTO sports (id, slug, name, graph_version) VALUES ('sp1', 'football', '{"en":"Football"}', '1.0.0')`);
  db.run(
    `INSERT INTO skills (id, slug, sport_id, names, age_min, age_max, equipment)
     VALUES ('k1', 'ball-control', 'sp1', '{"en":"Ball control"}', 5, 99, 'ball')`,
  );
  const test = db.query(
    `INSERT INTO skill_tests (id, slug, skill_id, metric, unit, direction, protocol, equipment)
     VALUES (?, ?, 'k1', 'm', 'u', ?, '{"en":"p"}', 'ball')`,
  );
  test.run('t-up', 'juggles', 'higher');
  test.run('t-down', 'slalom', 'lower');
}

/** `at` defaults to a strictly increasing time, so insertion order is recording order. */
let clock = 0;
function addResult(playerId: string, slug: string, value: number, over: { skipped?: boolean; at?: string } = {}): void {
  db.run(
    'INSERT INTO test_results (player_id, test_slug, value, skipped, recorded_at, client_uuid) VALUES (?, ?, ?, ?, ?, ?)',
    [playerId, slug, value, over.skipped ? 1 : 0, over.at ?? iso(Date.UTC(2026, 0, 1) + ++clock * 1000), uuid()],
  );
}

/** Two non-skipped results of one (player, test): the pair the median is taken over. */
function addPair(playerId: string, slug: string, first: number, latest: number): void {
  addPlayer(playerId);
  addResult(playerId, slug, first);
  addResult(playerId, slug, latest);
}

let dateCounter = 0;
function addSession(playerId: string, finishedAt: string | null, minutesDone: readonly (readonly [number, boolean])[] = []): void {
  addPlayerOnce(playerId);
  const items = minutesDone.map(([minutes, done], i) => ({ itemId: `i${i}`, drillVersionId: `d${i}`, minutes, done }));
  const date = iso(Date.UTC(2024, 0, 1) + DAY * ++dateCounter).slice(0, 10);
  db.run('INSERT INTO sessions (id, player_id, date, planner, graph_version, items, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    `s${dateCounter}`,
    playerId,
    date,
    'rules',
    '1.0.0',
    JSON.stringify(items),
    finishedAt,
  ]);
}

function addPlayerOnce(id: string): void {
  if (db.query('SELECT 1 FROM player_profiles WHERE player_id = ?').get(id) === null) addPlayer(id);
}

function addContribution(submitter: string, createdAt: string): void {
  db.run(
    `INSERT INTO contributions (id, kind, payload, submitter_user_id, content_hash, created_at, updated_at)
     VALUES (?, 'new', '{}', ?, ?, ?, ?)`,
    [`c${++seq}`, submitter, 'a'.repeat(64), createdAt, createdAt],
  );
}

let drillCounter = 0;
/** A drill with one version; returns the version id. `published: false` unpublishes it, `linked: false` leaves it without a current version. */
function addDrill(over: { published?: boolean; linked?: boolean } = {}): string {
  const n = ++drillCounter;
  if (n === 1) db.run(`INSERT OR IGNORE INTO sports (id, slug, name, graph_version) VALUES ('sp-d', 'futsal', '{"en":"F"}', '1.0.0')`);
  db.run(`INSERT INTO drills (id, slug, sport_id) VALUES (?, ?, 'sp-d')`, [`dr${n}`, `drill-${n}`]);
  db.run(
    `INSERT INTO drill_versions (id, drill_id, semver, status, content, equipment, space, level, minutes, license, author_name, source, origin)
     VALUES (?, ?, '1.0.0', 'COMMUNITY', '{"conditions":{"equipment":"cones","spaces":["yard"],"partner":false}}',
             'cones', 'yard', 'basic', 10, 'CC0-1.0', 'A', 'seed', 'seed')`,
    [`v${n}`, `dr${n}`],
  );
  if (over.linked !== false) db.run('UPDATE drills SET current_version_id = ? WHERE id = ?', [`v${n}`, `dr${n}`]);
  if (over.published === false) db.run(`UPDATE drills SET unpublished_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`, [`dr${n}`]);
  return `v${n}`;
}

function addReview(versionId: string, reviewerUserId: string | null, reviewer: string, from: string, to: string): void {
  db.run(
    'INSERT INTO reviews (drill_version_id, reviewer, reviewer_user_id, from_status, to_status) VALUES (?, ?, ?, ?, ?)',
    [versionId, reviewer, reviewerUserId, from, to],
  );
}

const impact = (now: Date = NOW) => computeImpact(db, now);

// --- zero data ----------------------------------------------------------------------------------

describe('zero data', () => {
  test('an empty database is all zeros (never null) and a zero-filled 12-week series', () => {
    const result = impact();
    expect(result).toEqual({
      playersWithBaseline: 0,
      playersRetested: 0,
      medianImprovementPct: 0,
      sessionsCompleted: 0,
      trainingHours: 0,
      activeContributors: 0,
      verifiedCoaches: 0,
      openMethodologies: 0,
      byWeek: [
        '2025-12-22', '2025-12-29', '2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26',
        '2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23', '2026-03-02', '2026-03-09',
      ].map((weekStart) => ({ weekStart, sessionsCompleted: 0 })),
    });
    expect(ImpactMetrics.parse(result)).toEqual(result);
  });

  test('players with only skipped results, unfinished sessions and no tests still give zeros', () => {
    addTests();
    addPlayer('p1');
    addResult('p1', 'juggles', 0, { skipped: true });
    addSession('p1', null, [[10, true]]);
    const result = impact();
    expect(result.playersWithBaseline).toBe(0);
    expect(result.playersRetested).toBe(0);
    expect(result.medianImprovementPct).toBe(0);
    expect(result.sessionsCompleted).toBe(0);
    expect(result.trainingHours).toBe(0);
  });
});

// --- players with a baseline / retested ---------------------------------------------------------

describe('playersWithBaseline and playersRetested', () => {
  test('a baseline is one non-skipped result; a retest is two non-skipped results for one test', () => {
    addTests();
    for (const id of ['once', 'twice', 'skipped-only', 'skipped-and-one', 'skipped-and-two', 'two-tests']) addPlayer(id);
    addPlayer('nothing');
    addResult('once', 'juggles', 5);
    addResult('twice', 'juggles', 5);
    addResult('twice', 'juggles', 6);
    addResult('skipped-only', 'juggles', 0, { skipped: true });
    addResult('skipped-only', 'juggles', 0, { skipped: true });
    addResult('skipped-and-one', 'juggles', 0, { skipped: true });
    addResult('skipped-and-one', 'juggles', 7);
    addResult('skipped-and-two', 'juggles', 0, { skipped: true });
    addResult('skipped-and-two', 'juggles', 7);
    addResult('skipped-and-two', 'juggles', 8);
    // one result on each of two tests is two baselines, not a retest of either
    addResult('two-tests', 'juggles', 3);
    addResult('two-tests', 'slalom', 9);

    const result = impact();
    expect(result.playersWithBaseline).toBe(5); // once, twice, skipped-and-one, skipped-and-two, two-tests
    expect(result.playersRetested).toBe(2); // twice, skipped-and-two
  });

  test('a player counts once however many tests or results they have', () => {
    addTests();
    addPlayer('p1');
    addResult('p1', 'juggles', 1);
    addResult('p1', 'juggles', 2);
    addResult('p1', 'juggles', 3);
    addResult('p1', 'slalom', 9);
    addResult('p1', 'slalom', 8);
    const result = impact();
    expect(result.playersWithBaseline).toBe(1);
    expect(result.playersRetested).toBe(1);
  });

  test('a player who retested only a test the catalogue does not know still counts as retested', () => {
    addTests();
    addPair('p1', 'no-such-test', 4, 6);
    const result = impact();
    expect(result.playersRetested).toBe(1);
    expect(result.medianImprovementPct).toBe(0); // no direction, so no pair to take a median over
  });
});

// --- median improvement -------------------------------------------------------------------------

describe('medianImprovementPct', () => {
  test('one higher-is-better pair: (latest - first) / |first| x 100', () => {
    addTests();
    addPair('p1', 'juggles', 10, 12);
    expect(impact().medianImprovementPct).toBeCloseTo(20, 9);
  });

  test('one lower-is-better pair: (first - latest) / |first| x 100, so a faster time is positive', () => {
    addTests();
    addPair('p1', 'slalom', 20, 15);
    expect(impact().medianImprovementPct).toBeCloseTo(25, 9);
  });

  test('regressions are negative in both directions', () => {
    addTests();
    addPair('p1', 'juggles', 10, 8);
    expect(impact().medianImprovementPct).toBeCloseTo(-20, 9);
    db.run('DELETE FROM test_results');
    addResult('p1', 'slalom', 10);
    addResult('p1', 'slalom', 12);
    expect(impact().medianImprovementPct).toBeCloseTo(-20, 9);
  });

  test('the denominator is |first|: a negative first value still reads as its direction', () => {
    addTests();
    addPair('p1', 'juggles', -10, -5); // higher is better: -5 is better than -10, by 50%
    expect(impact().medianImprovementPct).toBeCloseTo(50, 9);
  });

  test('an odd count takes the middle value', () => {
    addTests();
    addPair('a', 'juggles', 100, 110); // 10
    addPair('b', 'juggles', 100, 130); // 30
    addPair('c', 'juggles', 100, 120); // 20
    expect(impact().medianImprovementPct).toBeCloseTo(20, 9);
  });

  test('an even count takes the mean of the two middle values', () => {
    addTests();
    addPair('a', 'juggles', 100, 110); // 10
    addPair('b', 'juggles', 100, 120); // 20
    expect(impact().medianImprovementPct).toBeCloseTo(15, 9);
    addPair('c', 'juggles', 100, 130); // 30
    addPair('d', 'juggles', 100, 200); // 100
    expect(impact().medianImprovementPct).toBeCloseTo(25, 9); // (20 + 30) / 2, not the mean 40
  });

  test('the pairs mix directions: each is corrected on its own', () => {
    addTests();
    addPair('a', 'juggles', 100, 110); // higher: +10
    addPair('b', 'slalom', 100, 70); // lower: +30
    addPair('c', 'slalom', 100, 80); // lower: +20
    expect(impact().medianImprovementPct).toBeCloseTo(20, 9);
  });

  test('compares the FIRST and the LATEST result, not the best or the worst', () => {
    addTests();
    addPlayer('p1');
    addResult('p1', 'juggles', 10);
    addResult('p1', 'juggles', 30);
    addResult('p1', 'juggles', 5);
    addResult('p1', 'juggles', 12);
    expect(impact().medianImprovementPct).toBeCloseTo(20, 9);
  });

  test('first and latest are by recorded_at, not by insertion order', () => {
    addTests();
    addPlayer('p1');
    addResult('p1', 'juggles', 12, { at: '2026-02-03T10:00:00.000Z' }); // latest, inserted first
    addResult('p1', 'juggles', 10, { at: '2026-02-01T10:00:00.000Z' }); // first, inserted second
    expect(impact().medianImprovementPct).toBeCloseTo(20, 9);
  });

  test('skipped results are ignored: neither a skipped first nor a skipped latest counts', () => {
    addTests();
    addPlayer('p1');
    addResult('p1', 'juggles', 0, { skipped: true });
    addResult('p1', 'juggles', 10);
    addResult('p1', 'juggles', 15);
    addResult('p1', 'juggles', 0, { skipped: true });
    expect(impact().medianImprovementPct).toBeCloseTo(50, 9);
  });

  test('a pair whose first value is 0 is left out of the median (no percent of zero)', () => {
    addTests();
    addPair('zero', 'juggles', 0, 5);
    addPair('a', 'juggles', 100, 110); // 10
    addPair('b', 'juggles', 100, 130); // 30
    const result = impact();
    expect(result.medianImprovementPct).toBeCloseTo(20, 9); // over the two real pairs
    expect(Number.isFinite(result.medianImprovementPct)).toBe(true);
    expect(result.playersRetested).toBe(3); // the zero-first player did retest
  });

  test('only a zero-first pair leaves no pair at all: 0, not NaN or null', () => {
    addTests();
    addPair('zero', 'juggles', 0, 5);
    expect(impact().medianImprovementPct).toBe(0);
  });

  test('one player with two tests contributes two pairs', () => {
    addTests();
    addPlayer('p1');
    addResult('p1', 'juggles', 100);
    addResult('p1', 'juggles', 110); // +10
    addResult('p1', 'slalom', 100);
    addResult('p1', 'slalom', 60); // +40
    addPair('p2', 'juggles', 100, 120); // +20
    // pairs 10, 40, 20 -> median 20 (a per-player average of p1 would be 25 -> pairs 25, 20 -> 22.5)
    expect(impact().medianImprovementPct).toBeCloseTo(20, 9);
  });

  test('a player with a single result on a test has no pair for it', () => {
    addTests();
    addPlayer('p1');
    addResult('p1', 'juggles', 100);
    addPair('p2', 'juggles', 100, 150);
    expect(impact().medianImprovementPct).toBeCloseTo(50, 9);
  });
});

// --- sessions and training hours ----------------------------------------------------------------

describe('sessionsCompleted and trainingHours', () => {
  test('sessionsCompleted counts finished sessions only, of any date', () => {
    addSession('p1', ago(400 * DAY));
    addSession('p1', ago(2 * DAY));
    addSession('p2', ago(1 * DAY));
    addSession('p2', null);
    expect(impact().sessionsCompleted).toBe(3);
  });

  test('trainingHours is the minutes of DONE items in FINISHED sessions, over 60, unrounded', () => {
    addSession('p1', ago(DAY), [
      [10, true],
      [20, false], // not done
      [30, true],
    ]);
    addSession('p2', null, [[45, true]]); // done items of an unfinished session do not count
    addSession('p3', ago(2 * DAY), [[60, true]]);
    expect(impact().trainingHours).toBe(100 / 60); // 10 + 30 + 60 = 100 minutes, exact
  });

  test('a finished session with nothing done adds no hours', () => {
    addSession('p1', ago(DAY), [[25, false]]);
    const result = impact();
    expect(result.sessionsCompleted).toBe(1);
    expect(result.trainingHours).toBe(0);
  });

  test('ninety minutes is exactly 1.5 hours', () => {
    addSession('p1', ago(DAY), [[90, true]]);
    expect(impact().trainingHours).toBe(1.5);
  });
});

// --- active contributors ------------------------------------------------------------------------

describe('activeContributors (submitted in the last 90 days, inclusive)', () => {
  test('counts distinct submitters, once each however many contributions', () => {
    addContribution('u1', ago(1 * DAY));
    addContribution('u1', ago(2 * DAY));
    addContribution('u2', ago(60 * DAY));
    expect(impact().activeContributors).toBe(2);
  });

  test('the window is exactly 90 days: 90 days ago is in, one millisecond earlier is out', () => {
    addContribution('in-edge', ago(90 * DAY));
    addContribution('out-edge', ago(90 * DAY + 1));
    addContribution('in-30', ago(30 * DAY));
    addContribution('out-120', ago(120 * DAY));
    addContribution('out-365', ago(365 * DAY));
    expect(impact().activeContributors).toBe(2); // in-edge, in-30
  });

  test('a submitter with an old and a recent contribution is active; one with only old ones is not', () => {
    addContribution('u1', ago(200 * DAY));
    addContribution('u1', ago(5 * DAY));
    addContribution('u2', ago(200 * DAY));
    expect(impact().activeContributors).toBe(1);
  });

  test('the window follows the injected now', () => {
    addContribution('u1', '2026-01-01T00:00:00.000Z');
    expect(impact(new Date('2026-03-01T00:00:00.000Z')).activeContributors).toBe(1);
    expect(impact(new Date('2026-06-01T00:00:00.000Z')).activeContributors).toBe(0);
  });
});

// --- verified coaches and open methodologies ----------------------------------------------------

describe('verifiedCoaches', () => {
  test('distinct reviewers on rows whose to-status is REVIEWED, EXPERT_VERIFIED or ACADEMY_VERIFIED', () => {
    const v = addDrill();
    addReview(v, 'u-reviewed', 'A', 'COMMUNITY', 'REVIEWED');
    addReview(v, 'u-expert', 'B', 'REVIEWED', 'EXPERT_VERIFIED');
    addReview(v, 'u-academy', 'C', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED');
    addReview(v, 'u-demoter', 'D', 'ACADEMY_VERIFIED', 'COMMUNITY'); // to COMMUNITY: not a verification
    expect(impact().verifiedCoaches).toBe(3);
  });

  test('a reviewer with several rows counts once', () => {
    const v = addDrill();
    addReview(v, 'u1', 'A', 'COMMUNITY', 'REVIEWED');
    addReview(v, 'u1', 'A', 'REVIEWED', 'EXPERT_VERIFIED');
    addReview(v, 'u1', 'A', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED');
    expect(impact().verifiedCoaches).toBe(1);
  });

  test('a reviewer who also demoted still counts through their REVIEWED+ row', () => {
    const v = addDrill();
    addReview(v, 'u1', 'A', 'COMMUNITY', 'REVIEWED');
    addReview(v, 'u1', 'A', 'REVIEWED', 'COMMUNITY');
    expect(impact().verifiedCoaches).toBe(1);
  });

  test('a row without a reviewer user id is one reviewer per distinct name (a seeded review has no account)', () => {
    const v = addDrill();
    addReview(v, null, 'Seed Coach', 'COMMUNITY', 'REVIEWED');
    addReview(v, null, 'Seed Coach', 'REVIEWED', 'EXPERT_VERIFIED');
    addReview(v, null, 'Other Coach', 'COMMUNITY', 'REVIEWED');
    addReview(v, 'u1', 'Seed Coach', 'COMMUNITY', 'REVIEWED');
    expect(impact().verifiedCoaches).toBe(3);
  });

  test('no review rows: 0', () => {
    addDrill();
    expect(impact().verifiedCoaches).toBe(0);
  });
});

describe('openMethodologies', () => {
  test('counts published drills: not unpublished, linked to their current version', () => {
    addDrill();
    addDrill();
    addDrill({ published: false });
    addDrill({ linked: false });
    expect(impact().openMethodologies).toBe(2);
  });
});

// --- weekly series ------------------------------------------------------------------------------

describe('byWeek', () => {
  const week = (start: string) => impact().byWeek.find((w) => w.weekStart === start)?.sessionsCompleted;

  test('12 weekly buckets ascending, each starting on a Monday (UTC), the last being now\'s week', () => {
    const { byWeek } = impact();
    expect(byWeek).toHaveLength(12);
    expect(byWeek[0]?.weekStart).toBe('2025-12-22');
    expect(byWeek[11]?.weekStart).toBe('2026-03-09');
    for (const [i, w] of byWeek.entries()) {
      expect(new Date(`${w.weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
      if (i > 0) expect(Date.parse(w.weekStart) - Date.parse(byWeek[i - 1]!.weekStart)).toBe(7 * DAY);
    }
  });

  test('a session is counted in the Monday-based week of its finished_at', () => {
    addSession('p1', '2026-03-09T00:00:00.000Z'); // Monday 00:00 -> week of 03-09
    addSession('p1', '2026-03-08T23:59:59.999Z'); // Sunday 23:59:59.999 -> week of 03-02
    addSession('p1', '2026-03-02T00:00:00.000Z'); // Monday -> week of 03-02
    addSession('p1', '2026-03-04T15:00:00.000Z'); // Wednesday -> week of 03-02
    addSession('p1', '2026-03-10T09:00:00.000Z'); // Tuesday this week -> week of 03-09
    expect(week('2026-03-09')).toBe(2);
    expect(week('2026-03-02')).toBe(3);
    expect(week('2026-02-23')).toBe(0);
  });

  test('a Sunday belongs to the week that ends on it (the week does not start on Sunday)', () => {
    addSession('p1', '2026-03-01T12:00:00.000Z'); // Sunday 03-01 -> week of 02-23
    expect(week('2026-02-23')).toBe(1);
    expect(week('2026-03-02')).toBe(0);
  });

  test('the first bucket starts at its Monday 00:00; a session a millisecond earlier is outside the series', () => {
    addSession('p1', '2025-12-22T00:00:00.000Z');
    addSession('p1', '2025-12-21T23:59:59.999Z');
    const { byWeek, sessionsCompleted } = impact();
    expect(byWeek[0]).toEqual({ weekStart: '2025-12-22', sessionsCompleted: 1 });
    expect(byWeek.reduce((sum, w) => sum + w.sessionsCompleted, 0)).toBe(1);
    expect(sessionsCompleted).toBe(2); // the all-time counter still has it
  });

  test('a session finished in a later week than now is not in the series', () => {
    addSession('p1', '2026-03-16T00:00:00.000Z'); // next Monday
    expect(impact().byWeek.reduce((sum, w) => sum + w.sessionsCompleted, 0)).toBe(0);
  });

  test('unfinished sessions are not counted', () => {
    addSession('p1', null);
    expect(impact().byWeek.reduce((sum, w) => sum + w.sessionsCompleted, 0)).toBe(0);
  });

  test('weeks with no sessions are zero-filled between weeks that have some', () => {
    addSession('p1', '2025-12-23T10:00:00.000Z');
    addSession('p1', '2026-03-10T10:00:00.000Z');
    const counts = impact().byWeek.map((w) => w.sessionsCompleted);
    expect(counts).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  test('the series follows the injected now: Sunday 23:59:59.999 is still this week, Monday 00:00 is the next', () => {
    const sunday = impact(new Date('2026-03-15T23:59:59.999Z')).byWeek;
    expect(sunday[11]?.weekStart).toBe('2026-03-09');
    expect(sunday[0]?.weekStart).toBe('2025-12-22');
    const monday = impact(new Date('2026-03-16T00:00:00.000Z')).byWeek;
    expect(monday[11]?.weekStart).toBe('2026-03-16');
    expect(monday[0]?.weekStart).toBe('2025-12-29');
  });
});

// --- privacy ------------------------------------------------------------------------------------

/** Ids and names that must never leave the server. Distinctive, so a substring match cannot be an accident. */
const SECRETS = {
  players: ['player-zx81-secret', 'player-qk77-secret'],
  submitter: 'submitter-user-9f3a',
  reviewer: 'reviewer-user-4c1d',
  reviewerName: 'Reviewer Nameson',
};

/** Rows recent relative to `now`: the route reads the real clock, computeImpact the injected NOW. */
function seedEverything(now: Date = NOW): void {
  const recent = iso(now.getTime() - DAY);
  addTests();
  addPair(SECRETS.players[0]!, 'juggles', 10, 15);
  addPair(SECRETS.players[1]!, 'slalom', 20, 10);
  addSession(SECRETS.players[0]!, recent, [[30, true]]);
  addContribution(SECRETS.submitter, recent);
  const v = addDrill();
  addReview(v, SECRETS.reviewer, SECRETS.reviewerName, 'COMMUNITY', 'REVIEWED');
}

describe('privacy: aggregates only', () => {
  test('the serialised result carries no player id, user id or reviewer name', () => {
    seedEverything();
    const text = JSON.stringify(impact());
    for (const secret of [...SECRETS.players, SECRETS.submitter, SECRETS.reviewer, SECRETS.reviewerName]) {
      expect(text).not.toContain(secret);
    }
    // sanity: the data was really counted, so the absence above is not an empty result
    const result = impact();
    expect(result.playersWithBaseline).toBe(2);
    expect(result.activeContributors).toBe(1);
    expect(result.verifiedCoaches).toBe(1);
  });

  test('every value is a number or the weekly series: nothing else can carry a row', () => {
    seedEverything();
    const { byWeek, ...scalars } = impact();
    for (const value of Object.values(scalars)) expect(typeof value).toBe('number');
    for (const w of byWeek) expect(Object.keys(w).sort()).toEqual(['sessionsCompleted', 'weekStart']);
  });
});

// --- GET /api/admin/impact ----------------------------------------------------------------------

describe('GET /api/admin/impact', () => {
  const ROUTES_DIR_FILES = ['admin-impact.routes.ts', 'auth.routes.ts'] as const;
  const ROUTES_SOURCE_DIR = resolve(import.meta.dir, '../http/routes');
  const DEV_ORIGIN = 'http://localhost:4111'; // the dev default BETTER_AUTH_URL
  const PASSWORD = 'correct-horse-battery';
  const PATH = ENDPOINTS.getImpact.path;
  const ENV_KEYS = ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'BETTER_AUTH_TRUSTED_ORIGINS'] as const;

  let dir: string;
  let app: Hono;
  const savedEnv: Record<string, string | undefined> = {};

  /** A real createApp that mounts only the route under test and the real Better Auth handler. */
  async function buildApp(): Promise<Hono> {
    const routesDir = join(dir, 'routes');
    mkdirSync(routesDir, { recursive: true });
    for (const file of ROUTES_DIR_FILES) {
      writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(ROUTES_SOURCE_DIR, file))};\n`);
    }
    const deps: AppDeps = { db, version: 'test' };
    return createApp(deps, routesDir, { webDist: join(dir, 'no-dist') });
  }

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), 'admin-impact-routes-'));
    app = await buildApp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: DEV_ORIGIN },
      body: JSON.stringify(body),
    });

  /** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
  const cookieOf = (res: Response): string =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

  type Actor = { cookie: string; id: string };

  async function signInAnonymous(): Promise<Actor> {
    const res = await post('/api/auth/sign-in/anonymous', {});
    const body = (await res.json()) as { user: { id: string } };
    return { cookie: cookieOf(res), id: body.user.id };
  }

  async function signUp(email: string): Promise<Actor> {
    const res = await post('/api/auth/sign-up/email', { name: 'Coach', email, password: PASSWORD });
    const body = (await res.json()) as { user: { id: string } };
    return { cookie: cookieOf(res), id: body.user.id };
  }

  async function signUpAdmin(): Promise<Actor> {
    const actor = await signUp('boss@example.com');
    db.run(`UPDATE user SET role = 'admin' WHERE id = ?`, [actor.id]);
    return actor;
  }

  const get = (cookie?: string) => app.request(PATH, { headers: cookie ? { cookie } : {} });

  test('the route serves the contract path and method', () => {
    expect(ENDPOINTS.getImpact.method).toBe('GET');
    expect(PATH).toBe('/api/admin/impact');
  });

  test('no cookie is a 401 problem+json', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  test('a forged session cookie is a 401', async () => {
    const res = await get('better-auth.session_token=Zm9yZ2VkLXRva2Vu.Zm9yZ2VkLXNpZ25hdHVyZQ');
    expect(res.status).toBe(401);
  });

  test('a signed-in contributor is a 403 and no metrics leak in the body', async () => {
    seedEverything();
    const contributor = await signUp('contrib@example.com');
    const res = await get(contributor.cookie);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.text()).not.toContain('playersWithBaseline');
  });

  test('an anonymous player is a 403', async () => {
    const player = await signInAnonymous();
    const res = await get(player.cookie);
    expect(res.status).toBe(403);
  });

  test('an admin gets 200 and a body the contract parses; zero data is all zeros', async () => {
    const admin = await signUpAdmin();
    const res = await get(admin.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = ImpactMetrics.parse(await res.json());
    expect(body).toMatchObject({
      playersWithBaseline: 0,
      playersRetested: 0,
      medianImprovementPct: 0,
      sessionsCompleted: 0,
      trainingHours: 0,
      verifiedCoaches: 0,
      openMethodologies: 0,
    });
    expect(body.byWeek).toHaveLength(12);
    expect(body.byWeek.every((w) => w.sessionsCompleted === 0)).toBe(true);
  });

  test('an admin reads the database: the numbers are what the rows say', async () => {
    addTests();
    addPair('p-a', 'juggles', 100, 110); // +10
    addPair('p-b', 'slalom', 100, 70); // lower: +30
    addPlayer('p-solo');
    addResult('p-solo', 'juggles', 5);
    addSession('p-a', new Date().toISOString(), [[90, true]]);
    addDrill();
    const admin = await signUpAdmin();

    const res = await get(admin.cookie);
    expect(res.status).toBe(200);
    const body = ImpactMetrics.parse(await res.json());
    expect(body.playersWithBaseline).toBe(3);
    expect(body.playersRetested).toBe(2);
    expect(body.medianImprovementPct).toBeCloseTo(20, 9);
    expect(body.sessionsCompleted).toBe(1);
    expect(body.trainingHours).toBe(1.5);
    expect(body.openMethodologies).toBe(1);
    expect(body.byWeek[11]?.sessionsCompleted).toBe(1); // finished just now: this week, the last bucket
  });

  test('the response body carries no player id, user id or reviewer name', async () => {
    seedEverything(new Date());
    const admin = await signUpAdmin();
    const contributor = await signUp('contrib2@example.com');
    addContribution(contributor.id, new Date(Date.now() - DAY).toISOString());
    const res = await get(admin.cookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of [...SECRETS.players, SECRETS.submitter, SECRETS.reviewer, SECRETS.reviewerName, admin.id, contributor.id]) {
      expect(text).not.toContain(secret);
    }
    expect(ImpactMetrics.parse(JSON.parse(text)).activeContributors).toBe(2);
  });
});
