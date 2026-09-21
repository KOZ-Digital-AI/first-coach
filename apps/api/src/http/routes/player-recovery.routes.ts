// POST /api/player/recovery-code and POST /api/player/recover (fc-mol-bjm.3): a player without an account
// keeps their progress across devices with a code.
//
// Both sit behind requirePlayer (anonymous players included), which runs BEFORE the body is read: no session is a
// 401 whatever the body holds. The player is always the session's (`c.var.playerId`). EVERY response, the guard's
// 401, the problems and an unhandled 500 included, is `Cache-Control: no-store`: the create answer carries a secret.
// The logic (code, hash, restore transaction) is player/recovery.ts; this file is HTTP only.
//
// POST /api/player/recovery-code   -> 200 {code, createdAt}; 404 "not onboarded" when there is no profile to recover.
//   The code is shown once and replaces any earlier one.
// POST /api/player/recover         -> 200 {profile, roadmap}
//   The session must be an ANONYMOUS player (403 for an account: anonymous users carry the role contributor, so
//   the role cannot tell, `isAnonymous` does). Order: guard, anonymous check, attempt limit, body.
//   1. a body that is not a JSON object is a 400; an unknown key or a `replace` that is not a boolean is a 422
//      with `errors: [{ pointer, detail }]` (a client bug, nothing to hide);
//   2. every failure about the CODE (missing, malformed, unknown, replaced) is ONE generic 422 with no `errors`,
//      so neither the shape nor the existence of a code is revealed;
//   3. the current session already has training data and no `replace: true` -> 409 (only someone holding a valid
//      code can see it); otherwise the transaction of recoverPlayer moves everything.
//
// Readings the criteria leave open
//   * ATTEMPT LIMIT keyed by client IP ONLY, 5 per 15 minutes (RATE_LIMITS.recover). The criteria say "per session
//     and IP", but a session key lets a guesser mint a fresh anonymous session for every 5 guesses; the IP key
//     cannot be reset that way (fc-bs4). rateLimit() keys on `${playerId}|${ip}`; the wrapper below hands it one
//     constant in place of the player id, so the limiter's trusted-proxy IP rule and its fail-closed behaviour are
//     reused and rate-limit.ts is not changed. Every request that gets past the guards counts, a failed one
//     included. Creating a code is not limited (it needs the player's own session and reveals nothing).
//   * `replace` is not in the contract's RecoverRequest (a strict object with `code` only): it is accepted here in
//     an envelope that adds it, and `code` is still parsed by the contract's own field schema. CONTRACT GAP.
//   * "Training data" = a row of the current session's id in ANY table that has a player_id.
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z, ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { rateLimit } from "../../auth/rate-limit";
import { createRecoveryCode, recoverPlayer } from "../../player/recovery";
import { ENDPOINTS } from "../../shared/privacy";
import type { RecoverResponse } from "../../shared/privacy";
import { fromZodError, problem } from "../problem";

type Ctx = Context<{ Variables: AuthVariables }>;

const NO_STORE = "no-store";

/** Every response of the routes is never cached, whoever produced it (the guard and an unhandled error included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", NO_STORE);
};

/** What the rate limiter is keyed with instead of the player id: one bucket per client IP. */
const IP_ONLY_KEY = "recover";

/** rateLimit("recover") keyed by client IP only (see the header). Mount after a guard. */
function ipOnlyRateLimit(): MiddlewareHandler<{ Variables: AuthVariables }> {
  const limiter = rateLimit("recover");
  return async (c, next) => {
    const playerId = c.get("playerId");
    c.set("playerId", IP_ONLY_KEY);
    return limiter(c, async () => {
      c.set("playerId", playerId);
      await next();
    });
  };
}

/** The contract's RecoverRequest plus `replace`; `code` is validated separately, so its failure stays generic. */
const RecoverEnvelope = z.strictObject({ code: z.unknown(), replace: z.boolean().optional() });

/** One issue per unknown key, at that key's own path, so its pointer names the key. */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] })) : [issue],
    ),
  );
}

/** The one answer to every problem with the code itself. */
const invalidCode = (): Response => problem(422, "Unprocessable Entity", "The recovery code is not valid.");

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const player = requirePlayer(deps);
  const codeSpec = ENDPOINTS.createRecoveryCode;
  const recoverSpec = ENDPOINTS.recover;

  app.post(codeSpec.path, noStore, player, (c: Ctx) => {
    const created = createRecoveryCode(db, c.get("playerId"));
    if (created === null) return problem(404, "Not Found", "The player is not onboarded.");
    return c.json(created, 200);
  });

  const anonymousOnly: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    if (!c.get("user").isAnonymous) {
      return problem(403, "Forbidden", "Progress can only be restored into an anonymous player session.");
    }
    await next();
  };

  app.post(recoverSpec.path, noStore, player, anonymousOnly, ipOnlyRateLimit(), async (c: Ctx) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return problem(400, "Bad Request", "The request body must be a JSON object.");
    }

    const envelope = RecoverEnvelope.safeParse(body);
    if (!envelope.success) {
      return problem(422, "Unprocessable Entity", "The request is invalid.", fromZodError(expandUnknownKeys(envelope.error)));
    }
    const code = recoverSpec.request.shape.code.safeParse(envelope.data.code);
    if (!code.success) return invalidCode();

    const outcome = recoverPlayer(db, code.data, c.get("playerId"), { replace: envelope.data.replace === true });
    switch (outcome.status) {
      case "invalid":
        return invalidCode();
      case "conflict":
        return problem(409, "Conflict", "This session already has training data. Send replace: true to replace it with the recovered progress.");
      case "recovered": {
        const answer: RecoverResponse = { profile: outcome.profile, roadmap: outcome.roadmap };
        return c.json(answer, 200);
      }
    }
  });
}
