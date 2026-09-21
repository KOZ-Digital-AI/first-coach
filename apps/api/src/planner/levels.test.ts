import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { loadSeed } from '../commons/seed-loader';
import { getSkillTests } from '../commons/repo';
import type { SkillTestWithThresholds } from '../commons/repo';
import { AGE_MAX, AGE_MIN, SKILL_LEVEL_MAX, SKILL_LEVEL_MIN } from '../shared/domain';
import { EXPERIENCE_LEVELS } from '../shared/primitives';
import { SELF_LEVEL_TO_TRACK_LEVEL, SLALOM_ERROR_PENALTY_SECONDS, estimateLevels, thresholdBandForAge } from './levels';
import type { LevelResult } from './levels';

// Boundary semantics under test (seed-schema.ts SeedTestThresholds): [t2, t3, t4, t5] are the values
// needed to REACH levels 2..5: value >= t for a higher-is-better test, value <= t for a lower-is-better
// one. Level = 1 + the number of boundaries met.
//
// The "real seed" tests read config/commons/football/tests.json through loadSeed on a migrated
// in-memory database and getSkillTests, so the edges are the shipped numbers:
//   juggling-max-touches (higher) upTo9 [3,8,15,30]  from10to13 [5,12,25,50]  from14 [8,20,40,80]
//   slalom-time          (lower)  upTo9 [14,11.5,9.5,8]  from10to13 [12,10,8.5,7]  from14 [10,8.5,7,6]
// Tests with inline `tests` use the same TS type as input data for the pure function.

const SEED_DIR = resolve(import.meta.dir, '../../../../config/commons');

let db: Database;
let seedTests: SkillTestWithThresholds[];

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  seedTests = getSkillTests(db, 'football');
});

afterAll(() => {
  db.close();
});

const result = (testSlug: string, value: number, extra: Partial<LevelResult> = {}): LevelResult => ({ testSlug, value, ...extra });

const JUGGLING = 'juggling-max-touches';
const SLALOM = 'slalom-time';

/** The level of one real-seed test for a player of `age`, self level beginner. */
function realLevel(age: number, testSlug: string, value: number, extra: Partial<LevelResult> = {}): number {
  const skill = seedTests.find((t) => t.slug === testSlug)!.skill;
  const track = estimateLevels(age, [result(testSlug, value, extra)], seedTests, 'beginner').find((t) => t.skill === skill)!;
  expect(track.source).toBe('test');
  return track.level;
}

const inline = (over: Partial<SkillTestWithThresholds> = {}): SkillTestWithThresholds => ({
  slug: 't',
  skill: 'track',
  metric: 'm',
  unit: 'u',
  direction: 'higher',
  equipment: 'ball',
  protocol: { kk: 'k', ru: 'r', en: 'e' },
  thresholds: { upTo9: [1, 2, 3, 4], from10to13: [10, 20, 30, 40], from14: [100, 200, 300, 400] },
  ...over,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe('the real seed', () => {
  test('loads the five football tests, one per track, with thresholds', () => {
    expect(seedTests).toHaveLength(5);
    expect(new Set(seedTests.map((t) => t.skill)).size).toBe(5);
    for (const each of seedTests) expect(each.thresholds).not.toBeNull();
  });
});

describe('constants', () => {
  test('a slalom error costs one second', () => {
    expect(SLALOM_ERROR_PENALTY_SECONDS).toBe(1);
  });

  test('self levels map to track levels 1, 2, 3 and the keys are exactly the ExperienceLevel enum', () => {
    expect(SELF_LEVEL_TO_TRACK_LEVEL).toEqual({ beginner: 1, basic: 2, intermediate: 3 });
    expect(Object.keys(SELF_LEVEL_TO_TRACK_LEVEL).sort()).toEqual([...EXPERIENCE_LEVELS].sort());
  });
});

describe('thresholdBandForAge', () => {
  test('9 and under is upTo9, 10 to 13 is from10to13, 14 and over is from14', () => {
    expect(thresholdBandForAge(AGE_MIN)).toBe('upTo9');
    expect(thresholdBandForAge(9)).toBe('upTo9');
    expect(thresholdBandForAge(10)).toBe('from10to13');
    expect(thresholdBandForAge(13)).toBe('from10to13');
    expect(thresholdBandForAge(14)).toBe('from14');
    expect(thresholdBandForAge(AGE_MAX)).toBe('from14');
  });

  test.each([-1, 0, AGE_MIN - 1, AGE_MAX + 1, 10.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'throws a RangeError for %p (outside the contract Age, an integer AGE_MIN..AGE_MAX)',
    (age) => {
      expect(() => thresholdBandForAge(age)).toThrow(RangeError);
    },
  );
});

describe('higher-is-better edges (juggling, real seed)', () => {
  test('age 9 uses upTo9 [3, 8, 15, 30]: each boundary reaches its level, one below does not', () => {
    const cases: [number, number][] = [
      [0, 1], [2, 1], [3, 2], [7, 2], [8, 3], [14, 3], [15, 4], [29, 4], [30, 5], [1000, 5],
    ];
    for (const [value, level] of cases) expect(realLevel(9, JUGGLING, value), `value ${value}`).toBe(level);
  });

  test('age 14 uses from14 [8, 20, 40, 80]', () => {
    const cases: [number, number][] = [
      [7, 1], [8, 2], [19, 2], [20, 3], [39, 3], [40, 4], [79, 4], [80, 5],
    ];
    for (const [value, level] of cases) expect(realLevel(14, JUGGLING, value), `value ${value}`).toBe(level);
  });

  test('age 10 uses from10to13 [5, 12, 25, 50]', () => {
    const cases: [number, number][] = [
      [4, 1], [5, 2], [11, 2], [12, 3], [24, 3], [25, 4], [49, 4], [50, 5],
    ];
    for (const [value, level] of cases) expect(realLevel(10, JUGGLING, value), `value ${value}`).toBe(level);
  });

  test('the same value lands on different levels across the band cut-offs 9|10 and 13|14', () => {
    expect(realLevel(9, JUGGLING, 4)).toBe(2);
    expect(realLevel(10, JUGGLING, 4)).toBe(1);
    expect(realLevel(13, JUGGLING, 12)).toBe(3);
    expect(realLevel(14, JUGGLING, 12)).toBe(2);
  });
});

describe('lower-is-better edges (slalom, real seed)', () => {
  test('age 9 uses upTo9 [14, 11.5, 9.5, 8]: a boundary time reaches the level, a hair slower does not', () => {
    const cases: [number, number][] = [
      [30, 1], [14.01, 1], [14, 2], [11.51, 2], [11.5, 3], [9.51, 3], [9.5, 4], [8.01, 4], [8, 5], [0, 5],
    ];
    for (const [value, level] of cases) expect(realLevel(9, SLALOM, value), `time ${value}`).toBe(level);
  });

  test('age 14 uses from14 [10, 8.5, 7, 6]', () => {
    const cases: [number, number][] = [
      [10.01, 1], [10, 2], [8.51, 2], [8.5, 3], [7.01, 3], [7, 4], [6.01, 4], [6, 5],
    ];
    for (const [value, level] of cases) expect(realLevel(14, SLALOM, value), `time ${value}`).toBe(level);
  });

  test('age 13 uses from10to13 [12, 10, 8.5, 7] while age 14 uses from14 for the same time', () => {
    expect(realLevel(13, SLALOM, 7)).toBe(5);
    expect(realLevel(13, SLALOM, 7.01)).toBe(4);
    expect(realLevel(14, SLALOM, 7)).toBe(4);
    expect(realLevel(10, SLALOM, 12)).toBe(2);
    expect(realLevel(9, SLALOM, 12)).toBe(2);
    expect(realLevel(9, SLALOM, 11.5)).toBe(3);
    expect(realLevel(10, SLALOM, 11.5)).toBe(2);
  });
});

describe('slalom errors', () => {
  test('each error adds the penalty to the time, moving the player across a boundary', () => {
    // age 14, from14 [10, 8.5, 7, 6]: 6 s is level 5; 7 s level 4; 9 s level 2.
    expect(realLevel(14, SLALOM, 6, { errors: 0 })).toBe(5);
    expect(realLevel(14, SLALOM, 6, { errors: 1 })).toBe(4);
    expect(realLevel(14, SLALOM, 6, { errors: 3 })).toBe(2);
  });

  test('a missing errors field is the same as zero errors', () => {
    expect(realLevel(14, SLALOM, 6)).toBe(realLevel(14, SLALOM, 6, { errors: 0 }));
  });

  test('the penalised time is compared inclusively: 8.5 s clean is level 3, with one error 9.5 s is level 2', () => {
    expect(realLevel(14, SLALOM, 8.5, { errors: 0 })).toBe(3);
    expect(realLevel(14, SLALOM, 8.5, { errors: 1 })).toBe(2);
    // 7 s + 1 error = 8 s is still inside the 8.5 s boundary, 7 s + 2 errors = 9 s is not.
    expect(realLevel(14, SLALOM, 7, { errors: 1 })).toBe(3);
    expect(realLevel(14, SLALOM, 7, { errors: 2 })).toBe(2);
  });

  test('errors are never rewarded: more errors never raise the level', () => {
    for (const age of [9, 10, 13, 14]) {
      let previous = SKILL_LEVEL_MAX;
      for (let errors = 0; errors <= 6; errors += 1) {
        const level = realLevel(age, SLALOM, 6.5, { errors });
        expect(level).toBeLessThanOrEqual(previous);
        previous = level;
      }
    }
  });

  test('a higher-is-better test ignores errors', () => {
    // age 9, upTo9 [3, 8, 15, 30]: 14 touches is level 3; a penalty would carry 14 + 1 = 15 to level 4.
    expect(realLevel(9, JUGGLING, 14, { errors: 1 })).toBe(3);
    expect(realLevel(9, JUGGLING, 14, { errors: 5 })).toBe(3);
    expect(realLevel(9, JUGGLING, 14)).toBe(3);
  });
});

describe('fallback to the self-declared level', () => {
  const selfLevels = [
    ['beginner', 1],
    ['basic', 2],
    ['intermediate', 3],
  ] as const;

  test.each(selfLevels)('a missing result for a %p player is level %p with source self', (selfLevel, level) => {
    const tracks = estimateLevels(14, [], seedTests, selfLevel);
    expect(tracks).toHaveLength(5);
    for (const track of tracks) expect(track).toMatchObject({ level, source: 'self' });
  });

  test('an explicitly skipped result falls back even when its value would score the top level', () => {
    // A skipped slalom is sent as value 0, which would be level 5 if it were scored.
    const tracks = estimateLevels(14, [result(SLALOM, 0, { skipped: true })], seedTests, 'basic');
    const skill = seedTests.find((t) => t.slug === SLALOM)!.skill;
    expect(tracks.find((t) => t.skill === skill)).toEqual({ skill, level: 2, source: 'self' });
  });

  test('skipped: false is a scored result', () => {
    const tracks = estimateLevels(14, [result(SLALOM, 0, { skipped: false })], seedTests, 'basic');
    const skill = seedTests.find((t) => t.slug === SLALOM)!.skill;
    expect(tracks.find((t) => t.skill === skill)).toEqual({ skill, level: 5, source: 'test' });
  });

  test('only the skipped track falls back; the others stay scored', () => {
    const tracks = estimateLevels(
      14,
      [result(JUGGLING, 40), result(SLALOM, 0, { skipped: true })],
      seedTests,
      'intermediate',
    );
    const bySkill = Object.fromEntries(tracks.map((t) => [t.skill, t]));
    const juggling = seedTests.find((t) => t.slug === JUGGLING)!.skill;
    const slalom = seedTests.find((t) => t.slug === SLALOM)!.skill;
    expect(bySkill[juggling]).toEqual({ skill: juggling, level: 4, source: 'test' });
    expect(bySkill[slalom]).toEqual({ skill: slalom, level: 3, source: 'self' });
  });

  test('a test with null thresholds falls back to self even when a result was sent', () => {
    const tests = [inline({ slug: 'a', skill: 'no-thresholds', thresholds: null }), inline({ slug: 'b', skill: 'has-thresholds' })];
    const tracks = estimateLevels(9, [result('a', 999), result('b', 3)], tests, 'basic');
    expect(tracks).toEqual([
      { skill: 'no-thresholds', level: 2, source: 'self' },
      { skill: 'has-thresholds', level: 4, source: 'test' },
    ]);
  });

  test('a result for a test slug that no test carries is ignored', () => {
    const tracks = estimateLevels(9, [result('unknown', 1000)], [inline()], 'beginner');
    expect(tracks).toEqual([{ skill: 'track', level: 1, source: 'self' }]);
  });

  test('a track named by `tracks` that no test measures falls back to self', () => {
    const tracks = estimateLevels(9, [result('t', 4)], [inline()], 'intermediate', ['track', 'untested']);
    expect(tracks).toEqual([
      { skill: 'track', level: 5, source: 'test' },
      { skill: 'untested', level: 3, source: 'self' },
    ]);
  });
});

describe('output shape', () => {
  test('without `tracks` the tracks are the distinct skills of the tests, in test order, one entry each', () => {
    const tests = [inline({ slug: 'x', skill: 'b' }), inline({ slug: 'y', skill: 'a' }), inline({ slug: 'z', skill: 'b' })];
    expect(estimateLevels(9, [], tests, 'beginner').map((t) => t.skill)).toEqual(['b', 'a']);
  });

  test('`tracks` fixes the order and the entries, and an empty list is an empty roadmap', () => {
    const tests = [inline({ slug: 'x', skill: 'b' }), inline({ slug: 'y', skill: 'a' })];
    expect(estimateLevels(9, [], tests, 'beginner', ['a', 'b']).map((t) => t.skill)).toEqual(['a', 'b']);
    expect(estimateLevels(9, [], tests, 'beginner', [])).toEqual([]);
    expect(estimateLevels(9, [], [], 'beginner')).toEqual([]);
  });

  test('two tests on one track: the first scored test in test order decides, a skipped one is passed over', () => {
    const tests = [inline({ slug: 'first', skill: 'k' }), inline({ slug: 'second', skill: 'k' })];
    expect(estimateLevels(9, [result('first', 1), result('second', 4)], tests, 'beginner')).toEqual([{ skill: 'k', level: 2, source: 'test' }]);
    expect(estimateLevels(9, [result('first', 1, { skipped: true }), result('second', 4)], tests, 'beginner')).toEqual([
      { skill: 'k', level: 5, source: 'test' },
    ]);
    expect(estimateLevels(9, [result('second', 4)], tests, 'beginner')).toEqual([{ skill: 'k', level: 5, source: 'test' }]);
  });

  test('every real track has exactly one entry with a level in 1..5 for every age, self level and value', () => {
    const skills = seedTests.map((t) => t.skill);
    for (let age = AGE_MIN; age <= AGE_MAX; age += 1) {
      for (const selfLevel of EXPERIENCE_LEVELS) {
        for (const value of [0, 1, 7.5, 12, 45, 500]) {
          const results = seedTests.map((t, index) => result(t.slug, value, index % 2 === 0 ? { errors: 2 } : { skipped: true }));
          const tracks = estimateLevels(age, results, seedTests, selfLevel);
          expect(tracks.map((t) => t.skill)).toEqual(skills);
          for (const track of tracks) {
            expect(Number.isInteger(track.level)).toBe(true);
            expect(track.level).toBeGreaterThanOrEqual(SKILL_LEVEL_MIN);
            expect(track.level).toBeLessThanOrEqual(SKILL_LEVEL_MAX);
            expect(['test', 'self']).toContain(track.source);
          }
        }
      }
    }
  });

  test('scored results give source test on all five real tracks', () => {
    const results = seedTests.map((t) => result(t.slug, t.direction === 'higher' ? 1000 : 0));
    const tracks = estimateLevels(14, results, seedTests, 'beginner');
    expect(tracks).toHaveLength(5);
    for (const track of tracks) expect(track).toMatchObject({ level: 5, source: 'test' });
  });

  test('an age outside the contract throws a RangeError, even when every test is skipped', () => {
    expect(() => estimateLevels(4, [], seedTests, 'beginner')).toThrow(RangeError);
    expect(() => estimateLevels(Number.NaN, [], seedTests, 'beginner')).toThrow(RangeError);
    expect(() => estimateLevels(12.5, [], seedTests, 'beginner')).toThrow(RangeError);
  });
});

describe('purity', () => {
  test('deep-frozen inputs are neither mutated nor make the function throw, and the answer is repeatable', () => {
    const results = deepFreeze([result(JUGGLING, 25), result(SLALOM, 7.5, { errors: 2 }), result('wall-passing-60s', 0, { skipped: true })]);
    const tests = deepFreeze(structuredClone(seedTests));
    const tracks = deepFreeze(['juggling-coordination', 'dribbling', 'untested']);
    const before = JSON.stringify({ results, tests, tracks });
    const first = estimateLevels(11, results, tests, 'basic', tracks);
    const second = estimateLevels(11, results, tests, 'basic', tracks);
    expect(JSON.stringify({ results, tests, tracks })).toBe(before);
    expect(second).toEqual(first);
    expect(first).toEqual([
      { skill: 'juggling-coordination', level: 4, source: 'test' },
      { skill: 'dribbling', level: 3, source: 'test' },
      { skill: 'untested', level: 2, source: 'self' },
    ]);
  });
});
