// DELETE /api/player (fc-mol-bjm.5): the player erases their data and ends their identity.
//
// Behind requirePlayer (anonymous players and accounts alike): no session is a 401. The player is always the
// session's (`c.var.playerId`); the request has no body and nothing in it names a player. Every response, the
// guard's 401 and an unhandled 500 included, is `Cache-Control: no-store`.
//
// What it does (the rules and readings are in ../../player/delete.ts)
//   1. ONE transaction: deletes the profile (the foreign keys cascade every player-owned row), verifies by
//      introspection that no table with a player_id column still holds the id, and deletes the Better Auth user,
//      its sessions and its accounts. A table that forgot its cascade makes it throw: 500 (the app's error
//      handler logs it), NOTHING is changed and no cookie is cleared, so the player stays signed in and can retry;
//   2. answers 204 with no body and the session cookies cleared: Better Auth's own sign-out is run afterwards
//      (its session row is already gone, which it tolerates) and only its Set-Cookie headers are forwarded, so
//      the cookie names and attributes are always Better Auth's, secure prefix included.
// Contributions the caller made stay attributed (they are not player data); see delete.ts.
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { deletePlayerAccount } from "../../player/delete";
import { ENDPOINTS } from "../../shared/privacy";

const NO_STORE = "no-store";

/** Every response of the route is never cached, whoever produced it (the guard and an unhandled error included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", NO_STORE);
};

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard and the erasure read Better Auth's tables. Idempotent and shared with auth.routes.ts.
  const auth = getAuth(deps);
  await ensureAuthSchema(auth, deps.db);
  const { db } = deps;

  app.delete(ENDPOINTS.deletePlayer.path, noStore, requirePlayer(deps), async (c: Context<{ Variables: AuthVariables }>) => {
    deletePlayerAccount(db, c.var.playerId);
    const { headers } = await auth.api.signOut({ headers: c.req.raw.headers, returnHeaders: true });
    for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
    return c.body(null, ENDPOINTS.deletePlayer.status);
  });
}
