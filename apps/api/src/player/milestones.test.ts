import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadSeed } from '../commons/seed-loader';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { Milestone } from '../shared/journey';
import type { SessionEvent } from '../shared/session';
import { ingestEvents, progressSummary } from './events';
import { milestones } from './milestones';

// Every test runs against a real migrated :memory: database (001-006) with the shipped football seed
// (skill_tests carry the units and thresholds the rules read) and real player, session, event and
// test-result rows. Player rows are wiped between tests (the FKs cascade).
//
// The seed numbers the tests stand on (config/commons/football/tests.json):
//   ball-mastery-30s, juggling-max-touches: unit 'touches'; slalom-time: unit 's'; wall-passing-60s: 'passes'
//   weak-foot-passes (track weak-foot, higher is better), level-2 boundary t2 per age band:
//     upTo9 (age <= 9): 2    from10to13 (10..13): 3    from14 (>= 14): 4
//
// Readings the tests pin (see milestones.ts):
//   * a milestone is EARNED ONCE: its date is the `at` of the event at which the replay first crossed the
//     threshold, and a later undo or a worse result does not take it back;
//   * a training day is a local calendar day on which a session was finished (the reading of events.ts's streak);
//   * touches are the `value` of non-skipped test results of tests whose unit is 'touches'.

const SEED_DIR = resolve(import.meta.dir, '../../../../config/commons');

const BALL_MASTERY = 'ball-mastery-30s';
const JUGGLING = 'juggling-max-touches';
const SLALOM = 'slalom-time';
const WEAK_FOOT = 'weak-foot-passes';

let db: Database;
let seq: number;
let sessionSeq: number;

/** A lower-case RFC 4122 v4 UUID, distinct per n. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** An instant in January 2026 (day may overflow into February), canonical ISO UTC. */
const at = (day: number, hour = 10, minute = 0): string => new Date(Date.UTC(2026, 0, day, hour, minute)).toISOString();

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.run('DELETE FROM player_profiles');
  seq = 0;
  sessionSeq = 0;
  addProfile('p1');
});

function addProfile(playerId: string, age = 12): void {
  db.run(
    `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
     VALUES (?, ?, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, 'ru')`,
    [playerId, age],
  );
}

/** Session items per the contract's TodayItem (the fields the milestones read, plus extras). */
function itemsJson(minutes: readonly number[]): string {
  return JSON.stringify(
    minutes.map((m, i) => ({ itemId: `i${i + 1}`, drillVersionId: `drill-${i + 1}@1.0.0`, minutes: m, done: false, content: { goal: { en: 'g' } } })),
  );
}

/** One session row; ids are unique per call, dates too (UNIQUE (player_id, date)). */
function addSession(playerId: string, minutes: readonly number[] = [10, 20, 30]): string {
  sessionSeq += 1;
  const id = `s${sessionSeq}`;
  const date = new Date(Date.UTC(2025, 0, 1) + 86_400_000 * sessionSeq).toISOString().slice(0, 10);
  db.run('INSERT INTO sessions (id, player_id, date, planner, graph_version, items) VALUES (?, ?, ?, ?, ?, ?)', [id, playerId, date, 'rules', '1.0.0', itemsJson(minutes)]);
  return id;
}

/** One raw event row, in insertion (id) order; `at` is canonical UTC as the writers store it. */
function addEvent(playerId: string, sessionId: string, type: SessionEvent['type'], when: string, extra: { itemId?: string; value?: number } = {}): void {
  seq += 1;
  db.run('INSERT INTO session_events (player_id, session_id, client_uuid, type, item_id, value, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    playerId,
    sessionId,
    uuid(seq),
    type,
    extra.itemId ?? null,
    extra.value ?? null,
    when,
  ]);
}

/** A session (own row) finished at each given instant. */
function finishSessionsAt(playerId: string, instants: readonly string[]): string[] {
  return instants.map((when) => {
    const id = addSession(playerId);
    addEvent(playerId, id, 'session_finished', when);
    return id;
  });
}

function addResult(playerId: string, testSlug: string, value: number, recordedAt: string, extra: { skipped?: boolean; errors?: number } = {}): void {
  seq += 1;
  db.run('INSERT INTO test_results (player_id, test_slug, value, errors, skipped, recorded_at, client_uuid) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    playerId,
    testSlug,
    value,
    extra.errors ?? null,
    extra.skipped === true ? 1 : 0,
    recordedAt,
    uuid(seq),
  ]);
}

const keys = (ms: ReadonlyArray<{ key: string }>): string[] => ms.map((m) => m.key);
const achieved = (playerId: string, key: string, opts?: { timeZone?: string }): string | undefined =>
  milestones(db, playerId, opts).find((m) => m.key === key)?.achievedAt;
const rowCounts = (): unknown => ({
  sessions: db.query('SELECT * FROM sessions ORDER BY id').all(),
  events: db.query('SELECT * FROM session_events ORDER BY id').all(),
  results: db.query('SELECT * FROM test_results ORDER BY id').all(),
});

describe('milestones: shape', () => {
  test('a player with no data has no milestones', () => {
    expect(milestones(db, 'p1')).toEqual([]);
  });

  test('a player id that has no profile has no milestones', () => {
    expect(milestones(db, 'nobody')).toEqual([]);
  });

  test('a session with drills started but not finished, and no results, earns nothing', () => {
    const s = addSession('p1', [150, 150]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'drill_undone', at(2), { itemId: 'i1' });
    expect(milestones(db, 'p1')).toEqual([]);
  });

  test('the output parses with the contract schema, unchanged, and every entry carries its date', () => {
    finishSessionsAt('p1', [at(1)]);
    addResult('p1', BALL_MASTERY, 1000, at(2));
    addResult('p1', BALL_MASTERY, 1, at(3));
    const out = milestones(db, 'p1');
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(z.array(Milestone).parse(out)).toEqual(out);
    for (const m of out) expect(m.achievedAt).toBeDefined();
  });

  test('reading is derived: it writes nothing and is repeatable', () => {
    finishSessionsAt('p1', [at(1)]);
    addResult('p1', BALL_MASTERY, 1000, at(2));
    const before = rowCounts();
    const first = milestones(db, 'p1');
    expect(milestones(db, 'p1')).toEqual(first);
    expect(rowCounts()).toEqual(before);
  });
});

describe('FIRST_SESSION', () => {
  test('is the earliest session_finished, whatever order the rows arrived in', () => {
    const [a, b] = [addSession('p1'), addSession('p1')];
    addEvent('p1', b, 'session_finished', at(5)); // arrives first, is later
    addEvent('p1', a, 'session_finished', at(3));
    expect(achieved('p1', 'FIRST_SESSION')).toBe(at(3));
  });

  test('a second session_finished for the same session and a later session do not move it', () => {
    const [a, b] = [addSession('p1'), addSession('p1')];
    addEvent('p1', a, 'session_finished', at(3));
    addEvent('p1', a, 'session_finished', at(4));
    addEvent('p1', b, 'session_finished', at(6));
    expect(achieved('p1', 'FIRST_SESSION')).toBe(at(3));
  });

  test('drill and result events alone do not finish a session', () => {
    const s = addSession('p1');
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'result', at(1), { value: 7 });
    expect(keys(milestones(db, 'p1'))).not.toContain('FIRST_SESSION');
  });

  test("another player's finished session is not mine", () => {
    addProfile('p2');
    finishSessionsAt('p2', [at(1)]);
    expect(milestones(db, 'p1')).toEqual([]);
  });
});

describe('TEN_TRAINING_DAYS', () => {
  const nineDays = (): string[] => Array.from({ length: 9 }, (_, i) => at(i + 1));

  test('9 distinct days: not yet; the 10th day earns it, dated at the finish that made the tenth day', () => {
    finishSessionsAt('p1', nineDays());
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBeUndefined();
    finishSessionsAt('p1', [at(10, 8)]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBe(at(10, 8));
  });

  test('days are distinct: many finishes on 9 days are still 9 days', () => {
    finishSessionsAt('p1', [...nineDays(), at(1, 15), at(2, 15), at(3, 15), at(9, 23)]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBeUndefined();
  });

  test('the date is the first crossing, not a later day', () => {
    finishSessionsAt('p1', [...nineDays(), at(10), at(11), at(12)]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBe(at(10));
  });

  test('arrival order does not matter: the tenth day is found by time', () => {
    finishSessionsAt('p1', [at(10), at(9), at(8), at(7), at(6), at(5), at(4), at(3), at(2), at(1), at(20)]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBe(at(10));
  });

  test('a re-finished session counts its earliest finish only (one day, not two)', () => {
    const ids = finishSessionsAt('p1', nineDays());
    addEvent('p1', ids[0]!, 'session_finished', at(10)); // the same session again, on a new day: no un-finish, no new day
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBeUndefined();
  });

  test('a day is a local day: the day boundary of a non-UTC zone', () => {
    // 8 UTC days at 10:00, then two finishes on Jan 9 at 18:30Z and 19:30Z.
    // UTC: nine days (Jan 1-9). Asia/Almaty (UTC+5): 23:30 Jan 9 and 00:30 Jan 10 are two days: ten.
    const days = Array.from({ length: 8 }, (_, i) => at(i + 1));
    finishSessionsAt('p1', [...days, at(9, 18, 30), at(9, 19, 30)]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBeUndefined();
    expect(achieved('p1', 'TEN_TRAINING_DAYS', { timeZone: 'UTC' })).toBeUndefined();
    expect(achieved('p1', 'TEN_TRAINING_DAYS', { timeZone: 'Asia/Almaty' })).toBe(at(9, 19, 30));
  });

  test('a zone can also merge two UTC days into one local day', () => {
    // Jan 1 23:30Z and Jan 2 00:30Z are two UTC days but one day in America/New_York (18:30 and 19:30, Jan 1).
    const days = Array.from({ length: 8 }, (_, i) => at(i + 3)); // Jan 3-10: eight days
    finishSessionsAt('p1', [at(1, 23, 30), at(2, 0, 30), ...days]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBe(at(10)); // UTC: Jan 1, 2, 3..10 = ten
    expect(achieved('p1', 'TEN_TRAINING_DAYS', { timeZone: 'America/New_York' })).toBeUndefined(); // nine
  });

  test('an invalid time zone means UTC', () => {
    const days = Array.from({ length: 8 }, (_, i) => at(i + 1));
    finishSessionsAt('p1', [...days, at(9, 18, 30), at(9, 19, 30)]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS', { timeZone: 'Not/AZone' })).toBeUndefined();
  });

  test("another player's days are not mine", () => {
    addProfile('p2');
    finishSessionsAt('p1', nineDays());
    finishSessionsAt('p2', [at(10), at(11), at(12)]);
    expect(achieved('p1', 'TEN_TRAINING_DAYS')).toBeUndefined();
  });
});

describe('FIVE_HOURS_TRAINED', () => {
  test('299 minutes of done items: not yet; 300: earned, dated at the drill_done that crossed it', () => {
    const s = addSession('p1', [150, 149, 1]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'drill_done', at(2), { itemId: 'i2' });
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBeUndefined(); // 299
    addEvent('p1', s, 'drill_done', at(3), { itemId: 'i3' });
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBe(at(3)); // 300
  });

  test('items that were not done, or were finished but never ticked, add nothing', () => {
    const s = addSession('p1', [300]);
    addEvent('p1', s, 'session_finished', at(1));
    addEvent('p1', s, 'result', at(1), { itemId: 'i1', value: 5 });
    expect(keys(milestones(db, 'p1'))).not.toContain('FIVE_HOURS_TRAINED');
  });

  test('an undone drill is not counted: done then undone before the threshold lowers the count', () => {
    const s = addSession('p1', [150, 149, 1]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'drill_done', at(2), { itemId: 'i2' });
    addEvent('p1', s, 'drill_undone', at(3), { itemId: 'i2' }); // 150
    addEvent('p1', s, 'drill_done', at(4), { itemId: 'i3' }); // 151
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBeUndefined();
    addEvent('p1', s, 'drill_done', at(5), { itemId: 'i2' }); // 300 again
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBe(at(5));
  });

  test('a drill ticked twice counts once', () => {
    const s = addSession('p1', [150, 149]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'drill_done', at(2), { itemId: 'i1' });
    addEvent('p1', s, 'drill_done', at(3), { itemId: 'i2' });
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBeUndefined(); // 299, not 449
  });

  test('replays in (at, id) order, not arrival order: an older undo that arrives late still comes first', () => {
    const s = addSession('p1', [150, 150]);
    addEvent('p1', s, 'drill_done', at(2), { itemId: 'i1' });
    addEvent('p1', s, 'drill_undone', at(1), { itemId: 'i1' }); // older, arrives later: applied first, then the done wins
    addEvent('p1', s, 'drill_done', at(3), { itemId: 'i2' });
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBe(at(3));
  });

  test('same `at`: the smaller id is applied first', () => {
    const s = addSession('p1', [150, 150]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' }); // id 1: 150
    addEvent('p1', s, 'drill_undone', at(1), { itemId: 'i1' }); // id 2: 0
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i2' }); // id 3: 150 (in reverse id order it would be 300)
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBeUndefined();
  });

  test('minutes add up across sessions, and the date is the first crossing, not a later one', () => {
    const [a, b] = [addSession('p1', [100, 100]), addSession('p1', [100, 100])];
    addEvent('p1', a, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', a, 'drill_done', at(1, 11), { itemId: 'i2' });
    addEvent('p1', b, 'drill_done', at(2), { itemId: 'i1' });
    addEvent('p1', b, 'drill_done', at(3), { itemId: 'i2' }); // 400
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBe(at(2));
  });

  test('earned once: an undo after the crossing does not take the date back', () => {
    const s = addSession('p1', [150, 150]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'drill_done', at(2), { itemId: 'i2' });
    addEvent('p1', s, 'drill_undone', at(3), { itemId: 'i2' });
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBe(at(2));
  });

  test('an event for an item the session does not have changes nothing', () => {
    const s = addSession('p1', [150, 149]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'drill_done', at(2), { itemId: 'i2' });
    addEvent('p1', s, 'drill_done', at(3), { itemId: 'ghost' });
    addEvent('p1', s, 'drill_done', at(4)); // no itemId
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBeUndefined();
  });

  test("another player's minutes are not mine", () => {
    addProfile('p2');
    const mine = addSession('p1', [100]);
    addEvent('p1', mine, 'drill_done', at(1), { itemId: 'i1' });
    const theirs = addSession('p2', [250]);
    addEvent('p2', theirs, 'drill_done', at(2), { itemId: 'i1' });
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBeUndefined();
    expect(achieved('p2', 'FIVE_HOURS_TRAINED')).toBeUndefined(); // 250 < 300, and not 350 either
  });

  test('agrees with the stored progress: the ingested log reaches 300 minutes exactly when the milestone appears', () => {
    const now = new Date('2026-03-10T12:00:00.000Z');
    const s = addSession('p1', [150, 149, 1]);
    const ev = (type: SessionEvent['type'], n: number, extra: Partial<SessionEvent> = {}): SessionEvent => ({
      clientUuid: uuid(900 + n),
      sessionId: s,
      type,
      at: new Date(now.getTime() - 3_600_000 + n * 60_000).toISOString(),
      ...extra,
    });
    const first = ingestEvents(db, 'p1', [ev('drill_done', 1, { itemId: 'i1' }), ev('drill_done', 2, { itemId: 'i2' })], { now: () => now });
    expect(first.minutesTrained).toBe(299);
    expect(keys(milestones(db, 'p1'))).not.toContain('FIVE_HOURS_TRAINED');
    const second = ingestEvents(db, 'p1', [ev('drill_done', 3, { itemId: 'i3' }), ev('session_finished', 4)], { now: () => now });
    expect(second.minutesTrained).toBe(300);
    expect(progressSummary(db, 'p1', { now: () => now }).sessionsCompleted).toBe(1);
    expect(achieved('p1', 'FIVE_HOURS_TRAINED')).toBe(new Date(now.getTime() - 3_600_000 + 3 * 60_000).toISOString());
    expect(achieved('p1', 'FIRST_SESSION')).toBe(new Date(now.getTime() - 3_600_000 + 4 * 60_000).toISOString());
  });
});

describe('THOUSAND_TOUCHES', () => {
  test('999 touches: not yet; 1000: earned, dated at the result that crossed it', () => {
    addResult('p1', BALL_MASTERY, 600, at(1));
    addResult('p1', JUGGLING, 399, at(2));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBeUndefined();
    addResult('p1', BALL_MASTERY, 1, at(3));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBe(at(3));
  });

  test('the date is the first crossing, not a later result', () => {
    addResult('p1', BALL_MASTERY, 1000, at(1));
    addResult('p1', JUGGLING, 500, at(2));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBe(at(1));
  });

  test('sums both ball-mastery and juggling results: either alone is not enough', () => {
    addResult('p1', BALL_MASTERY, 500, at(1));
    addResult('p1', BALL_MASTERY, 400, at(2));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBeUndefined(); // 900
    addResult('p1', JUGGLING, 100, at(3));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBe(at(3));
  });

  test('tests measured in other units (seconds, passes) are not touches', () => {
    addResult('p1', SLALOM, 5000, at(1));
    addResult('p1', 'wall-passing-60s', 5000, at(2));
    addResult('p1', WEAK_FOOT, 9, at(3));
    addResult('p1', BALL_MASTERY, 999, at(4));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBeUndefined();
  });

  test('a skipped result measured nothing and adds nothing', () => {
    addResult('p1', BALL_MASTERY, 999, at(1));
    addResult('p1', JUGGLING, 500, at(2), { skipped: true });
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBeUndefined();
  });

  test('results are replayed by recorded_at, not by arrival', () => {
    addResult('p1', BALL_MASTERY, 500, at(5)); // arrives first, is later
    addResult('p1', JUGGLING, 500, at(3));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBe(at(5));
  });

  test("another player's touches are not mine", () => {
    addProfile('p2');
    addResult('p1', BALL_MASTERY, 600, at(1));
    addResult('p2', BALL_MASTERY, 600, at(2));
    expect(achieved('p1', 'THOUSAND_TOUCHES')).toBeUndefined();
    expect(achieved('p2', 'THOUSAND_TOUCHES')).toBe(at(2));
  });
});

describe('WEAK_FOOT_LEVEL_2', () => {
  // [age, value, level 2 reached?]: the t2 boundary of the age band, one below and at it.
  const edges: Array<[number, number, boolean]> = [
    [9, 1, false],
    [9, 2, true],
    [10, 2, false],
    [10, 3, true],
    [13, 2, false],
    [13, 3, true],
    [14, 3, false],
    [14, 4, true],
  ];

  test.each(edges)('age %i, %i successful passes: level 2 reached = %p', (age, value, reached) => {
    addProfile('young', age);
    addResult('young', WEAK_FOOT, value, at(1));
    expect(achieved('young', 'WEAK_FOOT_LEVEL_2')).toBe(reached ? at(1) : undefined);
  });

  test('the date is the first result that reached level 2, not the latest', () => {
    addResult('p1', WEAK_FOOT, 2, at(1)); // age 12: level 1
    addResult('p1', WEAK_FOOT, 3, at(2)); // level 2
    addResult('p1', WEAK_FOOT, 5, at(3)); // higher
    expect(achieved('p1', 'WEAK_FOOT_LEVEL_2')).toBe(at(2));
  });

  test('earned once: a later, worse result does not take it back', () => {
    addResult('p1', WEAK_FOOT, 3, at(1));
    addResult('p1', WEAK_FOOT, 1, at(2));
    expect(achieved('p1', 'WEAK_FOOT_LEVEL_2')).toBe(at(1));
  });

  test('results are replayed by recorded_at, not by arrival', () => {
    addResult('p1', WEAK_FOOT, 4, at(5)); // arrives first, is later
    addResult('p1', WEAK_FOOT, 3, at(2));
    expect(achieved('p1', 'WEAK_FOOT_LEVEL_2')).toBe(at(2));
  });

  test('a skipped result and results of other tests do not count', () => {
    addResult('p1', WEAK_FOOT, 9, at(1), { skipped: true });
    addResult('p1', JUGGLING, 90, at(2));
    addResult('p1', BALL_MASTERY, 90, at(3));
    expect(keys(milestones(db, 'p1'))).not.toContain('WEAK_FOOT_LEVEL_2');
  });

  test("another player's results are not mine, and each is judged by their own age band", () => {
    addProfile('older', 14);
    addResult('older', WEAK_FOOT, 3, at(1)); // level 1 for age 14
    addResult('p1', WEAK_FOOT, 3, at(2)); // level 2 for age 12
    expect(achieved('older', 'WEAK_FOOT_LEVEL_2')).toBeUndefined();
    expect(achieved('p1', 'WEAK_FOOT_LEVEL_2')).toBe(at(2));
  });
});

describe('FIRST_RETEST', () => {
  test('one result per test is a baseline, not a retest; the second result of the same test is', () => {
    addResult('p1', BALL_MASTERY, 10, at(1));
    addResult('p1', JUGGLING, 10, at(2));
    addResult('p1', SLALOM, 12, at(3));
    expect(achieved('p1', 'FIRST_RETEST')).toBeUndefined();
    addResult('p1', JUGGLING, 12, at(4));
    expect(achieved('p1', 'FIRST_RETEST')).toBe(at(4));
  });

  test('the date is the second result, not the third or later', () => {
    addResult('p1', SLALOM, 12, at(1));
    addResult('p1', SLALOM, 11, at(2));
    addResult('p1', SLALOM, 10, at(3));
    expect(achieved('p1', 'FIRST_RETEST')).toBe(at(2));
  });

  test('the earliest second result across tests wins', () => {
    addResult('p1', SLALOM, 12, at(1));
    addResult('p1', JUGGLING, 5, at(2));
    addResult('p1', JUGGLING, 6, at(3));
    addResult('p1', SLALOM, 11, at(4));
    expect(achieved('p1', 'FIRST_RETEST')).toBe(at(3));
  });

  test('results are replayed by recorded_at, not by arrival', () => {
    addResult('p1', SLALOM, 12, at(5));
    addResult('p1', SLALOM, 11, at(3));
    addResult('p1', SLALOM, 10, at(9));
    expect(achieved('p1', 'FIRST_RETEST')).toBe(at(5));
  });

  test('a skipped result is not a measurement: a skipped baseline makes the next result a first, not a retest', () => {
    addResult('p1', SLALOM, 0, at(1), { skipped: true });
    addResult('p1', SLALOM, 12, at(2));
    expect(achieved('p1', 'FIRST_RETEST')).toBeUndefined();
  });

  test("another player's result of the same test is not my retest", () => {
    addProfile('p2');
    addResult('p1', SLALOM, 12, at(1));
    addResult('p2', SLALOM, 11, at(2));
    expect(achieved('p1', 'FIRST_RETEST')).toBeUndefined();
  });
});

describe('ordering', () => {
  test('sorted by achieved date, then by key', () => {
    // FIRST_RETEST and THOUSAND_TOUCHES both cross at the same result (day 3); FIRST_SESSION is later (day 8).
    addResult('p1', BALL_MASTERY, 500, at(2));
    addResult('p1', BALL_MASTERY, 500, at(3));
    finishSessionsAt('p1', [at(8)]);
    const out = milestones(db, 'p1');
    expect(out).toEqual([
      { key: 'FIRST_RETEST', achievedAt: at(3) },
      { key: 'THOUSAND_TOUCHES', achievedAt: at(3) },
      { key: 'FIRST_SESSION', achievedAt: at(8) },
    ]);
  });

  test('an earlier date sorts before an alphabetically earlier key', () => {
    finishSessionsAt('p1', [at(1)]); // FIRST_SESSION on day 1
    addResult('p1', SLALOM, 12, at(2));
    addResult('p1', SLALOM, 11, at(3)); // FIRST_RETEST on day 3
    addResult('p1', WEAK_FOOT, 3, at(2)); // WEAK_FOOT_LEVEL_2 on day 2
    expect(keys(milestones(db, 'p1'))).toEqual(['FIRST_SESSION', 'WEAK_FOOT_LEVEL_2', 'FIRST_RETEST']);
  });

  test('all six rules can be earned by one player', () => {
    // ten training days, 300 minutes, 1000 touches, weak foot level 2 and a retest
    const s = addSession('p1', [150, 150]);
    addEvent('p1', s, 'drill_done', at(1), { itemId: 'i1' });
    addEvent('p1', s, 'drill_done', at(2), { itemId: 'i2' });
    finishSessionsAt('p1', Array.from({ length: 10 }, (_, i) => at(i + 1, 12)));
    addResult('p1', BALL_MASTERY, 500, at(1));
    addResult('p1', BALL_MASTERY, 500, at(2));
    addResult('p1', WEAK_FOOT, 3, at(3));
    expect([...keys(milestones(db, 'p1'))].sort()).toEqual(
      ['FIRST_RETEST', 'FIRST_SESSION', 'FIVE_HOURS_TRAINED', 'TEN_TRAINING_DAYS', 'THOUSAND_TOUCHES', 'WEAK_FOOT_LEVEL_2'].sort(),
    );
  });
});
