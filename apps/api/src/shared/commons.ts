// Contract: commons knowledge base is seeded for the planner and the library (fc-mol-9do).
//
// Serves: the planner's candidate filter, the drill library (list + facets), the drill detail
// screen, and third-party developers who reuse the export (web, through the @api-types alias).
// Bundled into the browser: imports ONLY "zod", "./primitives" and "./domain".
//
// Call budget: browse -> detail in <= 2 calls (GET the drill list, which carries its own
// facets so the library needs no second enum call; then GET one drill).
//
// Errors are ProblemDetails (RFC 9457) from ./primitives; they are not redeclared here.
//
// Re-exported, never redefined: `SkillTest` and `Attribution` live in ./domain.
//
// Gate-tested, NOT parse-tested: the call budget, and that the planner reads the seeded graph.
// Graph INTEGRITY (unique slugs, parents and prerequisites that exist, no cycles) is NOT part
// of the wire schema, so a partial graph or an export still parses; it is the pure helper
// `graphProblems` for the seeding job and the gate.
//
// PROPOSED, not fixed by the criteria: every path except /api/commons/export.json (which
// PRODUCT.md names) and the shapes marked "derived" below. A later API bead may rename them.
import { z } from "zod";
import { Attribution, Count, SKILL_LEVEL_MAX, SKILL_LEVEL_MIN, Semver, SkillTest, Timestamp } from "./domain";
import type { EndpointSpec } from "./domain";
import {
  DrillContent,
  EntityId,
  Equipment,
  ExperienceLevel,
  LICENSE_IDS,
  Locale,
  LocalizedText,
  Space,
  TrustStatus,
  paginated,
} from "./primitives";

export { Attribution, SkillTest } from "./domain";

// --- Skill graph -------------------------------------------------------------------------

export const SkillPrerequisite = z.object({
  skill: EntityId,
  minLevel: z.int().min(SKILL_LEVEL_MIN).max(SKILL_LEVEL_MAX),
});
export type SkillPrerequisite = z.infer<typeof SkillPrerequisite>;

/**
 * `parent` is null for a root skill. `levels` is the minimal shape the criteria leave open
 * (derived): one LocalizedText description per skill level, index 0 being level
 * SKILL_LEVEL_MIN. `ageMin`/`ageMax` are plain counts, not the player age range.
 */
export const SkillNode = z.object({
  slug: EntityId,
  parent: EntityId.nullable(),
  order: z.int(),
  names: LocalizedText,
  levels: z.array(LocalizedText),
  prerequisites: z.array(SkillPrerequisite),
  ageMin: Count,
  ageMax: Count,
  equipment: Equipment,
  safety: z.array(LocalizedText),
  outcomes: z.array(LocalizedText),
  mistakes: z.array(LocalizedText),
});
export type SkillNode = z.infer<typeof SkillNode>;

/** No integrity refinement: see `graphProblems`. */
export const SkillGraph = z.object({
  sport: EntityId,
  version: z.string().min(1),
  nodes: z.array(SkillNode),
});
export type SkillGraph = z.infer<typeof SkillGraph>;

/**
 * Graph integrity, as human-readable problems (an empty list means sound): duplicate slugs,
 * a parent or prerequisite that is not a node, and cycles along the parent chain or along the
 * prerequisites (a self-reference is a cycle). Pure: no side effects, input untouched.
 */
export function graphProblems(graph: SkillGraph): string[] {
  const problems: string[] = [];
  const known = new Set<string>();
  for (const node of graph.nodes) {
    if (known.has(node.slug)) problems.push(`Duplicate skill slug "${node.slug}"`);
    known.add(node.slug);
  }
  for (const node of graph.nodes) {
    if (node.parent !== null && !known.has(node.parent)) {
      problems.push(`Parent "${node.parent}" of "${node.slug}" is not a node of this graph`);
    }
    for (const prerequisite of node.prerequisites) {
      if (!known.has(prerequisite.skill)) {
        problems.push(`Prerequisite "${prerequisite.skill}" of "${node.slug}" is not a node of this graph`);
      }
    }
  }

  // Edges to missing nodes are already reported above, so they are left out of the cycle search.
  const edgesOf = (targets: (node: SkillNode) => string[]): Map<string, string[]> => {
    const edges = new Map<string, string[]>();
    for (const node of graph.nodes) {
      const existing = edges.get(node.slug) ?? [];
      edges.set(node.slug, [...existing, ...targets(node).filter((target) => known.has(target))]);
    }
    return edges;
  };

  const reportCycles = (label: string, edges: Map<string, string[]>): void => {
    const state = new Map<string, "open" | "done">();
    const path: string[] = [];
    const visit = (slug: string): void => {
      state.set(slug, "open");
      path.push(slug);
      for (const next of edges.get(slug) ?? []) {
        if (state.get(next) === "open") {
          const cycle = [...path.slice(path.indexOf(next)), next];
          problems.push(`Cycle along ${label}: ${cycle.join(" -> ")}`);
        } else if (!state.has(next)) {
          visit(next);
        }
      }
      path.pop();
      state.set(slug, "done");
    };
    for (const slug of edges.keys()) {
      if (!state.has(slug)) visit(slug);
    }
  };

  reportCycles("parents", edgesOf((node) => (node.parent === null ? [] : [node.parent])));
  reportCycles("prerequisites", edgesOf((node) => node.prerequisites.map((prerequisite) => prerequisite.skill)));
  return problems;
}

// --- Drills --------------------------------------------------------------------------------

/**
 * One library row. `space` is the criteria's singular (the drill's primary space); the full
 * list lives in the detail's `content.conditions.spaces`. `level` = ExperienceLevel is an
 * unconfirmed guess. `minutes` is a positive integer, like the dose values in DrillContent.
 *
 * Additive, all OPTIONAL and omitted (never null) when there is no value (fc-mol-hum.6), so a
 * library card needs no detail call per drill: `ageMin` / `ageMax` are the current version's
 * `content.conditions` bounds, `source` / `license` its attribution, and `orgLabel` the label of the
 * most recent review of that version that set its current status.
 */
export const DrillSummary = z.object({
  slug: EntityId,
  title: LocalizedText,
  track: EntityId,
  level: ExperienceLevel,
  minutes: z.int().positive(),
  equipment: Equipment,
  space: Space,
  status: TrustStatus,
  versionId: EntityId,
  ageMin: z.int().nonnegative().optional(),
  ageMax: z.int().nonnegative().optional(),
  source: z.string().optional(),
  license: z.enum(LICENSE_IDS).optional(),
  orgLabel: z.string().optional(),
});
export type DrillSummary = z.infer<typeof DrillSummary>;

/** Derived: an earlier version of the drill. */
export const DrillHistoryEntry = z.object({
  versionId: EntityId,
  semver: Semver,
  createdAt: Timestamp,
  note: z.string().optional(),
});
export type DrillHistoryEntry = z.infer<typeof DrillHistoryEntry>;

export const DrillReview = z.object({
  reviewer: z.string(),
  orgLabel: z.string(),
  from: TrustStatus,
  to: TrustStatus,
  note: z.string(),
  at: Timestamp,
});
export type DrillReview = z.infer<typeof DrillReview>;

/**
 * The current version of a drill. `slug` (derived) identifies the drill, which the export
 * needs; the semver lives in `attribution`. `content` is primitives' DrillContent as-is.
 */
export const DrillDetail = z.object({
  slug: EntityId,
  versionId: EntityId,
  content: DrillContent,
  attribution: Attribution,
  history: z.array(DrillHistoryEntry),
  reviews: z.array(DrillReview),
});
export type DrillDetail = z.infer<typeof DrillDetail>;

const facetEntries = <T extends z.ZodType>(value: T) => z.array(z.object({ value, count: Count }));

/** Facets travel with the list, so the library needs no second enum call. */
export const DrillFacets = z.object({
  skills: z.array(z.object({ slug: EntityId, names: LocalizedText.optional(), count: Count })),
  statuses: facetEntries(TrustStatus),
  equipment: facetEntries(Equipment),
  levels: facetEntries(ExperienceLevel),
});
export type DrillFacets = z.infer<typeof DrillFacets>;

export const DrillListResponse = paginated(DrillSummary).extend({ facets: DrillFacets });
export type DrillListResponse = z.infer<typeof DrillListResponse>;

/**
 * Derived from the library consumer: one filter per facet plus `space`, the paginated()
 * cursor and a page size. Query strings arrive as text, so `limit` is coerced.
 */
export const DrillListQuery = z.strictObject({
  skill: EntityId.optional(),
  level: ExperienceLevel.optional(),
  equipment: Equipment.optional(),
  space: Space.optional(),
  status: TrustStatus.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  locale: Locale.optional(),
});
export type DrillListQuery = z.infer<typeof DrillListQuery>;

export const DrillParams = z.strictObject({ slug: EntityId });
export type DrillParams = z.infer<typeof DrillParams>;

export const DrillQuery = z.strictObject({ locale: Locale.optional() });
export type DrillQuery = z.infer<typeof DrillQuery>;

// --- Export (public, third-party developers) -------------------------------------------------

/** Derived: one sport with its graph, baseline tests and drills. */
export const ExportedSport = z.object({
  slug: EntityId,
  name: LocalizedText,
  graph: SkillGraph,
  tests: z.array(SkillTest),
  drills: z.array(DrillDetail),
});
export type ExportedSport = z.infer<typeof ExportedSport>;

/**
 * snake_case keys: a published data format, not an internal DTO. `license` is required (no
 * default). `attribution_notice` carries the attribution line of CONTENT-LICENSE.md, so a
 * blank one is rejected. `schema_version` as a semver is derived.
 */
export const CommonsExport = z.object({
  schema_version: Semver,
  license: z.enum(LICENSE_IDS),
  attribution_notice: z.string().min(1),
  generated_at: Timestamp,
  sports: z.array(ExportedSport),
});
export type CommonsExport = z.infer<typeof CommonsExport>;

// --- Endpoints ---------------------------------------------------------------------------------

export const ENDPOINTS = {
  listDrills: {
    method: "GET",
    path: "/api/commons/drills",
    query: DrillListQuery,
    response: DrillListResponse,
    public: true,
  },
  getDrill: {
    method: "GET",
    path: "/api/commons/drills/:slug",
    params: DrillParams,
    query: DrillQuery,
    response: DrillDetail,
    public: true,
  },
  export: {
    method: "GET",
    path: "/api/commons/export.json",
    response: CommonsExport,
    contentType: "application/json",
    public: true,
  },
} as const satisfies Record<string, EndpointSpec>;
