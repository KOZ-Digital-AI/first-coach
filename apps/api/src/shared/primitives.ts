// Cross-slice contract primitives.
//
// This module is bundled into the browser through the @api-types alias, so it
// must import ONLY from "zod" (no bun:*, node:* or other modules). Consumers
// must use `import type` for type-only names (verbatimModuleSyntax).
import { z } from "zod";

// --- Locale ----------------------------------------------------------------

export const LOCALES = ["kk", "ru", "en"] as const;
export const Locale = z.enum(LOCALES);
export type Locale = z.infer<typeof Locale>;

/** Locales tried, in order, after the requested one. */
export const LOCALE_FALLBACKS: readonly Locale[] = ["ru", "en"];

const isUsable = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

export const LocalizedText = z
  .strictObject({
    kk: z.string().optional(),
    ru: z.string().optional(),
    en: z.string().optional(),
  })
  .refine((text) => LOCALES.some((locale) => isUsable(text[locale])), {
    error: "At least one locale must have non-blank text",
  });
export type LocalizedText = z.infer<typeof LocalizedText>;

/**
 * Picks text for `locale`, falling back requested -> ru -> en. Blank or
 * whitespace-only values count as missing. Returns undefined when nothing is
 * usable.
 */
export function pickLocalized(text: LocalizedText, locale: Locale): string | undefined {
  for (const candidate of [locale, ...LOCALE_FALLBACKS]) {
    const value = text[candidate];
    if (isUsable(value)) return value;
  }
  return undefined;
}

// --- Enums -----------------------------------------------------------------

export const TRUST_STATUSES = [
  "COMMUNITY",
  "REVIEWED",
  "EXPERT_VERIFIED",
  "ACADEMY_VERIFIED",
] as const;
export const TrustStatus = z.enum(TRUST_STATUSES);
export type TrustStatus = z.infer<typeof TrustStatus>;

/** The minimum kit a drill needs (a single value, not an ordering). */
export const EQUIPMENT = ["nothing", "ball", "ball_wall", "cones", "full_field"] as const;
export const Equipment = z.enum(EQUIPMENT);
export type Equipment = z.infer<typeof Equipment>;

export const SPACES = ["home_3x3", "yard", "field", "gym"] as const;
export const Space = z.enum(SPACES);
export type Space = z.infer<typeof Space>;

export const EXPERIENCE_LEVELS = ["beginner", "basic", "intermediate"] as const;
export const ExperienceLevel = z.enum(EXPERIENCE_LEVELS);
export type ExperienceLevel = z.infer<typeof ExperienceLevel>;

export const GOALS = ["control", "dribbling", "passing", "weakfoot", "coordination"] as const;
export const Goal = z.enum(GOALS);
export type Goal = z.infer<typeof Goal>;

export const LICENSE_IDS = ["CC-BY-SA-4.0", "CC-BY-4.0", "CC0-1.0"] as const;
export const DEFAULT_LICENSE_ID = "CC-BY-SA-4.0" satisfies (typeof LICENSE_IDS)[number];
export const LicenseId = z.enum(LICENSE_IDS).default(DEFAULT_LICENSE_ID);
export type LicenseId = z.infer<typeof LicenseId>;

// --- Identifiers -----------------------------------------------------------

/** Slug / nanoid compatible id (nanoid ids may be mixed case and start with - or _). */
export const EntityId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);
export type EntityId = z.infer<typeof EntityId>;

export const SkillRef = z.strictObject({ skillId: EntityId });
export type SkillRef = z.infer<typeof SkillRef>;

export const DrillVersionRef = z.strictObject({
  drillId: EntityId,
  version: z.int().positive(),
});
export type DrillVersionRef = z.infer<typeof DrillVersionRef>;

export const ClientUuid = z.uuid().toLowerCase();
export type ClientUuid = z.infer<typeof ClientUuid>;

// --- Drill content ---------------------------------------------------------

/** Absolute http(s) URL, or a root-relative path with a single leading "/". */
const MediaUrl = z.union([
  z.httpUrl(),
  z.string().regex(/^\/(?![/\\])\S*$/, { error: "Expected an http(s) URL or a root-relative path" }),
]);

export const MEDIA_KINDS = ["video", "image", "document"] as const;
export const MediaKind = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKind>;

export const DrillMedia = z.strictObject({
  kind: MediaKind,
  url: MediaUrl,
  caption: LocalizedText.optional(),
});
export type DrillMedia = z.infer<typeof DrillMedia>;

export const DrillDose = z
  .strictObject({
    reps: z.int().positive().optional(),
    sets: z.int().positive().optional(),
    durationSec: z.int().positive().optional(),
  })
  .refine((dose) => dose.reps !== undefined || dose.sets !== undefined || dose.durationSec !== undefined, {
    error: "Provide at least one of reps, sets, durationSec",
  });
export type DrillDose = z.infer<typeof DrillDose>;

export const DrillConditions = z.strictObject({
  equipment: Equipment,
  spaces: z.array(Space).min(1),
  partner: z.boolean().default(false),
  ageMin: z.int().nonnegative().optional(),
  ageMax: z.int().nonnegative().optional(),
});
export type DrillConditions = z.infer<typeof DrillConditions>;

export const DrillContent = z.strictObject({
  title: LocalizedText.optional(),
  goal: LocalizedText,
  instructions: LocalizedText,
  dose: DrillDose,
  mistakes: z.array(LocalizedText).default([]),
  progressions: z.array(LocalizedText).default([]),
  regressions: z.array(LocalizedText).default([]),
  conditions: DrillConditions,
  safety: z.array(LocalizedText).default([]),
  media: z.array(DrillMedia).default([]),
});
export type DrillContent = z.infer<typeof DrillContent>;

// --- Problem details (RFC 9457) ---------------------------------------------

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** JSON Pointer (RFC 6901): empty string (whole document) or starts with "/". */
const JsonPointer = z
  .string()
  .refine((pointer) => pointer === "" || pointer.startsWith("/"), {
    error: "Expected a JSON Pointer (empty or starting with '/')",
  });

export const ProblemError = z.looseObject({
  pointer: JsonPointer,
  detail: z.string(),
});
export type ProblemError = z.infer<typeof ProblemError>;

export const ProblemDetails = z.looseObject({
  type: z.string().default("about:blank"),
  title: z.string(),
  status: z.int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.array(ProblemError).default([]),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

// --- Pagination ------------------------------------------------------------

export type Paginated<T> = {
  items: T[];
  nextCursor: string | null;
  total?: number;
};

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.int().nonnegative().optional(),
  });
}

// --- Health ----------------------------------------------------------------

export const DATABASE_STATES = ["ok", "error"] as const;
export const DatabaseState = z.enum(DATABASE_STATES);
export type DatabaseState = z.infer<typeof DatabaseState>;

/** Loose: later beads add fields (drill count, migration version). */
export const HealthResponse = z.looseObject({
  ok: z.boolean(),
  version: z.string().min(1),
  database: DatabaseState,
});
export type HealthResponse = z.infer<typeof HealthResponse>;
