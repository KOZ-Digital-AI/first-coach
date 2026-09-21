// Level estimation from baseline test results (fc-mol-9l4.5). Pure: no database, clock or
// randomness, and no input is mutated.
//
// Boundary semantics (seed-schema.ts SeedTestThresholds): a test's band holds four boundaries
// [t2, t3, t4, t5], the values needed to REACH levels 2..5. A boundary is met when `value >= t`
// for a higher-is-better test and `value <= t` for a lower-is-better one (inclusive). The level is
// 1 + the number of boundaries met.
import type { SeedTestThresholds, ThresholdBand } from "../commons/seed-schema";
import type { SkillTestWithThresholds } from "../commons/repo";
import { AGE_MAX, AGE_MIN } from "../shared/domain";
import type { RoadmapTrack } from "../shared/domain";
import type { BaselineResult } from "../shared/onboarding";
import type { ExperienceLevel } from "../shared/primitives";

/** The part of a baseline result the estimator reads (the wire BaselineResult without its ids). */
export type LevelResult = Pick<BaselineResult, "testSlug" | "value" | "errors" | "skipped">;

/** Seconds a slalom error adds to the measured time. Applies to lower-is-better tests only. */
export const SLALOM_ERROR_PENALTY_SECONDS = 1;

/** The track level a player's self-declared experience stands for when a test gives none. */
export const SELF_LEVEL_TO_TRACK_LEVEL = {
  beginner: 1,
  basic: 2,
  intermediate: 3,
} as const satisfies Record<ExperienceLevel, RoadmapTrack["level"]>;

/**
 * age <= 9 is `upTo9`, 10..13 `from10to13`, >= 14 `from14`. A RangeError for an age outside the
 * contract's Age (an integer AGE_MIN..AGE_MAX): NaN, non-integers and out-of-bound ages.
 */
export function thresholdBandForAge(age: number): ThresholdBand {
  if (!Number.isInteger(age) || age < AGE_MIN || age > AGE_MAX) {
    throw new RangeError(`age must be an integer from ${AGE_MIN} to ${AGE_MAX}, got ${age}`);
  }
  if (age <= 9) return "upTo9";
  if (age <= 13) return "from10to13";
  return "from14";
}

/**
 * The level 1..5 a scored value reaches. Errors are a slalom concept: they add a time penalty on a
 * lower-is-better test and are ignored on a higher-is-better one.
 */
function scoredLevel(test: SkillTestWithThresholds, boundaries: SeedTestThresholds[ThresholdBand], result: LevelResult): RoadmapTrack["level"] {
  const higher = test.direction === "higher";
  const value = higher ? result.value : result.value + (result.errors ?? 0) * SLALOM_ERROR_PENALTY_SECONDS;
  const met = boundaries.filter((boundary) => (higher ? value >= boundary : value <= boundary)).length;
  return 1 + met;
}

/**
 * One roadmap track per skill: the level the player's baseline result reaches for their age band
 * (source "test"), or the self-declared level (source "self") when the track has no test, the test
 * has no thresholds, or its result is missing or skipped.
 *
 * `tracks` defaults to the distinct skills of `tests`, in test order; pass it to include tracks
 * that no test measures. With several tests on one track, the first scored one in `tests` order
 * decides.
 */
export function estimateLevels(
  age: number,
  results: readonly LevelResult[],
  tests: readonly SkillTestWithThresholds[],
  selfLevel: ExperienceLevel,
  tracks: readonly string[] = [...new Set(tests.map((test) => test.skill))],
): RoadmapTrack[] {
  const band = thresholdBandForAge(age);
  return tracks.map((skill) => {
    for (const test of tests) {
      if (test.skill !== skill || test.thresholds === null) continue;
      const result = results.find((each) => each.testSlug === test.slug);
      if (result === undefined || result.skipped === true) continue;
      return { skill, level: scoredLevel(test, test.thresholds[band], result), source: "test" as const };
    }
    return { skill, level: SELF_LEVEL_TO_TRACK_LEVEL[selfLevel], source: "self" as const };
  });
}
