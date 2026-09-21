// The planner's candidate filter (fc-mol-9l4.6): the ONLY source of drills for both the
// deterministic and the AI planner. Pure: no database, no clock, no I/O; inputs are never mutated.
//
// `candidates(profile, levels, settings, versions, graph?)` returns the published drill versions a
// player may be given. A version is kept when ALL of these hold:
//   - equipment  the drill's kit is one the player owns (see EQUIPMENT_OWNED).
//   - space      the drill can be done in a space no larger than the player's (see SPACE_SIZE).
//   - partner    a drill that needs a partner only when profile.partner is true.
//   - age        ageMin <= age <= ageMax, inclusive; a null bound is open.
//   - status     status rank >= the configured minimum of the player's age band.
//   - level      drill level <= track level + 1 (see EXPERIENCE_NUMBER).
//   - prereqs    every prerequisite of every skill the drill trains is met (see below).
// Sorted by trust status (highest first), then level (lowest first), then slug (a total order).
//
// READINGS the criteria leave open (each pinned by a test):
//   - The profile stores ONE equipment preset (shared/domain PlayerProfile.equipment), not a list.
//     The preset is expanded into what the player owns: ball_wall implies ball, cones implies ball,
//     full_field implies everything; nothing is always owned. It is NOT the reverse: a 'ball'
//     player owns neither the wall nor cones, so a ball_wall/cones drill is never given to them.
//   - A drill lists every space it can be done in (`spaces`). Space is read as SIZE, by the declared
//     order of the Space enum (home_3x3 < yard < field < gym): the drill fits when the smallest of
//     its spaces is not larger than the player's space (a drill for a small space also works in a
//     bigger one). Plain membership would leave a gym or field player without drills, since the
//     seed has none listed for a gym and one for a field.
//   - Levels: a track's level is an integer 1..5 (`levels`, keyed by skill slug; a missing key is 1);
//     a drill's level is an ExperienceLevel, numbered beginner 1, basic 2, intermediate 3. The
//     "track" of a drill is its primary skill (PublishedVersion.track); a drill without one
//     counts as track level 1.
//   - Prerequisites come from the skill graph (SkillNode.prerequisites {skill, minLevel}), which a
//     version does not carry, so it is an OPTIONAL fifth argument. Each skill the drill trains
//     (`version.skills`) must have every prerequisite at `(levels[skill] ?? 1) >= minLevel`; one
//     step deep, not transitive. A skill the graph does not list has none. Without a graph
//     prerequisites are not checked. (The seed's drills all train top-level tracks, which have no
//     prerequisites.)
//   - Trust order is TRUST_STATUSES' own: COMMUNITY < REVIEWED < EXPERT_VERIFIED < ACADEMY_VERIFIED
//     (the order repo.ts's `minStatus` floor already uses).
//   - Age bands (settings.minStatusByAgeBand): age <= 9 u10, 10..13 u14, >= 14 adult.
//   - `versions` come from listPublishedVersions, which returns published versions only, and the
//     type carries no unpublished/withdrawn flag, so none is checked here.
//
// `levels` is a minimal local type (a record of skill slug -> integer 1..5) so this module does not
// depend on the level estimator.
import type { PublishedVersion } from '../commons/repo';
import type { AgeBand, Settings } from '../admin/settings';
import { TRUST_STATUSES } from '../shared/primitives';
import type { Equipment, ExperienceLevel, Space, TrustStatus } from '../shared/primitives';

/** Skill slug (track or sub-skill) -> level 1..5. A missing slug counts as level 1. */
export type Levels = Readonly<Record<string, number>>;

/** The part of the player profile the filter reads (a full PlayerProfile fits). */
export interface CandidateProfile {
  age: number;
  equipment: Equipment;
  space: Space;
  partner: boolean;
}

/** The part of the skill graph the filter reads (a SkillGraph fits). */
export interface PrerequisiteGraph {
  nodes: readonly {
    slug: string;
    prerequisites: readonly { skill: string; minLevel: number }[];
  }[];
}

export type CandidateSettings = Pick<Settings, 'minStatusByAgeBand'>;

/** COMMUNITY 0 < REVIEWED 1 < EXPERT_VERIFIED 2 < ACADEMY_VERIFIED 3 (TRUST_STATUSES order). */
export const TRUST_RANK: Readonly<Record<TrustStatus, number>> = {
  COMMUNITY: TRUST_STATUSES.indexOf('COMMUNITY'),
  REVIEWED: TRUST_STATUSES.indexOf('REVIEWED'),
  EXPERT_VERIFIED: TRUST_STATUSES.indexOf('EXPERT_VERIFIED'),
  ACADEMY_VERIFIED: TRUST_STATUSES.indexOf('ACADEMY_VERIFIED'),
};

/** What each equipment preset lets a player do. */
export const EQUIPMENT_OWNED: Readonly<Record<Equipment, readonly Equipment[]>> = {
  nothing: ['nothing'],
  ball: ['nothing', 'ball'],
  ball_wall: ['nothing', 'ball', 'ball_wall'],
  cones: ['nothing', 'ball', 'cones'],
  full_field: ['nothing', 'ball', 'ball_wall', 'cones', 'full_field'],
};

/** Space size, by the declared order of the Space enum. */
export const SPACE_SIZE: Readonly<Record<Space, number>> = { home_3x3: 0, yard: 1, field: 2, gym: 3 };

/** A drill's ExperienceLevel as a number, comparable with a track level. */
export const EXPERIENCE_NUMBER: Readonly<Record<ExperienceLevel, number>> = { beginner: 1, basic: 2, intermediate: 3 };

/** The age band whose minimum status applies: <= 9 u10, 10..13 u14, >= 14 adult. RangeError for a negative, non-integer or non-finite age. */
export function minStatusBandForAge(age: number): AgeBand {
  if (!Number.isInteger(age) || age < 0) throw new RangeError(`Age must be a non-negative integer, got ${String(age)}`);
  if (age <= 9) return 'u10';
  if (age <= 13) return 'u14';
  return 'adult';
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const levelOf = (levels: Levels, skill: string | null): number =>
  skill !== null && Object.hasOwn(levels, skill) ? (levels[skill] ?? 1) : 1;

export function candidates(
  profile: CandidateProfile,
  levels: Levels,
  settings: CandidateSettings,
  versions: readonly PublishedVersion[],
  graph?: PrerequisiteGraph,
): PublishedVersion[] {
  const minRank = TRUST_RANK[settings.minStatusByAgeBand[minStatusBandForAge(profile.age)]];
  const owned = EQUIPMENT_OWNED[profile.equipment];
  const playerSpace = SPACE_SIZE[profile.space];
  const prerequisitesOf = new Map((graph?.nodes ?? []).map((node) => [node.slug, node.prerequisites]));

  const allowed = (v: PublishedVersion): boolean =>
    owned.includes(v.equipment) &&
    Math.min(...v.spaces.map((space) => SPACE_SIZE[space])) <= playerSpace &&
    (profile.partner || !v.partner) &&
    (v.ageMin === null || v.ageMin <= profile.age) &&
    (v.ageMax === null || v.ageMax >= profile.age) &&
    TRUST_RANK[v.status] >= minRank &&
    EXPERIENCE_NUMBER[v.level] <= levelOf(levels, v.track) + 1 &&
    v.skills.every((skill) => (prerequisitesOf.get(skill) ?? []).every((pre) => levelOf(levels, pre.skill) >= pre.minLevel));

  return versions
    .filter(allowed)
    .sort(
      (a, b) =>
        TRUST_RANK[b.status] - TRUST_RANK[a.status] ||
        EXPERIENCE_NUMBER[a.level] - EXPERIENCE_NUMBER[b.level] ||
        compare(a.slug, b.slug),
    );
}
