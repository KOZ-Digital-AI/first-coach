// Contract: visitor lands, switches language and starts (fc-mol-opc).
//
// Serves the landing page. Call budget: the landing page renders with exactly
// 1 API call (GET /api/commons/stats). No mutation in this slice.
// Errors are ProblemDetails (see ./primitives); they are not redeclared here.
//
// Gate-tested rather than parse-tested: the 1-call budget and the endpoint
// being public and cacheable (HTTP cache headers are the route's job, not the
// schema's). Parse-tested here: the CommonsStats shape and ENDPOINTS.
//
// Imports ONLY "zod", "./primitives" and "./domain": bundled into the browser
// through the @api-types alias, so no node/bun APIs and no side effects.
import { z } from "zod";
import { Count } from "./domain";
import type { EndpointSpec } from "./domain";

/** RESPONSE: plain object, so keys the server adds later are stripped, never a failure. */
export const CommonsStats = z.object({
  drills: Count,
  tracks: Count,
  contributions: Count,
  sports: Count,
});
export type CommonsStats = z.infer<typeof CommonsStats>;

export const ENDPOINTS = {
  getStats: {
    method: "GET",
    path: "/api/commons/stats",
    response: CommonsStats,
    public: true,
  },
} as const satisfies Record<string, EndpointSpec>;
