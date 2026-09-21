// PATCH /api/player/profile and POST /api/player/plan/reset (fc-mol-0bt.6): the player edits their plan inputs.
//
// Both sit behind requirePlayer (anonymous players included), which runs BEFORE the body is read: no session is a
// 401 whatever the body holds. The player is always the session's (`c.var.playerId`); nothing in a request names
// another one (the PATCH schema is strict, so a `playerId` key is a 422), and every statement below is keyed by
// that id. EVERY response, the guard's 401, the problems and an unhandled 500 included, is `Cache-Control: no-store`:
// the answers are per player and change as they train.
//
// PATCH /api/player/profile  (body: ENDPOINTS.patchProfile.request, a strict partial of the editable fields)
//   1. a body that is not a JSON object is a 400; the contract's schema refuses anything else with a 422 and
//      `errors: [{ pointer, detail }]` (as POST /api/player/start), and NOTHING is written;
//   2. ONE `db.transaction(...).immediate()` then: reads the profile (none = 404 "not onboarded"), merges the
//      patch, upserts it (profile-repo), rebuilds the roadmap and stores it as the new current one (the old rows
//      stay as history), and deletes the player's session of today that is not finished, so the next
//      GET /api/player/today composes one from the new plan. Any failure rolls the whole thing back;
//   3. answers 200 `{ profile, roadmap }`.
// POST /api/player/plan/reset
//   the same guard and transaction: deletes every roadmaps row of the player (002_player.sql: "a plan reset deletes
//   the player's roadmaps rows; the profile and results stay") and today's unfinished session; answers 200
//   `{ profile, roadmap: null }`. Test results, the profile and every other session are kept.
//
// Readings the criteria leave open (each pinned by player-profile.routes.test.ts)
//   * ROADMAP REBUILD = buildRoadmap(patched profile, the latest stored roadmap's tracks): the levels are the
//     baseline's, a profile edit does not re-measure them. The new roadmap keeps the graph_version of the row its
//     tracks came from (the graph they were measured against). A roadmap that cannot be rebuilt (a stored one that
//     is not the contract's, fewer tracks than a roadmap needs) is a 500 and nothing changes: fail closed.
//   * NO ROADMAP (after a reset) there is nothing to rebuild from: the patch still updates the profile and answers
//     `roadmap: null` (PatchProfileResponse: "null after a plan reset until the baseline is redone"); no roadmap is
//     invented.
//   * A PATCH THAT CHANGES NOTHING (an empty body, or values equal to the stored ones) is a no-op that writes
//     nothing and keeps today's session, so its done items survive; only a real change resets the day.
//   * LOCAL DATE = the X-Timezone header (an IANA name; absent, blank or invalid means UTC, never an error), the
//     rule of GET /api/player/today, which is what decides the session the client sees. The helpers are copied
//     here (that route does not export them and is not this bead's to change).
//   * "Today's unfinished session" = the sessions row of (player, local date) whose finished_at IS NULL. A finished
//     session and every other day's row (the picker's history) stay. The row's session_events go with it (the
//     database's ON DELETE CASCADE): CONTRACT GAP, drill_done events of a dropped session are lost with it.
//   * The sport is the player-data model's default (football), through the roadmap row: this route reads no graph.
import type { Database } from "bun:sqlite";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { buildRoadmap } from "../../planner/roadmap";
import { getProfile, getRoadmap, saveRoadmap, upsertProfile } from "../../player/profile-repo";
import { PlayerProfile, Roadmap } from "../../shared/domain";
import type { CalendarDate } from "../../shared/domain";
import { ENDPOINTS } from "../../shared/journey";
import type { PatchProfileResponse, ResetPlanResponse } from "../../shared/journey";
import { fromZodError, problem } from "../problem";

const NO_STORE = "no-store";

/** Every response of the routes is never cached, whoever produced it (the guard and an unhandled error included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", NO_STORE);
};

// --- the player's local day (as GET /api/player/today) ---------------------------------------------

/** An IANA zone name: "UTC", "Europe/Kyiv", "America/Argentina/Buenos_Aires", "Etc/GMT+5"; never an offset. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** The IANA zone named by the X-Timezone header, or undefined (= UTC) when it is absent or not a zone. */
function timeZoneOf(header: string | undefined): string | undefined {
  const zone = header?.trim();
  if (zone === undefined || zone === "" || !ZONE_SHAPE.test(zone)) return undefined;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The calendar day (YYYY-MM-DD) `instant` falls on in `timeZone` (UTC when undefined). */
function localDate(instant: Date, timeZone: string | undefined): CalendarDate {
  if (timeZone === undefined) return instant.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// --- writes ------------------------------------------------------------------------------------------

/** Deletes the player's session of `date` unless it is finished. Must run inside the caller's transaction. */
function dropUnfinishedSession(db: Database, playerId: string, date: CalendarDate): void {
  db.query("DELETE FROM sessions WHERE player_id = ?1 AND date = ?2 AND finished_at IS NULL").run(playerId, date);
}

/** The player's current roadmap row (the latest by created_at, id): the plan and the graph version it was built on. */
function latestRoadmap(db: Database, playerId: string): { roadmap: Roadmap; graphVersion: string } | null {
  const row = db
    .query<{ json: string; graph_version: string }, [string]>(
      "SELECT json, graph_version FROM roadmaps WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(playerId);
  return row === null ? null : { roadmap: Roadmap.parse(JSON.parse(row.json)), graphVersion: row.graph_version };
}

/** One issue per unknown key, at that key's own path, so its pointer names the key. */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] })) : [issue],
    ),
  );
}

const notOnboarded = (): Response => problem(404, "Not Found", "The player is not onboarded.");

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const patchSpec = ENDPOINTS.patchProfile;
  const resetSpec = ENDPOINTS.resetPlan;

  app.patch(patchSpec.path, noStore, requirePlayer(deps), async (c: Context<{ Variables: AuthVariables }>) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    const parsed = patchSpec.request.safeParse(body);
    if (!parsed.success) {
      return problem(422, "Unprocessable Entity", "The request is invalid.", fromZodError(expandUnknownKeys(parsed.error)));
    }
    const patch = parsed.data;

    const playerId = c.var.playerId;
    const date = localDate(new Date(), timeZoneOf(c.req.header("x-timezone")));

    const answer = db
      .transaction((): PatchProfileResponse | null => {
        const current = getProfile(db, playerId);
        if (current === null) return null;
        const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((key) => patch[key] !== current[key]);
        if (!changed) return { profile: current, roadmap: getRoadmap(db, playerId) };

        // Re-validated as a whole: a stored profile that is not the contract's fails closed (500), never a guess.
        const profile = upsertProfile(db, playerId, PlayerProfile.parse({ ...current, ...patch }));
        const latest = latestRoadmap(db, playerId);
        let roadmap: Roadmap | null = null;
        if (latest !== null) {
          roadmap = buildRoadmap(profile, latest.roadmap.tracks);
          saveRoadmap(db, playerId, roadmap, latest.graphVersion);
        }
        dropUnfinishedSession(db, playerId, date);
        return { profile, roadmap };
      })
      .immediate();
    return answer === null ? notOnboarded() : c.json(answer, 200);
  });

  app.post(resetSpec.path, noStore, requirePlayer(deps), (c: Context<{ Variables: AuthVariables }>) => {
    const playerId = c.var.playerId;
    const date = localDate(new Date(), timeZoneOf(c.req.header("x-timezone")));

    const answer = db
      .transaction((): ResetPlanResponse | null => {
        const profile = getProfile(db, playerId);
        if (profile === null) return null;
        db.query("DELETE FROM roadmaps WHERE player_id = ?").run(playerId);
        dropUnfinishedSession(db, playerId, date);
        return { profile, roadmap: null };
      })
      .immediate();
    return answer === null ? notOnboarded() : c.json(answer, 200);
  });
}
