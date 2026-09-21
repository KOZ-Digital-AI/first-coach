// Better Auth handler at /api/auth/*. Route modules mount in alphabetical order, so this
// runs before createApp's `/api/*` 404 guard and the static SPA mount, and needs no `00-`
// prefix. Better Auth's tables are created here, before the server starts listening.
import type { Hono } from "hono";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  const auth = getAuth(deps);
  await ensureAuthSchema(auth, deps.db);
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}
