// GET /api/commons/stats: the landing stat strip's one call. Public; the numbers are computed
// from SQLite on every request by the commons repository.
import type { Hono } from "hono";
import type { AppDeps } from "../../app";
import { getStats } from "../../commons/repo";
import { ENDPOINTS } from "../../shared/stats";
import type { CommonsStats } from "../../shared/stats";

export function register(app: Hono, deps: AppDeps): void {
  app.get(ENDPOINTS.getStats.path, (c) => {
    const body: CommonsStats = getStats(deps.db);
    return c.json(body, 200);
  });
}
