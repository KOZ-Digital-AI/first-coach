// POST /api/player/test-results (fc-mol-0bt.5): the retest batch. A player re-measures skill tests; the server
// stores the batch, re-estimates the levels, rebuilds the roadmap and answers the refreshed Journey AND roadmap
// in ONE response (the contract's call budget: a retest is one call).
//
// Behind requirePlayer (anonymous players included), which runs BEFORE the body is read: no session is a 401
// whatever the body holds. The player is always the session's (`c.var.playerId`); nothing in the body can name
// one (the contract's request schema is strict, so a `playerId` key is a 422 at its pointer). This route holds
// player data and FAILS CLOSED: anything it cannot positively accept is refused before a single row is written,
// and an unexpected error is rethrown to the app's onError (500), never swallowed.
//
// Order of the checks, each answering with an RFC 9457 problem (http/problem):
//   1. no session                                    401 (the guard);
//   2. body larger than MAX_BODY_BYTES                413, judged by a declared content-length AND by the bytes
//                                                     actually read (the stream is cancelled at the limit);
//   3. body that is not a JSON object                 400;
//   4. the contract's TestResultsRequest              422 with `errors: [{ pointer, detail }]` (JSON Pointers,
//                                                     "/results/0/clientUuid", "/playerId" for an unknown key);
//   5. more than MAX_RESULTS results                  422 at "/results";
//   6. ONE `db.transaction(...).immediate()`, in this order:
//        - no player_profiles row                    404 "not onboarded" (nothing written);
//        - the sport's tests are not seeded          503 (nothing written);
//        - a negative value                          422 at /results/<i>/value, an unknown test slug 422 at
//                                                     /results/<i>/testSlug, ALL listed together, before any write;
//        - the batch is stored idempotently by clientUuid (profile-repo insertBaseline), the levels are
//          re-estimated from the STORED results, the roadmap is rebuilt and stored (profile-repo saveRoadmap, which
//          writes nothing when the newest stored roadmap is identical, so a replay adds no row).
//   Then the Journey is read and the answer is `{ journey, roadmap }`, the same on the first call and on every
//   replay of it.
//
// Readings the criteria leave open, each pinned by player-tests.routes.test.ts:
//   * Re-estimation: the level of a track comes from the player's LATEST non-skipped stored result of its test
//     (by recorded_at, then id), through the merged estimateLevels; a track without such a result keeps the
//     self-declared level (source "self"). So a later, lower result lowers the track: the roadmap says where the
//     player is now, and the Journey's personalBest keeps the best.
//   * Negative values: the contract's `value` is z.number(), which allows them. A measured time, count or score
//     is never below 0, so a negative value is refused (422); 0 is a valid measurement. A skipped result has no
//     place here (the contract's TestResult has no `skipped`; the strict schema refuses it).
//   * Bounds the contract leaves open: MAX_RESULTS results (there are a handful of tests per sport; a batch is a
//     retest, not an import) and MAX_BODY_BYTES bytes.
//   * A clientUuid stored for ANOTHER player is dropped by insertBaseline, never taken over or rewritten (the
//     schema makes client_uuid unique across players); the response derives from the caller's own rows only, so
//     it tells nothing about the other player's row. A replayed clientUuid keeps the FIRST stored value.
//   * The sport is ONBOARDING_SPORT, as POST /api/player/start (the profile has no sport).
//   * The Journey is NOT reassembled here: it is what GET /api/player/journey answers for the same session
//     (fetched in-process from that route through the same app, right after the transaction commits), so the
//     retest response and the dashboard can never disagree. The X-Timezone header is forwarded to it. If that
//     route is not mounted or answers anything but 200, this route answers a 500 (the results are stored and a
//     retry with the same clientUuids is a safe replay).
import { Hono } from "hono";
import type { Context } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillTests } from "../../commons/repo";
import { estimateLevels } from "../../planner/levels";
import type { LevelResult } from "../../planner/levels";
import { buildRoadmap } from "../../planner/roadmap";
import { getGraphVersion, getProfile, insertBaseline, saveRoadmap } from "../../player/profile-repo";
import type { Roadmap } from "../../shared/domain";
import { ENDPOINTS } from "../../shared/journey";
import type { TestResult } from "../../shared/journey";
import type { ProblemError } from "../../shared/primitives";
import { fromZodError, problem } from "../problem";
import { ONBOARDING_SPORT } from "./player-start.routes";

/** Most results one request may carry. */
export const MAX_RESULTS = 50;
/** Largest request body, in bytes. 50 results are about 10 KiB. */
export const MAX_BODY_BYTES = 32 * 1024;

const spec = ENDPOINTS.postTestResults;

/** One issue per unknown key, at that key's own path, so its pointer names the key. */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] })) : [issue],
    ),
  );
}

/**
 * The request body as text, or null when it is larger than MAX_BODY_BYTES: judged by the declared
 * content-length first, then by the bytes actually received (the stream is cancelled at the limit, so an
 * oversized or lying body is never buffered whole).
 */
async function readBoundedText(req: Request): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return null;
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type Outcome =
  | { kind: "ok"; roadmap: Roadmap }
  | { kind: "not-onboarded" }
  | { kind: "not-seeded" }
  | { kind: "invalid"; errors: ProblemError[] };

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const player = requirePlayer(deps);
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.post(spec.path, player, async (c: Context<{ Variables: AuthVariables }>) => {
    const text = await readBoundedText(c.req.raw);
    if (text === null) return problem(413, "Payload Too Large", `The request body must be at most ${MAX_BODY_BYTES} bytes.`);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }

    const parsed = spec.request.safeParse(body);
    if (!parsed.success) {
      return problem(422, "Unprocessable Entity", "The request is invalid.", fromZodError(expandUnknownKeys(parsed.error)));
    }
    const { results } = parsed.data;
    if (results.length > MAX_RESULTS) {
      return problem(422, "Unprocessable Entity", "The request is invalid.", [
        { pointer: "/results", detail: `At most ${MAX_RESULTS} results per request.` },
      ]);
    }
    const playerId = c.get("playerId");

    const outcome = db
      .transaction((): Outcome => {
        const profile = getProfile(db, playerId);
        if (profile === null) return { kind: "not-onboarded" };
        const graphVersion = getGraphVersion(db, ONBOARDING_SPORT);
        if (graphVersion === null) return { kind: "not-seeded" };
        const tests = getSkillTests(db, ONBOARDING_SPORT);

        const known = new Set(tests.map((test) => test.slug));
        const errors: ProblemError[] = [];
        results.forEach((result: TestResult, index) => {
          if (result.value < 0) errors.push({ pointer: `/results/${index}/value`, detail: "A test result cannot be negative." });
          if (!known.has(result.testSlug)) errors.push({ pointer: `/results/${index}/testSlug`, detail: "Not a skill test of this sport." });
        });
        if (errors.length > 0) return { kind: "invalid", errors };

        insertBaseline(db, playerId, results);

        // The latest non-skipped stored result of each test (rows come oldest first, so a later one overwrites).
        const latest = new Map<string, LevelResult>();
        const rows = db
          .query<{ test_slug: string; value: number; errors: number | null; skipped: number }, [string]>(
            "SELECT test_slug, value, errors, skipped FROM test_results WHERE player_id = ? ORDER BY recorded_at, id",
          )
          .all(playerId);
        for (const row of rows) {
          if (row.skipped === 1) continue;
          latest.set(row.test_slug, { testSlug: row.test_slug, value: row.value, ...(row.errors !== null && { errors: row.errors }), skipped: false });
        }

        const roadmap = buildRoadmap(profile, estimateLevels(profile.age, [...latest.values()], tests, profile.level));
        saveRoadmap(db, playerId, roadmap, graphVersion);
        return { kind: "ok", roadmap };
      })
      .immediate();

    switch (outcome.kind) {
      case "not-onboarded":
        return problem(404, "Not Found", "The player is not onboarded yet.");
      case "not-seeded":
        return problem(503, "Service Unavailable", `The ${ONBOARDING_SPORT} skill tests are not loaded yet.`);
      case "invalid":
        return problem(422, "Unprocessable Entity", "The request is invalid.", outcome.errors);
      case "ok":
        break;
    }

    // The player's own Journey, from the journey route itself (see the header).
    const forwarded = new Headers();
    for (const name of ["cookie", "x-timezone"]) {
      const value = c.req.header(name);
      if (value !== undefined) forwarded.set(name, value);
    }
    const journeyResponse = await app.request(ENDPOINTS.getJourney.path, { headers: forwarded });
    if (journeyResponse.status !== 200) throw new Error(`the journey route answered ${journeyResponse.status}`);

    return c.json(spec.response.parse({ journey: await journeyResponse.json(), roadmap: outcome.roadmap }), 200);
  });

  app.route("/", routes);
}
