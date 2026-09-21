// Zod schemas for the commons seed files (fc-mol-f2u.2): skill-graph.json, tests.json, one
// drill track file per track, and rubrics.json. Pure schemas: loading files is a later bead.
//
// Seed files are AUTHORED content, so they are stricter than the wire contracts in
// ../shared/commons: every text carries all three locales (kk, ru, en), non-blank; unknown
// keys are rejected (a misspelt `licence` must not vanish); slugs are kebab-case and unique
// per file. Each seed shape stays convertible to its wire contract (SkillNode, SkillTest,
// DrillContent / DrillSummary / Attribution).
//
// The criteria fix: three non-blank locales, minutes > 0, level 1-3, age 5-99 with
// ageMin <= ageMax, equipment/space from the primitives, licence from the SPDX enum, kebab
// slugs unique per file. Everything else below is DERIVED from the wire contracts and marked
// so.
//
// The object-level rules (ageMin <= ageMax; test thresholds vs direction) make Zod 4 throw on `.pick()/.omit()/.partial()`,
// so the unrefined `*Base` objects are exported next to the refined ones.
import { z } from "zod";
import { AGE_MAX, AGE_MIN, SKILL_LEVEL_MAX, SKILL_LEVEL_MIN, Semver, TestDirection } from "../shared/domain";
import { DrillDose, Equipment, LICENSE_IDS, Space } from "../shared/primitives";

// --- Shared building blocks ------------------------------------------------------------------

/** Unlike primitives' LocalizedText (any one locale), a seed text needs all three, non-blank. */
const NonBlank = z.string().trim().min(1);
export const SeedText = z.strictObject({ kk: NonBlank, ru: NonBlank, en: NonBlank });
export type SeedText = z.infer<typeof SeedText>;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const Slug = z.string().regex(SLUG_PATTERN, { error: "Expected a kebab-case slug such as ball-control" });
export type Slug = z.infer<typeof Slug>;

export const DRILL_LEVEL_MIN = 1;
export const DRILL_LEVEL_MAX = 3;

const Age = z.int().min(AGE_MIN).max(AGE_MAX);

/** Reported at `ageMax`: the upper bound is the one that contradicts the lower. */
const ageOrder = (ctx: z.core.ParsePayload<{ ageMin: number; ageMax: number }>): void => {
  if (ctx.value.ageMin > ctx.value.ageMax) {
    ctx.issues.push({
      code: "custom",
      input: ctx.value.ageMax,
      path: ["ageMax"],
      message: "ageMin must not be greater than ageMax",
    });
  }
};

/** Reports every repeat of a slug (never its first use) at `<key>.<index>.slug`. */
const uniqueSlugs =
  <K extends string>(key: K) =>
  (ctx: z.core.ParsePayload<Record<K, readonly { slug: string }[]>>): void => {
    const seen = new Set<string>();
    ctx.value[key].forEach((item, index) => {
      if (seen.has(item.slug)) {
        ctx.issues.push({
          code: "custom",
          input: item.slug,
          path: [key, index, "slug"],
          message: `Duplicate slug "${item.slug}"`,
        });
      }
      seen.add(item.slug);
    });
  };

// --- skill-graph.json -------------------------------------------------------------------------

/** Derived: the fields of ../shared/commons SkillNode with seed texts and kebab slugs. */
export const SeedSkillNodeBase = z.strictObject({
  slug: Slug,
  parent: Slug.nullable(),
  order: z.int(),
  names: SeedText,
  levels: z.array(SeedText),
  prerequisites: z.array(z.strictObject({ skill: Slug, minLevel: z.int().min(SKILL_LEVEL_MIN).max(SKILL_LEVEL_MAX) })),
  ageMin: Age,
  ageMax: Age,
  equipment: Equipment,
  safety: z.array(SeedText),
  outcomes: z.array(SeedText),
  mistakes: z.array(SeedText),
});
export const SeedSkillNode = SeedSkillNodeBase.check(ageOrder);
export type SeedSkillNode = z.infer<typeof SeedSkillNode>;

/** Derived: SkillGraph. Graph integrity (parents, cycles) stays with `graphProblems`. */
export const SeedSkillGraphFile = z
  .strictObject({ sport: Slug, version: z.string().min(1), nodes: z.array(SeedSkillNode) })
  .check(uniqueSlugs("nodes"));
export type SeedSkillGraphFile = z.infer<typeof SeedSkillGraphFile>;

// --- tests.json -------------------------------------------------------------------------------

/** The age bands a test's level thresholds are given for. */
export const THRESHOLD_BANDS = ["upTo9", "from10to13", "from14"] as const;
export type ThresholdBand = (typeof THRESHOLD_BANDS)[number];

/** Boundaries per band: the values that reach levels 2, 3, 4 and 5. */
export const THRESHOLD_LEVELS = 4;

/**
 * `[t2, t3, t4, t5]` are the values needed to REACH levels 2..5 in one age band: `value >= t`
 * for a higher-is-better test, `value <= t` for a lower-is-better one. Below (higher) or above
 * (lower) the first boundary is level 1. Zod 4's `z.number()` already rejects NaN and +-Infinity.
 */
const ThresholdBoundaries = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const SeedTestThresholds = z.strictObject({
  upTo9: ThresholdBoundaries,
  from10to13: ThresholdBoundaries,
  from14: ThresholdBoundaries,
});
export type SeedTestThresholds = z.infer<typeof SeedTestThresholds>;

/** Strictly increasing (higher) or strictly decreasing (lower); equal neighbours are rejected. */
const isMonotonic = (boundaries: readonly number[], direction: TestDirection): boolean =>
  boundaries.every((value, index) => {
    const previous = boundaries[index - 1];
    if (previous === undefined) return true;
    return direction === "higher" ? value > previous : value < previous;
  });

/** Reported at `thresholds.<band>`. Ordering ACROSS bands is content, not schema. */
const thresholdsMonotonic = (ctx: z.core.ParsePayload<{ direction: TestDirection; thresholds?: SeedTestThresholds }>): void => {
  const { direction, thresholds } = ctx.value;
  if (thresholds === undefined) return;
  for (const band of THRESHOLD_BANDS) {
    if (isMonotonic(thresholds[band], direction)) continue;
    ctx.issues.push({
      code: "custom",
      input: thresholds[band],
      path: ["thresholds", band],
      message: `Thresholds must be strictly ${direction === "higher" ? "increasing" : "decreasing"} for a ${direction}-is-better test`,
    });
  }
};

/** Derived: SkillTest with a seed protocol and kebab slugs; `thresholds` is seed-only (not on the wire). */
export const SeedTestBase = z.strictObject({
  slug: Slug,
  skill: Slug,
  metric: z.string().min(1),
  unit: z.string().min(1),
  direction: TestDirection,
  protocol: SeedText,
  equipment: Equipment,
  thresholds: SeedTestThresholds.optional(),
});
export const SeedTest = SeedTestBase.check(thresholdsMonotonic);
export type SeedTest = z.infer<typeof SeedTest>;

export const SeedTestsFile = z
  .strictObject({ sport: Slug, tests: z.array(SeedTest) })
  .check(uniqueSlugs("tests"));
export type SeedTestsFile = z.infer<typeof SeedTestsFile>;

// --- drill track files ------------------------------------------------------------------------

/**
 * Derived: DrillSummary (slug, title, minutes, equipment, space; `level` 1-3 maps onto
 * ExperienceLevel), DrillContent (goal, instructions, dose, mistakes, safety, partner, ages;
 * the single `space` becomes `conditions.spaces`) and Attribution (author, source, sourceUrl,
 * license, semver; `createdAt` is stamped when seeding). The licence is REQUIRED: primitives'
 * LicenseId bakes in a default that would mask a missing field (fc-7ah). Progression and
 * regression are drill slugs here; the seeding job resolves them.
 */
export const SeedDrillBase = z.strictObject({
  slug: Slug,
  title: SeedText,
  goal: SeedText,
  instructions: SeedText,
  dose: DrillDose,
  mistakes: z.array(SeedText).optional(),
  safety: z.array(SeedText).optional(),
  progressionSlugs: z.array(Slug).optional(),
  regressionSlugs: z.array(Slug).optional(),
  minutes: z.int().positive(),
  level: z.int().min(DRILL_LEVEL_MIN).max(DRILL_LEVEL_MAX),
  ageMin: Age,
  ageMax: Age,
  equipment: Equipment,
  space: Space,
  partner: z.boolean().optional(),
  license: z.enum(LICENSE_IDS),
  author: z.string().min(1),
  source: z.string().min(1),
  sourceUrl: z.httpUrl().optional(),
  semver: Semver,
});
export const SeedDrill = SeedDrillBase.check(ageOrder);
export type SeedDrill = z.infer<typeof SeedDrill>;

export const SeedDrillTrackFile = z
  .strictObject({ sport: Slug, track: Slug, drills: z.array(SeedDrill) })
  .check(uniqueSlugs("drills"));
export type SeedDrillTrackFile = z.infer<typeof SeedDrillTrackFile>;

// --- rubrics.json -----------------------------------------------------------------------------

/**
 * Derived (the criteria name the file but give no shape): what a coach checks to award one
 * skill level, on the same 1-5 scale as SkillNode levels.
 */
export const SeedRubric = z.strictObject({
  skill: Slug,
  level: z.int().min(SKILL_LEVEL_MIN).max(SKILL_LEVEL_MAX),
  criteria: SeedText,
});
export type SeedRubric = z.infer<typeof SeedRubric>;

export const SeedRubricsFile = z.strictObject({ sport: Slug, rubrics: z.array(SeedRubric) });
export type SeedRubricsFile = z.infer<typeof SeedRubricsFile>;
