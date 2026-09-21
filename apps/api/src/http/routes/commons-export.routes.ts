// GET /api/commons/export.json and GET /api/commons/schema.json: the open dataset and the JSON
// Schema it validates against. Both are public. The export is built from SQLite on every request;
// the schema is generated from the CommonsExport Zod contract. A build failure is left to the
// app's onError (problem+json 500).
import type { Hono } from "hono";
import type { AppDeps } from "../../app";
import { buildExport, buildSchema } from "../../commons/export";
import { ENDPOINTS } from "../../shared/commons-api";

export function register(app: Hono, deps: AppDeps): void {
  app.get(ENDPOINTS.exportCommons.path, (c) => c.json(buildExport(deps.db), 200));
  app.get(ENDPOINTS.commonsSchema.path, (c) => c.json(buildSchema(), 200));
}
