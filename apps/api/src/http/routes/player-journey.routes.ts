// GET /api/player/journey?locale (fc-mol-0bt.4): the My Journey dashboard in ONE response.
//
// Behind requirePlayer: any signed-in user, anonymous players included (players are anonymous by design).
// The player is always the session's (`c.var.playerId`); nothing in the request names another one. Method, path
// and the Zod query/response schemas come from the contract (shared/journey ENDPOINTS).
//
// The Journey is composed from the merged modules:
//   buildJourney  metrics, tests, retestsDue (it leaves `tree` and `milestones` as [] placeholders)
//   deriveTree    REPLACES `tree`: the sport's skill graph, the player's roadmap levels and focus, and the
//                 completed drill counts
//   milestones    REPLACES `milestones`
//
// Errors are RFC 9457 problems (http/problem):
//   - no session -> 401 (the guard);
//   - a query the contract schema rejects (unknown locale, unknown key) -> 400, one `errors[]` entry per Zod issue;
//   - a player with no profile row -> 404 "not onboarded";
//   - anything else is rethrown to the app's onError (500), never swallowed.
//
// Readings the criteria leave open (each pinned by player-journey.routes.test.ts):
//   * Locale: the contract's query has `locale`, so it is ?locale (not Accept-Language). Absent, it is the player's
//     stored profile locale (their own choice), where the public read routes default to 'ru'.
//   * Time zone: the X-Timezone header (IANA, checked with Intl); absent or invalid means UTC, never an error.
//     It is handed to both buildJourney (streak) and milestones (training days).
//   * Not onboarded = no player_profiles row. A profile with no roadmap (a plan reset) is onboarded: its tree is
//     derived from empty levels and focus, so every track's first node trains.
//   * Roadmap = the player's newest `roadmaps` row (created_at, then id): its `tracks` are deriveTree's levels and
//     its `focus` its focus.
//   * completedDrillCounts: deriveTree reads a count per sub-skill node, but the commons link every drill to its
//     TRACK only (drill_skills.is_primary = the track), so a drill cannot be told to belong to one sub-skill. The
//     completed drills of a track (session items with done = true, drill version -> drill -> primary skill -> the
//     track it sits under) are counted once and every sub-skill of that track is credited with that count; which
//     nodes are mastered is then decided by the track level. Completed drills are counted over all the player's
//     sessions (an undone drill has done = false, as ingestEvents keeps it).
//   * The sport is the player-data model's default (football), as buildJourney.
import type { Database } from "bun:sqlite";
import type { Context, Hono } from "hono";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillGraph } from "../../commons/repo";
import { DEFAULT_SPORT, buildJourney } from "../../player/journey";
import { milestones } from "../../player/milestones";
import { deriveTree } from "../../player/skill-tree";
import type { SkillGraph } from "../../shared/commons";
import { Roadmap } from "../../shared/domain";
import { ENDPOINTS } from "../../shared/journey";
import type { Journey } from "../../shared/journey";
import type { Locale } from "../../shared/primitives";
import { fromZodError, problem } from "../problem";

/** The IANA zone named by the X-Timezone header, or undefined (= UTC) when it is absent or not a zone. */
function timeZoneOf(header: string | undefined): string | undefined {
  const zone = header?.trim();
  if (zone === undefined || zone === "") return undefined;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The player's newest stored roadmap, or null (a profile after a plan reset has none). */
function latestRoadmap(db: Database, playerId: string): Roadmap | null {
  const row = db
    .query("SELECT json FROM roadmaps WHERE player_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(playerId) as { json: string } | null;
  return row === null ? null : Roadmap.parse(JSON.parse(row.json));
}

/** Completed drills per track, credited to every node of the track (see the header). */
function completedDrillCounts(db: Database, playerId: string, graph: SkillGraph): Record<string, number> {
  const parentOf = new Map(graph.nodes.map((node) => [node.slug, node.parent]));
  const rootOf = (slug: string): string | null => {
    const seen = new Set<string>();
    let current: string | null | undefined = slug;
    while (current !== null && current !== undefined && !seen.has(current)) {
      seen.add(current);
      const parent: string | null | undefined = parentOf.get(current);
      if (parent === null) return current;
      current = parent;
    }
    return null;
  };

  const rows = db
    .query(
      `SELECT sk.slug AS skill, count(*) AS n
         FROM sessions s, json_each(s.items) j
         JOIN drill_versions v ON v.id = json_extract(j.value, '$.drillVersionId')
         JOIN drill_skills ds ON ds.drill_id = v.drill_id AND ds.is_primary = 1
         JOIN skills sk ON sk.id = ds.skill_id
        WHERE s.player_id = ?1 AND json_extract(j.value, '$.done') = 1
        GROUP BY sk.slug`,
    )
    .all(playerId) as Array<{ skill: string; n: number }>;

  const perTrack = new Map<string, number>();
  for (const row of rows) {
    const track = rootOf(row.skill);
    if (track !== null) perTrack.set(track, (perTrack.get(track) ?? 0) + row.n);
  }
  return Object.fromEntries(
    graph.nodes.flatMap((node): [string, number][] => {
      const track = rootOf(node.slug);
      const count = track === null ? undefined : perTrack.get(track);
      return count === undefined ? [] : [[node.slug, count]];
    }),
  );
}

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this
  // holds whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const spec = ENDPOINTS.getJourney;

  app.get(spec.path, requirePlayer(deps), (c: Context<{ Variables: AuthVariables }>) => {
    const query = spec.query.safeParse(c.req.query());
    if (!query.success) return problem(400, "Bad Request", "Invalid request parameters.", fromZodError(query.error));

    const { db } = deps;
    const playerId = c.var.playerId;
    const profile = db.query("SELECT locale FROM player_profiles WHERE player_id = ?1").get(playerId) as { locale: Locale } | null;
    if (profile === null) return problem(404, "Not Found", "The player is not onboarded yet.");

    const locale = query.data.locale ?? profile.locale;
    const timeZone = timeZoneOf(c.req.header("x-timezone"));
    const zone = timeZone === undefined ? {} : { timeZone };

    const journey = buildJourney(db, playerId, locale, new Date(), zone);
    const graph = getSkillGraph(db, DEFAULT_SPORT, locale);
    const roadmap = latestRoadmap(db, playerId);
    const tree =
      graph === null ? [] : deriveTree(graph, roadmap?.tracks ?? [], completedDrillCounts(db, playerId, graph), roadmap?.focus ?? [], locale);

    const body: Journey = { ...journey, tree, milestones: milestones(db, playerId, zone) };
    return c.json(body, 200);
  });
}
