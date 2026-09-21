// Contract: player sees measurable progress and retests skills (fc-mol-szj).
//
// Serves the My Journey dashboard, the skill tree, the retest flow and the plan
// settings. Consumed at RUNTIME by the web through the `@api-types/*` alias, so
// this module imports ONLY "zod", "./primitives" and "./domain" (no node/bun
// APIs, no side effects).
//
// Call budget: the dashboard is 1 call (GET journey); a retest is 1 call (POST
// test-results returns the refreshed journey AND roadmap). Mutations return the
// updated resources.
//
// Errors on every endpoint are ProblemDetails (primitives); it is never redeclared here.
//
// Conventions: requests are strict objects, responses are plain objects (unknown
// server keys are stripped, so additive server changes never break cached PWA
// clients). `locale` is a query on the GET only; mutations rely on Accept-Language.
//
// Gate-tested rather than parse-tested: the call budget (1 call per screen),
// idempotency of the batch (a replayed clientUuid must not duplicate a result),
// and that the journey is computed only from the player's own history.
import { z } from "zod";
import { Count, PlayerProfile, PlayerProfileView, Roadmap, TestDirection, Timestamp } from "./domain";
import type { EndpointSpec } from "./domain";
import { ClientUuid, EntityId, Locale } from "./primitives";

// --- GET /api/player/journey?locale ------------------------------------------------------
// Everything is the player against their own history: there is deliberately no rank,
// percentile, average-of-others or leaderboard field anywhere in this file.

export const JourneyQuery = z.strictObject({ locale: Locale.optional() });
export type JourneyQuery = z.infer<typeof JourneyQuery>;

export const JourneyMetrics = z.object({
  sessionsCompleted: Count,
  minutesTrained: Count,
  streakDays: Count,
  skillsImproving: Count,
});
export type JourneyMetrics = z.infer<typeof JourneyMetrics>;

export const NODE_STATES = ["mastered", "training", "locked"] as const;

/** `name` is already resolved for the request locale (the endpoint takes ?locale). */
export const TreeNode = z.object({
  slug: EntityId,
  name: z.string().min(1),
  state: z.enum(NODE_STATES),
  level: Count,
});
export type TreeNode = z.infer<typeof TreeNode>;

export const TreeTrack = z.object({ track: EntityId, nodes: z.array(TreeNode) });
export type TreeTrack = z.infer<typeof TreeTrack>;

export const TestHistoryPoint = z.object({ value: z.number(), at: Timestamp });
export type TestHistoryPoint = z.infer<typeof TestHistoryPoint>;

/**
 * One row per skill test the player has taken. `tests[]` lists only tests with at
 * least one result, which is why `personalBest` is required.
 */
export const JourneyTest = z.object({
  testSlug: EntityId,
  name: z.string().min(1),
  unit: z.string().min(1),
  direction: TestDirection,
  history: z.array(TestHistoryPoint),
  previous: z.number().optional(),
  latest: z.number().optional(),
  changePct: z.number().optional(),
  personalBest: z.number(),
  retestDueAt: Timestamp.optional(),
});
export type JourneyTest = z.infer<typeof JourneyTest>;

export const Milestone = z.object({ key: z.string().min(1), achievedAt: Timestamp.optional() });
export type Milestone = z.infer<typeof Milestone>;

export const Journey = z.object({
  metrics: JourneyMetrics,
  tree: z.array(TreeTrack),
  tests: z.array(JourneyTest),
  milestones: z.array(Milestone),
  /** Slugs of the tests that are due for a retest. */
  retestsDue: z.array(EntityId),
});
export type Journey = z.infer<typeof Journey>;

// --- POST /api/player/test-results (batch, idempotent by clientUuid) -------------------------

export const TestResult = z.strictObject({
  testSlug: EntityId,
  value: z.number(),
  attempts: Count.optional(),
  errors: Count.optional(),
  clientUuid: ClientUuid,
});
export type TestResult = z.infer<typeof TestResult>;

export const TestResultsRequest = z.strictObject({ results: z.array(TestResult).min(1) });
export type TestResultsRequest = z.infer<typeof TestResultsRequest>;

export const TestResultsResponse = z.object({ journey: Journey, roadmap: Roadmap });
export type TestResultsResponse = z.infer<typeof TestResultsResponse>;

// --- PATCH /api/player/profile ----------------------------------------------------------------

/** Age and level are part of the baseline and are not editable here; every listed field is optional. */
export const PatchProfileRequest = PlayerProfile.pick({
  goal: true,
  equipment: true,
  space: true,
  partner: true,
  daysPerWeek: true,
  minutesPerSession: true,
  locale: true,
})
  .partial()
  .strict();
export type PatchProfileRequest = z.infer<typeof PatchProfileRequest>;

/** `roadmap` is null after a plan reset until the baseline is redone. */
export const PatchProfileResponse = z.object({ profile: PlayerProfileView, roadmap: Roadmap.nullable() });
export type PatchProfileResponse = z.infer<typeof PatchProfileResponse>;

// --- POST /api/player/plan/reset -----------------------------------------------------------------

/** Redo the baseline: the profile stays, the roadmap is gone. */
export const ResetPlanResponse = z.object({ profile: PlayerProfileView, roadmap: z.null() });
export type ResetPlanResponse = z.infer<typeof ResetPlanResponse>;

export const ENDPOINTS = {
  getJourney: {
    method: "GET",
    path: "/api/player/journey",
    query: JourneyQuery,
    response: Journey,
  },
  postTestResults: {
    method: "POST",
    path: "/api/player/test-results",
    request: TestResultsRequest,
    response: TestResultsResponse,
  },
  patchProfile: {
    method: "PATCH",
    path: "/api/player/profile",
    request: PatchProfileRequest,
    response: PatchProfileResponse,
  },
  resetPlan: {
    method: "POST",
    path: "/api/player/plan/reset",
    response: ResetPlanResponse,
  },
} as const satisfies Record<string, EndpointSpec>;
