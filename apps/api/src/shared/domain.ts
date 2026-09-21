// Schemas and helpers that two or more slice contracts share, so each is defined once.
//
// This module is bundled into the browser through the @api-types alias, so it
// must import ONLY from "zod" and "./primitives" (no node/bun APIs, no side
// effects). Consumers must use `import type` for type-only names
// (verbatimModuleSyntax).
//
// The shared objects carry NO object-level refinement and NO `.default()`:
// Zod 4 throws on `.pick()/.omit()/.partial()` of a refined object, and a
// default would mask a missing field.
import { z } from "zod";
import { EntityId, Equipment, ExperienceLevel, Goal, LICENSE_IDS, Locale, LocalizedText, Space } from "./primitives";

// --- Small shared scalars ---------------------------------------------------

/** ISO 8601 date-time carrying a UTC offset ("Z" or "+05:00"). */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/** Calendar date, YYYY-MM-DD. */
export const CalendarDate = z.iso.date();
export type CalendarDate = z.infer<typeof CalendarDate>;

/** Non-negative integer. */
export const Count = z.int().min(0);
export type Count = z.infer<typeof Count>;

// --- Player bounds ------------------------------------------------------------

export const AGE_MIN = 5;
export const AGE_MAX = 99;
export const DAYS_PER_WEEK = [2, 3, 4, 5, 6] as const;
export const MINUTES_PER_SESSION = [10, 15, 20, 30, 45] as const;
export const ROADMAP_WEEKS = 4;
export const SKILL_LEVEL_MIN = 1;
export const SKILL_LEVEL_MAX = 5;
export const FOCUS_MIN = 2;
export const FOCUS_MAX = 3;

const Age = z.int().min(AGE_MIN).max(AGE_MAX);
const DaysPerWeek = z.int().min(DAYS_PER_WEEK[0]).max(DAYS_PER_WEEK[DAYS_PER_WEEK.length - 1]);
const MinutesPerSession = z.literal(MINUTES_PER_SESSION);
const SkillLevel = z.int().min(SKILL_LEVEL_MIN).max(SKILL_LEVEL_MAX);

// --- Player profile -------------------------------------------------------------

/**
 * The profile fields. Deliberately has NO name, email or birth date.
 * Shape only: wrap it as PlayerProfile (requests) or PlayerProfileView (responses).
 */
export const PlayerProfileShape = {
  age: Age,
  level: ExperienceLevel,
  goal: Goal,
  equipment: Equipment,
  space: Space,
  partner: z.boolean(),
  daysPerWeek: DaysPerWeek,
  minutesPerSession: MinutesPerSession,
  locale: Locale,
};

/** REQUESTS: an unknown key (name, email, birthDate, id, ...) fails. */
export const PlayerProfile = z.strictObject(PlayerProfileShape);
export type PlayerProfile = z.infer<typeof PlayerProfile>;

/** RESPONSES: unknown server keys are stripped; a missing or out-of-bound field still fails. */
export const PlayerProfileView = z.object(PlayerProfileShape);
export type PlayerProfileView = z.infer<typeof PlayerProfileView>;

// --- Roadmap --------------------------------------------------------------------

export const ROADMAP_SOURCES = ["test", "self"] as const;

export const RoadmapTrack = z.object({
  skill: EntityId,
  level: SkillLevel,
  source: z.enum(ROADMAP_SOURCES),
});
export type RoadmapTrack = z.infer<typeof RoadmapTrack>;

export const RoadmapFocus = z.object({
  skill: EntityId,
  level: SkillLevel,
  targetLevel: SkillLevel,
  reason: z.string().min(1),
});
export type RoadmapFocus = z.infer<typeof RoadmapFocus>;

export const Roadmap = z.object({
  currentLevelLabel: z.string().min(1),
  tracks: z.array(RoadmapTrack),
  goal: Goal,
  weeks: z.literal(ROADMAP_WEEKS),
  sessionsPerWeek: DaysPerWeek,
  minutesPerSession: MinutesPerSession,
  focus: z.array(RoadmapFocus).min(FOCUS_MIN).max(FOCUS_MAX),
});
export type Roadmap = z.infer<typeof Roadmap>;

// --- Skill tests ------------------------------------------------------------------

export const TEST_DIRECTIONS = ["higher", "lower"] as const;
export const TestDirection = z.enum(TEST_DIRECTIONS);
export type TestDirection = z.infer<typeof TestDirection>;

export const SkillTest = z.object({
  slug: EntityId,
  skill: EntityId,
  metric: z.string().min(1),
  unit: z.string().min(1),
  direction: TestDirection,
  protocol: LocalizedText,
  equipment: Equipment,
});
export type SkillTest = z.infer<typeof SkillTest>;

// --- Attribution --------------------------------------------------------------------

export const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
  error: "Expected a semantic version such as 1.0.0",
});
export type Semver = z.infer<typeof Semver>;

/** The license is REQUIRED: primitives' LicenseId bakes in a default that would mask a missing field. */
export const Attribution = z.object({
  author: z.string().min(1),
  source: z.string().min(1),
  sourceUrl: z.httpUrl().optional(),
  license: z.enum(LICENSE_IDS),
  createdAt: Timestamp,
  semver: Semver,
});
export type Attribution = z.infer<typeof Attribution>;

// --- Endpoint description (TYPE ONLY: no runtime value) -------------------------------

/**
 * Every slice contract file writes
 * `export const ENDPOINTS = {...} as const satisfies Record<string, EndpointSpec>`.
 * `path` uses Hono-style `:param` segments. `public: true` marks anonymous
 * endpoints so the API client skips anonymous sign-in.
 */
export type EndpointSpec = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  request?: z.ZodType;
  response?: z.ZodType;
  status?: number;
  contentType?: string;
  public?: true;
};
