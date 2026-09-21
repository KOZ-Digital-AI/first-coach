// The player's journey (GET /api/player/journey): measurable progress against their OWN history.
//
// Contract: ../shared/journey.ts (Journey). Tables: 002 (test_results), 005 (sessions, session_events).
//
//   buildJourney(db, playerId, locale, now, opts)  the whole Journey for one player.
//
// Everything is read for `playerId` only (every query filters on player_id) and against the injected `now`
// (no global clock), so the result is a pure function of the database, the locale and `now`.
//
// Readings the criteria leave open (each pinned by journey.test.ts):
//   * Test history comes from `test_results` (what POST /api/player/test-results writes: test_slug, value,
//     skipped, recorded_at), NOT from session_events. 005 documents a `result` event for the session's skill
//     test as item-less and sessions do not store their skill test, so no event names its test. A `result`
//     event is therefore not read here. `at` of a history point is the row's recorded_at.
//   * A skipped result (nothing measured, value 0) is not part of the history, so it neither becomes the
//     latest value nor restarts the retest clock. Results of a slug that is not a test of the sport are ignored.
//   * History is ordered by (recorded_at, id); `previous` and `latest` are its last two points.
//   * changePct = (latest - previous) / |previous| * 100 for a higher-is-better test and
//     (previous - latest) / |previous| * 100 for a lower-is-better one, so a positive number is always an
//     improvement (14 -> 21 is +50, slalom 30s -> 24s is +20). It is omitted (the contract has `.optional()`,
//     never null) with fewer than two results or when previous is 0. It is not rounded.
//   * personalBest = the maximum (higher) or minimum (lower) over the whole history.
//   * Retest interval: `retestIntervalsDays` (admin settings, [7, 14, 30] by default) is read by result count.
//     After the k-th result of a test (k = 1 is the baseline) the next retest is due
//     retestIntervalsDays[min(k, length) - 1] days after THAT result: 7 days after the 1st, 14 after the 2nd,
//     30 after the 3rd and every later one (the last interval repeats). `retestsDue` holds the slugs whose
//     retestDueAt <= now (inclusive), in test-slug order.
//   * metrics.skillsImproving = the number of distinct skills (tracks) that have a test whose LATEST result
//     beats its FIRST result (the baseline) strictly, in the improving direction. Not "previous": 10, 30, 20
//     is improving. One result is never improving.
//   * The other metrics (sessionsCompleted, minutesTrained, streakDays) are progressSummary's: imported, not
//     recomputed, so the session screen and the journey can never disagree.
//   * `name` is the localized name of the test's SKILL (requested -> ru -> en, as getSkillGraph); a test has
//     no localized name of its own (`metric` is a plain string), which is the fallback if the skill is unknown.
//   * The sport is not in the player data model: it defaults to football (the only seeded sport) and can be
//     passed in `opts`. The player's time zone (streak) is the caller's, as in events.ts; default UTC.
//   * `tree` and `milestones` are [] : the criteria of this function do not define them (see the report).
import type { Database } from 'bun:sqlite';
import { getSettings } from '../admin/settings';
import { getSkillGraph, getSkillTests } from '../commons/repo';
import type { Journey, JourneyTest } from '../shared/journey';
import type { Locale } from '../shared/primitives';
import { progressSummary } from './events';

/** The only sport with a seed today; the player data model has no sport. */
export const DEFAULT_SPORT = 'football';

const DAY_MS = 86_400_000;

export interface JourneyOptions {
  sport?: string;
  /** IANA name for the streak's calendar days; missing or invalid means UTC (as events.ts). */
  timeZone?: string;
}

interface ResultRow {
  test_slug: string;
  value: number;
  recorded_at: string;
}

/** Percentage change of `latest` against `previous`, positive = improvement; undefined when it is undefined. */
function changePct(direction: 'higher' | 'lower', previous: number, latest: number): number | undefined {
  if (previous === 0) return undefined;
  const delta = direction === 'higher' ? latest - previous : previous - latest;
  return (delta * 100) / Math.abs(previous);
}

/** True when `latest` is strictly better than `baseline` in the test's direction. */
function beats(direction: 'higher' | 'lower', latest: number, baseline: number): boolean {
  return direction === 'higher' ? latest > baseline : latest < baseline;
}

export function buildJourney(db: Database, playerId: string, locale: Locale, now: Date, opts: JourneyOptions = {}): Journey {
  const sport = opts.sport ?? DEFAULT_SPORT;
  const intervals = getSettings(db).retestIntervalsDays;
  const skillNames = new Map((getSkillGraph(db, sport, locale)?.nodes ?? []).map((node) => [node.slug, node.names[locale]]));

  const rows = db
    .query('SELECT test_slug, value, recorded_at FROM test_results WHERE player_id = ?1 AND skipped = 0 ORDER BY recorded_at, id')
    .all(playerId) as ResultRow[];
  const bySlug = new Map<string, ResultRow[]>();
  for (const row of rows) bySlug.set(row.test_slug, [...(bySlug.get(row.test_slug) ?? []), row]);

  const tests: JourneyTest[] = [];
  const retestsDue: string[] = [];
  const improving = new Set<string>();

  for (const test of getSkillTests(db, sport, locale)) {
    const results = bySlug.get(test.slug);
    if (results === undefined || results.length === 0) continue;

    const values = results.map((r) => r.value);
    const first = results[0]!;
    const last = results[results.length - 1]!;
    const previous = results.length >= 2 ? results[results.length - 2]!.value : undefined;
    const change = previous === undefined ? undefined : changePct(test.direction, previous, last.value);

    const days = intervals[Math.min(results.length, intervals.length) - 1]!;
    const retestDueAt = new Date(Date.parse(last.recorded_at) + days * DAY_MS).toISOString();
    if (Date.parse(retestDueAt) <= now.getTime()) retestsDue.push(test.slug);
    if (beats(test.direction, last.value, first.value)) improving.add(test.skill);

    tests.push({
      testSlug: test.slug,
      name: skillNames.get(test.skill) ?? test.metric,
      unit: test.unit,
      direction: test.direction,
      history: results.map((r) => ({ value: r.value, at: r.recorded_at })),
      ...(previous === undefined ? {} : { previous }),
      latest: last.value,
      ...(change === undefined ? {} : { changePct: change }),
      personalBest: test.direction === 'higher' ? Math.max(...values) : Math.min(...values),
      retestDueAt,
    });
  }

  const progress = progressSummary(db, playerId, { now: () => now, ...(opts.timeZone === undefined ? {} : { timeZone: opts.timeZone }) });
  return {
    metrics: { ...progress, skillsImproving: improving.size },
    tree: [],
    tests,
    milestones: [],
    retestsDue,
  };
}
