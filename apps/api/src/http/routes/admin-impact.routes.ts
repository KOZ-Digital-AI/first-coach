// GET /api/admin/impact (fc-mol-0v3.6): the impact numbers for the admin page (`getImpact`).
//
// Behind requireAdmin: no session is a 401, a signed-in non-admin a 403, and neither reaches the
// database. The answer is computed on every request (nothing is cached), with the wall clock read
// HERE and injected into computeImpact, which has none of its own. Aggregates only: the response
// holds no player id, user id or name.
import type { Hono } from "hono";
import type { AppDeps } from "../../app";
import { computeImpact } from "../../admin/impact";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requireAdmin } from "../../auth/middleware";
import { ENDPOINTS } from "../../shared/admin";

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this
  // holds whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const admin = requireAdmin(deps);

  app.get(ENDPOINTS.getImpact.path, admin, (c) => c.json(computeImpact(deps.db, new Date()), 200));
}
