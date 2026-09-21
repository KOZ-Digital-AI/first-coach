import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DAYS_PER_WEEK, FOCUS_MAX, FOCUS_MIN, MINUTES_PER_SESSION, ROADMAP_WEEKS, Roadmap, SKILL_LEVEL_MAX } from '../shared/domain';
import type { RoadmapTrack } from '../shared/domain';
import { GOALS } from '../shared/primitives';
import type { Goal } from '../shared/primitives';
import {
  GOAL_TO_TRACK,
  LEVEL_LABELS,
  LEVEL_LABEL_MIN_MEANS,
  ROADMAP_REASON_GOAL,
  ROADMAP_REASON_WEAKEST,
  buildRoadmap,
  levelLabelForMean,
} from './roadmap';
import type { RoadmapProfile } from './roadmap';

// The rule under test ports the prototype's buildRoadmap (first-coach-demo.html):
//   entries = skills mapped to {skill, score}, sorted ASCENDING by score (Array.sort is stable, so
//             a tie keeps the input order);
//   the stated goal's skill is moved to the FRONT, whatever its score (a no-op when it is already
//             first or when the goal maps to no skill);
//   focus = the first 3 entries; the goal's entry gets the goal reason, every other the weakest one;
//   target = Math.min(5, score + 1).
// The contract adds: weeks = 4, sessionsPerWeek/minutesPerSession from the profile, a
// currentLevelLabel from the mean level, and a focus of FOCUS_MIN..FOCUS_MAX entries.
// `tracks` in the output is the input in INPUT order (the sort only decides the focus).

const track = (skill: string, level: number, source: RoadmapTrack['source'] = 'self'): RoadmapTrack => ({ skill, level, source });

const profile = (goal: Goal, extra: Partial<RoadmapProfile> = {}): RoadmapProfile => ({
  goal,
  daysPerWeek: 3,
  minutesPerSession: 20,
  ...extra,
});

/** Tracks named a..e in this order, with the given levels. */
const named = (levels: readonly number[]): RoadmapTrack[] => levels.map((level, i) => track(String.fromCharCode(97 + i), level));

const skills = (roadmap: Roadmap): string[] => roadmap.focus.map((f) => f.skill);

/** A real goal and the track it moves first. */
const GOAL_A: Goal = 'control';
const TRACK_OF_GOAL_A = GOAL_TO_TRACK[GOAL_A];

/** Deep-freezes a value so any write to it throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The five root skills of the shipped football skill graph (read from the JSON, not hard-coded). */
const graph = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../config/commons/football/skill-graph.json'), 'utf8')) as {
  nodes: { slug: string; parent: string | null }[];
};
const ROOT_SLUGS = graph.nodes.filter((node) => node.parent === null).map((node) => node.slug);

describe('constants', () => {
  test('the reason keys are the client-localized keys "goal" and "weakest"', () => {
    expect(ROADMAP_REASON_GOAL).toBe('goal');
    expect(ROADMAP_REASON_WEAKEST).toBe('weakest');
  });

  test('the skill graph has five root tracks (the premise of GOAL_TO_TRACK)', () => {
    expect(ROOT_SLUGS).toHaveLength(5);
  });

  test('GOAL_TO_TRACK maps every Goal to a distinct root track of the skill graph', () => {
    expect(Object.keys(GOAL_TO_TRACK).sort()).toEqual([...GOALS].sort());
    for (const goal of GOALS) expect(ROOT_SLUGS).toContain(GOAL_TO_TRACK[goal]);
    expect(new Set(Object.values(GOAL_TO_TRACK)).size).toBe(GOALS.length);
  });

  test('GOAL_TO_TRACK follows the prototype mapping (control to ball, weakfoot to weak foot, coordination to juggling)', () => {
    expect(GOAL_TO_TRACK).toEqual({
      control: 'ball-mastery',
      dribbling: 'dribbling',
      passing: 'passing-first-touch',
      weakfoot: 'weak-foot',
      coordination: 'juggling-coordination',
    });
  });

  test('the level labels are exactly Foundation, Basic, Intermediate, Advanced', () => {
    expect([...LEVEL_LABELS]).toEqual(['Foundation', 'Basic', 'Intermediate', 'Advanced']);
  });

  test('the label thresholds are inclusive lower bounds of the mean: Basic 2, Intermediate 3, Advanced 4', () => {
    expect(LEVEL_LABEL_MIN_MEANS).toEqual({ Basic: 2, Intermediate: 3, Advanced: 4 });
  });
});

describe('goal-first ordering', () => {
  test('a goal track that is the weakest stays first, the rest ascending', () => {
    const levels = [track('x', 3), track(TRACK_OF_GOAL_A, 1), track('y', 2), track('z', 5)];
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    expect(skills(roadmap)).toEqual([TRACK_OF_GOAL_A, 'y', 'x']);
  });

  test('a goal track that is the strongest is moved to the front, the rest ascending', () => {
    const levels = [track('x', 3), track('y', 1), track(TRACK_OF_GOAL_A, 5), track('z', 2)];
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    expect(skills(roadmap)).toEqual([TRACK_OF_GOAL_A, 'y', 'z']);
  });

  test('a goal track in the middle is moved to the front, the rest keep their ascending order', () => {
    const levels = [track('x', 1), track(TRACK_OF_GOAL_A, 3), track('y', 2), track('z', 4)];
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    expect(skills(roadmap)).toEqual([TRACK_OF_GOAL_A, 'x', 'y']);
  });

  test('a strongest goal track keeps its own level and target in the focus', () => {
    const levels = [track('x', 1), track('y', 2), track(TRACK_OF_GOAL_A, 4)];
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    expect(roadmap.focus[0]).toEqual({ skill: TRACK_OF_GOAL_A, level: 4, targetLevel: 5, reason: ROADMAP_REASON_GOAL });
  });

  test('without the goal, the focus is the three weakest tracks in ascending order', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), named([4, 2, 5, 1, 3]));
    expect(skills(roadmap)).toEqual(['d', 'b', 'e']);
  });

  test('each goal moves its own mapped track first', () => {
    for (const goal of GOALS) {
      const levels = [...ROOT_SLUGS.filter((slug) => slug !== GOAL_TO_TRACK[goal]).map((slug) => track(slug, 1)), track(GOAL_TO_TRACK[goal], 5)];
      expect(buildRoadmap(profile(goal), levels).focus[0]?.skill).toBe(GOAL_TO_TRACK[goal]);
    }
  });

  test('a goal whose track is not among the levels moves nothing', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), [track('x', 3), track('y', 1), track('z', 2)]);
    expect(skills(roadmap)).toEqual(['y', 'z', 'x']);
    expect(roadmap.focus.every((f) => f.reason === ROADMAP_REASON_WEAKEST)).toBe(true);
  });
});

describe('reasons', () => {
  test('the goal track has the goal reason, every other focus the weakest reason', () => {
    const levels = [track('x', 1), track(TRACK_OF_GOAL_A, 4), track('y', 2), track('z', 3)];
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    expect(roadmap.focus.map((f) => [f.skill, f.reason])).toEqual([
      [TRACK_OF_GOAL_A, ROADMAP_REASON_GOAL],
      ['x', ROADMAP_REASON_WEAKEST],
      ['y', ROADMAP_REASON_WEAKEST],
    ]);
  });

  test('a goal track that is also the weakest still gets the goal reason', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), [track('x', 2), track(TRACK_OF_GOAL_A, 1), track('y', 3)]);
    expect(roadmap.focus[0]?.reason).toBe(ROADMAP_REASON_GOAL);
    expect(roadmap.focus[1]?.reason).toBe(ROADMAP_REASON_WEAKEST);
  });

  test('every reason is a non-empty string (the contract)', () => {
    for (const focus of buildRoadmap(profile(GOAL_A), named([1, 2, 3])).focus) expect(focus.reason.length).toBeGreaterThan(0);
  });
});

describe('ties', () => {
  test('equal levels keep the input order', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), [track('c', 2), track('a', 2), track('b', 1), track('d', 2)]);
    expect(skills(roadmap)).toEqual(['b', 'c', 'a']);
  });

  test('a tie across the focus boundary is decided by the input order', () => {
    // b, c, d all have level 2; only two of them fit beside a (level 1).
    const first = buildRoadmap(profile(GOAL_A), [track('a', 1), track('b', 2), track('c', 2), track('d', 2)]);
    expect(skills(first)).toEqual(['a', 'b', 'c']);
    const reversed = buildRoadmap(profile(GOAL_A), [track('a', 1), track('d', 2), track('c', 2), track('b', 2)]);
    expect(skills(reversed)).toEqual(['a', 'd', 'c']);
  });

  test('the goal track wins a tie with a track listed before it', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), [track('x', 2), track('y', 2), track(TRACK_OF_GOAL_A, 2)]);
    expect(skills(roadmap)).toEqual([TRACK_OF_GOAL_A, 'x', 'y']);
  });

  test('the sort is deterministic: the same input twice gives the same roadmap', () => {
    const levels = [track('c', 2), track('a', 2), track('b', 2), track('d', 2)];
    expect(buildRoadmap(profile(GOAL_A), levels)).toEqual(buildRoadmap(profile(GOAL_A), levels));
  });
});

describe('all-equal levels', () => {
  test('with the goal track present it goes first, then the input order', () => {
    const levels = [track('x', 3), track('y', 3), track(TRACK_OF_GOAL_A, 3), track('z', 3), track('w', 3)];
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    expect(skills(roadmap)).toEqual([TRACK_OF_GOAL_A, 'x', 'y']);
  });

  test('without the goal track it is the input order', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), named([3, 3, 3, 3, 3]));
    expect(skills(roadmap)).toEqual(['a', 'b', 'c']);
  });

  test('all-equal levels of every level 1..5 still parse and target min(level + 1, 5)', () => {
    for (let level = 1; level <= SKILL_LEVEL_MAX; level++) {
      const roadmap = Roadmap.parse(buildRoadmap(profile(GOAL_A), named([level, level, level, level])));
      for (const focus of roadmap.focus) expect(focus.targetLevel).toBe(Math.min(level + 1, SKILL_LEVEL_MAX));
    }
  });
});

describe('target level', () => {
  test('is level + 1', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), named([1, 2, 3]));
    expect(roadmap.focus.map((f) => [f.level, f.targetLevel])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  test('is capped at 5: level 4 reaches 5 and level 5 stays at 5', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), named([4, 5, 5, 5]));
    expect(roadmap.focus.map((f) => [f.level, f.targetLevel])).toEqual([
      [4, 5],
      [5, 5],
      [5, 5],
    ]);
  });

  test('a level 5 goal track put first keeps target 5', () => {
    const roadmap = buildRoadmap(profile(GOAL_A), [track('x', 1), track('y', 2), track(TRACK_OF_GOAL_A, 5)]);
    expect(roadmap.focus[0]).toEqual({ skill: TRACK_OF_GOAL_A, level: 5, targetLevel: 5, reason: ROADMAP_REASON_GOAL });
  });

  test('never exceeds SKILL_LEVEL_MAX and always parses through the contract', () => {
    const roadmap = Roadmap.parse(buildRoadmap(profile(GOAL_A), named([5, 5, 5, 5, 5])));
    for (const focus of roadmap.focus) expect(focus.targetLevel).toBeLessThanOrEqual(SKILL_LEVEL_MAX);
  });
});

describe('focus size', () => {
  test('is FOCUS_MAX (3) when there are three or more tracks', () => {
    expect(FOCUS_MAX).toBe(3);
    for (const count of [3, 4, 5]) {
      expect(buildRoadmap(profile(GOAL_A), named(Array.from({ length: count }, () => 2))).focus).toHaveLength(FOCUS_MAX);
    }
  });

  test('is 2 when there are exactly 2 tracks, both in the focus', () => {
    expect(FOCUS_MIN).toBe(2);
    const roadmap = buildRoadmap(profile(GOAL_A), [track('x', 4), track('y', 2)]);
    expect(skills(roadmap)).toEqual(['y', 'x']);
    expect(Roadmap.parse(roadmap).focus).toHaveLength(2);
  });

  test('fewer than FOCUS_MIN tracks throw a RangeError with a clear message', () => {
    expect(() => buildRoadmap(profile(GOAL_A), [])).toThrow(RangeError);
    expect(() => buildRoadmap(profile(GOAL_A), [track('x', 2)])).toThrow(RangeError);
    expect(() => buildRoadmap(profile(GOAL_A), [track('x', 2)])).toThrow(/at least 2 tracks/);
  });
});

describe('roadmap fields', () => {
  test('weeks is ROADMAP_WEEKS (4)', () => {
    expect(ROADMAP_WEEKS).toBe(4);
    expect(buildRoadmap(profile(GOAL_A), named([1, 2, 3])).weeks).toBe(ROADMAP_WEEKS);
  });

  test('sessionsPerWeek comes from the profile daysPerWeek and minutesPerSession from the profile', () => {
    for (const daysPerWeek of DAYS_PER_WEEK) {
      for (const minutesPerSession of MINUTES_PER_SESSION) {
        const roadmap = buildRoadmap(profile(GOAL_A, { daysPerWeek, minutesPerSession }), named([1, 2, 3]));
        expect(roadmap.sessionsPerWeek).toBe(daysPerWeek);
        expect(roadmap.minutesPerSession).toBe(minutesPerSession);
      }
    }
  });

  test('goal is the profile goal', () => {
    for (const goal of GOALS) expect(buildRoadmap(profile(goal), named([1, 2, 3])).goal).toBe(goal);
  });

  test('tracks is the input in INPUT order, with source kept, as copies', () => {
    const levels = [track('c', 4, 'test'), track('a', 1, 'self'), track('b', 3, 'test')];
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    expect(roadmap.tracks).toEqual(levels);
    expect(roadmap.tracks).not.toBe(levels);
    expect(roadmap.tracks[0]).not.toBe(levels[0]);
  });
});

describe('currentLevelLabel from the mean level over ALL tracks', () => {
  const labelOf = (levels: readonly number[]) => buildRoadmap(profile(GOAL_A), named(levels)).currentLevelLabel;

  test('mean below 2 is Foundation', () => {
    expect(labelOf([1, 1, 1])).toBe('Foundation');
    expect(labelOf([1, 2, 2, 2])).toBe('Foundation'); // 1.75
    expect(labelOf([2, 1, 2, 1])).toBe('Foundation'); // 1.5, the example roadmap of the product brief
  });

  test('mean exactly 2 is Basic, just below it is Foundation', () => {
    expect(labelOf([2, 2, 2])).toBe('Basic');
    expect(labelOf([1, 2, 3])).toBe('Basic'); // 2
    expect(labelOf([1, 2, 2, 2, 2])).toBe('Foundation'); // 1.8
    expect(labelOf([1, 1, 2, 2, 5])).toBe('Basic'); // 2.2
  });

  test('mean exactly 3 is Intermediate, just below it is Basic', () => {
    expect(labelOf([3, 3, 3])).toBe('Intermediate');
    expect(labelOf([2, 3, 3, 3])).toBe('Basic'); // 2.75
    expect(labelOf([1, 3, 5])).toBe('Intermediate'); // 3
  });

  test('mean exactly 4 is Advanced, just below it is Intermediate', () => {
    expect(labelOf([4, 4, 4])).toBe('Advanced');
    expect(labelOf([3, 4, 4, 4])).toBe('Intermediate'); // 3.75
    expect(labelOf([3, 5, 4])).toBe('Advanced'); // 4
    expect(labelOf([5, 5, 5])).toBe('Advanced');
  });

  test('the mean covers every track, not only the focus', () => {
    // Focus is the three weakest (1, 1, 1); the whole mean (1 + 1 + 1 + 5 + 5) / 5 = 2.6 is Basic.
    expect(labelOf([1, 1, 1, 5, 5])).toBe('Basic');
  });

  test('levelLabelForMean is inclusive at each boundary and monotonic', () => {
    expect(levelLabelForMean(1)).toBe('Foundation');
    expect(levelLabelForMean(1.999)).toBe('Foundation');
    expect(levelLabelForMean(2)).toBe('Basic');
    expect(levelLabelForMean(2.999)).toBe('Basic');
    expect(levelLabelForMean(3)).toBe('Intermediate');
    expect(levelLabelForMean(3.999)).toBe('Intermediate');
    expect(levelLabelForMean(4)).toBe('Advanced');
    expect(levelLabelForMean(5)).toBe('Advanced');
  });
});

describe('purity', () => {
  test('a deep-frozen input is not mutated and still builds', () => {
    const levels = deepFreeze([track('x', 3, 'test'), track(TRACK_OF_GOAL_A, 5), track('y', 1), track('z', 2)]);
    const snapshot = JSON.stringify(levels);
    const frozenProfile = deepFreeze(profile(GOAL_A));
    const roadmap = buildRoadmap(frozenProfile, levels);
    expect(JSON.stringify(levels)).toBe(snapshot);
    expect(skills(roadmap)).toEqual([TRACK_OF_GOAL_A, 'y', 'z']);
  });

  test('mutating the output does not change the input', () => {
    const levels = [track('x', 3), track('y', 1), track('z', 2)];
    const snapshot = JSON.stringify(levels);
    const roadmap = buildRoadmap(profile(GOAL_A), levels);
    roadmap.tracks[0]!.level = 5;
    roadmap.tracks.reverse();
    roadmap.focus[0]!.level = 5;
    expect(JSON.stringify(levels)).toBe(snapshot);
  });

  test('is deterministic', () => {
    const levels = [track('x', 3), track('y', 1), track('z', 2)];
    expect(buildRoadmap(profile(GOAL_A), levels)).toEqual(buildRoadmap(profile(GOAL_A), levels));
  });
});

describe('the real skill graph', () => {
  test('the five root track slugs build a roadmap that parses through the contract', () => {
    const levels = ROOT_SLUGS.map((slug, i) => track(slug, i + 1, i % 2 === 0 ? 'test' : 'self'));
    for (const goal of GOALS) {
      const roadmap = Roadmap.parse(buildRoadmap(profile(goal), levels));
      expect(roadmap.focus).toHaveLength(FOCUS_MAX);
      expect(roadmap.focus[0]?.skill).toBe(GOAL_TO_TRACK[goal]);
      expect(roadmap.focus[0]?.reason).toBe(ROADMAP_REASON_GOAL);
      expect(roadmap.tracks.map((t) => t.skill)).toEqual(ROOT_SLUGS);
      expect(roadmap.currentLevelLabel).toBe('Intermediate'); // mean (1 + 2 + 3 + 4 + 5) / 5 = 3
    }
  });

  test('the goal track weakest among the five is first and the next two are the next weakest', () => {
    const others = ROOT_SLUGS.filter((slug) => slug !== GOAL_TO_TRACK.control);
    const levels = [...others.map((slug, i) => track(slug, i + 2)), track(GOAL_TO_TRACK.control, 1)];
    const roadmap = Roadmap.parse(buildRoadmap(profile('control'), levels));
    expect(skills(roadmap)).toEqual([GOAL_TO_TRACK.control, others[0]!, others[1]!]);
  });
});
