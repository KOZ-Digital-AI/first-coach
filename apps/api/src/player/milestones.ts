// The player's milestones, DERIVED on every read from their own history (fc-mol-0bt.3). Nothing is stored and
// no other player's data is read, so nothing here can compare players.
//
// Contract: ../shared/journey.ts `Milestone` = { key: string, achievedAt?: Timestamp } (Journey.milestones).
// The contract fixes no key list, so MILESTONE_KEYS below is the list this module produces. Every entry
// carries achievedAt, canonical ISO UTC. The list is sorted by achievedAt, then by key.
//
// Sources (005_sessions.sql, 002_player.sql, 001/004 skill_tests):
//   * the player's session_events, replayed in (at, id) order (the order of session_events_by_player, and of
//     events.ts: it derives done flags and finished_at by the same replay);
//   * the player's test_results, replayed in (recorded_at, id) order (test_results_by_player_time);
//   * sessions.items (the minutes of each drill), player_profiles.age, skill_tests (unit, thresholds).
//
// Rules and the readings chosen where the criteria are silent:
//   * EARNED ONCE. A milestone's date is the `at` of the event at which the replay FIRST reached the threshold.
//     The replay only ever records the first crossing, so a later undo, a worse result or a later crossing
//     never moves or removes it. (events.ts's `done` flag and `minutesTrained` are the CURRENT state and can
//     fall; a milestone is history.)
//   * FIRST_SESSION: the earliest session_finished event (events.ts: finished_at is the earliest one per session).
//   * TEN_TRAINING_DAYS: 10 distinct local calendar days on which a session was finished (the day of a
//     session's earliest finish, the same reading as events.ts's streak). The zone is `opts.timeZone` (IANA;
//     missing or invalid means UTC), as in events.ts: the player's zone is not in the data model.
//   * FIVE_HOURS_TRAINED: the minutes of the items that are done reach 300. Replays drill_done / drill_undone
//     by (session, item): the last one wins, a repeated drill_done counts once, an undo takes the minutes back.
//     An event with no itemId, or for an item the session does not have, changes nothing (as in events.ts).
//   * THOUSAND_TOUCHES: the sum of `value` over the player's non-skipped test results of tests whose unit is
//     'touches' (skill_tests.unit; in the seed ball-mastery-30s and juggling-max-touches) reaches 1000.
//     DRILL RESULTS IN TOUCHES ARE NOT REPRESENTABLE in the data model and are not counted: a session `result`
//     event carries only a number (no unit, no test slug; a drill's dose has reps/sets/durationSec but no
//     unit), so its value cannot be told to be touches.
//   * WEAK_FOOT_LEVEL_2: the first non-skipped result of the weak-foot track's test whose level, by
//     planner/levels.ts and the thresholds of the age band of the player's profile age, is >= 2. The age is
//     the profile's current age (the model keeps no age history).
//   * FIRST_RETEST: the second non-skipped result for the same test (a skipped result measured nothing, so it is
//     not a baseline). Session `result` events name no test, so only test_results count.
import type { Database } from 'bun:sqlite';
import { getSkillTests } from '../commons/repo';
import type { SkillTestWithThresholds } from '../commons/repo';
import { estimateLevels } from '../planner/levels';
import type { Milestone } from '../shared/journey';
import type { EventsOptions } from './events';

export const MILESTONE_KEYS = ['FIRST_SESSION', 'TEN_TRAINING_DAYS', 'THOUSAND_TOUCHES', 'WEAK_FOOT_LEVEL_2', 'FIVE_HOURS_TRAINED', 'FIRST_RETEST'] as const;
export type MilestoneKey = (typeof MILESTONE_KEYS)[number];

export const TRAINING_DAYS_TARGET = 10;
export const TOUCHES_TARGET = 1000;
export const MINUTES_TARGET = 300;
export const WEAK_FOOT_TRACK = 'weak-foot';
export const WEAK_FOOT_TARGET_LEVEL = 2;
/** skill_tests.unit of the tests whose value is a count of touches. */
export const TOUCHES_UNIT = 'touches';

// --- time zone helpers (as events.ts, which does not export its own) ----------------------------

/** One calendar-day formatter for the zone; an unknown zone name means UTC. */
function dayFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
  try {
    return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: timeZone ?? 'UTC' });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' });
  }
}

/** The calendar day (YYYY-MM-DD) an instant falls on in the formatter's zone. */
function localDate(format: Intl.DateTimeFormat, instant: string): string {
  const parts = format.formatToParts(new Date(instant));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// --- readers -----------------------------------------------------------------------------------

interface EventRow {
  session_id: string;
  type: string;
  item_id: string | null;
  at: string;
}

interface ResultRow {
  test_slug: string;
  value: number;
  errors: number | null;
  skipped: number;
  recorded_at: string;
}

/** Minutes of each item of each of the player's sessions: session id -> item id -> minutes (items sharing an id add up, as events.ts flips them all). */
function itemMinutes(db: Database, playerId: string): Map<string, Map<string, number>> {
  const rows = db.query('SELECT id, items FROM sessions WHERE player_id = ?1').all(playerId) as Array<{ id: string; items: string }>;
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const items: unknown = JSON.parse(row.items);
    const perItem = new Map<string, number>();
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item !== 'object' || item === null) continue;
        const { itemId, minutes } = item as { itemId?: unknown; minutes?: unknown };
        if (typeof itemId !== 'string' || typeof minutes !== 'number' || !Number.isFinite(minutes)) continue;
        perItem.set(itemId, (perItem.get(itemId) ?? 0) + minutes);
      }
    }
    out.set(row.id, perItem);
  }
  return out;
}

/** Every skill test of every sport (slugs are unique across sports). */
function allSkillTests(db: Database): SkillTestWithThresholds[] {
  const sports = db.query('SELECT slug FROM sports').all() as Array<{ slug: string }>;
  return sports.flatMap((sport) => getSkillTests(db, sport.slug));
}

// --- milestones --------------------------------------------------------------------------------

/**
 * The player's milestones with the date each was first achieved, sorted by date then key. A player with no
 * history (or no profile) has none. Pure read: no writes, no clock.
 */
export function milestones(db: Database, playerId: string, opts: Pick<EventsOptions, 'timeZone'> = {}): Milestone[] {
  const first = new Map<MilestoneKey, string>();
  /** Records the FIRST crossing only: the replay runs in time order, so the first call is the earliest. */
  const reached = (key: MilestoneKey, at: string): void => {
    if (!first.has(key)) first.set(key, at);
  };

  // Sessions: FIRST_SESSION, TEN_TRAINING_DAYS, FIVE_HOURS_TRAINED.
  const log = db.query('SELECT session_id, type, item_id, at FROM session_events WHERE player_id = ?1 ORDER BY at, id').all(playerId) as EventRow[];
  if (log.length > 0) {
    const minutesOf = itemMinutes(db, playerId);
    const format = dayFormatter(opts.timeZone);
    const finished = new Set<string>();
    const days = new Set<string>();
    const isDone = new Map<string, boolean>();
    let minutes = 0;
    for (const e of log) {
      if (e.type === 'session_finished') {
        if (finished.has(e.session_id)) continue; // only a session's earliest finish counts
        finished.add(e.session_id);
        reached('FIRST_SESSION', e.at);
        days.add(localDate(format, e.at));
        if (days.size >= TRAINING_DAYS_TARGET) reached('TEN_TRAINING_DAYS', e.at);
      } else if ((e.type === 'drill_done' || e.type === 'drill_undone') && e.item_id !== null) {
        const itemMins = minutesOf.get(e.session_id)?.get(e.item_id);
        if (itemMins === undefined) continue; // not an item of this session: changes nothing
        const key = `${e.session_id}\u0000${e.item_id}`;
        const now = e.type === 'drill_done';
        if (now === (isDone.get(key) === true)) continue; // already in that state
        isDone.set(key, now);
        minutes += now ? itemMins : -itemMins;
        if (minutes >= MINUTES_TARGET) reached('FIVE_HOURS_TRAINED', e.at);
      }
    }
  }

  // Test results: THOUSAND_TOUCHES, WEAK_FOOT_LEVEL_2, FIRST_RETEST.
  const results = db
    .query('SELECT test_slug, value, errors, skipped, recorded_at FROM test_results WHERE player_id = ?1 ORDER BY recorded_at, id')
    .all(playerId) as ResultRow[];
  if (results.length > 0) {
    const tests = allSkillTests(db);
    const testBySlug = new Map(tests.map((t) => [t.slug, t]));
    const profile = db.query('SELECT age FROM player_profiles WHERE player_id = ?1').get(playerId) as { age: number } | null;
    const perTest = new Map<string, number>();
    let touches = 0;
    for (const r of results) {
      if (r.skipped === 1) continue; // nothing was measured
      const count = (perTest.get(r.test_slug) ?? 0) + 1;
      perTest.set(r.test_slug, count);
      if (count >= 2) reached('FIRST_RETEST', r.recorded_at);

      const test = testBySlug.get(r.test_slug);
      if (test === undefined) continue;
      if (test.unit === TOUCHES_UNIT) {
        touches += r.value;
        if (touches >= TOUCHES_TARGET) reached('THOUSAND_TOUCHES', r.recorded_at);
      }
      if (test.skill === WEAK_FOOT_TRACK && profile !== null && !first.has('WEAK_FOOT_LEVEL_2')) {
        const level = estimateLevels(profile.age, [{ testSlug: r.test_slug, value: r.value, ...(r.errors === null ? {} : { errors: r.errors }) }], tests, 'beginner', [WEAK_FOOT_TRACK])[0];
        if (level !== undefined && level.source === 'test' && level.level >= WEAK_FOOT_TARGET_LEVEL) reached('WEAK_FOOT_LEVEL_2', r.recorded_at);
      }
    }
  }

  return [...first]
    .map(([key, achievedAt]): Milestone => ({ key, achievedAt }))
    .sort((a, b) => (a.achievedAt! < b.achievedAt! ? -1 : a.achievedAt! > b.achievedAt! ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
