// POST /api/player/start and GET /api/player/me (fc-mol-9l4.9): a player onboards without signup.
//
// Both sit behind requirePlayer (anonymous players included), which runs BEFORE the body is read: no
// session is a 401 whatever the body holds. The player id is `c.var.playerId`, the session's user id;
// nothing in the body can name a player (the request schema is strict, so a `playerId` key is a 422).
//
// POST /api/player/start
//   1. a body that is not a JSON object is a 400; the contract's StartRequest schema refuses anything else
//      with a 422 and `errors: [{ pointer, detail }]` (JSON Pointers as problem.ts: "/profile/age",
//      "/baseline/0/clientUuid", "/playerId" for an unknown key), and NOTHING is written;
//   2. then ONE `db.transaction(...).immediate()` does, in this order: read the sport's tests, refuse a
//      baseline entry whose test is not one of them (422 on "/baseline/<i>/testSlug", before any write),
//      upsert the profile, insert the baseline idempotently by clientUuid, estimate the levels from the
//      STORED results (age band, thresholds, self level as the fallback), build the roadmap and store it;
//   3. answer 200 with `{ profile, roadmap }`, on the first call and on every replay alike.
// GET /api/player/me answers the same `{ profile, roadmap }` from what is stored, or a 404 problem
// "not onboarded" (the /train route guard's question).
//
// Ambiguities, read the simplest way:
//   - The contract's StartRequest carries no sport, so the baseline is judged against ONBOARDING_SPORT.
//   - GET /api/player/me is not declared in the shared contracts; its response is StartResponse.
//   - A database where that sport is not seeded cannot build a plan: 503, nothing written.
import { Hono } from "hono";
import type { Context } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillTests } from "../../commons/repo";
import { estimateLevels } from "../../planner/levels";
import { buildRoadmap } from "../../planner/roadmap";
import {
  UnknownTestError,
  assertKnownTests,
  getGraphVersion,
  getProfile,
  getRoadmap,
  insertBaseline,
  saveRoadmap,
  upsertProfile,
} from "../../player/profile-repo";
import { ENDPOINTS } from "../../shared/onboarding";
import type { StartResponse } from "../../shared/onboarding";
import { fromZodError, problem } from "../problem";

/** The sport every player onboards into: the contract's StartRequest has no sport field. */
export const ONBOARDING_SPORT = "football";

export const ME_PATH = "/api/player/me";

/** One issue per unknown key, at that key's own path, so its pointer names the key. */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] })) : [issue],
    ),
  );
}

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const player = requirePlayer(deps);
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.post(ENDPOINTS.start.path, player, async (c: Context<{ Variables: AuthVariables }>) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }

    const parsed = ENDPOINTS.start.request.safeParse(body);
    if (!parsed.success) {
      return problem(422, "Unprocessable Entity", "The request is invalid.", fromZodError(expandUnknownKeys(parsed.error)));
    }
    const { profile, baseline } = parsed.data;
    const playerId = c.get("playerId");

    try {
      const response = db
        .transaction((): StartResponse | null => {
          const graphVersion = getGraphVersion(db, ONBOARDING_SPORT);
          if (graphVersion === null) return null;
          const tests = getSkillTests(db, ONBOARDING_SPORT);
          assertKnownTests(baseline, tests.map((test) => test.slug));

          const stored = upsertProfile(db, playerId, profile);
          const results = insertBaseline(db, playerId, baseline);
          const levels = estimateLevels(stored.age, results, tests, stored.level);
          const roadmap = buildRoadmap(stored, levels);
          saveRoadmap(db, playerId, roadmap, graphVersion);
          return { profile: stored, roadmap };
        })
        .immediate();
      if (response === null) return problem(503, "Service Unavailable", `The ${ONBOARDING_SPORT} skill tests are not loaded yet.`);
      return c.json(response, 200);
    } catch (error) {
      if (error instanceof UnknownTestError) {
        return problem(422, "Unprocessable Entity", "The request is invalid.", [
          { pointer: `/baseline/${error.index}/testSlug`, detail: "Not a skill test of this sport." },
        ]);
      }
      throw error;
    }
  });

  routes.get(ME_PATH, player, (c: Context<{ Variables: AuthVariables }>) => {
    const playerId = c.get("playerId");
    const found = db.transaction((): StartResponse | null => {
      const profile = getProfile(db, playerId);
      const roadmap = getRoadmap(db, playerId);
      return profile === null || roadmap === null ? null : { profile, roadmap };
    })();
    if (found === null) return problem(404, "Not Found", "The player is not onboarded.");
    return c.json(found, 200);
  });

  app.route("/", routes);
}
