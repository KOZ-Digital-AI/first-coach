// Contract: a player onboards without signup, takes baseline skill tests and gets a
// roadmap (fc-mol-sd5).
//
// Serves: the onboarding wizard and the roadmap screen (web, through the @api-types alias).
// Bundled into the browser: imports ONLY "zod", "./primitives" and "./domain".
//
// Call budget: landing -> roadmap in <= 3 calls including anonymous sign-in
// (sign-in, GET /api/onboarding/:sport, POST /api/player/start).
//
// Errors are ProblemDetails (RFC 9457, with per-field pointers) from ./primitives;
// they are not redeclared here.
//
// Gate-tested, NOT parse-tested: the call budget, and that POST /api/player/start is
// idempotent per player (a second call replaces the plan).
import { z } from "zod";
import { Count, DAYS_PER_WEEK, MINUTES_PER_SESSION, PlayerProfile, PlayerProfileView, Roadmap, SkillTest } from "./domain";
import type { EndpointSpec } from "./domain";
import { ClientUuid, EntityId, Equipment, ExperienceLevel, Goal, Locale, Space } from "./primitives";

// --- GET /api/onboarding/:sport?locale ----------------------------------------------

export const OnboardingParams = z.strictObject({ sport: EntityId });
export type OnboardingParams = z.infer<typeof OnboardingParams>;

export const OnboardingQuery = z.strictObject({ locale: Locale.optional() });
export type OnboardingQuery = z.infer<typeof OnboardingQuery>;

/**
 * Every enum the wizard shows comes from this response. `partner` is a boolean list
 * (there is no partner enum); the day/minute lists use the domain bounds; each test
 * carries a localized protocol and its required equipment (SkillTest).
 */
export const OnboardingOptions = z.object({
  levels: z.array(ExperienceLevel),
  goals: z.array(Goal),
  equipment: z.array(Equipment),
  spaces: z.array(Space),
  partner: z.array(z.boolean()),
  daysPerWeek: z.array(z.literal(DAYS_PER_WEEK)),
  minutesPerSession: z.array(z.literal(MINUTES_PER_SESSION)),
  tests: z.array(SkillTest),
});
export type OnboardingOptions = z.infer<typeof OnboardingOptions>;

// --- POST /api/player/start -----------------------------------------------------------

/**
 * One baseline entry. `value` is REQUIRED by the contract, also on a skipped test
 * (nothing was measured, so the client sends 0 with `skipped: true`); the server then
 * uses the self-assessed level for that skill (roadmap track source "self").
 */
export const BaselineResult = z.strictObject({
  testSlug: EntityId,
  value: z.number(),
  attempts: Count.optional(),
  errors: Count.optional(),
  skipped: z.boolean().optional(),
  clientUuid: ClientUuid,
});
export type BaselineResult = z.infer<typeof BaselineResult>;

/** `baseline` may be empty: a player can skip every test. The profile has no name, email or birth date. */
export const StartRequest = z.strictObject({
  profile: PlayerProfile,
  baseline: z.array(BaselineResult),
});
export type StartRequest = z.infer<typeof StartRequest>;

/** The mutation returns the created resources. */
export const StartResponse = z.object({
  profile: PlayerProfileView,
  roadmap: Roadmap,
});
export type StartResponse = z.infer<typeof StartResponse>;

// --- Endpoints ----------------------------------------------------------------------------

export const ENDPOINTS = {
  getOptions: {
    method: "GET",
    path: "/api/onboarding/:sport",
    params: OnboardingParams,
    query: OnboardingQuery,
    response: OnboardingOptions,
    public: true,
  },
  start: {
    method: "POST",
    path: "/api/player/start",
    request: StartRequest,
    response: StartResponse,
  },
} as const satisfies Record<string, EndpointSpec>;
