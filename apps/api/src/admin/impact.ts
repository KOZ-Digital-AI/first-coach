// Admin impact metrics (fc-mol-0v3.6): what GET /api/admin/impact serves (`ImpactMetrics`, shared/admin.ts),
// computed from SQLite on every call. Nothing is cached or kept here.
//
// PRIVACY: aggregates only. Player ids, user ids and reviewer names are read to count distinct people
// and are never part of the result: every output value is a number or a {weekStart, sessionsCompleted}.
//
// The clock is injected (`now`): there is no global clock in this module, so every window is exact.
//
// Definitions (the criteria name the metrics, these readings fix them; pinned in impact.test.ts)
//   playersWithBaseline  players with at least one NON-SKIPPED test result.
//   playersRetested      players with at least two non-skipped results for at least one test.
//   medianImprovementPct the median over (player, test) pairs with at least two non-skipped results of the
//                        direction-aware percent change between the FIRST and the LATEST result (by
//                        recorded_at, then id):
//                          higher is better  (latest - first) / |first| x 100
//                          lower is better   (first - latest) / |first| x 100
//                        so a gain is positive in both directions. A pair whose first value is 0 is left out
//                        (a percent of zero is undefined); so is a pair whose test is not in skill_tests
//                        (its direction is unknown; test_results.test_slug has no FK). The median of an even
//                        count is the mean of the two middle values; no pair at all is 0, never null or NaN.
//   sessionsCompleted    sessions with a finished_at, of any date.
//   trainingHours        the minutes of the items marked done (sessions.items JSON, TodayItem.done and
//                        .minutes) in FINISHED sessions, divided by 60. Not rounded: the UI formats it.
//   activeContributors   distinct submitter_user_id of contributions created in the last 90 days, the window
//                        being inclusive: created_at >= now - 90 days. Any state counts (submitting is what
//                        makes a contributor active).
//   verifiedCoaches      distinct reviewers of reviews rows whose to_status is REVIEWED, EXPERT_VERIFIED or
//                        ACADEMY_VERIFIED. A reviewer is reviewer_user_id, or, on a row without one (a seeded
//                        review has no account), the reviewer name.
//   openMethodologies    published drills, the same definition as getStats().drills: not unpublished and
//                        linked to a current version.
//   byWeek               finished sessions per week for the last 12 weeks ending with now's week, oldest
//                        first, zero-filled. A week runs Monday 00:00:00.000 UTC to the next Monday, and
//                        `weekStart` is its Monday. A session is in the week of its finished_at (UTC);
//                        sessions outside the 12 weeks are still in sessionsCompleted.
import type { Database } from 'bun:sqlite';
import type { ImpactMetrics } from '../shared/admin';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
export const WEEKS = 12;
export const ACTIVE_CONTRIBUTOR_DAYS = 90;

/** The Monday 00:00:00.000 UTC of the week containing `at`, in epoch ms. */
function mondayOf(at: Date): number {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const sinceMonday = (at.getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
  return midnight - sinceMonday * DAY_MS;
}

/** Median of a non-empty ascending-sorted list; an even count is the mean of the two middle values. */
function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface PairRow {
  player_id: string;
  n: number;
  first: number;
  latest: number;
  direction: 'higher' | 'lower' | null;
}

export function computeImpact(db: Database, now: Date): ImpactMetrics {
  // One row per (player, test) over the non-skipped results: how many there are, the first and the latest.
  const pairs = db
    .query<PairRow, []>(
      `WITH r AS (
         SELECT player_id, test_slug,
                count(*) OVER (PARTITION BY player_id, test_slug) AS n,
                first_value(value) OVER w AS first,
                last_value(value) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS latest,
                row_number() OVER w AS rn
           FROM test_results
          WHERE skipped = 0
         WINDOW w AS (PARTITION BY player_id, test_slug ORDER BY recorded_at, id)
       )
       SELECT r.player_id, r.n, r.first, r.latest, t.direction
         FROM r LEFT JOIN skill_tests t ON t.slug = r.test_slug
        WHERE r.rn = 1`,
    )
    .all();

  const withBaseline = new Set<string>();
  const retested = new Set<string>();
  const improvements: number[] = [];
  for (const pair of pairs) {
    withBaseline.add(pair.player_id);
    if (pair.n < 2) continue;
    retested.add(pair.player_id);
    if (pair.direction === null || pair.first === 0) continue;
    const change = pair.direction === 'higher' ? pair.latest - pair.first : pair.first - pair.latest;
    improvements.push((change / Math.abs(pair.first)) * 100);
  }
  improvements.sort((a, b) => a - b);

  const count = (sql: string, ...params: string[]): number =>
    db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;

  const sessionsCompleted = count('SELECT count(*) AS n FROM sessions WHERE finished_at IS NOT NULL');

  const minutesDone =
    db
      .query<{ minutes: number }, []>(
        `SELECT coalesce(sum(json_extract(i.value, '$.minutes')), 0) AS minutes
           FROM sessions s, json_each(s.items) i
          WHERE s.finished_at IS NOT NULL AND json_extract(i.value, '$.done') = 1`,
      )
      .get()?.minutes ?? 0;

  const activeSince = new Date(now.getTime() - ACTIVE_CONTRIBUTOR_DAYS * DAY_MS).toISOString();
  const activeContributors = count(
    'SELECT count(DISTINCT submitter_user_id) AS n FROM contributions WHERE created_at >= ?',
    activeSince,
  );

  const verifiedCoaches = count(
    `SELECT count(DISTINCT coalesce(reviewer_user_id, 'name:' || reviewer)) AS n
       FROM reviews WHERE to_status IN ('REVIEWED', 'EXPERT_VERIFIED', 'ACADEMY_VERIFIED')`,
  );

  const openMethodologies = count(
    'SELECT count(*) AS n FROM drills WHERE unpublished_at IS NULL AND current_version_id IS NOT NULL',
  );

  // The finished_at values are ISO-8601 UTC with milliseconds (migration 005), so they compare as strings.
  const thisMonday = mondayOf(now);
  const firstMonday = thisMonday - (WEEKS - 1) * WEEK_MS;
  const perWeek = new Map<string, number>(
    db
      .query<{ week: string; n: number }, [string, string]>(
        `SELECT date(finished_at, 'weekday 0', '-6 days') AS week, count(*) AS n
           FROM sessions
          WHERE finished_at >= ?1 AND finished_at < ?2
          GROUP BY week`,
      )
      .all(new Date(firstMonday).toISOString(), new Date(thisMonday + WEEK_MS).toISOString())
      .map((row) => [row.week, row.n]),
  );
  const byWeek = Array.from({ length: WEEKS }, (_, i) => {
    const weekStart = new Date(firstMonday + i * WEEK_MS).toISOString().slice(0, 10);
    return { weekStart, sessionsCompleted: perWeek.get(weekStart) ?? 0 };
  });

  return {
    playersWithBaseline: withBaseline.size,
    playersRetested: retested.size,
    medianImprovementPct: improvements.length === 0 ? 0 : median(improvements),
    sessionsCompleted,
    trainingHours: minutesDone / 60,
    activeContributors,
    verifiedCoaches,
    openMethodologies,
    byWeek,
  };
}
