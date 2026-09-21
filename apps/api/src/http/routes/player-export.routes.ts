// GET /api/player/export (fc-mol-bjm.4): the player downloads everything stored about them as a JSON attachment.
//
// Behind requirePlayer (anonymous players included: the player is whoever holds the session; the guard sets
// `c.var.playerId`, and nothing in the request, query and headers included, can name another player). No session
// is a 401. The document is built by player/export.ts; the response is `application/json` with a
// `Content-Disposition: attachment` and, like every response of this route (the guard's 401 and an unhandled 500
// included), `Cache-Control: no-store`: it is personal data and must not be kept by a cache.
// A player who never onboarded still gets a (mostly empty) document, not a 404.
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { buildPlayerExport } from "../../player/export";
import { ENDPOINTS } from "../../shared/privacy";

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const spec = ENDPOINTS.exportPlayer;

  app.get(spec.path, noStore, requirePlayer(deps), (c: Context<{ Variables: AuthVariables }>) => {
    const doc = buildPlayerExport(deps.db, c.var.playerId);
    c.header("Content-Disposition", `attachment; filename="first-coach-export-${doc.exportedAt.slice(0, 10)}.json"`);
    return c.json(doc, 200);
  });
}
