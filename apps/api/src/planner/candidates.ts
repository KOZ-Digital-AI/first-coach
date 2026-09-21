// The planner's candidate filter (fc-mol-9l4.6): the ONLY source of drills for both the
// deterministic and the AI planner. Pure: no database, no clock, no I/O; inputs are never mutated.
//
// `candidates(profile, levels, settings, versions, graph)` returns the published drill versions a
// player may be given. Versions are first reduced to ONE per drill (see below); then a version is
// kept when ALL of these hold:
//   - equipment  the drill's kit is one the player owns (see EQUIPMENT_OWNED).
//   - space      the drill can be done in a space no larger than the player's (see SPACE_SIZE).
//   - partner    a drill that needs a partner only when profile.partner is true.
//   - age        ageMin <= age <= ageMax, inclusive; a null bound is open.
//   - status     status rank >= the configured minimum of the player's age band.
//   - level      drill level <= track level + 1 (see EXPERIENCE_NUMBER).
//   - prereqs    every skill the drill trains is in the graph and has all its prerequisites met.
// Sorted by trust status (highest first), then level (lowest first), then slug (a total order).
//
// SAFETY: the filter fails CLOSED. `graph` is a required argument (no default): the prerequisite
// rule is always applied, and a drill training a skill the graph does not list is excluded. A
// player age outside AGE_MIN..AGE_MAX (integers) is a RangeError, never a guess.
//
// READINGS the criteria leave open (each pinned by a test):
//   - The profile stores ONE equipment preset (shared/domain PlayerProfile.equipment), not a list.
//     The preset is expanded into what the player owns: ball_wall implies ball, cones implies ball,
//     full_field implies everything; nothing is always owned. It is NOT the reverse: a 'ball'
//     player owns neither the wall nor cones, so a ball_wall/cones drill is never given to them.
//   - A drill lists every space it can be done in (`spaces`). The Space enum has no ordering, so
//     this is the conservative reading of size: home_3x3 1, yard 2, gym 2, field 3. A gym hall is
//     treated as EQUAL to a yard, never as a field: it has no 15 m run-up, so a field-only drill is
//     not offered in a gym. A drill fits when the SMALLEST of its spaces is not larger than the
//     player's space (a drill for a small space also works in a bigger one). Plain membership would
//     leave a gym player with no drills, since the seed lists none for a gym.
//   - Levels: a track's level is an integer 1..5 (`levels`, keyed by skill slug; a missing key is 1);
//     a drill's level is an ExperienceLevel, numbered beginner 1, basic 2, intermediate 3. The
//     "track" of a drill is its primary skill (PublishedVersion.track); a drill without one
//     counts as track level 1 (and, training no skill, has no prerequisites to meet).
//   - Prerequisites come from the skill graph (SkillNode.prerequisites {skill, minLevel}), which a
//     version does not carry, hence the `graph` argument. Each skill the drill trains
//     (`version.skills`) must be a node of the graph and have every prerequisite at
//     `(levels[skill] ?? 1) >= minLevel`; one step deep, not transitive. The level estimator emits
//     only the 5 test tracks, so a sub-skill's level is absent (= 1) unless the caller supplies
//     sub-skill levels: sub-skill drills whose prerequisites need minLevel >= 2 are NOT offered
//     until it does (fail closed). The seed's drills all train top-level tracks, which have no
//     prerequisites.
//   - `versions` must hold the CURRENT published version of each drill, one per drill (as
//     listPublishedVersions returns); duplicates of one drill are the caller's bug. To be safe the
//     filter DEDUPES by drillId first and keeps the highest attribution.semver (numeric parts, a
//     release above its pre-release, then versionId as a last tie-break). Dedupe runs BEFORE the
//     rules, so a newer version that fails a rule is never replaced by an older one that passes.
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
import { AGE_MAX, AGE_MIN } from '../shared/domain';
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

/** Space size (conservative: a gym hall equals a yard, it is not a field). */
export const SPACE_SIZE: Readonly<Record<Space, number>> = { home_3x3: 1, yard: 2, gym: 2, field: 3 };

/** A drill's ExperienceLevel as a number, comparable with a track level. */
export const EXPERIENCE_NUMBER: Readonly<Record<ExperienceLevel, number>> = { beginner: 1, basic: 2, intermediate: 3 };

/** The age band whose minimum status applies: <= 9 u10, 10..13 u14, >= 14 adult. RangeError unless age is an integer in AGE_MIN..AGE_MAX. */
export function minStatusBandForAge(age: number): AgeBand {
  if (!Number.isInteger(age) || age < AGE_MIN || age > AGE_MAX) {
    throw new RangeError(`Age must be an integer from ${AGE_MIN} to ${AGE_MAX}, got ${String(age)}`);
  }
  if (age <= 9) return 'u10';
  if (age <= 13) return 'u14';
  return 'adult';
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Highest attribution.semver first: numeric core, a release above its pre-release, then the pre-release text. */
function compareSemver(a: string, b: string): number {
  const parse = (semver: string) => {
    const [core = '', ...pre] = semver.split('-');
    return { parts: core.split('.').map(Number), pre: pre.join('-') };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === '') return 1;
  if (y.pre === '') return -1;
  return compare(x.pre, y.pre);
}

const isNewer = (a: PublishedVersion, b: PublishedVersion): boolean =>
  compareSemver(a.attribution.semver, b.attribution.semver) > 0 ||
  (compareSemver(a.attribution.semver, b.attribution.semver) === 0 && compare(a.versionId, b.versionId) > 0);

/** One version per drill: the newest. Input order is irrelevant; the input is not touched. */
function currentVersions(versions: readonly PublishedVersion[]): PublishedVersion[] {
  const newest = new Map<string, PublishedVersion>();
  for (const v of versions) {
    const known = newest.get(v.drillId);
    if (known === undefined || isNewer(v, known)) newest.set(v.drillId, v);
  }
  return [...newest.values()];
}

const levelOf = (levels: Levels, skill: string | null): number =>
  skill !== null && Object.hasOwn(levels, skill) ? (levels[skill] ?? 1) : 1;

export function candidates(
  profile: CandidateProfile,
  levels: Levels,
  settings: CandidateSettings,
  versions: readonly PublishedVersion[],
  graph: PrerequisiteGraph,
): PublishedVersion[] {
  const minRank = TRUST_RANK[settings.minStatusByAgeBand[minStatusBandForAge(profile.age)]];
  const owned = EQUIPMENT_OWNED[profile.equipment];
  const playerSpace = SPACE_SIZE[profile.space];
  const prerequisitesOf = new Map(graph.nodes.map((node) => [node.slug, node.prerequisites]));

  const allowed = (v: PublishedVersion): boolean =>
    owned.includes(v.equipment) &&
    Math.min(...v.spaces.map((space) => SPACE_SIZE[space])) <= playerSpace &&
    (profile.partner || !v.partner) &&
    (v.ageMin === null || v.ageMin <= profile.age) &&
    (v.ageMax === null || v.ageMax >= profile.age) &&
    TRUST_RANK[v.status] >= minRank &&
    EXPERIENCE_NUMBER[v.level] <= levelOf(levels, v.track) + 1 &&
    v.skills.every((skill) => {
      const prerequisites = prerequisitesOf.get(skill);
      return prerequisites !== undefined && prerequisites.every((pre) => levelOf(levels, pre.skill) >= pre.minLevel);
    });

  return currentVersions(versions)
    .filter(allowed)
    .sort(
      (a, b) =>
        TRUST_RANK[b.status] - TRUST_RANK[a.status] ||
        EXPERIENCE_NUMBER[a.level] - EXPERIENCE_NUMBER[b.level] ||
        compare(a.slug, b.slug),
    );
}
