// GET and PUT /api/player/consents (fc-mol-bjm.2): the privacy settings screen reads and changes what the player agreed to.
//
// Both sit behind requirePlayer (anonymous players included), which runs BEFORE the body is read: no session is a 401
// whatever the body holds. The player is always the session's (`c.var.playerId`); the request schema is strict, so a
// body that names anything else (a `playerId`) is a 422. EVERY response, the guard's 401 and the problems included, is
// `Cache-Control: no-store`: the answers are per player and change when they do.
//
// GET  answers 200 Consents; a player who never chose (or has not onboarded) has everything off.
// PUT  (body: ENDPOINTS.updateConsents.request) answers the updated Consents (one call, mutation returns the resource):
//   1. a body that is not a JSON object is a 400; the contract's schema refuses anything else with a 422 and
//      `errors: [{ pointer, detail }]` (JSON Pointers as problem.ts, "/playerId" for an unknown key), nothing written;
//   2. the store (player/consents.ts) appends the history rows in one transaction and applies the under-13 rule from
//      the player's age: a grant of videoAnalysis under 13 without guardianConfirmed is a 422 pointing at
//      "/guardianConfirmed", nothing written; revocation is always allowed;
//   3. a player with no profile has no age: 404 problem "not onboarded" (as the other player routes), nothing written.
import type { Context, Hono, MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { GuardianConfirmationRequiredError, PlayerNotOnboardedError, getConsents, setConsents } from "../../player/consents";
import { ENDPOINTS } from "../../shared/privacy";
import { fromZodError, problem } from "../problem";

/** Every response of the routes is never cached, whoever produced it (the guard and an unhandled error included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

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
  const getSpec = ENDPOINTS.getConsents;
  const putSpec = ENDPOINTS.updateConsents;

  app.get(getSpec.path, noStore, requirePlayer(deps), (c: Context<{ Variables: AuthVariables }>) =>
    c.json(getConsents(db, c.var.playerId), 200),
  );

  app.put(putSpec.path, noStore, requirePlayer(deps), async (c: Context<{ Variables: AuthVariables }>) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    const parsed = putSpec.request.safeParse(body);
    if (!parsed.success) {
      return problem(422, "Unprocessable Entity", "The request is invalid.", fromZodError(expandUnknownKeys(parsed.error)));
    }

    try {
      return c.json(setConsents(db, c.var.playerId, parsed.data), 200);
    } catch (error) {
      if (error instanceof GuardianConfirmationRequiredError) {
        return problem(422, "Unprocessable Entity", "The request is invalid.", [
          { pointer: "/guardianConfirmed", detail: "A guardian must confirm (true) for a player under 13 to grant video analysis." },
        ]);
      }
      if (error instanceof PlayerNotOnboardedError) return problem(404, "Not Found", "The player is not onboarded.");
      throw error;
    }
  });
}
