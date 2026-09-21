import { describe, expect, test } from "bun:test";
import { validateGraph } from "./graph";
import type { GraphProblem, SeedDrill, SeedSkillNode } from "./graph";

/** A node: `[slug, parent, ...prerequisite slugs]`. */
const node = (slug: string, parent: string | null = null, ...requires: string[]): SeedSkillNode => ({
  slug,
  parent,
  prerequisites: requires.map((skill) => ({ skill, minLevel: 1 })),
});

const drill = (slug: string, skill: string, links: Partial<SeedDrill> = {}): SeedDrill => ({ slug, skill, ...links });

/** The structured part of a problem: kind, slug and the optional path/target (never the message). */
const shape = (problems: GraphProblem[]) =>
  problems.map((problem) => ({ kind: problem.kind, slug: problem.slug, target: problem.target, path: problem.path }));

/** Every prerequisite and parent must come strictly before its dependent in `order`. */
const expectTopological = (nodes: SeedSkillNode[], order: string[]) => {
  const position = new Map(order.map((slug, index) => [slug, index] as const));
  for (const each of nodes) {
    const at = position.get(each.slug);
    expect(at).toBeDefined();
    const before = [...(each.parent ? [each.parent] : []), ...(each.prerequisites ?? []).map((p) => p.skill)];
    for (const dependency of before) {
      expect(position.get(dependency)).toBeDefined();
      expect(position.get(dependency)!).toBeLessThan(at!);
    }
  }
};

/** Deterministic Fisher-Yates so a failing permutation is reproducible. */
const shuffled = <T>(items: readonly T[], seed: number): T[] => {
  const out = [...items];
  let state = seed;
  for (let index = out.length - 1; index > 0; index--) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const swap = state % (index + 1);
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
};

const pad = (value: number) => String(value).padStart(5, "0");

describe("validateGraph: sound graphs", () => {
  test("an empty graph is ok with an empty order", () => {
    expect(validateGraph([], [])).toEqual({ ok: true, problems: [], order: [] });
  });

  test("an acyclic graph passes and its order puts every prerequisite and parent first", () => {
    const nodes = [
      node("jump", "balance", "run"),
      node("run", "movement", "walk"),
      node("walk", "movement", "crawl"),
      node("crawl", "movement"),
      node("balance"),
      node("movement"),
    ];
    const drills = [
      drill("crawl-basics", "crawl", { progression: ["walk-basics"] }),
      drill("walk-basics", "walk", { progression: "run-basics", regression: ["crawl-basics"], skills: ["crawl"] }),
      drill("run-basics", "run", { regression: "walk-basics" }),
    ];
    const report = validateGraph(nodes, drills);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.order).toHaveLength(nodes.length);
    expect(new Set(report.order)).toEqual(new Set(nodes.map((each) => each.slug)));
    expectTopological(nodes, report.order);
  });

  test("ties between ready skills are broken by slug order, not input order", () => {
    // a and c are both ready first; b waits for c.
    const report = validateGraph([node("c"), node("b", null, "c"), node("a")], []);
    expect(report.order).toEqual(["a", "c", "b"]);
  });

  test("prerequisites and parents are optional on a node", () => {
    expect(validateGraph([{ slug: "a" }, { slug: "b", parent: "a" }], [])).toEqual({
      ok: true,
      problems: [],
      order: ["a", "b"],
    });
  });

  test("the input is left untouched", () => {
    const nodes = [node("b", "a", "a"), node("a")];
    const drills = [drill("d", "a", { progression: ["d"] })];
    const before = JSON.stringify([nodes, drills]);
    validateGraph(nodes, drills);
    expect(JSON.stringify([nodes, drills])).toBe(before);
  });
});

describe("validateGraph: cycles", () => {
  test("a 3-node prerequisite cycle is reported once, with its path starting at the smallest slug", () => {
    // a requires b requires c requires a; listed starting from c to prove the start is chosen by slug.
    const report = validateGraph([node("c", null, "a"), node("b", null, "c"), node("a", null, "b")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(shape(report.problems)[0]).toEqual({
      kind: "prerequisite_cycle",
      slug: "a",
      target: undefined,
      path: ["a", "b", "c", "a"],
    });
    expect(report.order).toEqual([]);
  });

  test("a node that merely depends on a cycle is not part of the reported cycle", () => {
    const report = validateGraph([node("a", null, "b"), node("b", null, "c"), node("c", null, "a"), node("d", null, "a")], []);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]!.path).toEqual(["a", "b", "c", "a"]);
  });

  test("a self-prerequisite is a cycle of length 1", () => {
    const report = validateGraph([node("a", null, "a")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "prerequisite_cycle", slug: "a", path: ["a", "a"] });
    expect(report.order).toEqual([]);
  });

  test("a cycle along parent links is a parent_cycle, not a prerequisite_cycle", () => {
    const report = validateGraph([node("b", "a"), node("a", "b")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "parent_cycle", slug: "a", path: ["a", "b", "a"] });
    expect(report.order).toEqual([]);
  });

  test("a cycle that mixes a parent link and a prerequisite still leaves no order and is reported", () => {
    // a's parent is b, and b requires a: neither chain alone loops.
    const report = validateGraph([node("a", "b"), node("b", null, "a")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "mixed_cycle", slug: "a", path: ["a", "b", "a"] });
    expect(report.order).toEqual([]);
  });

  test("two disjoint cycles are reported separately", () => {
    const report = validateGraph(
      [node("x", null, "y"), node("y", null, "z"), node("z", null, "x"), node("a", null, "b"), node("b", null, "a")],
      [],
    );
    expect(report.problems).toHaveLength(2);
    expect(shape(report.problems)).toEqual([
      { kind: "prerequisite_cycle", slug: "a", target: undefined, path: ["a", "b", "a"] },
      { kind: "prerequisite_cycle", slug: "x", target: undefined, path: ["x", "y", "z", "x"] },
    ]);
    expect(report.order).toEqual([]);
  });
});

describe("validateGraph: dangling references", () => {
  test("a prerequisite that is not a node is dangling_prerequisite", () => {
    const report = validateGraph([node("a", null, "ghost")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_prerequisite", slug: "a", target: "ghost" });
  });

  test("a parent that is not a node is dangling_parent", () => {
    const report = validateGraph([node("a", "ghost")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_parent", slug: "a", target: "ghost" });
  });

  test("a drill skill that is not a node is dangling_drill_skill, keyed by the drill", () => {
    const report = validateGraph([node("a")], [drill("d1", "ghost")]);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_drill_skill", slug: "d1", target: "ghost" });
  });

  test("an entry of a drill's skills list that is not a node is dangling_drill_skill", () => {
    const report = validateGraph([node("a")], [drill("d1", "a", { skills: ["a", "ghost"] })]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_drill_skill", slug: "d1", target: "ghost" });
  });

  test("the same missing skill named by skill and skills is reported once", () => {
    const report = validateGraph([node("a")], [drill("d1", "ghost", { skills: ["ghost"] })]);
    expect(report.problems).toHaveLength(1);
  });

  test("a progression that is not a drill is dangling_progression", () => {
    const report = validateGraph([node("a")], [drill("d1", "a", { progression: ["d2", "ghost"] }), drill("d2", "a")]);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_progression", slug: "d1", target: "ghost" });
  });

  test("a single-string progression is checked too", () => {
    const report = validateGraph([node("a")], [drill("d1", "a", { progression: "ghost" })]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_progression", slug: "d1", target: "ghost" });
  });

  test("a regression that is not a drill is dangling_regression", () => {
    const report = validateGraph([node("a")], [drill("d1", "a", { regression: ["ghost"] })]);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_regression", slug: "d1", target: "ghost" });
  });

  test("progression and regression name drills, so a skill slug there is dangling", () => {
    const report = validateGraph([node("a")], [drill("d1", "a", { progression: "a" })]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "dangling_progression", slug: "d1", target: "a" });
  });

  test("with only dangling references the order is still computed over the resolvable nodes", () => {
    const report = validateGraph([node("b", null, "a", "ghost"), node("a")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.order).toEqual(["a", "b"]);
  });
});

describe("validateGraph: duplicate slugs", () => {
  test("a skill slug used twice is reported once as duplicate_slug and listed once in the order", () => {
    const report = validateGraph([node("a"), node("b", null, "a"), node("a")], []);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ kind: "duplicate_slug", slug: "a" });
    expect(report.order).toEqual(["a", "b"]);
  });
});

describe("validateGraph: several problems and determinism", () => {
  const nodes = [
    node("ok-root"),
    node("dup"),
    node("dup"),
    node("p", "ghost-parent"),
    node("q", null, "zz-ghost", "aa-ghost"),
    node("x", null, "y"),
    node("y", null, "x"),
  ];
  const drills = [drill("d", "ghost-skill", { progression: "ghost-p", regression: ["ghost-r"] })];

  test("all problems are reported, ordered by kind, then slug, then target", () => {
    const report = validateGraph(nodes, drills);
    expect(report.ok).toBe(false);
    expect(shape(report.problems)).toEqual([
      { kind: "prerequisite_cycle", slug: "x", target: undefined, path: ["x", "y", "x"] },
      { kind: "dangling_prerequisite", slug: "q", target: "aa-ghost", path: undefined },
      { kind: "dangling_prerequisite", slug: "q", target: "zz-ghost", path: undefined },
      { kind: "dangling_parent", slug: "p", target: "ghost-parent", path: undefined },
      { kind: "dangling_drill_skill", slug: "d", target: "ghost-skill", path: undefined },
      { kind: "dangling_progression", slug: "d", target: "ghost-p", path: undefined },
      { kind: "dangling_regression", slug: "d", target: "ghost-r", path: undefined },
      { kind: "duplicate_slug", slug: "dup", target: undefined, path: undefined },
    ]);
    expect(report.order).toEqual([]);
  });

  test("the report is identical for any permutation of the input", () => {
    const baseline = validateGraph(nodes, drills);
    for (let seed = 1; seed <= 25; seed++) {
      const permutedNodes = shuffled(nodes, seed).map((each) => ({
        ...each,
        prerequisites: shuffled(each.prerequisites ?? [], seed + 100),
      }));
      const permutedDrills = shuffled(drills, seed + 200);
      expect(validateGraph(permutedNodes, permutedDrills)).toEqual(baseline);
    }
  });

  test("a sound graph gets the same order for any permutation of the input", () => {
    const sound = [
      node("m"),
      node("k", "m"),
      node("l", "m", "k"),
      node("j", null, "l", "k"),
      node("i", null, "m"),
      node("h"),
    ];
    const baseline = validateGraph(sound, []);
    expect(baseline.ok).toBe(true);
    expectTopological(sound, baseline.order);
    for (let seed = 1; seed <= 25; seed++) {
      expect(validateGraph(shuffled(sound, seed), [])).toEqual(baseline);
    }
  });
});

describe("validateGraph: scale", () => {
  const SIZE = 5000;

  test("a 5,000-node prerequisite chain completes with the only valid order", () => {
    // Slugs sort opposite to the chain, so a slug-sorted answer would be wrong.
    const chain = Array.from({ length: SIZE }, (_, index) => `s${pad(SIZE - 1 - index)}`);
    const nodes = chain.map((slug, index) => node(slug, null, ...(index === 0 ? [] : [chain[index - 1]!])));
    const report = validateGraph(nodes, []);
    expect(report.ok).toBe(true);
    expect(report.order).toEqual(chain);
  });

  test("a 5,000-node parent chain completes with the only valid order", () => {
    const chain = Array.from({ length: SIZE }, (_, index) => `s${pad(SIZE - 1 - index)}`);
    const nodes = chain.map((slug, index) => node(slug, index === 0 ? null : chain[index - 1]!));
    const report = validateGraph(nodes, []);
    expect(report.ok).toBe(true);
    expect(report.order).toEqual(chain);
  });

  test("a 5,000-node cycle is reported with its full path", () => {
    const slugs = Array.from({ length: SIZE }, (_, index) => `s${pad(index)}`);
    const nodes = slugs.map((slug, index) => node(slug, null, slugs[(index + 1) % SIZE]!));
    const report = validateGraph(nodes, []);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]!.kind).toBe("prerequisite_cycle");
    expect(report.problems[0]!.path).toEqual([...slugs, slugs[0]!]);
    expect(report.order).toEqual([]);
  });
});
