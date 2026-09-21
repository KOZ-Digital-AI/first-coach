// Contract: the player trains today's session and records results (fc-mol-d8g).
//
// Serves the session screen, the drill player and the offline outbox.
// Errors on every endpoint are ProblemDetails (see ./primitives); not redeclared here.
//
// Call budget: opening today's session is 1 call (GET /api/player/today); finishing a
// session is 1 call (POST /api/player/session-events with a session_finished event);
// N offline results sync in 1 call (one batch, no maximum).
//
// Gate-tested, NOT parse-tested (a schema parse cannot prove them): the call budget;
// "complete enough to train offline" beyond the required fields; `content` carrying the
// requested locale AND en (the schema takes the primitives' DrillContent as is);
// idempotency by clientUuid; the 30-day offline acceptance (needs "now", so server
// behaviour, not a refinement).
//
// This module is bundled into the browser through the @api-types alias, so it imports
// ONLY "zod", "./primitives" and "./domain". Consumers must use `import type` for
// type-only names (verbatimModuleSyntax).
import { z } from "zod";
import { Attribution, CalendarDate, Count, Roadmap, SkillTest, Timestamp } from "./domain";
import type { EndpointSpec } from "./domain";
import { ClientUuid, DrillContent, EntityId, ExperienceLevel, Locale, TrustStatus } from "./primitives";

/**
 * The offline outbox may sync events up to this many days old. The server enforces it
 * (it needs "now"); the outbox uses it to decide what is still worth sending.
 */
export const OFFLINE_EVENT_MAX_AGE_DAYS = 30;

// --- GET /api/player/today?locale -----------------------------------------------------

export const TodayQuery = z.strictObject({ locale: Locale.optional() });
export type TodayQuery = z.infer<typeof TodayQuery>;

/**
 * One drill of today's session. `content` is the drill's full DrillContent (the server
 * sends its LocalizedText in the requested locale AND en), so the session trains offline.
 *
 * `track` and `level` (fc-mol-urn.11) are the drill's primary skill slug (DrillSummary.track: one of the skill graph's
 * tracks) and the ExperienceLevel of the drill VERSION the item points at. Both are OPTIONAL and additive: a session cached
 * by an older client, or answered by an older server, has neither and must still parse (see backlog fc-r99 on strict
 * DrillContent). The server omits `track` for a drill that has no primary skill linked yet; it always sends `level`.
 */
export const TodayItem = z.object({
  itemId: EntityId,
  drillVersionId: EntityId,
  minutes: Count,
  reason: z.string().optional(),
  done: z.boolean(),
  content: DrillContent,
  status: TrustStatus,
  attribution: Attribution,
  track: EntityId.optional(),
  level: ExperienceLevel.optional(),
  regressionOf: EntityId.optional(),
  progressionOf: EntityId.optional(),
});
export type TodayItem = z.infer<typeof TodayItem>;

/** The part of the roadmap the session screen shows, derived from Roadmap so they cannot drift. */
export const RoadmapSummary = Roadmap.pick({
  currentLevelLabel: true,
  focus: true,
  sessionsPerWeek: true,
  minutesPerSession: true,
});
export type RoadmapSummary = z.infer<typeof RoadmapSummary>;

export const TodaySession = z.object({
  id: EntityId,
  date: CalendarDate,
  planner: z.enum(["rules", "ai"]),
  totalMinutes: Count,
  graphVersion: z.string(),
  items: z.array(TodayItem),
  roadmapSummary: RoadmapSummary,
  skillTest: SkillTest.optional(),
});
export type TodaySession = z.infer<typeof TodaySession>;

// --- POST /api/player/session-events (batch, idempotent by clientUuid) ----------------

/**
 * One shape for every type: `itemId` is optional throughout (a `result` for the session's
 * skill test has no item) and `value` is optional.
 */
export const SessionEvent = z.strictObject({
  clientUuid: ClientUuid,
  sessionId: EntityId,
  type: z.enum(["drill_done", "drill_undone", "result", "session_finished"]),
  itemId: EntityId.optional(),
  value: z.number().optional(),
  at: Timestamp,
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const SessionEventsRequest = z.strictObject({ events: z.array(SessionEvent).min(1) });
export type SessionEventsRequest = z.infer<typeof SessionEventsRequest>;

export const SessionProgress = z.object({
  sessionsCompleted: Count,
  minutesTrained: Count,
  streakDays: Count,
});
export type SessionProgress = z.infer<typeof SessionProgress>;

export const SessionEventsResponse = z.object({
  session: TodaySession,
  progress: SessionProgress,
  nextSessionDate: CalendarDate,
});
export type SessionEventsResponse = z.infer<typeof SessionEventsResponse>;

// --- POST /api/player/today/swap ------------------------------------------------------

export const SwapRequest = z.strictObject({
  itemId: EntityId,
  direction: z.enum(["easier", "harder"]),
});
export type SwapRequest = z.infer<typeof SwapRequest>;

// --- Endpoints ------------------------------------------------------------------------

export const ENDPOINTS = {
  getToday: {
    method: "GET",
    path: "/api/player/today",
    query: TodayQuery,
    response: TodaySession,
  },
  postSessionEvents: {
    method: "POST",
    path: "/api/player/session-events",
    request: SessionEventsRequest,
    response: SessionEventsResponse,
  },
  postSwap: {
    method: "POST",
    path: "/api/player/today/swap",
    request: SwapRequest,
    response: TodaySession,
  },
} as const satisfies Record<string, EndpointSpec>;
