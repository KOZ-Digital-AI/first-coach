// Better Auth handler at /api/auth/*. Route modules mount in alphabetical order, so this
// runs before createApp's `/api/*` 404 guard and the static SPA mount, and needs no `00-`
// prefix. Better Auth's tables are created here, before the server starts listening.
import type { Hono } from "hono";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  const auth = getAuth(deps);
  await ensureAuthSchema(auth, deps.db);
  // This one wildcard mount is Better Auth's ENTIRE HTTP surface (auth-gate spec §4, P4):
  //   - sign-in/sign-up/sign-out (email + anonymous), get-session: meant to be reachable with no
  //     session, by anyone, always.
  //   - the admin plugin's user-management sub-routes (/api/auth/admin/list-users, set-role,
  //     ban-user, unban-user, impersonate-user, create-user, remove-user, ...): NOT guarded by a
  //     Hono middleware here. Better Auth's own `adminMiddleware` enforces the session requirement
  //     (no session -> 401) and `adminRoles: ["admin"]` (see better-auth.ts) enforces the role (a
  //     signed-in non-admin, anonymous player included -> 403), entirely inside the library, before
  //     any of these route handlers run.
  // Mounting the whole handler with no Hono guard is correct and deliberate, not a gap: adding one
  // here would 401 the public sign-in/sign-up endpoints too. auth.routes.test.ts is what proves the
  // admin sub-routes are still closed — it hits them with no session, an anonymous session and a
  // contributor session (each refused) and an admin session (which succeeds), so a regression in
  // Better Auth's own gate fails CI instead of shipping.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
}
