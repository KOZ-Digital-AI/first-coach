import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { loadSeed } from '../commons/seed-loader';
import { getSkillGraph, getSkillTests, listPublishedVersions } from '../commons/repo';
import type { PublishedVersion } from '../commons/repo';
import { DEFAULT_SETTINGS } from '../admin/settings';
import { EQUIPMENT, SPACES } from '../shared/primitives';
import type { Equipment, Goal, Space } from '../shared/primitives';
import type { SkillGraph } from '../shared/commons';
import { MINUTES_PER_SESSION } from '../shared/domain';
import type { Roadmap, RoadmapFocus, SkillTest } from '../shared/domain';
import { TodayItem, TodaySession } from '../shared/session';
import { candidates } from './candidates';
import type { Levels } from './candidates';
import { GOAL_TO_TRACK, buildRoadmap } from './roadmap';
import {
  SESSION_REASON_FILL,
  SESSION_REASON_FOCUS,
  SESSION_REASON_WARMUP,
  SKILL_TEST_MINUTES,
  fnv1a32,
  mulberry32,
  pickSession,
  seedFor,
} from './session';
import type { HistoryEntry, PickedSession, SessionOptions } from './session';

// The real seed (config/commons) is loaded on a migrated in-memory database and read back through
// repo.ts, and the candidates come from the merged candidates() filter, so every session below is
// picked from exactly the published versions the planner will get. Scenario tests derive their pools
// from real versions (filter / spread), never from an invented drill.

const SEED_DIR = resolve(import.meta.dir, '../../../../config/commons');

let db: Database;
let versions: PublishedVersion[];
let graph: SkillGraph;
let skillTests: SkillTest[];

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  versions = listPublishedVersions(db);
  const loaded = getSkillGraph(db, 'football', 'en');
  if (loaded === null) throw new Error('football skill graph missing from the seed');
  graph = loaded;
  skillTests = getSkillTests(db, 'football').map(({ thresholds: _thresholds, ...test }) => test);
});

afterAll(() => {
  db.close();
});

// --- helpers ---------------------------------------------------------------------------------

type Minutes = (typeof MINUTES_PER_SESSION)[number];
const AGES = [7, 12, 16] as const;
const PARTNER = [false, true] as const;
const TRACKS = Object.values(GOAL_TO_TRACK);
const LEVEL_NUMBER = { beginner: 1, basic: 2, intermediate: 3 } as const;

const FRESH: Levels = {};
const MIXED: Levels = {
  'ball-mastery': 3,
  dribbling: 2,
  'passing-first-touch': 1,
  'weak-foot': 4,
  'juggling-coordination': 2,
};
const RICH: Levels = Object.fromEntries(TRACKS.map((track) => [track, 3]));

interface Who {
  age: number;
  equipment: Equipment;
  space: Space;
  partner: boolean;
}
const who = (over: Partial<Who> = {}): Who => ({ age: 12, equipment: 'ball_wall', space: 'yard', partner: false, ...over });

const poolFor = (over: Partial<Who>, levels: Levels): PublishedVersion[] =>
  candidates(who(over), levels, DEFAULT_SETTINGS, versions, graph);

const roadmapFor = (goal: Goal, levels: Levels, minutes: Minutes): Roadmap =>
  buildRoadmap(
    { goal, daysPerWeek: 3, minutesPerSession: minutes },
    TRACKS.map((skill) => ({ skill, level: levels[skill] ?? 1, source: 'self' as const })),
  );

/** A roadmap with a hand-picked focus, tracks all at level 3 (so any pool level is meaningful). */
const roadmapWithFocus = (focus: RoadmapFocus[], minutes: Minutes = 45): Roadmap => ({
  ...roadmapFor('control', RICH, minutes),
  focus,
});
const focusOn = (skill: string, level: number): RoadmapFocus => ({ skill, level, targetLevel: level + 1, reason: 'weakest' });

const DATE = '2026-09-21';
const PLAYER = 'player-one';
const opts = (over: Partial<SessionOptions> = {}): SessionOptions => ({ playerId: PLAYER, date: DATE, ...over });
const profileOf = (minutes: Minutes) => ({ minutesPerSession: minutes });

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const byId = (pool: readonly PublishedVersion[]): Map<string, PublishedVersion> => new Map(pool.map((v) => [v.versionId, v]));
const drillIdsOf = (session: PickedSession, pool: readonly PublishedVersion[]): string[] =>
  session.items.map((item) => byId(pool).get(item.drillVersionId)!.drillId);
const versionIdsOf = (session: PickedSession): string[] => session.items.map((item) => item.drillVersionId);
const drillMinutes = (session: PickedSession): number => session.items.reduce((sum, item) => sum + item.minutes, 0);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Deterministic test-side shuffle (Fisher-Yates over a tiny LCG), independent of the module under test. */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Test-side subset-sum: can some subset of `minutes` add up to a value in [lo, hi]? */
function reachable(minutes: readonly number[], lo: number, hi: number): boolean {
  let sums = new Set<number>([0]);
  for (const m of minutes) {
    const next = new Set(sums);
    for (const s of sums) if (s + m <= hi) next.add(s + m);
    sums = next;
  }
  return [...sums].some((s) => s >= lo && s <= hi);
}

// --- seeding ---------------------------------------------------------------------------------

describe('seedFor', () => {
  test('fnv1a32 matches the published FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  test('seedFor is the FNV-1a hash of "playerId:date", an unsigned 32-bit integer', () => {
    expect(seedFor('p1', '2026-09-21')).toBe(fnv1a32('p1:2026-09-21'));
    const seed = seedFor('p1', '2026-09-21');
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
  });

  test('the seed changes with the player and with the date', () => {
    expect(seedFor('p1', '2026-09-21')).not.toBe(seedFor('p2', '2026-09-21'));
    expect(seedFor('p1', '2026-09-21')).not.toBe(seedFor('p1', '2026-09-22'));
  });

  test('mulberry32 repeats for one seed, stays in [0, 1) and differs between seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
    const other = mulberry32(43);
    expect(Array.from({ length: 50 }, () => other())).not.toEqual(first);
  });
});

// --- shape -----------------------------------------------------------------------------------

describe('the picked session follows the contract', () => {
  const pool = () => poolFor({}, MIXED);

  test('date, planner and totals; every item is a contract TodayItem without its itemId', () => {
    const session = pickSession(profileOf(30), roadmapFor('control', MIXED, 30), pool(), [], opts());
    expect(session.date).toBe(DATE);
    expect(session.planner).toBe('rules');
    expect(session.items.length).toBeGreaterThan(0);
    expect(session.totalMinutes).toBe(drillMinutes(session));
    for (const item of session.items) {
      expect(() => TodayItem.omit({ itemId: true }).parse(item)).not.toThrow();
      expect(item.done).toBe(false);
    }
  });

  test('an item carries its version id, minutes, content, status and attribution from the candidate', () => {
    const list = pool();
    const session = pickSession(profileOf(30), roadmapFor('control', MIXED, 30), list, [], opts());
    for (const item of session.items) {
      const version = byId(list).get(item.drillVersionId)!;
      expect(item.minutes).toBe(version.minutes);
      expect(item.content).toEqual(version.content);
      expect(item.status).toBe(version.status);
      expect(item.attribution).toEqual(version.attribution);
    }
  });

  test('with a retest due the result still satisfies the TodaySession fields the picker owns', () => {
    const due = skillTests.slice(0, 1);
    const session = pickSession(profileOf(30), roadmapFor('control', MIXED, 30), pool(), [], opts({ retestDue: due }));
    const stub = { id: 'session-1', graphVersion: 'g1', roadmapSummary: TodaySession.shape.roadmapSummary.parse(roadmapFor('control', MIXED, 30)) };
    const items = session.items.map((item, i) => ({ ...item, itemId: `item-${i}` }));
    expect(() => TodaySession.parse({ ...stub, ...session, items })).not.toThrow();
  });

  test('the reason names why the item is there: warm-up first, then the focus skills, then fill', () => {
    const list = pool();
    const road = roadmapFor('control', MIXED, 45);
    const session = pickSession(profileOf(45), road, list, [], opts());
    expect(session.items[0]!.reason).toBe(SESSION_REASON_WARMUP);
    expect(session.items.slice(1, 1 + road.focus.length).map((i) => i.reason)).toEqual(road.focus.map(() => SESSION_REASON_FOCUS));
    expect(session.items.slice(1 + road.focus.length).every((i) => i.reason === SESSION_REASON_FILL)).toBe(true);
  });
});

// --- warm-up ---------------------------------------------------------------------------------

describe('warm-up', () => {
  test('the first item is a beginner (level 1) drill of the ball-mastery track with the fewest minutes', () => {
    const list = poolFor({}, MIXED);
    const session = pickSession(profileOf(30), roadmapFor('passing', MIXED, 30), list, [], opts());
    const first = byId(list).get(session.items[0]!.drillVersionId)!;
    const warmups = list.filter((v) => v.level === 'beginner' && v.track === 'ball-mastery');
    expect(warmups.length).toBeGreaterThan(0);
    expect(first.level).toBe('beginner');
    expect(first.track).toBe('ball-mastery');
    expect(first.minutes).toBe(Math.min(...warmups.map((v) => v.minutes)));
  });

  test('without a ball-mastery beginner drill the warm-up is the shortest beginner drill left', () => {
    const list = poolFor({}, MIXED).filter((v) => !(v.track === 'ball-mastery' && v.level === 'beginner'));
    const session = pickSession(profileOf(30), roadmapFor('passing', MIXED, 30), list, [], opts());
    const first = byId(list).get(session.items[0]!.drillVersionId)!;
    const beginners = list.filter((v) => v.level === 'beginner');
    expect(first.level).toBe('beginner');
    expect(first.minutes).toBe(Math.min(...beginners.map((v) => v.minutes)));
  });

  test('without any beginner drill there is no warm-up and the session is still picked', () => {
    const list = poolFor({}, MIXED).filter((v) => v.level !== 'beginner');
    const session = pickSession(profileOf(30), roadmapFor('passing', MIXED, 30), list, [], opts());
    expect(session.items.length).toBeGreaterThan(0);
    expect(session.items.some((item) => item.reason === SESSION_REASON_WARMUP)).toBe(false);
  });

  test('a warm-up done in the previous 2 sessions gives way to another beginner drill', () => {
    const list = poolFor({}, MIXED);
    const road = roadmapFor('control', MIXED, 30);
    const day1 = pickSession(profileOf(30), road, list, [], opts());
    const history: HistoryEntry[] = [{ date: addDays(DATE, -1), drillVersionIds: [day1.items[0]!.drillVersionId] }];
    const day2 = pickSession(profileOf(30), road, list, history, opts());
    expect(day2.items[0]!.drillVersionId).not.toBe(day1.items[0]!.drillVersionId);
    expect(byId(list).get(day2.items[0]!.drillVersionId)!.level).toBe('beginner');
  });
});

// --- one drill per focus skill at the right level ---------------------------------------------

describe('one drill per focus skill', () => {
  test('after the warm-up, item i is a drill of focus skill i (roadmap order)', () => {
    const list = poolFor({}, MIXED);
    const road = roadmapFor('dribbling', MIXED, 45);
    const session = pickSession(profileOf(45), road, list, [], opts());
    const tracks = session.items.map((item) => byId(list).get(item.drillVersionId)!.track);
    expect(tracks.slice(1, 1 + road.focus.length)).toEqual(road.focus.map((f) => f.skill));
  });

  test('a focus pick is at the focus level when the track has a drill of that level', () => {
    const list = poolFor({}, RICH);
    for (const level of [1, 2, 3]) {
      const road = roadmapWithFocus([focusOn('dribbling', level), focusOn('passing-first-touch', level)]);
      const session = pickSession(profileOf(45), road, list, [], opts());
      for (const [i, focus] of road.focus.entries()) {
        const version = byId(list).get(session.items[1 + i]!.drillVersionId)!;
        expect(version.track).toBe(focus.skill);
        expect(LEVEL_NUMBER[version.level]).toBe(level);
      }
    }
  });

  test('with no drill at the focus level the target level (focus + 1) comes next', () => {
    const list = poolFor({}, RICH).filter((v) => !(v.track === 'dribbling' && v.level === 'basic'));
    const road = roadmapWithFocus([focusOn('dribbling', 2), focusOn('passing-first-touch', 1)]);
    const session = pickSession(profileOf(45), road, list, [], opts());
    expect(byId(list).get(session.items[1]!.drillVersionId)!.level).toBe('intermediate');
  });

  test('with neither the focus level nor its target, the nearest lower level is used', () => {
    const list = poolFor({}, RICH).filter((v) => !(v.track === 'dribbling' && v.level === 'intermediate'));
    const road = roadmapWithFocus([focusOn('dribbling', 3), focusOn('passing-first-touch', 1)]);
    const session = pickSession(profileOf(45), road, list, [], opts());
    expect(byId(list).get(session.items[1]!.drillVersionId)!.level).toBe('basic');
  });

  test('a focus drill done in the previous 2 sessions is passed over while the track has another', () => {
    const list = poolFor({}, RICH);
    const road = roadmapWithFocus([focusOn('dribbling', 2), focusOn('passing-first-touch', 2)]);
    const day1 = pickSession(profileOf(45), road, list, [], opts());
    const day2 = pickSession(profileOf(45), road, list, [{ date: addDays(DATE, -1), drillVersionIds: versionIdsOf(day1) }], opts());
    expect(day2.items[1]!.drillVersionId).not.toBe(day1.items[1]!.drillVersionId);
    expect(day2.items[2]!.drillVersionId).not.toBe(day1.items[2]!.drillVersionId);
  });

  test('a recent drill is still used when it is the only one of the track that fits', () => {
    const only = poolFor({}, RICH).filter((v) => v.track === 'dribbling' && v.level === 'basic').slice(0, 1);
    const rest = poolFor({}, RICH).filter((v) => v.track !== 'dribbling');
    const list = [...only, ...rest];
    const road = roadmapWithFocus([focusOn('dribbling', 2), focusOn('passing-first-touch', 1)]);
    const history: HistoryEntry[] = [{ date: addDays(DATE, -1), drillVersionIds: [only[0]!.versionId] }];
    const session = pickSession(profileOf(45), road, list, history, opts());
    expect(versionIdsOf(session)).toContain(only[0]!.versionId);
  });

  test('a focus drill that would push the session over budget + 3 is skipped for one that fits', () => {
    const list = poolFor({}, RICH);
    const road = roadmapWithFocus([focusOn('dribbling', 2), focusOn('passing-first-touch', 2), focusOn('weak-foot', 2)], 10);
    const session = pickSession(profileOf(10), road, list, [], opts());
    expect(session.totalMinutes).toBeLessThanOrEqual(13);
    expect(session.totalMinutes).toBeGreaterThanOrEqual(8);
  });
});

// --- budget, duplicates, fill ------------------------------------------------------------------

describe('fill to the minutes budget', () => {
  test('every session minutes option lands within budget - 2 .. budget + 3 on a big pool', () => {
    const list = poolFor({}, MIXED);
    for (const minutes of MINUTES_PER_SESSION) {
      for (const goal of ['control', 'dribbling', 'passing', 'weakfoot', 'coordination'] as const) {
        const session = pickSession(profileOf(minutes), roadmapFor(goal, MIXED, minutes), list, [], opts());
        expect(session.totalMinutes).toBeGreaterThanOrEqual(minutes - 2);
        expect(session.totalMinutes).toBeLessThanOrEqual(minutes + 3);
      }
    }
  });

  test('the fill takes drills from other tracks too, not only the focus tracks', () => {
    const list = poolFor({}, MIXED);
    const road = roadmapFor('control', MIXED, 45);
    const session = pickSession(profileOf(45), road, list, [], opts());
    const tracks = new Set(session.items.map((item) => byId(list).get(item.drillVersionId)!.track));
    expect(tracks.size).toBeGreaterThan(road.focus.length);
  });

  test('no drill appears twice', () => {
    const list = poolFor({}, MIXED);
    for (const minutes of MINUTES_PER_SESSION) {
      const session = pickSession(profileOf(minutes), roadmapFor('control', MIXED, minutes), list, [], opts());
      const ids = drillIdsOf(session, list);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(versionIdsOf(session)).size).toBe(session.items.length);
    }
  });

  test('a session never holds two versions of one drill', () => {
    const list = poolFor({}, MIXED);
    const twins = list.slice(0, 12).map((v, i) => ({ ...structuredClone(v), versionId: `${v.versionId}-newer-${i}` }));
    const session = pickSession(profileOf(45), roadmapFor('control', MIXED, 45), [...list, ...twins], [], opts());
    const both = byId([...list, ...twins]);
    const drills = session.items.map((item) => both.get(item.drillVersionId)!.drillId);
    expect(new Set(drills).size).toBe(drills.length);
  });

  test('a pool that cannot fill the budget yields every drill it has, as close as it can get', () => {
    const list = poolFor({ equipment: 'nothing', age: 16 }, FRESH);
    expect(list.length).toBeGreaterThan(0);
    const session = pickSession(profileOf(45), roadmapFor('control', FRESH, 45), list, [], opts());
    expect(session.items.length).toBe(list.length);
    expect(session.totalMinutes).toBe(list.reduce((sum, v) => sum + v.minutes, 0));
  });

  test('an empty pool gives an empty session', () => {
    const session = pickSession(profileOf(20), roadmapFor('control', FRESH, 20), [], [], opts());
    expect(session.items).toEqual([]);
    expect(session.totalMinutes).toBe(0);
    expect(session.skillTest).toBeUndefined();
  });

  test('a minutes budget that is not a positive number is a RangeError', () => {
    const list = poolFor({}, FRESH);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => pickSession({ minutesPerSession: bad as Minutes }, roadmapFor('control', FRESH, 20), list, [], opts())).toThrow(RangeError);
    }
  });
});

// --- history ---------------------------------------------------------------------------------

describe('history', () => {
  const list = () => poolFor({}, MIXED);
  const road = () => roadmapFor('control', MIXED, 30);

  test('drills done in the previous session are left out while the pool has alternatives', () => {
    const pool = list();
    const day1 = pickSession(profileOf(30), road(), pool, [], opts());
    const day2 = pickSession(profileOf(30), road(), pool, [{ date: addDays(DATE, -1), drillVersionIds: versionIdsOf(day1) }], opts());
    const again = new Set(versionIdsOf(day1));
    expect(versionIdsOf(day2).filter((id) => again.has(id))).toEqual([]);
  });

  test('drills of the 2 most recent sessions are avoided, whatever the order of the entries', () => {
    const pool = list();
    const a = pickSession(profileOf(30), road(), pool, [], opts({ date: '2026-09-10' }));
    const b = pickSession(profileOf(30), road(), pool, [{ date: '2026-09-10', drillVersionIds: versionIdsOf(a) }], opts({ date: '2026-09-11' }));
    const history: HistoryEntry[] = [
      { date: '2026-09-11', drillVersionIds: versionIdsOf(b) },
      { date: '2026-09-10', drillVersionIds: versionIdsOf(a) },
    ];
    const c = pickSession(profileOf(30), road(), pool, history, opts({ date: '2026-09-12' }));
    const avoid = new Set([...versionIdsOf(a), ...versionIdsOf(b)]);
    expect(versionIdsOf(c).filter((id) => avoid.has(id))).toEqual([]);
    expect(pickSession(profileOf(30), road(), pool, [...history].reverse(), opts({ date: '2026-09-12' }))).toEqual(c);
  });

  test('a session older than the previous 2 no longer counts', () => {
    const pool = list();
    const baseline = pickSession(profileOf(30), road(), pool, [], opts());
    const history: HistoryEntry[] = [
      { date: addDays(DATE, -3), drillVersionIds: versionIdsOf(baseline) },
      { date: addDays(DATE, -2), drillVersionIds: [] },
      { date: addDays(DATE, -1), drillVersionIds: [] },
    ];
    expect(pickSession(profileOf(30), road(), pool, history, opts())).toEqual(baseline);
  });

  test('entries dated today or later are not "previous" sessions', () => {
    const pool = list();
    const baseline = pickSession(profileOf(30), road(), pool, [], opts());
    const history: HistoryEntry[] = [
      { date: DATE, drillVersionIds: versionIdsOf(baseline) },
      { date: addDays(DATE, 1), drillVersionIds: versionIdsOf(baseline) },
    ];
    expect(pickSession(profileOf(30), road(), pool, history, opts())).toEqual(baseline);
  });

  test('a history entry can name drills by drillId as well as by version id', () => {
    const pool = list();
    const day1 = pickSession(profileOf(30), road(), pool, [], opts());
    const day2 = pickSession(profileOf(30), road(), pool, [{ date: addDays(DATE, -1), drillIds: drillIdsOf(day1, pool) }], opts());
    const again = new Set(versionIdsOf(day1));
    expect(versionIdsOf(day2).filter((id) => again.has(id))).toEqual([]);
  });

  test('unknown ids in the history are ignored', () => {
    const pool = list();
    const baseline = pickSession(profileOf(30), road(), pool, [], opts());
    const history: HistoryEntry[] = [
      { date: addDays(DATE, -1), drillVersionIds: ['no-such-version', ''], drillIds: ['no-such-drill'] },
      { date: addDays(DATE, -2), drillVersionIds: ['also-unknown'] },
    ];
    expect(pickSession(profileOf(30), road(), pool, history, opts())).toEqual(baseline);
  });
});

// --- skill test ------------------------------------------------------------------------------

describe('retest', () => {
  const pool = () => poolFor({}, MIXED);
  const road = (minutes: Minutes) => roadmapFor('control', MIXED, minutes);

  test('the seed has skill tests to retest with', () => {
    expect(skillTests.length).toBeGreaterThan(0);
  });

  test('with no retest due there is no skill test and the total is the drills', () => {
    for (const retestDue of [undefined, []] as const) {
      const session = pickSession(profileOf(30), road(30), pool(), [], opts({ retestDue }));
      expect(session.skillTest).toBeUndefined();
      expect(session.totalMinutes).toBe(drillMinutes(session));
    }
  });

  test('a due retest adds the FIRST due test as a 2-minute skill test, outside the drill items', () => {
    const due = [skillTests[2]!, skillTests[0]!];
    const list = pool();
    const session = pickSession(profileOf(30), road(30), list, [], opts({ retestDue: due }));
    expect(SKILL_TEST_MINUTES).toBe(2);
    expect(session.skillTest).toEqual(due[0]!);
    expect(session.items.every((item) => byId(list).has(item.drillVersionId))).toBe(true);
    expect(session.totalMinutes).toBe(drillMinutes(session) + 2);
  });

  test('the skill test has the SkillTest fields only', () => {
    const withExtra = [{ ...skillTests[0]!, thresholds: { anything: 1 } }];
    const session = pickSession(profileOf(30), road(30), pool(), [], opts({ retestDue: withExtra }));
    expect(session.skillTest).toEqual(skillTests[0]!);
  });

  test('the 2 test minutes count toward the window: the session stays within budget - 2 .. budget + 3', () => {
    for (const minutes of MINUTES_PER_SESSION) {
      const session = pickSession(profileOf(minutes), road(minutes), pool(), [], opts({ retestDue: skillTests.slice(0, 1) }));
      expect(session.totalMinutes).toBeGreaterThanOrEqual(minutes - 2);
      expect(session.totalMinutes).toBeLessThanOrEqual(minutes + 3);
    }
  });
});

// --- determinism, purity -----------------------------------------------------------------------

describe('determinism', () => {
  const list = () => poolFor({}, MIXED);
  const road = () => roadmapFor('control', MIXED, 30);

  test('20 repeated calls with the same inputs return the same session', () => {
    const pool = list();
    const first = pickSession(profileOf(30), road(), pool, [], opts({ retestDue: skillTests.slice(0, 1) }));
    for (let i = 0; i < 20; i += 1) {
      expect(pickSession(profileOf(30), road(), pool, [], opts({ retestDue: skillTests.slice(0, 1) }))).toEqual(first);
    }
  });

  test('the order the caller lists the candidates in does not matter', () => {
    const pool = list();
    const first = pickSession(profileOf(30), road(), pool, [], opts());
    for (let seed = 1; seed <= 10; seed += 1) {
      expect(pickSession(profileOf(30), road(), shuffled(pool, seed), [], opts())).toEqual(first);
    }
    expect(pickSession(profileOf(30), road(), [...pool].reverse(), [], opts())).toEqual(first);
  });

  test('another date or another player gives another session (the seed breaks ties)', () => {
    const pool = list();
    const base = JSON.stringify(pickSession(profileOf(30), road(), pool, [], opts()));
    const byDate = Array.from({ length: 10 }, (_, i) => JSON.stringify(pickSession(profileOf(30), road(), pool, [], opts({ date: addDays(DATE, i + 1) }))));
    const byPlayer = Array.from({ length: 10 }, (_, i) => JSON.stringify(pickSession(profileOf(30), road(), pool, [], opts({ playerId: `player-${i}` }))));
    expect(byDate.some((s) => s !== base)).toBe(true);
    expect(byPlayer.some((s) => s !== base)).toBe(true);
  });

  test('no Math.random and no Date.now: the picker is pure', () => {
    const pool = list();
    const random = Math.random;
    const now = Date.now;
    Math.random = () => {
      throw new Error('Math.random called');
    };
    Date.now = () => {
      throw new Error('Date.now called');
    };
    try {
      expect(() => pickSession(profileOf(30), road(), pool, [], opts({ retestDue: skillTests.slice(0, 1) }))).not.toThrow();
    } finally {
      Math.random = random;
      Date.now = now;
    }
  });

  test('inputs are never mutated: deep-frozen inputs work and are unchanged', () => {
    const pool = deepFreeze(list());
    const profile = deepFreeze(profileOf(30));
    const roadmap = deepFreeze(road());
    const history = deepFreeze<HistoryEntry[]>([{ date: addDays(DATE, -1), drillVersionIds: [pool[0]!.versionId] }]);
    const options = deepFreeze(opts({ retestDue: skillTests.slice(0, 1).map((t) => ({ ...t })) }));
    const before = JSON.stringify([pool, profile, roadmap, history, options]);
    const session = pickSession(profile, roadmap, pool, history, options);
    expect(session.items.length).toBeGreaterThan(0);
    expect(JSON.stringify([pool, profile, roadmap, history, options])).toBe(before);
  });
});

// --- variety ---------------------------------------------------------------------------------

describe('variety across consecutive days', () => {
  function simulate(minutes: Minutes, days: number, playerId = PLAYER) {
    const pool = poolFor({ equipment: 'ball_wall', space: 'yard', age: 12 }, FRESH);
    const road = roadmapFor('control', FRESH, minutes);
    const history: HistoryEntry[] = [];
    const sessions: PickedSession[] = [];
    for (let i = 0; i < days; i += 1) {
      const date = addDays(DATE, i);
      const session = pickSession(profileOf(minutes), road, pool, history, { playerId, date });
      sessions.push(session);
      history.push({ date, drillVersionIds: versionIdsOf(session) });
    }
    return { pool, sessions };
  }

  for (const minutes of [15, 20, 30, 45] as const) {
    test(`${minutes} min: no drill repeats in consecutive sessions over 7 days`, () => {
      const { pool, sessions } = simulate(minutes, 7);
      for (let i = 1; i < sessions.length; i += 1) {
        const previous = new Set(drillIdsOf(sessions[i - 1]!, pool));
        expect(drillIdsOf(sessions[i]!, pool).filter((id) => previous.has(id))).toEqual([]);
      }
    });

    test(`${minutes} min: 7 days use more drills than one session holds, and every session stays in the window`, () => {
      const { pool, sessions } = simulate(minutes, 7);
      const union = new Set(sessions.flatMap((s) => drillIdsOf(s, pool)));
      expect(union.size).toBeGreaterThan(sessions[0]!.items.length);
      for (const session of sessions) {
        expect(session.totalMinutes).toBeGreaterThanOrEqual(minutes - 2);
        expect(session.totalMinutes).toBeLessThanOrEqual(minutes + 3);
      }
    });
  }

  test('the same 7 days replayed give the same sessions', () => {
    expect(simulate(30, 7).sessions).toEqual(simulate(30, 7).sessions);
  });
});

// --- seed coverage: every onboarding preset combination ------------------------------------------

describe('seed coverage (real seed, every preset combination)', () => {
  // equipment x space x partner x age {7,12,16} x minutes x two level profiles x retest on/off.
  // Window: total <= budget + 3 always; total >= budget - 2 whenever SOME subset of the pool can
  // reach [budget - 2, budget + 3] (computed here by subset-sum, independent of the picker);
  // otherwise the picker returns a maximal packing (no unpicked drill would still fit).
  for (const equipment of EQUIPMENT) {
    test(`equipment ${equipment}`, () => {
      let sessions = 0;
      let unreachable = 0;
      for (const space of SPACES) {
        for (const partner of PARTNER) {
          for (const age of AGES) {
            for (const levels of [FRESH, MIXED]) {
              const pool = poolFor({ equipment, space, partner, age }, levels);
              const known = byId(pool);
              const hasBeginner = pool.some((v) => v.level === 'beginner');
              for (const minutes of MINUTES_PER_SESSION) {
                for (const retest of [false, true]) {
                  const label = `${equipment}/${space}/partner=${partner}/age=${age}/${levels === FRESH ? 'fresh' : 'mixed'}/${minutes}min/retest=${retest}`;
                  const retestDue = retest ? skillTests.slice(0, 1) : undefined;
                  const road = roadmapFor('control', levels, minutes);
                  const session = pickSession(profileOf(minutes), road, pool, [], opts({ retestDue }));
                  sessions += 1;

                  expect(session.items.length, label).toBeGreaterThan(0);
                  for (const item of session.items) {
                    const version = known.get(item.drillVersionId);
                    expect(version, `${label} item not from candidates`).toBeDefined();
                    expect(item.minutes, label).toBe(version!.minutes);
                  }
                  const drills = drillIdsOf(session, pool);
                  expect(new Set(drills).size, `${label} duplicate drill`).toBe(drills.length);

                  const testMinutes = retest ? SKILL_TEST_MINUTES : 0;
                  const total = drillMinutes(session) + testMinutes;
                  expect(session.totalMinutes, label).toBe(total);
                  expect(total, `${label} over budget + 3`).toBeLessThanOrEqual(minutes + 3);
                  expect(session.skillTest !== undefined, label).toBe(retest);

                  const poolMinutes = pool.map((v) => v.minutes);
                  if (reachable(poolMinutes, minutes - 2 - testMinutes, minutes + 3 - testMinutes)) {
                    expect(total, `${label} below budget - 2 although the pool can reach it`).toBeGreaterThanOrEqual(minutes - 2);
                  } else {
                    unreachable += 1;
                    const picked = new Set(versionIdsOf(session));
                    for (const v of pool.filter((each) => !picked.has(each.versionId))) {
                      expect(total + v.minutes, `${label} stopped short although ${v.slug} still fits`).toBeGreaterThan(minutes + 3);
                    }
                  }

                  if (hasBeginner) {
                    expect(known.get(session.items[0]!.drillVersionId)!.level, `${label} warm-up first`).toBe('beginner');
                  }

                  if (retest === false && minutes === 20) {
                    expect(pickSession(profileOf(minutes), road, pool, [], opts({ retestDue })), `${label} determinism`).toEqual(session);
                  }
                }
              }
            }
          }
        }
      }
      expect(sessions).toBe(SPACES.length * PARTNER.length * AGES.length * 2 * MINUTES_PER_SESSION.length * 2);
      expect(unreachable).toBeLessThan(sessions);
    });
  }
});
