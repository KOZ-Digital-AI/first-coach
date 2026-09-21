// POST /api/player/today/swap (fc-mol-urn.6): the player asks for an easier or harder drill in place of one
// unfinished item of today's session.
//
// Behind requirePlayer (anonymous players included), which runs BEFORE the body is read. The player is always
// the session's (`c.var.playerId`) and only ever their own session is read or written: the body is a strict
// {itemId, direction} (a `playerId` or `sessionId` key is a 422) and the session is the caller's session of
// their local day. Every response, the guard's 401 and the problems included, is `Cache-Control: no-store`.
//
// What it does (planner/swap.ts holds the choice)
//   1. a body that is not JSON is a 400; the contract's SwapRequest refuses anything else with a 422 and
//      `errors: [{ pointer, detail }]` (as POST /api/player/start);
//   2. today's session is read through GET /api/player/today's own handler (see "Reading" below): a player who
//      is not onboarded is a 404 "not onboarded", an unknown ?locale a 400, an unseeded graph a 503, all relayed
//      as that route answers them; a first call of the day creates the session, as GET does;
//   3. ONE `db.transaction(...).immediate()`: the item must be in the session (404) and not finished (409);
//      the replacement is picked from the SAME candidate set pickSession uses (getSettings -> candidates over
//      the published versions, the player's profile and roadmap levels, the skill graph) minus the drills
//      already in the session; none is a 409 "no alternative"; else the item is rewritten in place (json_set on
//      that one array slot, so no other byte of `items` moves) and NOTHING is written on any refusal;
//   4. the answer is the updated TodaySession, built by the same GET handler after the write, so it is exactly
//      what the next GET returns (content of the new drill's immutable version, locale, skill test, totals).
// Errors are RFC 9457 problems: 401 (the guard), 400, 404, 409, 422, 503.
//
// Readings the criteria leave open
//   * The stored item keeps its itemId, reason and position; it takes the new drill's VERSION id and minutes,
//     `done: false`, and the relation to the drill it replaced: `regressionOf` (easier) or `progressionOf`
//     (harder) = the replaced drill's VERSION id (versions are immutable and keep resolving). The relation is
//     recorded for a linked replacement and for a same-skill fallback alike, and replaces any earlier one of
//     the item (an item has one relation, of its latest swap).
//   * "Finished item" = `done: true`. A session that is finished (finished_at) but has an unfinished item does
//     not block the swap: the criteria name the item only.
//   * Reading: the GET route module exports only `register`, and the view of a stored session (content in the
//     locale and en, status, attribution, skill test, totals, the X-Timezone day) lives inside it. Rather than
//     copy that ~150 lines, this route mounts the GET route on a PRIVATE app and calls it with the caller's
//     cookie and X-Timezone header, so the two can never drift. CONTRACT GAP: exporting the view builder from
//     player-today.routes.ts would let this be a plain function call (that file is not owned by this bead).
//   * ?locale is accepted as on GET (the contract's postSwap declares no query; the client that opened its
//     session in a locale needs the same locale back).
import { Hono } from "hono";
import type { Context } from "hono";
import { ZodError } from "zod";
import { getSettings } from "../../admin/settings";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillGraph, listPublishedVersions } from "../../commons/repo";
import { candidates } from "../../planner/candidates";
import { pickSwap } from "../../planner/swap";
import type { SwapSubject } from "../../planner/swap";
import { DEFAULT_SPORT } from "../../player/journey";
import { getProfile, getRoadmap } from "../../player/profile-repo";
import type { DrillContent } from "../../shared/primitives";
import { ENDPOINTS } from "../../shared/session";
import type { TodaySession } from "../../shared/session";
import { fromZodError, problem } from "../problem";
import { register as registerToday } from "./player-today.routes";

/** One entry of sessions.items, as player-today.routes.ts stores it. */
interface StoredItem {
  itemId: string;
  drillVersionId: string;
  minutes: number;
  reason?: string;
  done: boolean;
  regressionOf?: string;
  progressionOf?: string;
}

interface SubjectRow {
  drill_id: string;
  level: SwapSubject["level"];
  minutes: number;
  content: string;
  track: string | null;
}

type Outcome = "swapped" | "not_found" | "finished" | "no_alternative" | "unavailable";

/** One issue per unknown key, at that key's own path, so its pointer names the key (as player-start.routes.ts). */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] })) : [issue],
    ),
  );
}

/** A response of the private GET route as a fresh, mutable one of this route (status, body and content type kept). */
async function relay(res: Response): Promise<Response> {
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const spec = ENDPOINTS.postSwap;

  // GET /api/player/today, mounted on a private app: the only reader of a stored session's view (see the header).
  const reader = new Hono();
  await registerToday(reader, deps);
  const readToday = (c: Context<{ Variables: AuthVariables }>): Promise<Response> => {
    const headers = new Headers();
    for (const name of ["cookie", "authorization", "x-timezone"]) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    const url = new URL(ENDPOINTS.getToday.path, c.req.url);
    url.search = new URL(c.req.url).search;
    return Promise.resolve(reader.fetch(new Request(url, { headers })));
  };

  /** Swaps the item of the player's session in ONE immediate transaction; every refusal writes nothing. */
  const swapItem = (playerId: string, sessionId: string, itemId: string, direction: "easier" | "harder"): Outcome =>
    db
      .transaction((): Outcome => {
        const row = db.query<{ items: string }, [string, string]>("SELECT items FROM sessions WHERE id = ?1 AND player_id = ?2").get(sessionId, playerId);
        if (row === null) return "not_found";
        const stored = JSON.parse(row.items) as StoredItem[];
        const index = stored.findIndex((entry) => entry.itemId === itemId);
        const current = stored[index];
        if (current === undefined) return "not_found";
        if (current.done === true) return "finished";

        const profile = getProfile(db, playerId);
        const roadmap = getRoadmap(db, playerId);
        const graph = profile === null ? null : getSkillGraph(db, DEFAULT_SPORT, profile.locale);
        if (profile === null || roadmap === null || graph === null) return "unavailable";

        // The drill being replaced: read from its stored VERSION (which may no longer be the drill's current one).
        const subjectRow = db
          .query<SubjectRow, [string]>(
            `SELECT v.drill_id, v.level, v.minutes, v.content,
                    (SELECT s.slug FROM drill_skills ds JOIN skills s ON s.id = ds.skill_id
                      WHERE ds.drill_id = v.drill_id AND ds.is_primary = 1) AS track
               FROM drill_versions v WHERE v.id = ?1`,
          )
          .get(current.drillVersionId);
        if (subjectRow === null) throw new Error(`Session item ${itemId} names an unknown drill version`);
        const subject: SwapSubject = {
          drillId: subjectRow.drill_id,
          track: subjectRow.track,
          level: subjectRow.level,
          minutes: subjectRow.minutes,
          content: JSON.parse(subjectRow.content) as DrillContent,
        };

        const drillOf = db.query<{ drill_id: string }, [string]>("SELECT drill_id FROM drill_versions WHERE id = ?1");
        const inSession = new Set(stored.map((entry) => drillOf.get(entry.drillVersionId)?.drill_id ?? ""));

        // The same candidate set as the session was composed from (player-today.routes.ts createSession).
        const levels = Object.fromEntries(roadmap.tracks.map((track) => [track.skill, track.level]));
        const pool = candidates(profile, levels, getSettings(db), listPublishedVersions(db, { sport: DEFAULT_SPORT }), graph);
        const picked = pickSwap(subject, direction, pool, inSession);
        if (picked === undefined) return "no_alternative";

        const replacement: StoredItem = {
          itemId: current.itemId,
          drillVersionId: picked.versionId,
          minutes: picked.minutes,
          ...(current.reason === undefined ? {} : { reason: current.reason }),
          done: false,
          ...(direction === "easier" ? { regressionOf: current.drillVersionId } : { progressionOf: current.drillVersionId }),
        };
        db.query("UPDATE sessions SET items = json_set(items, ?1, json(?2)) WHERE id = ?3 AND player_id = ?4").run(
          `$[${index}]`,
          JSON.stringify(replacement),
          sessionId,
          playerId,
        );
        return "swapped";
      })
      .immediate();

  app.post(spec.path, async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  }, requirePlayer(deps), async (c: Context<{ Variables: AuthVariables }>) => {
    let json: unknown;
    try {
      json = JSON.parse(await c.req.text());
    } catch {
      return problem(400, "Bad Request", "The request body is not valid JSON.");
    }
    const body = spec.request.safeParse(json);
    if (!body.success) return problem(422, "Unprocessable Entity", "Invalid request body.", fromZodError(expandUnknownKeys(body.error)));
    const { itemId, direction } = body.data;

    // Today's session of the caller's local day (created on a first call, as GET does).
    const opening = await readToday(c);
    if (opening.status !== 200) return relay(opening);
    const session = (await opening.json()) as TodaySession;

    switch (swapItem(c.var.playerId, session.id, itemId, direction)) {
      case "not_found":
        return problem(404, "Not Found", `Item ${itemId} is not in today's session.`);
      case "finished":
        return problem(409, "Item already finished", "A finished item cannot be swapped.");
      case "no_alternative":
        return problem(409, "No alternative", `There is no alternative drill that is ${direction} for this player.`);
      case "unavailable":
        return problem(503, "Service Unavailable", `The ${DEFAULT_SPORT} skill graph is not loaded yet.`);
      case "swapped":
        return relay(await readToday(c));
    }
  });
}
