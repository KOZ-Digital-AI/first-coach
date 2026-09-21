// Player profile repository (fc-mol-9l4.9): every read and write of player_profiles, test_results and
// roadmaps (002_player.sql) that POST /api/player/start and GET /api/player/me need.
//
// Every function takes the bun:sqlite Database as its first parameter (no module singleton) and is
// synchronous. SQL uses bound parameters only.
//
// Rules that hold for EVERY function
//   - OWNER ISOLATION: every statement is keyed by `playerId`, which the caller takes from the session,
//     never from a request body. Nothing here reads or writes a row of another player, with one
//     exception the schema dictates: test_results.client_uuid is UNIQUE across ALL players, so a
//     batch entry whose clientUuid is already stored for someone else is dropped (ON CONFLICT DO
//     NOTHING) and never rewritten or taken over; insertBaseline then does not return it.
//   - TRANSACTIONS: each write runs in its own BEGIN IMMEDIATE transaction (db.transaction(fn).immediate()).
//     Called inside a caller's transaction it nests as a savepoint, so the start route can run the whole
//     onboarding in ONE immediate transaction and roll everything back on any failure.
//   - Timestamps are canonical ISO 8601 UTC with milliseconds (Date#toISOString), as the schema's CHECKs
//     require. `now` is an option for tests.
//
// CHOICES the contract leaves open (each pinned by a test)
//   - upsertProfile is INSERT .. ON CONFLICT (player_id) DO UPDATE, never INSERT OR REPLACE (whose delete
//     would cascade away every result and roadmap). created_at survives an update; updated_at moves.
//   - insertBaseline is INSERT .. ON CONFLICT (client_uuid) DO NOTHING: a replay stores nothing new. It
//     returns the STORED rows of this player for the batch's clientUuids, in batch order, so the first
//     write wins and a retry with different numbers cannot change the plan derived from them. A skipped
//     result is stored with value 0 (the schema: "1: nothing measured, value is 0").
//   - saveRoadmap keeps history (the table is never UNIQUE per player; the current roadmap is the latest by
//     (created_at, id)), but writes nothing when the newest stored roadmap is byte-identical, so a replayed
//     start adds no row while a changed plan does.
import type { Database } from "bun:sqlite";
import type { LevelResult } from "../planner/levels";
import type { PlayerProfile, PlayerProfileView, Roadmap } from "../shared/domain";
import type { BaselineResult } from "../shared/onboarding";

// --- errors ----------------------------------------------------------------------------------

/** A baseline entry names a test that is not one of the sport's tests (routes answer 422 on /baseline/<index>/testSlug). */
export class UnknownTestError extends Error {
  readonly index: number;
  readonly testSlug: string;

  constructor(index: number, testSlug: string) {
    super(`Baseline entry ${index} names an unknown test`); // never the raw slug: it is client input of any length
    this.name = "UnknownTestError";
    this.index = index;
    this.testSlug = testSlug;
  }
}

/** Injectable clock. */
export interface RepoOptions {
  now?: () => Date;
}

const iso = (options: RepoOptions): string => (options.now?.() ?? new Date()).toISOString();

// --- profile ---------------------------------------------------------------------------------

interface ProfileRow {
  age: number;
  level: string;
  goal: string;
  equipment: string;
  space: string;
  partner: number;
  days_per_week: number;
  minutes_per_session: number;
  locale: string;
}

const PROFILE_COLUMNS = "age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale";

// The columns are validated by Zod at the write boundary (and the enums CHECKed where the contract fixes
// them); the read trusts what was written, like the other repositories.
const toView = (row: ProfileRow): PlayerProfileView => ({
  age: row.age,
  level: row.level as PlayerProfileView["level"],
  goal: row.goal as PlayerProfileView["goal"],
  equipment: row.equipment as PlayerProfileView["equipment"],
  space: row.space as PlayerProfileView["space"],
  partner: row.partner === 1,
  daysPerWeek: row.days_per_week as PlayerProfileView["daysPerWeek"],
  minutesPerSession: row.minutes_per_session as PlayerProfileView["minutesPerSession"],
  locale: row.locale as PlayerProfileView["locale"],
});

/** The player's profile, or null when they have not onboarded. */
export function getProfile(db: Database, playerId: string): PlayerProfileView | null {
  const row = db
    .query<ProfileRow, [string]>(`SELECT ${PROFILE_COLUMNS} FROM player_profiles WHERE player_id = ?`)
    .get(playerId);
  return row === null ? null : toView(row);
}

/** Creates the player's profile or replaces its fields (history is kept); returns it as stored. */
export function upsertProfile(db: Database, playerId: string, profile: PlayerProfile, options: RepoOptions = {}): PlayerProfileView {
  const at = iso(options);
  return db
    .transaction((): PlayerProfileView => {
      db.query(
        `INSERT INTO player_profiles (player_id, ${PROFILE_COLUMNS}, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (player_id) DO UPDATE SET
           age = excluded.age, level = excluded.level, goal = excluded.goal, equipment = excluded.equipment,
           space = excluded.space, partner = excluded.partner, days_per_week = excluded.days_per_week,
           minutes_per_session = excluded.minutes_per_session, locale = excluded.locale,
           updated_at = excluded.updated_at`,
      ).run(
        playerId,
        profile.age,
        profile.level,
        profile.goal,
        profile.equipment,
        profile.space,
        profile.partner ? 1 : 0,
        profile.daysPerWeek,
        profile.minutesPerSession,
        profile.locale,
        at,
        at,
      );
      return getProfile(db, playerId)!;
    })
    .immediate();
}

// --- baseline results --------------------------------------------------------------------------

/** Throws UnknownTestError for the first entry whose test is not in `knownSlugs`; touches nothing. */
export function assertKnownTests(baseline: readonly BaselineResult[], knownSlugs: Iterable<string>): void {
  const known = new Set(knownSlugs);
  baseline.forEach((result, index) => {
    if (!known.has(result.testSlug)) throw new UnknownTestError(index, result.testSlug);
  });
}

interface ResultRow {
  test_slug: string;
  value: number;
  errors: number | null;
  skipped: number;
}

/**
 * Stores a baseline batch idempotently by clientUuid and returns this player's STORED rows for it, in
 * batch order (an entry dropped because its clientUuid belongs to another player is not returned).
 */
export function insertBaseline(
  db: Database,
  playerId: string,
  baseline: readonly BaselineResult[],
  options: RepoOptions = {},
): LevelResult[] {
  const at = iso(options);
  return db
    .transaction((): LevelResult[] => {
      const insert = db.query(
        `INSERT INTO test_results (player_id, test_slug, value, attempts, errors, skipped, recorded_at, client_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_uuid) DO NOTHING`,
      );
      for (const result of baseline) {
        const skipped = result.skipped === true;
        insert.run(playerId, result.testSlug, skipped ? 0 : result.value, result.attempts ?? null, result.errors ?? null, skipped ? 1 : 0, at, result.clientUuid);
      }
      const read = db.query<ResultRow, [string, string]>(
        "SELECT test_slug, value, errors, skipped FROM test_results WHERE player_id = ? AND client_uuid = ?",
      );
      const stored: LevelResult[] = [];
      for (const result of baseline) {
        const row = read.get(playerId, result.clientUuid);
        if (row === null) continue;
        stored.push({
          testSlug: row.test_slug,
          value: row.value,
          ...(row.errors !== null && { errors: row.errors }),
          skipped: row.skipped === 1,
        });
      }
      return stored;
    })
    .immediate();
}

// --- roadmap ------------------------------------------------------------------------------------

/** The `graph_version` of a sport, or null when the sport is not seeded. */
export function getGraphVersion(db: Database, sport: string): string | null {
  const row = db.query<{ graph_version: string }, [string]>("SELECT graph_version FROM sports WHERE slug = ?").get(sport);
  return row === null ? null : row.graph_version;
}

/** The player's current roadmap (the latest by created_at, id), or null when there is none. */
export function getRoadmap(db: Database, playerId: string): Roadmap | null {
  const row = db
    .query<{ json: string }, [string]>("SELECT json FROM roadmaps WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(playerId);
  return row === null ? null : (JSON.parse(row.json) as Roadmap);
}

/** Stores `roadmap` as the player's current one, unless the newest stored roadmap is identical (a replay). */
export function saveRoadmap(db: Database, playerId: string, roadmap: Roadmap, graphVersion: string, options: RepoOptions = {}): void {
  const at = iso(options);
  const json = JSON.stringify(roadmap);
  db.transaction((): void => {
    const latest = db
      .query<{ json: string; graph_version: string }, [string]>(
        "SELECT json, graph_version FROM roadmaps WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(playerId);
    if (latest !== null && latest.json === json && latest.graph_version === graphVersion) return;
    db.query("INSERT INTO roadmaps (player_id, json, graph_version, created_at) VALUES (?, ?, ?, ?)").run(playerId, json, graphVersion, at);
  }).immediate();
}
