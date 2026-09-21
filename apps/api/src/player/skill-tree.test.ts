import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../db/database';
import { MIGRATIONS_DIR, migrate } from '../db/migrate';
import { loadSeed } from '../commons/seed-loader';
import { getSkillGraph } from '../commons/repo';
import type { SkillGraph } from '../shared/commons';
import { SKILL_LEVEL_MAX } from '../shared/domain';
import type { RoadmapTrack } from '../shared/domain';
import { NODE_STATES, TreeTrack } from '../shared/journey';
import type { TreeNode } from '../shared/journey';
import { MASTERY_MIN_DRILLS, deriveTree } from './skill-tree';
import type { TreeGraph } from './skill-tree';

// Readings of the criteria under test (see skill-tree.ts):
//   * a node's level is its 1-based position in its track, capped at SKILL_LEVEL_MAX - 1, so the top
//     track level (5) can master every node; "track level above the node's level" is strict (>).
//   * a prerequisite {skill, minLevel} is met when the LEVEL OF THE PREREQUISITE'S TRACK is >= minLevel.
//   * per track the frontier is the first non-mastered node in order whose prerequisites are met; when
//     none is met the first non-mastered node still trains (a track never dead-ends). A node in the
//     focus trains regardless of its prerequisites; a focused track starts at its first non-mastered node.
//
// The main tests run on the REAL football seed (config/commons) loaded into a migrated in-memory
// database and read back with getSkillGraph: 5 tracks, 25 sub-skills. Small synthetic graphs are used
// only as inputs for the edge cases of the pure function.

const SEED_DIR = resolve(import.meta.dir, '../../../../config/commons');

let db: Database;
let seed: SkillGraph;

beforeAll(() => {
  db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  seed = getSkillGraph(db, 'football', 'en')!;
});

afterAll(() => {
  db.close();
});

const TRACKS = ['ball-mastery', 'dribbling', 'passing-first-touch', 'weak-foot', 'juggling-coordination'];
const FIRST_NODES = ['basic-touches', 'close-dribbling', 'inside-foot-pass', 'weak-foot-touches', 'balance-footwork'];
const BALL_MASTERY = ['basic-touches', 'inside-touches', 'outside-touches', 'alternating-touches', 'direction-change', 'speed-control'];
const PASSING = ['inside-foot-pass', 'passing-accuracy', 'first-touch-control', 'directional-first-touch', 'moving-pass'];

type Level = RoadmapTrack['level'];

/** Every seed track at level 1 (a self-declared beginner) unless `over` says otherwise. */
function levels(over: Record<string, Level> = {}): RoadmapTrack[] {
  return TRACKS.map((skill) => ({ skill, level: over[skill] ?? 1, source: 'self' as const }));
}

const focusOf = (...skills: string[]) => skills.map((skill) => ({ skill }));

function track(tree: ReturnType<typeof deriveTree>, slug: string): TreeNode[] {
  const found = tree.find((each) => each.track === slug);
  if (found === undefined) throw new Error(`no track ${slug}`);
  return found.nodes;
}

/** slug -> state of one track. */
function states(tree: ReturnType<typeof deriveTree>, slug: string): Record<string, string> {
  return Object.fromEntries(track(tree, slug).map((node) => [node.slug, node.state]));
}

const inState = (tree: ReturnType<typeof deriveTree>, slug: string, state: string): string[] =>
  track(tree, slug)
    .filter((node) => node.state === state)
    .map((node) => node.slug);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** A synthetic graph node: only what deriveTree reads. */
const node = (slug: string, parent: string | null, prerequisites: { skill: string; minLevel: number }[] = []): TreeGraph['nodes'][number] => ({
  slug,
  parent,
  names: { en: `${slug} (en)` },
  prerequisites,
});

describe('the real seed graph', () => {
  test('has 5 tracks and 25 sub-skills, all with prerequisites data', () => {
    expect(seed.nodes.filter((each) => each.parent === null)).toHaveLength(5);
    expect(seed.nodes.filter((each) => each.parent !== null)).toHaveLength(25);
    expect(seed.nodes.some((each) => each.prerequisites.length > 0)).toBe(true);
  });
});

describe('shape', () => {
  test('one entry per track in graph order, every sub-skill once, valid against the journey contract', () => {
    const tree = deriveTree(seed, levels(), {}, []);
    expect(() => z.array(TreeTrack).parse(tree)).not.toThrow();
    expect(tree.map((each) => each.track)).toEqual(TRACKS);
    expect(tree.flatMap((each) => each.nodes)).toHaveLength(25);
    expect(new Set(tree.flatMap((each) => each.nodes.map((n) => n.slug))).size).toBe(25);
    expect(tree.flatMap((each) => each.nodes).every((n) => (NODE_STATES as readonly string[]).includes(n.state))).toBe(true);
  });

  test('a track lists its sub-skills in the graph order, never the track itself', () => {
    const tree = deriveTree(seed, levels(), {}, []);
    expect(track(tree, 'ball-mastery').map((n) => n.slug)).toEqual(BALL_MASTERY);
    expect(track(tree, 'passing-first-touch').map((n) => n.slug)).toEqual(PASSING);
    expect(tree.flatMap((each) => each.nodes.map((n) => n.slug))).not.toContain('ball-mastery');
  });

  test("node level is the 1-based position in the track, capped at SKILL_LEVEL_MAX - 1", () => {
    const tree = deriveTree(seed, levels(), {}, []);
    expect(track(tree, 'ball-mastery').map((n) => n.level)).toEqual([1, 2, 3, 4, 4, 4]);
    expect(track(tree, 'weak-foot').map((n) => n.level)).toEqual([1, 2, 3, 4]);
    for (const n of tree.flatMap((each) => each.nodes)) expect(n.level).toBeLessThan(SKILL_LEVEL_MAX);
  });

  test('names come in the requested locale, falling back requested -> ru -> en', () => {
    const ru = getSkillGraph(db, 'football', 'ru')!;
    const treeRu = deriveTree(ru, levels(), {}, [], 'ru');
    const basicRu = ru.nodes.find((n) => n.slug === 'basic-touches')!.names.ru;
    expect(track(treeRu, 'ball-mastery')[0]!.name).toBe(basicRu!);
    const treeEn = deriveTree(seed, levels(), {}, []);
    expect(track(treeEn, 'ball-mastery')[0]!.name).toBe(seed.nodes.find((n) => n.slug === 'basic-touches')!.names.en!);
    expect(track(treeEn, 'ball-mastery')[0]!.name).not.toBe(basicRu!);
    // a graph with only an English name serves every locale
    const enOnly = deriveTree({ nodes: [node('t', null), node('a', 't')] }, [], {}, [], 'kk');
    expect(enOnly[0]!.nodes[0]!.name).toBe('a (en)');
  });
});

describe('a fresh player', () => {
  const fresh = () => deriveTree(seed, levels(), {}, []);

  test('has the first node of every track training and every other node locked', () => {
    const tree = fresh();
    for (const [index, slug] of TRACKS.entries()) {
      expect(inState(tree, slug, 'training')).toEqual([FIRST_NODES[index]!]);
      expect(inState(tree, slug, 'mastered')).toEqual([]);
      expect(inState(tree, slug, 'locked')).toHaveLength(track(tree, slug).length - 1);
    }
  });

  test('a track with no level entry defaults to level 1: same tree as an explicit level 1 for all', () => {
    expect(deriveTree(seed, [], {}, [])).toEqual(fresh());
  });
});

describe('prerequisites gate unlocking', () => {
  test('a node whose prerequisite track level is below minLevel is locked, and unlocks when the level reaches it (inclusive)', () => {
    // passing-accuracy needs inside-foot-pass @3; first-touch-control needs inside-foot-pass @2.
    const counts = { 'inside-foot-pass': MASTERY_MIN_DRILLS };
    const two = deriveTree(seed, levels({ 'passing-first-touch': 2 }), counts, []);
    expect(states(two, 'passing-first-touch')).toEqual({
      'inside-foot-pass': 'mastered',
      'passing-accuracy': 'locked',
      'first-touch-control': 'training',
      'directional-first-touch': 'locked',
      'moving-pass': 'locked',
    });
    const three = deriveTree(seed, levels({ 'passing-first-touch': 3 }), counts, []);
    expect(states(three, 'passing-first-touch')).toEqual({
      'inside-foot-pass': 'mastered',
      'passing-accuracy': 'training',
      'first-touch-control': 'locked',
      'directional-first-touch': 'locked',
      'moving-pass': 'locked',
    });
  });

  test('a prerequisite in another track is judged by THAT track level', () => {
    // A: a1; B: b1 needs a1 @3, b2 has none. B's own level never matters for b1.
    const graph: TreeGraph = { nodes: [node('A', null), node('a1', 'A'), node('B', null), node('b1', 'B', [{ skill: 'a1', minLevel: 3 }]), node('b2', 'B')] };
    const lv = (a: Level, b: Level): RoadmapTrack[] => [
      { skill: 'A', level: a, source: 'self' },
      { skill: 'B', level: b, source: 'self' },
    ];
    expect(states(deriveTree(graph, lv(2, 5), {}, []), 'B')).toEqual({ b1: 'locked', b2: 'training' });
    expect(states(deriveTree(graph, lv(3, 1), {}, []), 'B')).toEqual({ b1: 'training', b2: 'locked' });
    expect(states(deriveTree(graph, lv(5, 1), {}, []), 'B')).toEqual({ b1: 'training', b2: 'locked' });
  });

  test('every prerequisite must be met, not one of them', () => {
    const graph: TreeGraph = {
      nodes: [node('A', null), node('a1', 'A'), node('B', null), node('b1', 'B', [{ skill: 'a1', minLevel: 2 }, { skill: 'a1', minLevel: 4 }]), node('b2', 'B')],
    };
    const lv = (a: Level): RoadmapTrack[] => [{ skill: 'A', level: a, source: 'self' }];
    expect(states(deriveTree(graph, lv(3), {}, []), 'B')).toEqual({ b1: 'locked', b2: 'training' });
    expect(states(deriveTree(graph, lv(4), {}, []), 'B')).toEqual({ b1: 'training', b2: 'locked' });
  });

  test('a prerequisite that is not a node of the graph is never met', () => {
    const graph: TreeGraph = { nodes: [node('T', null), node('t1', 'T', [{ skill: 'ghost', minLevel: 1 }]), node('t2', 'T')] };
    expect(states(deriveTree(graph, [], {}, []), 'T')).toEqual({ t1: 'locked', t2: 'training' });
  });

  test('when no open node has its prerequisites met the first open node still trains (a track never dead-ends)', () => {
    const graph: TreeGraph = { nodes: [node('T', null), node('t1', 'T', [{ skill: 't1', minLevel: 5 }]), node('t2', 'T', [{ skill: 't1', minLevel: 5 }])] };
    expect(states(deriveTree(graph, [], {}, []), 'T')).toEqual({ t1: 'training', t2: 'locked' });
  });

  test('a mastered node leaves the frontier to the next node in order', () => {
    const counts = { 'basic-touches': 3, 'inside-touches': 3 };
    const tree = deriveTree(seed, levels({ 'ball-mastery': 3 }), counts, []);
    expect(states(tree, 'ball-mastery')).toEqual({
      'basic-touches': 'mastered',
      'inside-touches': 'mastered',
      'outside-touches': 'training',
      'alternating-touches': 'locked',
      'direction-change': 'locked',
      'speed-control': 'locked',
    });
  });
});

describe('mastered needs both conditions', () => {
  const stateOfFirst = (level: Level, drills: number): string => {
    const tree = deriveTree(seed, levels({ 'ball-mastery': level }), { 'basic-touches': drills }, []);
    return track(tree, 'ball-mastery')[0]!.state;
  };

  test('track level above the node level AND at least 3 completed drills', () => {
    expect(stateOfFirst(2, 3)).toBe('mastered');
    expect(stateOfFirst(5, 100)).toBe('mastered');
  });

  test('enough drills but a track level not above the node level is not mastered (strictly above)', () => {
    expect(stateOfFirst(1, 3)).toBe('training');
    expect(stateOfFirst(1, 50)).toBe('training');
  });

  test('a level above the node but fewer than 3 drills is not mastered', () => {
    expect(MASTERY_MIN_DRILLS).toBe(3);
    expect(stateOfFirst(5, 2)).toBe('training');
    expect(stateOfFirst(5, 0)).toBe('training');
  });

  test('the level bar rises with the node position: node 2 needs level 3, node 4+ needs level 5', () => {
    const drills = Object.fromEntries(BALL_MASTERY.map((slug) => [slug, 3]));
    const mastered = (level: Level) => inState(deriveTree(seed, levels({ 'ball-mastery': level }), drills, []), 'ball-mastery', 'mastered');
    expect(mastered(1)).toEqual([]);
    expect(mastered(2)).toEqual(['basic-touches']);
    expect(mastered(3)).toEqual(['basic-touches', 'inside-touches']);
    expect(mastered(4)).toEqual(['basic-touches', 'inside-touches', 'outside-touches']);
    expect(mastered(5)).toEqual(BALL_MASTERY);
  });

  test('drills are counted per node: a node without its own drills is not mastered by its neighbours', () => {
    const tree = deriveTree(seed, levels({ 'ball-mastery': 5 }), { 'inside-touches': 9 }, []);
    expect(inState(tree, 'ball-mastery', 'mastered')).toEqual(['inside-touches']);
  });

  test('the level and the drills of ANOTHER track do not master a node', () => {
    const tree = deriveTree(seed, levels({ dribbling: 5 }), { 'basic-touches': 9 }, []);
    expect(inState(tree, 'ball-mastery', 'mastered')).toEqual([]);
  });

  test('a fully mastered track has no training node; the other tracks are untouched', () => {
    const drills = Object.fromEntries(BALL_MASTERY.map((slug) => [slug, 3]));
    const tree = deriveTree(seed, levels({ 'ball-mastery': 5 }), drills, []);
    expect(inState(tree, 'ball-mastery', 'training')).toEqual([]);
    expect(inState(tree, 'ball-mastery', 'locked')).toEqual([]);
    expect(inState(tree, 'dribbling', 'training')).toEqual(['close-dribbling']);
  });
});

describe('every unfinished track has a training frontier', () => {
  test('across every level and progress mix, a track with an unmastered node has at least one training node', () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      for (const drills of [0, 2, 3]) {
        for (const slug of TRACKS) {
          const counts = Object.fromEntries(seed.nodes.map((n) => [n.slug, drills]));
          const tree = deriveTree(seed, levels({ [slug]: level }), counts, []);
          for (const each of tree) {
            const open = each.nodes.filter((n) => n.state !== 'mastered');
            const training = each.nodes.filter((n) => n.state === 'training');
            if (open.length > 0) expect(training.length).toBeGreaterThanOrEqual(1);
            else expect(training).toHaveLength(0);
          }
        }
      }
    }
  });

  test('a focused node with enough drills but too low a track level is still open, so it trains', () => {
    const tree = deriveTree(seed, levels({ 'ball-mastery': 3 }), { 'basic-touches': 3, 'inside-touches': 3, 'speed-control': 3 }, focusOf('speed-control'));
    // speed-control has 3 drills but level 3 is not above its node level 4: it is open, and in the focus
    expect(states(tree, 'ball-mastery')['speed-control']).toBe('training');
    expect(states(tree, 'ball-mastery')['basic-touches']).toBe('mastered');
  });
});

describe('focus', () => {
  test('a node in the focus trains even when its prerequisites are unmet, next to the frontier', () => {
    const tree = deriveTree(seed, levels(), {}, focusOf('direction-change'));
    expect(inState(tree, 'ball-mastery', 'training')).toEqual(['basic-touches', 'direction-change']);
    expect(inState(tree, 'ball-mastery', 'locked')).toEqual(['inside-touches', 'outside-touches', 'alternating-touches', 'speed-control']);
  });

  test('a mastered node in the focus stays mastered (mastered outranks training)', () => {
    const tree = deriveTree(seed, levels({ 'ball-mastery': 3 }), { 'basic-touches': 3 }, focusOf('basic-touches'));
    expect(states(tree, 'ball-mastery')['basic-touches']).toBe('mastered');
  });

  test('a track in the focus (a roadmap focus entry) starts at its first unmastered node even when its prerequisites are unmet', () => {
    const graph: TreeGraph = { nodes: [node('A', null), node('a1', 'A'), node('B', null), node('b1', 'B', [{ skill: 'a1', minLevel: 4 }]), node('b2', 'B')] };
    expect(states(deriveTree(graph, [], {}, []), 'B')).toEqual({ b1: 'locked', b2: 'training' });
    expect(states(deriveTree(graph, [], {}, focusOf('B')), 'B')).toEqual({ b1: 'training', b2: 'locked' });
    // ...and a focus on another track does not change B
    expect(states(deriveTree(graph, [], {}, focusOf('A')), 'B')).toEqual({ b1: 'locked', b2: 'training' });
  });

  test('accepts the roadmap focus entries as they are', () => {
    const roadmapFocus = [{ skill: 'direction-change', level: 1 as const, targetLevel: 2 as const, reason: 'weakest' }];
    const tree = deriveTree(seed, levels(), {}, roadmapFocus);
    expect(states(tree, 'ball-mastery')['direction-change']).toBe('training');
  });
});

describe('input the graph does not know is ignored', () => {
  const fresh = deriveTree(seed, levels(), {}, []);

  test('unknown tracks, nodes and focus entries change nothing and never appear in the output', () => {
    const noisy = deriveTree(
      seed,
      [...levels(), { skill: 'chess', level: 5, source: 'test' }],
      { ghost: 9, 'chess-opening': 9 },
      focusOf('ghost', 'chess'),
    );
    expect(noisy).toEqual(fresh);
    const slugs = noisy.flatMap((each) => [each.track, ...each.nodes.map((n) => n.slug)]);
    expect(slugs).not.toContain('chess');
    expect(slugs).not.toContain('ghost');
  });

  test('a level given for a sub-skill (levels are per track) does not count', () => {
    expect(deriveTree(seed, [{ skill: 'basic-touches', level: 5, source: 'test' }], { 'basic-touches': 9 }, [])).toEqual(fresh);
  });

  test('a level applies to its own track only', () => {
    const tree = deriveTree(seed, [{ skill: 'dribbling', level: 5, source: 'test' }], { 'close-dribbling': 3, 'basic-touches': 3 }, []);
    expect(inState(tree, 'dribbling', 'mastered')).toEqual(['close-dribbling']);
    expect(inState(tree, 'ball-mastery', 'mastered')).toEqual([]);
    expect(inState(tree, 'ball-mastery', 'training')).toEqual(['basic-touches']);
  });

  test('the first level entry of a track wins when there are duplicates', () => {
    const tree = deriveTree(seed, [{ skill: 'ball-mastery', level: 5, source: 'test' }, { skill: 'ball-mastery', level: 1, source: 'self' }], { 'basic-touches': 3 }, []);
    expect(states(tree, 'ball-mastery')['basic-touches']).toBe('mastered');
  });

  test('a duplicate node slug appears once', () => {
    const graph: TreeGraph = { nodes: [node('T', null), node('t1', 'T'), node('t1', 'T'), node('t2', 'T')] };
    expect(track(deriveTree(graph, [], {}, []), 'T').map((n) => n.slug)).toEqual(['t1', 't2']);
  });

  test('a count keyed like an Object.prototype member is not a drill count', () => {
    const graph: TreeGraph = { nodes: [node('T', null), node('constructor', 'T'), node('toString', 'T')] };
    expect(states(deriveTree(graph, [{ skill: 'T', level: 5, source: 'test' }], {}, []), 'T')).toEqual({ constructor: 'training', toString: 'locked' });
  });
});

describe('a bad graph does not hang the function', () => {
  test('a parent cycle (a <-> b) has no track: its nodes are left out, the rest is derived', () => {
    const graph: TreeGraph = { nodes: [node('T', null), node('t1', 'T'), node('a', 'b'), node('b', 'a'), node('self', 'self')] };
    const tree = deriveTree(graph, [], {}, []);
    expect(tree.map((each) => each.track)).toEqual(['T']);
    expect(track(tree, 'T').map((n) => n.slug)).toEqual(['t1']);
  });

  test('a node whose parent is not in the graph is left out', () => {
    const graph: TreeGraph = { nodes: [node('T', null), node('t1', 'T'), node('orphan', 'nowhere')] };
    expect(track(deriveTree(graph, [], {}, []), 'T').map((n) => n.slug)).toEqual(['t1']);
  });

  test('prerequisite cycles (including a self prerequisite) terminate with a deterministic tree', () => {
    const graph: TreeGraph = {
      nodes: [
        node('A', null),
        node('a1', 'A', [{ skill: 'b1', minLevel: 2 }]),
        node('a2', 'A', [{ skill: 'a2', minLevel: 1 }]),
        node('B', null),
        node('b1', 'B', [{ skill: 'a1', minLevel: 2 }]),
      ],
    };
    const first = deriveTree(graph, [], {}, []);
    expect(deriveTree(graph, [], {}, [])).toEqual(first);
    // level 1 everywhere: a1 needs level 2 (unmet), a2 needs A level 1 (met) -> a2 is the frontier
    expect(states(first, 'A')).toEqual({ a1: 'locked', a2: 'training' });
    expect(states(first, 'B')).toEqual({ b1: 'training' });
    // levels are compared, never followed, so raising both tracks still terminates
    const raised = deriveTree(graph, [{ skill: 'A', level: 2, source: 'self' }, { skill: 'B', level: 2, source: 'self' }], {}, []);
    expect(states(raised, 'A')).toEqual({ a1: 'training', a2: 'locked' });
  });

  test('a root with no sub-skills is a track with no nodes', () => {
    const tree = deriveTree({ nodes: [node('T', null), node('E', null)] }, [], {}, []);
    expect(tree).toEqual([{ track: 'T', nodes: [] }, { track: 'E', nodes: [] }]);
  });

  test('an empty graph gives an empty tree', () => {
    expect(deriveTree({ nodes: [] }, levels(), { x: 1 }, focusOf('x'))).toEqual([]);
  });
});

describe('pure', () => {
  test('the same input gives the same tree', () => {
    const args = [levels({ dribbling: 3 }), { 'close-dribbling': 4 }, focusOf('speed-control')] as const;
    expect(deriveTree(seed, ...args)).toEqual(deriveTree(seed, ...args));
  });

  test('deep-frozen inputs are accepted and left untouched', () => {
    const graph = structuredClone(seed);
    const lv = levels({ 'ball-mastery': 3 });
    const counts = { 'basic-touches': 3 };
    const focus = focusOf('direction-change');
    const before = structuredClone({ graph, lv, counts, focus });
    deepFreeze(graph);
    deepFreeze(lv);
    deepFreeze(counts);
    deepFreeze(focus);
    const tree = deriveTree(graph, lv, counts, focus);
    expect(tree.flatMap((each) => each.nodes)).toHaveLength(25);
    expect({ graph, lv, counts, focus }).toEqual(before);
  });

  test('the order of the level entries does not matter', () => {
    const lv = levels({ dribbling: 3, 'weak-foot': 2 });
    expect(deriveTree(seed, [...lv].reverse(), {}, [])).toEqual(deriveTree(seed, lv, {}, []));
  });

  test('the result shares no mutable structure with the input: editing it leaves the graph alone', () => {
    const tree = deriveTree(seed, levels(), {}, []);
    const names = JSON.stringify(seed);
    tree[0]!.nodes[0]!.name = 'changed';
    tree[0]!.nodes.pop();
    expect(JSON.stringify(seed)).toBe(names);
    expect(deriveTree(seed, levels(), {}, [])[0]!.nodes[0]!.name).not.toBe('changed');
  });
});
