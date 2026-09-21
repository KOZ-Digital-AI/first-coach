// Roadmap builder (fc-mol-9l4.7). Ports the prototype's buildRoadmap (first-coach-demo.html): tracks
// sorted ascending by level, the stated goal's track moved to the front, the first FOCUS_MAX become
// the focus. Pure: no database, clock or randomness, and no input is mutated.
//
// Ties: Array.prototype.sort is stable, so equal levels keep the INPUT order. The goal's track goes
// first whatever its level. `tracks` in the result is the input in input order; the sort only
// decides the focus.
import { FOCUS_MAX, FOCUS_MIN, ROADMAP_WEEKS, SKILL_LEVEL_MAX } from "../shared/domain";
import type { PlayerProfile, Roadmap, RoadmapFocus, RoadmapTrack } from "../shared/domain";
import type { Goal } from "../shared/primitives";

/** The part of a player profile the builder reads. */
export type RoadmapProfile = Pick<PlayerProfile, "goal" | "daysPerWeek" | "minutesPerSession">;

/** Reason keys of a focus entry; the client localizes them (the contract's `reason` is free text). */
export const ROADMAP_REASON_GOAL = "goal";
export const ROADMAP_REASON_WEAKEST = "weakest";

/** The skill-graph root track a stated goal moves to the front (the prototype's preferredMap). */
export const GOAL_TO_TRACK = {
  control: "ball-mastery",
  dribbling: "dribbling",
  passing: "passing-first-touch",
  weakfoot: "weak-foot",
  coordination: "juggling-coordination",
} as const satisfies Record<Goal, string>;

export const LEVEL_LABELS = ["Foundation", "Basic", "Intermediate", "Advanced"] as const;
export type LevelLabel = (typeof LEVEL_LABELS)[number];

/** Inclusive lower bound of the mean level for each label above Foundation (which is anything lower). */
export const LEVEL_LABEL_MIN_MEANS = { Basic: 2, Intermediate: 3, Advanced: 4 } as const satisfies Record<Exclude<LevelLabel, "Foundation">, number>;

/** The label for a mean track level: each bound of LEVEL_LABEL_MIN_MEANS is inclusive. */
export function levelLabelForMean(mean: number): LevelLabel {
  if (mean >= LEVEL_LABEL_MIN_MEANS.Advanced) return "Advanced";
  if (mean >= LEVEL_LABEL_MIN_MEANS.Intermediate) return "Intermediate";
  if (mean >= LEVEL_LABEL_MIN_MEANS.Basic) return "Basic";
  return "Foundation";
}

/**
 * The player's 4-week roadmap: the FOCUS_MAX weakest tracks (the stated goal's track first), each
 * aimed one level up, capped at SKILL_LEVEL_MAX. A RangeError when there are fewer than FOCUS_MIN tracks.
 */
export function buildRoadmap(profile: RoadmapProfile, levels: readonly RoadmapTrack[]): Roadmap {
  if (levels.length < FOCUS_MIN) {
    throw new RangeError(`a roadmap needs at least ${FOCUS_MIN} tracks, got ${levels.length}`);
  }
  const ordered = [...levels].sort((a, b) => a.level - b.level);
  const goalTrack = GOAL_TO_TRACK[profile.goal];
  const goalIndex = ordered.findIndex((each) => each.skill === goalTrack);
  if (goalIndex > 0) {
    const [moved] = ordered.splice(goalIndex, 1);
    ordered.unshift(moved!);
  }
  const focus: RoadmapFocus[] = ordered.slice(0, FOCUS_MAX).map((each) => ({
    skill: each.skill,
    level: each.level,
    targetLevel: Math.min(each.level + 1, SKILL_LEVEL_MAX),
    reason: each.skill === goalTrack ? ROADMAP_REASON_GOAL : ROADMAP_REASON_WEAKEST,
  }));
  const mean = levels.reduce((sum, each) => sum + each.level, 0) / levels.length;
  return {
    currentLevelLabel: levelLabelForMean(mean),
    tracks: levels.map((each) => ({ ...each })),
    goal: profile.goal,
    weeks: ROADMAP_WEEKS,
    sessionsPerWeek: profile.daysPerWeek,
    minutesPerSession: profile.minutesPerSession,
    focus,
  };
}
