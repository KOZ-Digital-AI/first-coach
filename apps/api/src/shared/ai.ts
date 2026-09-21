// Contract: AI Coach personalises today's session from approved drills only (fc-mol-dj0).
//
// Serves the session screen ("Ask AI Coach") and the drill player ("Explain this drill").
// Errors on every endpoint are ProblemDetails (see ./primitives); not redeclared here.
//
// The answer to POST /api/player/today/ai-plan is the SAME TodaySession the session slice
// serves (REUSED from ./session, never redefined), in one of two variants:
//   - planner "ai": a reason on EVERY item, and no fallback;
//   - planner "rules": the unchanged deterministic session, plus fallback{code}.
// An AI failure is NEVER an error status: it is the "rules" variant with a fallback code.
//
// The explain endpoint is the one place an AI failure IS an error: 503 with a ProblemDetails
// whose `type` is AI_UNAVAILABLE. primitives' ProblemDetails has no separate machine-code
// field, so the code travels in `type` (it is a loose object and keeps it).
//
// Call budget: 1 call each (one ai-plan call, one explain call).
//
// The hard server timeout is exported as AI_PLAN_TIMEOUT_MS (the web needs it for its client
// abort); the call is synchronous: no async job, nothing to poll. "Ids must come from the
// server candidate set" has an executable form, aiPlanUnknownIds(plan, candidateIds): only
// the server knows the set, so a schema cannot check membership; the server calls the helper
// and treats a non-empty result as invalid_output.
//
// Gate-tested / server-side, NOT parse-tested (a schema parse cannot prove them): that the
// server really aborts at the timeout; "never an error status for AI failures"; the call
// budget.
//
// Follow-up bead: the API's problem() helper hardcodes type "about:blank" and cannot emit an
// `ai_unavailable` problem yet.
//
// Requests are strict: an unknown key fails. Responses stay loose (unknown server keys are
// stripped).
//
// Bundled into the browser through the @api-types alias: imports ONLY "zod", "./primitives",
// "./domain" and "./session" (no node/bun APIs, no side effects). Consumers must use
// `import type` for type-only names (verbatimModuleSyntax).
import { z } from "zod";
import type { EndpointSpec } from "./domain";
import { EntityId, Locale } from "./primitives";
import { TodayItem, TodaySession } from "./session";

/** `type` of the 503 ProblemDetails returned by the explain endpoint when the AI is unavailable. */
export const AI_UNAVAILABLE = "ai_unavailable";

// --- POST /api/player/today/ai-plan ---------------------------------------------------

/** Hard server timeout of the ai-plan call (criteria: 20 s). The web aborts its request with it. */
export const AI_PLAN_TIMEOUT_MS = 20_000;

/** The optional note is limited by the criteria's own rule: at most 200 characters. */
export const AI_NOTE_MAX_CHARS = 200;

/** Empty note allowed (the criteria say nothing about it, so it is not pinned). */
export const AiPlanRequest = z.strictObject({ note: z.string().max(AI_NOTE_MAX_CHARS).optional() });
export type AiPlanRequest = z.infer<typeof AiPlanRequest>;

/** Why the server answered with the deterministic session instead of an AI plan. */
export const AI_FALLBACK_CODES = ["no_key", "disabled", "timeout", "invalid_output", "provider_error"] as const;
export const AiFallbackCode = z.enum(AI_FALLBACK_CODES);
export type AiFallbackCode = z.infer<typeof AiFallbackCode>;

/**
 * A session item planned by the AI: derived from TodayItem with the reason made REQUIRED and
 * non-blank (trimmed first, so a whitespace-only reason fails, as primitives' blank rule does).
 */
export const AiTodayItem = TodayItem.extend({ reason: z.string().trim().min(1) });
export type AiTodayItem = z.infer<typeof AiTodayItem>;

/**
 * planner "ai": every item carries a reason. `fallback` must be absent: `z.never().optional()`
 * accepts a missing key and rejects any value (a plain object would silently strip it).
 */
export const AiPlannedSession = TodaySession.extend({
  planner: z.literal("ai"),
  items: z.array(AiTodayItem),
  fallback: z.never().optional(),
});
export type AiPlannedSession = z.infer<typeof AiPlannedSession>;

/** planner "rules": the unchanged deterministic session; the fallback code is REQUIRED. */
export const RulesFallbackSession = TodaySession.extend({
  planner: z.literal("rules"),
  fallback: z.object({ code: AiFallbackCode }),
});
export type RulesFallbackSession = z.infer<typeof RulesFallbackSession>;

export const AiPlanResponse = z.discriminatedUnion("planner", [AiPlannedSession, RulesFallbackSession]);
export type AiPlanResponse = z.infer<typeof AiPlanResponse>;

// --- AiPlan: the internal structured-output schema the LLM must fill --------------------

/**
 * One planned drill. `minutes` is a positive integer (derived: Count would allow a
 * meaningless 0-minute drill). `drillVersionId` must be a member of the server's candidate
 * set of approved drills: that is validated server-side, a schema cannot know the set.
 */
export const AiPlanItem = z.strictObject({
  drillVersionId: EntityId,
  minutes: z.int().positive(),
  reason: z.string().min(1),
});
export type AiPlanItem = z.infer<typeof AiPlanItem>;

export const AiPlan = z.strictObject({ items: z.array(AiPlanItem).min(1) });
export type AiPlan = z.infer<typeof AiPlan>;

/**
 * The drillVersionIds of `plan` that are NOT in `candidateIds` (the server's set of approved
 * drills), in plan order and deduplicated. Empty means every id came from the candidate set.
 */
export function aiPlanUnknownIds(plan: AiPlan, candidateIds: Iterable<string>): string[] {
  const candidates = new Set(candidateIds);
  const unknown = new Set<string>();
  for (const { drillVersionId } of plan.items) {
    if (!candidates.has(drillVersionId)) unknown.add(drillVersionId);
  }
  return [...unknown];
}

// --- POST /api/player/drills/:versionId/explain ---------------------------------------

/** Derived: the id is the same EntityId TodayItem uses for drillVersionId. */
export const ExplainParams = z.strictObject({ versionId: EntityId });
export type ExplainParams = z.infer<typeof ExplainParams>;

export const EXPLAIN_AUDIENCES = ["child", "default"] as const;
export const ExplainAudience = z.enum(EXPLAIN_AUDIENCES);
export type ExplainAudience = z.infer<typeof ExplainAudience>;

export const ExplainRequest = z.strictObject({ locale: Locale, audience: ExplainAudience });
export type ExplainRequest = z.infer<typeof ExplainRequest>;

/** `aiGenerated` is always the literal true: an explanation that is not AI-generated is not this response. */
export const ExplainResponse = z.object({
  text: z.string().min(1),
  aiGenerated: z.literal(true),
  basedOnVersionId: EntityId,
});
export type ExplainResponse = z.infer<typeof ExplainResponse>;

// --- Endpoints ------------------------------------------------------------------------

export const ENDPOINTS = {
  aiPlan: {
    method: "POST",
    path: "/api/player/today/ai-plan",
    request: AiPlanRequest,
    response: AiPlanResponse,
  },
  explainDrill: {
    method: "POST",
    path: "/api/player/drills/:versionId/explain",
    params: ExplainParams,
    request: ExplainRequest,
    response: ExplainResponse,
  },
} as const satisfies Record<string, EndpointSpec>;
