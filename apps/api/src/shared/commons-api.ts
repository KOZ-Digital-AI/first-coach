// Contract: visitor browses the Open Sport Commons and downloads the open dataset (fc-mol-nu7).
//
// The HTTP contract for the library, the drill detail, the skill graph and third-party
// developers. It REUSES the J1a schemas of ./commons (DrillListResponse, DrillDetail,
// SkillGraph, CommonsExport): they are referenced by ENDPOINTS, never redefined or re-exported.
//
// SUPERSEDES the endpoint constants of ./commons (its `ENDPOINTS` and the query/params schemas
// DrillListQuery, DrillParams, DrillQuery), whose paths other than /api/commons/export.json were
// marked PROPOSED. The paths below are the criteria's; a later API bead uses THIS file's
// ENDPOINTS. ./commons stays untouched, for its response schemas.
//
// Bundled into the browser through the @api-types alias: imports ONLY "zod", "./primitives",
// "./domain" and "./commons" (no node/bun APIs, no side effects). `z.toJSONSchema` is NOT used
// here: generating schema.json belongs to the API side.
//
// Requests are strict: an unknown query or param key fails. Responses stay loose (unknown server
// keys are stripped). Query values arrive as strings and every filter here is a string or a
// primitives enum (ExperienceLevel is the strings beginner|basic|intermediate), so nothing is
// coerced. An unknown enum value fails at the single key (e.g. path ["status"]), which the
// repo's fromZodError turns into the pointer "/status" of a 400 problem (RFC 9457).
//
// Gate-tested, NOT parse-tested: the call budget (browse -> detail in <= 2 calls: the list
// carries its own facets), that the export serves every locale and attribution for every drill
// (the schema only proves a drill without attribution is refused), and that schema.json is
// generated from the Zod schema of CommonsExport rather than written by hand.
import { z } from "zod";
import { CommonsExport, DrillDetail, DrillListResponse, SkillGraph } from "./commons";
import type { EndpointSpec } from "./domain";
import { EntityId, Equipment, ExperienceLevel, Locale, TrustStatus } from "./primitives";

// --- GET /api/commons/drills?skill&status&equipment&level&q&locale ---------------------------

/** All filters optional. `q` is a free-text search and must be non-empty when present. */
export const CommonsDrillQuery = z.strictObject({
  skill: EntityId.optional(),
  status: TrustStatus.optional(),
  equipment: Equipment.optional(),
  level: ExperienceLevel.optional(),
  q: z.string().min(1).optional(),
  locale: Locale.optional(),
});
export type CommonsDrillQuery = z.infer<typeof CommonsDrillQuery>;

// --- GET /api/commons/drills/:slug?locale and GET /api/commons/skill-graph/:sport?locale -----

export const CommonsDrillParams = z.strictObject({ slug: EntityId });
export type CommonsDrillParams = z.infer<typeof CommonsDrillParams>;

export const CommonsSkillGraphParams = z.strictObject({ sport: EntityId });
export type CommonsSkillGraphParams = z.infer<typeof CommonsSkillGraphParams>;

export const CommonsLocaleQuery = z.strictObject({ locale: Locale.optional() });
export type CommonsLocaleQuery = z.infer<typeof CommonsLocaleQuery>;

// --- GET /api/commons/schema.json --------------------------------------------------------------

/** A JSON Schema document (of CommonsExport): any JSON object, its keys are not modelled. */
export const CommonsJsonSchemaDocument = z.record(z.string(), z.unknown());
export type CommonsJsonSchemaDocument = z.infer<typeof CommonsJsonSchemaDocument>;

// --- Endpoints ---------------------------------------------------------------------------------

export const ENDPOINTS = {
  listDrills: {
    method: "GET",
    path: "/api/commons/drills",
    query: CommonsDrillQuery,
    response: DrillListResponse,
    public: true,
  },
  getDrill: {
    method: "GET",
    path: "/api/commons/drills/:slug",
    params: CommonsDrillParams,
    query: CommonsLocaleQuery,
    response: DrillDetail,
    public: true,
  },
  getSkillGraph: {
    method: "GET",
    path: "/api/commons/skill-graph/:sport",
    params: CommonsSkillGraphParams,
    query: CommonsLocaleQuery,
    response: SkillGraph,
    public: true,
  },
  exportCommons: {
    method: "GET",
    path: "/api/commons/export.json",
    response: CommonsExport,
    contentType: "application/json",
    public: true,
  },
  commonsSchema: {
    method: "GET",
    path: "/api/commons/schema.json",
    response: CommonsJsonSchemaDocument,
    contentType: "application/json",
    public: true,
  },
} as const satisfies Record<string, EndpointSpec>;
