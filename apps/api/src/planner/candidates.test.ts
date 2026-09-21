import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { loadSeed } from '../commons/seed-loader';
import { getSkillGraph, listPublishedVersions } from '../commons/repo';
import type { PublishedVersion } from '../commons/repo';
import { DEFAULT_SETTINGS } from '../admin/settings';
import type { Settings } from '../admin/settings';
import { EQUIPMENT, SPACES, TRUST_STATUSES } from '../shared/primitives';
import type { Equipment, Space, TrustStatus } from '../shared/primitives';
import type { SkillGraph } from '../shared/commons';
import { TRUST_RANK, candidates, minStatusBandForAge } from './candidates';

// The real seed (config/commons) is loaded on a migrated in-memory database and read back through
// repo.ts, so the filter is exercised against the exact published versions the planner will get.
// Rule-specific tests derive their variants from a REAL version by overriding one field (spread),
// never from an invented drill.

const SEED_DIR = resolve(import.meta.dir, '../../../../config/commons');

let db: Database;
let versions: PublishedVersion[];
let graph: SkillGraph;

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  versions = listPublishedVersions(db);
  const loaded = getSkillGraph(db, 'football', 'en');
  if (loaded === null) throw new Error('football skill graph missing from the seed');
  graph = loaded;
});

afterAll(() => {
  db.close();
});

// --- helpers ---------------------------------------------------------------------------------

const AGES = [7, 12, 16] as const;
const PARTNER = [false, true] as const;

const profile = (over: { age?: number; equipment?: Equipment; space?: Space; partner?: boolean } = {}) => ({
  age: 12,
  equipment: 'ball' as Equipment,
  space: 'yard' as Space,
  partner: false,
  ...over,
});

const settingsWith = (min: Partial<Settings['minStatusByAgeBand']>): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  minStatusByAgeBand: { ...DEFAULT_SETTINGS.minStatusByAgeBand, ...min },
});
const ALL_REVIEWED = settingsWith({ u10: 'REVIEWED', u14: 'REVIEWED', adult: 'REVIEWED' });

/** A real version with some fields overridden. */
function variant(over: Partial<PublishedVersion>, base: PublishedVersion = versions[0]!): PublishedVersion {
  return { ...structuredClone(base), ...over };
}

const slugs = (list: readonly PublishedVersion[]): string[] => list.map((v) => v.slug);

/** Test-side statement of what a player owns, spelled out per preset (independent of the implementation). */
const OWNED: Record<Equipment, readonly Equipment[]> = {
  nothing: ['nothing'],
  ball: ['nothing', 'ball'],
  ball_wall: ['nothing', 'ball', 'ball_wall'],
  cones: ['nothing', 'ball', 'cones'],
  full_field: ['nothing', 'ball', 'ball_wall', 'cones', 'full_field'],
};
const SPACE_SIZE: Record<Space, number> = { home_3x3: 0, yard: 1, field: 2, gym: 3 };
const EXPERIENCE_NUMBER = { beginner: 1, basic: 2, intermediate: 3 } as const;
const BAND_OF = (age: number) => (age <= 9 ? 'u10' : age <= 13 ? 'u14' : 'adult');

/** The rules a version breaks for a player: [] means it may be given. Real seed: no prerequisites, no levels. */
function violations(v: PublishedVersion, p: ReturnType<typeof profile>, settings: Settings, levels: Record<string, number>): string[] {
  const broken: string[] = [];
  if (!OWNED[p.equipment].includes(v.equipment)) broken.push('equipment');
  if (!v.spaces.some((s) => SPACE_SIZE[s] <= SPACE_SIZE[p.space])) broken.push('space');
  if (v.partner && !p.partner) broken.push('partner');
  if (v.ageMin !== null && p.age < v.ageMin) broken.push('ageMin');
  if (v.ageMax !== null && p.age > v.ageMax) broken.push('ageMax');
  if (TRUST_STATUSES.indexOf(v.status) < TRUST_STATUSES.indexOf(settings.minStatusByAgeBand[BAND_OF(p.age)])) broken.push('status');
  const trackLevel = v.track === null ? 1 : (levels[v.track] ?? 1);
  if (EXPERIENCE_NUMBER[v.level] > trackLevel + 1) broken.push('level');
  return broken;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// --- band + rank -----------------------------------------------------------------------------

describe('minStatusBandForAge', () => {
  test.each([
    [0, 'u10'],
    [5, 'u10'],
    [7, 'u10'],
    [9, 'u10'],
    [10, 'u14'],
    [12, 'u14'],
    [13, 'u14'],
    [14, 'adult'],
    [16, 'adult'],
    [99, 'adult'],
  ] as const)('age %i is band %s', (age, band) => {
    expect(minStatusBandForAge(age)).toBe(band);
  });

  test.each([-1, 9.5, Number.NaN, Number.POSITIVE_INFINITY])('age %p is a RangeError', (age) => {
    expect(() => minStatusBandForAge(age)).toThrow(RangeError);
  });

  test('candidates refuses an invalid age the same way', () => {
    expect(() => candidates(profile({ age: 9.5 }), {}, DEFAULT_SETTINGS, versions, graph)).toThrow(RangeError);
  });
});

describe('TRUST_RANK', () => {
  test('follows the TRUST_STATUSES order, strictly increasing', () => {
    expect(TRUST_RANK).toEqual({ COMMUNITY: 0, REVIEWED: 1, EXPERT_VERIFIED: 2, ACADEMY_VERIFIED: 3 });
  });
});

// --- the real seed ---------------------------------------------------------------------------

describe('the real seed', () => {
  test('the seed under test is the 60 published COMMUNITY drills', () => {
    expect(versions).toHaveLength(60);
    expect(new Set(versions.map((v) => v.status))).toEqual(new Set(['COMMUNITY']));
  });

  test('every equipment x space x age x partner combination gets a non-empty pool (levels absent)', () => {
    const empty: string[] = [];
    for (const equipment of EQUIPMENT) {
      for (const space of SPACES) {
        for (const age of AGES) {
          for (const partner of PARTNER) {
            const pool = candidates({ age, equipment, space, partner }, {}, DEFAULT_SETTINGS, versions, graph);
            if (pool.length === 0) empty.push(`${equipment}/${space}/${age}/${String(partner)}`);
          }
        }
      }
    }
    expect(empty).toEqual([]);
  });

  test('a beginner with every track at level 1 gets a non-empty pool for every combination', () => {
    const levels = Object.fromEntries(graph.nodes.map((n) => [n.slug, 1]));
    for (const equipment of EQUIPMENT) {
      for (const space of SPACES) {
        for (const age of AGES) {
          for (const partner of PARTNER) {
            const pool = candidates({ age, equipment, space, partner }, levels, DEFAULT_SETTINGS, versions, graph);
            expect(pool.length, `${equipment}/${space}/${age}/${String(partner)}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  test('a ball_wall or cones drill never appears for a Ball only player', () => {
    for (const space of SPACES) {
      for (const age of AGES) {
        for (const partner of PARTNER) {
          const pool = candidates({ age, equipment: 'ball', space, partner }, { 'ball-mastery': 5 }, DEFAULT_SETTINGS, versions, graph);
          for (const v of pool) expect(['nothing', 'ball']).toContain(v.equipment);
        }
      }
    }
    // The seed really has such drills, so the assertion above is not vacuous.
    expect(versions.some((v) => v.equipment === 'ball_wall')).toBe(true);
    expect(versions.some((v) => v.equipment === 'cones')).toBe(true);
  });

  test('a ball_wall player also gets ball drills but no cones drill, and a cones player no ball_wall drill', () => {
    const wall = candidates(profile({ equipment: 'ball_wall', space: 'gym', age: 12, partner: true }), { 'ball-mastery': 5, dribbling: 5, 'weak-foot': 5, 'passing-first-touch': 5, 'juggling-coordination': 5 }, DEFAULT_SETTINGS, versions, graph);
    expect(new Set(wall.map((v) => v.equipment))).toEqual(new Set(['nothing', 'ball', 'ball_wall']));
    const cones = candidates(profile({ equipment: 'cones', space: 'gym', age: 12, partner: true }), { 'ball-mastery': 5, dribbling: 5, 'weak-foot': 5, 'passing-first-touch': 5, 'juggling-coordination': 5 }, DEFAULT_SETTINGS, versions, graph);
    expect(new Set(cones.map((v) => v.equipment))).toEqual(new Set(['nothing', 'ball', 'cones']));
  });

  test('raising the minimum status to REVIEWED empties the Genesis pool for every combination', () => {
    for (const equipment of EQUIPMENT) {
      for (const space of SPACES) {
        for (const age of AGES) {
          for (const partner of PARTNER) {
            expect(candidates({ age, equipment, space, partner }, {}, ALL_REVIEWED, versions, graph)).toEqual([]);
          }
        }
      }
    }
  });

  test('the minimum is read per age band: 7 -> u10, 12 -> u14, 16 -> adult', () => {
    const p = (age: number) => profile({ age, equipment: 'full_field', space: 'gym', partner: true });
    const u10 = settingsWith({ u10: 'REVIEWED' });
    expect(candidates(p(7), {}, u10, versions, graph)).toEqual([]);
    expect(candidates(p(12), {}, u10, versions, graph)).not.toEqual([]);
    expect(candidates(p(16), {}, u10, versions, graph)).not.toEqual([]);
    const u14 = settingsWith({ u14: 'REVIEWED' });
    expect(candidates(p(7), {}, u14, versions, graph)).not.toEqual([]);
    expect(candidates(p(12), {}, u14, versions, graph)).toEqual([]);
    expect(candidates(p(16), {}, u14, versions, graph)).not.toEqual([]);
    const adult = settingsWith({ adult: 'REVIEWED' });
    expect(candidates(p(7), {}, adult, versions, graph)).not.toEqual([]);
    expect(candidates(p(12), {}, adult, versions, graph)).not.toEqual([]);
    expect(candidates(p(16), {}, adult, versions, graph)).toEqual([]);
  });

  test('every result satisfies every rule, and every excluded drill breaks one (whole grid, several level sets)', () => {
    const levelSets: Record<string, number>[] = [
      {},
      { 'ball-mastery': 1, dribbling: 1, 'weak-foot': 1, 'passing-first-touch': 1, 'juggling-coordination': 1 },
      { 'ball-mastery': 2, dribbling: 3, 'weak-foot': 1 },
      { 'ball-mastery': 5, dribbling: 5, 'weak-foot': 5, 'passing-first-touch': 5, 'juggling-coordination': 5 },
    ];
    for (const levels of levelSets) {
      for (const equipment of EQUIPMENT) {
        for (const space of SPACES) {
          for (const age of [5, 7, 9, 10, 12, 14, 16, 40]) {
            for (const partner of PARTNER) {
              const p = { age, equipment, space, partner };
              const pool = candidates(p, levels, DEFAULT_SETTINGS, versions, graph);
              const chosen = new Set(pool);
              const label = `${JSON.stringify(levels)} ${equipment}/${space}/${age}/${String(partner)}`;
              for (const v of versions) {
                const broken = violations(v, p, DEFAULT_SETTINGS, levels);
                if (chosen.has(v)) expect(broken, `${label} ${v.slug} was given`).toEqual([]);
                else expect(broken.length, `${label} ${v.slug} was excluded for no reason`).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
  });

  test('default settings apply no status filter to a COMMUNITY seed: same pool as the Genesis bands', () => {
    const everyone = candidates(profile({ equipment: 'full_field', space: 'gym', age: 16, partner: true }), { 'ball-mastery': 5, dribbling: 5, 'weak-foot': 5, 'passing-first-touch': 5, 'juggling-coordination': 5 }, DEFAULT_SETTINGS, versions, graph);
    const ageOk = versions.filter((v) => (v.ageMin ?? 0) <= 16 && (v.ageMax ?? 99) >= 16);
    expect(slugs(everyone).sort()).toEqual(slugs(ageOk).sort());
  });

  test('partner drills appear only when a partner is available', () => {
    const base = { age: 12, equipment: 'full_field' as Equipment, space: 'gym' as Space };
    const levels = { 'ball-mastery': 5, dribbling: 5, 'weak-foot': 5, 'passing-first-touch': 5, 'juggling-coordination': 5 };
    const alone = candidates({ ...base, partner: false }, levels, DEFAULT_SETTINGS, versions, graph);
    const together = candidates({ ...base, partner: true }, levels, DEFAULT_SETTINGS, versions, graph);
    expect(alone.some((v) => v.partner)).toBe(false);
    expect(together.some((v) => v.partner)).toBe(true);
    expect(together.length).toBeGreaterThan(alone.length);
  });

  test('a home_3x3 player is only given drills that can be done in a home_3x3 space', () => {
    const pool = candidates(profile({ space: 'home_3x3', equipment: 'full_field', partner: true, age: 12 }), { 'ball-mastery': 5, dribbling: 5, 'weak-foot': 5, 'passing-first-touch': 5, 'juggling-coordination': 5 }, DEFAULT_SETTINGS, versions, graph);
    expect(pool.length).toBeGreaterThan(0);
    for (const v of pool) expect(v.spaces).toContain('home_3x3');
    expect(versions.some((v) => !v.spaces.includes('home_3x3'))).toBe(true);
  });
});

// --- single rules on real-derived versions ------------------------------------------------------

describe('space', () => {
  const only = (spaces: Space[]) => variant({ spaces, space: spaces[0]!, level: 'beginner', equipment: 'nothing', partner: false, ageMin: null, ageMax: null });
  const fits = (drillSpaces: Space[], player: Space) => candidates(profile({ space: player }), {}, DEFAULT_SETTINGS, [only(drillSpaces)], graph).length === 1;

  test('a drill fits a player whose space is at least as large as the smallest space the drill supports', () => {
    expect(fits(['yard'], 'home_3x3')).toBe(false);
    expect(fits(['yard'], 'yard')).toBe(true);
    expect(fits(['yard'], 'field')).toBe(true);
    expect(fits(['field'], 'yard')).toBe(false);
    expect(fits(['field'], 'gym')).toBe(true);
    expect(fits(['gym'], 'field')).toBe(false);
    expect(fits(['field', 'yard'], 'yard')).toBe(true);
    expect(fits(['field', 'gym'], 'yard')).toBe(false);
  });
});

describe('age', () => {
  const ranged = (ageMin: number | null, ageMax: number | null) => variant({ ageMin, ageMax, level: 'beginner', equipment: 'nothing', partner: false, spaces: ['home_3x3'], space: 'home_3x3' });
  const given = (age: number, v: PublishedVersion) => candidates(profile({ age, space: 'gym' }), {}, DEFAULT_SETTINGS, [v], graph).length === 1;

  test('the range is inclusive at both ends', () => {
    const v = ranged(8, 12);
    expect([7, 8, 12, 13].map((age) => given(age, v))).toEqual([false, true, true, false]);
  });

  test('a null bound is open', () => {
    expect([5, 99].map((age) => given(age, ranged(null, null)))).toEqual([true, true]);
    expect([5, 99].map((age) => given(age, ranged(null, 10)))).toEqual([true, false]);
    expect([5, 99].map((age) => given(age, ranged(10, null)))).toEqual([false, true]);
  });
});

describe('trust status', () => {
  const withStatus = (status: TrustStatus, slug: string) => variant({ status, slug, level: 'beginner', equipment: 'nothing', partner: false, ageMin: null, ageMax: null, spaces: ['home_3x3'], space: 'home_3x3' });
  const one = (status: TrustStatus) => withStatus(status, status.toLowerCase());

  test('a drill at exactly the minimum is kept, a lower one is dropped, a higher one is kept', () => {
    const p = profile({ age: 12 });
    const mixed = TRUST_STATUSES.map(one);
    const at = (min: TrustStatus) => slugs(candidates(p, {}, settingsWith({ u14: min }), mixed, graph)).sort();
    expect(at('COMMUNITY')).toEqual(['academy_verified', 'community', 'expert_verified', 'reviewed']);
    expect(at('REVIEWED')).toEqual(['academy_verified', 'expert_verified', 'reviewed']);
    expect(at('EXPERT_VERIFIED')).toEqual(['academy_verified', 'expert_verified']);
    expect(at('ACADEMY_VERIFIED')).toEqual(['academy_verified']);
  });
});

describe('level', () => {
  const at = (level: PublishedVersion['level'], track: string | null) =>
    variant({ level, track, skills: track === null ? [] : [track], slug: `${track}-${level}`, equipment: 'nothing', partner: false, ageMin: null, ageMax: null, spaces: ['home_3x3'], space: 'home_3x3' });
  const pick = (levels: Record<string, number>, list: PublishedVersion[]) => slugs(candidates(profile(), levels, DEFAULT_SETTINGS, list, graph)).sort();
  const dribbling = () => (['beginner', 'basic', 'intermediate'] as const).map((l) => at(l, 'dribbling'));

  test('a drill may be one level above the track level', () => {
    expect(pick({ dribbling: 1 }, dribbling())).toEqual(['dribbling-basic', 'dribbling-beginner']);
    expect(pick({ dribbling: 2 }, dribbling())).toEqual(['dribbling-basic', 'dribbling-beginner', 'dribbling-intermediate']);
    expect(pick({ dribbling: 5 }, dribbling())).toEqual(['dribbling-basic', 'dribbling-beginner', 'dribbling-intermediate']);
  });

  test('a track missing from levels counts as level 1, and only its own track level counts', () => {
    expect(pick({}, dribbling())).toEqual(['dribbling-basic', 'dribbling-beginner']);
    expect(pick({ 'weak-foot': 5 }, dribbling())).toEqual(['dribbling-basic', 'dribbling-beginner']);
  });

  test('a drill without a track counts as level 1', () => {
    expect(pick({ dribbling: 5 }, (['beginner', 'basic', 'intermediate'] as const).map((l) => at(l, null)))).toEqual(['null-basic', 'null-beginner']);
  });
});

describe('prerequisites', () => {
  const skilled = (skills: string[]) =>
    variant({ skills, track: skills[0] ?? null, slug: skills.join('+'), level: 'beginner', equipment: 'nothing', partner: false, ageMin: null, ageMax: null, spaces: ['home_3x3'], space: 'home_3x3' });
  const given = (levels: Record<string, number>, v: PublishedVersion, g: SkillGraph | null = graph) => candidates(profile(), levels, DEFAULT_SETTINGS, [v], g ?? undefined).length === 1;

  test('the real graph has the prerequisite the cases below rely on', () => {
    expect(graph.nodes.find((n) => n.slug === 'inside-touches')?.prerequisites).toEqual([{ skill: 'basic-touches', minLevel: 2 }]);
  });

  test('every prerequisite must reach its minLevel (a missing level counts as 1)', () => {
    const v = skilled(['inside-touches']);
    expect(given({}, v)).toBe(false);
    expect(given({ 'basic-touches': 1 }, v)).toBe(false);
    expect(given({ 'basic-touches': 2 }, v)).toBe(true);
    expect(given({ 'basic-touches': 5 }, v)).toBe(true);
    const two = skilled(['alternating-touches']);
    expect(given({ 'inside-touches': 3, 'outside-touches': 2 }, two)).toBe(false);
    expect(given({ 'inside-touches': 3, 'outside-touches': 3 }, two)).toBe(true);
  });

  test('a skill without prerequisites is always allowed', () => {
    expect(given({}, skilled(['basic-touches']))).toBe(true);
    expect(given({}, skilled(['dribbling']))).toBe(true);
  });

  test('every skill the drill trains has to have its prerequisites met, not only the track', () => {
    const v = skilled(['dribbling', 'inside-touches']);
    expect(given({}, v)).toBe(false);
    expect(given({ 'basic-touches': 2 }, v)).toBe(true);
  });

  test('a skill the graph does not know has no prerequisites', () => {
    expect(given({}, skilled(['no-such-skill']))).toBe(true);
  });

  test('with no graph supplied prerequisites are not checked', () => {
    expect(given({}, skilled(['inside-touches']), null)).toBe(true);
  });
});

// --- order, purity ---------------------------------------------------------------------------------

describe('order', () => {
  const make = (slug: string, status: TrustStatus, level: PublishedVersion['level']) =>
    variant({ slug, status, level, track: 'dribbling', skills: ['dribbling'], equipment: 'nothing', partner: false, ageMin: null, ageMax: null, spaces: ['home_3x3'], space: 'home_3x3' });

  test('trust status descending, then level ascending, then slug ascending', () => {
    const list = [
      make('b-community-beginner', 'COMMUNITY', 'beginner'),
      make('a-community-basic', 'COMMUNITY', 'basic'),
      make('z-reviewed-basic', 'REVIEWED', 'basic'),
      make('y-academy-basic', 'ACADEMY_VERIFIED', 'basic'),
      make('c-community-beginner', 'COMMUNITY', 'beginner'),
      make('x-expert-beginner', 'EXPERT_VERIFIED', 'beginner'),
      make('a-reviewed-beginner', 'REVIEWED', 'beginner'),
    ];
    const pool = candidates(profile(), { dribbling: 2 }, DEFAULT_SETTINGS, list, graph);
    expect(slugs(pool)).toEqual([
      'y-academy-basic',
      'x-expert-beginner',
      'a-reviewed-beginner',
      'z-reviewed-basic',
      'b-community-beginner',
      'c-community-beginner',
      'a-community-basic',
    ]);
  });

  test('the same input in any order gives the same result', () => {
    const p = profile({ equipment: 'full_field', space: 'gym', partner: true, age: 12 });
    const levels = { 'ball-mastery': 3 };
    const forward = slugs(candidates(p, levels, DEFAULT_SETTINGS, versions, graph));
    const backward = slugs(candidates(p, levels, DEFAULT_SETTINGS, [...versions].reverse(), graph));
    expect(backward).toEqual(forward);
    expect(new Set(forward).size).toBe(forward.length);
  });
});

describe('purity', () => {
  test('frozen inputs are neither mutated nor rejected, and the result is a new array of the same objects', () => {
    const frozenVersions = deepFreeze(structuredClone(versions));
    const frozenGraph = deepFreeze(structuredClone(graph));
    const frozenSettings = deepFreeze(structuredClone(DEFAULT_SETTINGS)) as Settings;
    const frozenProfile = deepFreeze(profile({ equipment: 'full_field', space: 'gym', partner: true, age: 12 }));
    const frozenLevels = deepFreeze({ 'ball-mastery': 2 });
    const before = JSON.stringify([frozenVersions, frozenGraph, frozenSettings, frozenProfile, frozenLevels]);
    const orderBefore = slugs(frozenVersions);

    const pool = candidates(frozenProfile, frozenLevels, frozenSettings, frozenVersions, frozenGraph);

    expect(pool.length).toBeGreaterThan(0);
    expect(pool).not.toBe(frozenVersions);
    for (const v of pool) expect(frozenVersions).toContain(v);
    expect(slugs(frozenVersions)).toEqual(orderBefore);
    expect(JSON.stringify([frozenVersions, frozenGraph, frozenSettings, frozenProfile, frozenLevels])).toBe(before);
  });

  test('an empty version list gives an empty pool', () => {
    expect(candidates(profile(), {}, DEFAULT_SETTINGS, [], graph)).toEqual([]);
  });
});

describe('equipment closure', () => {
  const kit = (equipment: Equipment) => variant({ equipment, level: 'beginner', partner: false, ageMin: null, ageMax: null, spaces: ['home_3x3'], space: 'home_3x3' });
  const owned = (player: Equipment) =>
    EQUIPMENT.filter((needed) => candidates(profile({ equipment: player, space: 'gym' }), {}, DEFAULT_SETTINGS, [kit(needed)], graph).length === 1);

  test('what each preset lets a player do', () => {
    expect(owned('nothing')).toEqual(['nothing']);
    expect(owned('ball')).toEqual(['nothing', 'ball']);
    expect(owned('ball_wall')).toEqual(['nothing', 'ball', 'ball_wall']);
    expect(owned('cones')).toEqual(['nothing', 'ball', 'cones']);
    expect(owned('full_field')).toEqual([...EQUIPMENT]);
  });
});
