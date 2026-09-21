import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as domain from "./domain";
import * as primitives from "./primitives";
import {
  Attribution,
  CommonsExport,
  DrillDetail,
  DrillListQuery,
  DrillListResponse,
  DrillSummary,
  ENDPOINTS,
  SkillGraph,
  SkillNode,
  SkillTest,
  graphProblems,
} from "./commons";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const AT = "2026-09-01T10:00:00Z";

// Local factories: each call returns a fresh, valid payload to mutate one field at a time.
const node = (overrides: Record<string, unknown> = {}) => ({
  slug: "juggling",
  parent: null as string | null,
  order: 4,
  names: { ru: "Жонглирование", en: "Juggling" },
  levels: [{ en: "One touch, one bounce" }, { en: "Ladder 3-5-7" }],
  prerequisites: [{ skill: "ball-control", minLevel: 1 }] as Array<{ skill: string; minLevel: number }>,
  ageMin: 7,
  ageMax: 16,
  equipment: "ball",
  safety: [{ en: "Clear the space around you" }],
  outcomes: [{ en: "Ten touches in a row" }],
  mistakes: [{ en: "Kicking too high" }],
  ...overrides,
});

const rootNode = () => node({ slug: "ball-control", order: 1, names: { en: "Ball control" }, prerequisites: [] });

const graph = (nodes: unknown[] = [rootNode(), node()]) => ({ sport: "football", version: "0.1.0", nodes });

/** A parsed graph for graphProblems: nodes are `[slug, parent, prerequisite slugs]`. */
const graphOf = (...specs: Array<[string, string | null, string[]?]>) =>
  SkillGraph.parse(
    graph(
      specs.map(([slug, parent, prerequisites = []]) =>
        node({ slug, parent, prerequisites: prerequisites.map((skill) => ({ skill, minLevel: 1 })) }),
      ),
    ),
  );

const skillTest = () => ({
  slug: "juggling-max-touches",
  skill: "juggling",
  metric: "Max consecutive touches",
  unit: "touches",
  direction: "higher",
  protocol: { ru: "Жонглируйте без падения мяча.", en: "Juggle without dropping the ball." },
  equipment: "ball",
});

const summary = () => ({
  slug: "five-gate-slalom",
  title: { ru: "Слалом через 5 ворот", en: "Five-Gate Slalom" },
  track: "dribbling",
  level: "beginner",
  minutes: 7,
  equipment: "cones",
  space: "yard",
  status: "COMMUNITY",
  versionId: "five-gate-slalom-v1",
});

const content = () => ({
  goal: { en: "Close control while turning" },
  instructions: { en: "Dribble through five gates using both feet." },
  dose: { durationSec: 60 },
  conditions: { equipment: "cones", spaces: ["yard", "field"] },
});

const attribution = () => ({
  author: "FIRST COACH Genesis",
  source: "FIRST COACH Genesis",
  sourceUrl: "https://example.org/source",
  license: "CC-BY-SA-4.0",
  createdAt: AT,
  semver: "1.0.0",
});

const historyEntry = () => ({ versionId: "five-gate-slalom-v1", semver: "1.0.0", createdAt: AT, note: "First version" });

const review = () => ({
  reviewer: "A. Coach",
  orgLabel: "Kairat Academy",
  from: "COMMUNITY",
  to: "REVIEWED",
  note: "Checked the safety notes.",
  at: AT,
});

const detail = () => ({
  slug: "five-gate-slalom",
  versionId: "five-gate-slalom-v1",
  content: content(),
  attribution: attribution(),
  history: [historyEntry()],
  reviews: [review()],
});

const facets = () => ({
  skills: [{ slug: "dribbling", names: { en: "Dribbling" }, count: 3 }],
  statuses: [
    { value: "COMMUNITY", count: 3 },
    { value: "REVIEWED", count: 0 },
  ],
  equipment: [{ value: "cones", count: 1 }],
  levels: [{ value: "beginner", count: 2 }],
});

const list = () => ({ items: [summary()], nextCursor: null as string | null, facets: facets() });

const sport = () => ({
  slug: "football",
  name: { ru: "Футбол", en: "Football" },
  graph: graph(),
  tests: [skillTest()],
  drills: [detail()],
});

const exported = () => ({
  schema_version: "0.1.0",
  license: "CC-BY-SA-4.0",
  attribution_notice:
    "Source: Open Sport Commons by FIRST COACH (KOZ AI) and contributors, licensed CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/",
  generated_at: AT,
  sports: [sport()],
});

const NODE_KEYS = [
  "slug",
  "parent",
  "order",
  "names",
  "levels",
  "prerequisites",
  "ageMin",
  "ageMax",
  "equipment",
  "safety",
  "outcomes",
  "mistakes",
] as const;

describe("SkillNode", () => {
  test("parses a realistic node and keeps every listed field", () => {
    const parsed = SkillNode.parse(node());
    expect(Object.keys(parsed).sort()).toEqual([...NODE_KEYS].sort());
    expect(parsed.prerequisites).toEqual([{ skill: "ball-control", minLevel: 1 }]);
  });

  test.each([...NODE_KEYS])("rejects a node missing %s", (key) => {
    expect(ok(SkillNode, without(node(), key))).toBe(false);
  });

  test("a root node has parent null and a child has a slug", () => {
    expect(ok(SkillNode, node({ parent: null }))).toBe(true);
    expect(ok(SkillNode, node({ parent: "ball-control" }))).toBe(true);
  });

  test("parent is a string or null, not a number", () => {
    expect(ok(SkillNode, node({ parent: 3 }))).toBe(false);
  });

  test("names is a LocalizedText: an empty one is rejected", () => {
    expect(ok(SkillNode, node({ names: {} }))).toBe(false);
  });

  test("names is a LocalizedText: a plain string is rejected", () => {
    expect(ok(SkillNode, node({ names: "Juggling" }))).toBe(false);
  });

  test("a fractional order is rejected", () => {
    expect(ok(SkillNode, node({ order: 1.5 }))).toBe(false);
  });

  test.each([1, 3, 5])("accepts a prerequisite minLevel of %p", (minLevel) => {
    expect(ok(SkillNode, node({ prerequisites: [{ skill: "ball-control", minLevel }] }))).toBe(true);
  });

  test.each([0, 6])("rejects a prerequisite minLevel of %p (outside 1 to 5)", (minLevel) => {
    expect(ok(SkillNode, node({ prerequisites: [{ skill: "ball-control", minLevel }] }))).toBe(false);
  });

  test("rejects a fractional prerequisite minLevel", () => {
    expect(ok(SkillNode, node({ prerequisites: [{ skill: "ball-control", minLevel: 1.5 }] }))).toBe(false);
  });

  test("a prerequisite needs a skill", () => {
    expect(ok(SkillNode, node({ prerequisites: [{ minLevel: 1 }] }))).toBe(false);
  });

  test("a prerequisite needs a minLevel", () => {
    expect(ok(SkillNode, node({ prerequisites: [{ skill: "ball-control" }] }))).toBe(false);
  });

  test("prerequisites may be empty (a root skill)", () => {
    expect(ok(SkillNode, node({ prerequisites: [] }))).toBe(true);
  });

  test("a level descriptor must be a LocalizedText with usable text", () => {
    expect(ok(SkillNode, node({ levels: [{ en: "   " }] }))).toBe(false);
  });

  test("age bounds are not capped to the player range (5 to 99)", () => {
    expect(ok(SkillNode, node({ ageMin: 0, ageMax: 120 }))).toBe(true);
  });

  test("ageMin must not be negative", () => {
    expect(ok(SkillNode, node({ ageMin: -1 }))).toBe(false);
  });

  test("ageMax must not be negative", () => {
    expect(ok(SkillNode, node({ ageMax: -1 }))).toBe(false);
  });

  test("ageMin must be an integer", () => {
    expect(ok(SkillNode, node({ ageMin: 7.5 }))).toBe(false);
  });

  test("equipment is a primitives Equipment value", () => {
    expect(ok(SkillNode, node({ equipment: "markers" }))).toBe(false);
  });

  test.each(["safety", "outcomes", "mistakes"])("%s is a list of LocalizedText, not of strings", (key) => {
    expect(ok(SkillNode, node({ [key]: ["plain text"] }))).toBe(false);
  });

  test.each(["safety", "outcomes", "mistakes"])("%s may be empty", (key) => {
    expect(ok(SkillNode, node({ [key]: [] }))).toBe(true);
  });
});

describe("SkillGraph", () => {
  test("parses a graph with a root and a child", () => {
    expect(SkillGraph.parse(graph()).nodes).toHaveLength(2);
  });

  test.each(["sport", "version", "nodes"])("rejects a graph missing %s", (key) => {
    expect(ok(SkillGraph, without(graph(), key))).toBe(false);
  });

  test("an empty node list is a valid graph", () => {
    expect(ok(SkillGraph, graph([]))).toBe(true);
  });

  test("an empty version is rejected", () => {
    expect(ok(SkillGraph, { ...graph(), version: "" })).toBe(false);
  });

  test("a node inside the graph is validated as a SkillNode", () => {
    expect(ok(SkillGraph, graph([node({ ageMin: -1 })]))).toBe(false);
  });

  test("a PARTIAL graph (a node whose parent is absent) still parses: integrity is graphProblems' job", () => {
    const partial = graph([node({ parent: "ghost" })]);
    expect(ok(SkillGraph, partial)).toBe(true);
    expect(graphProblems(SkillGraph.parse(partial))).not.toEqual([]);
  });

  test("the wire schema does not reject duplicate slugs", () => {
    expect(ok(SkillGraph, graph([rootNode(), rootNode()]))).toBe(true);
  });

  test("the wire schema does not reject a cycle", () => {
    const cyclic = graph([node({ slug: "a", parent: "b" }), node({ slug: "b", parent: "a" })]);
    expect(ok(SkillGraph, cyclic)).toBe(true);
  });
});

describe("graphProblems", () => {
  test("a well-formed graph has no problems", () => {
    expect(graphProblems(SkillGraph.parse(graph()))).toEqual([]);
  });

  test("an empty graph has no problems", () => {
    expect(graphProblems(SkillGraph.parse(graph([])))).toEqual([]);
  });

  test("a root, a child and a grandchild are fine", () => {
    expect(graphProblems(graphOf(["a", null], ["b", "a"], ["c", "b"]))).toEqual([]);
  });

  test("a diamond of prerequisites is not a cycle", () => {
    const diamond = graphOf(["a", null], ["b", "a", ["a"]], ["c", "a", ["a"]], ["d", "a", ["b", "c"]]);
    expect(graphProblems(diamond)).toEqual([]);
  });

  test("a prerequisite may point at an ancestor without being a cycle", () => {
    expect(graphProblems(graphOf(["a", null], ["b", "a", ["a"]]))).toEqual([]);
  });

  test("reports a duplicate slug once, naming it", () => {
    const problems = graphProblems(graphOf(["a", null], ["b", "a"], ["b", "a"]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("b");
  });

  test("reports a parent that is not in the graph, naming both slugs", () => {
    const problems = graphProblems(graphOf(["a", null], ["b", "ghost"]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ghost");
    expect(problems[0]).toContain("b");
  });

  test("reports a prerequisite that is not in the graph, naming both slugs", () => {
    const problems = graphProblems(graphOf(["a", null], ["b", "a", ["ghost"]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ghost");
    expect(problems[0]).toContain("b");
  });

  test("reports a node that is its own parent as one cycle", () => {
    const problems = graphProblems(graphOf(["a", "a"]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a");
  });

  test("reports a two-node parent cycle once, naming both nodes", () => {
    const problems = graphProblems(graphOf(["a", "b"], ["b", "a"]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a");
    expect(problems[0]).toContain("b");
  });

  test("reports a three-node parent cycle once, even with a tail hanging off it", () => {
    const problems = graphProblems(graphOf(["a", "c"], ["b", "a"], ["c", "b"], ["tail", "a"]));
    expect(problems).toHaveLength(1);
    for (const slug of ["a", "b", "c"]) expect(problems[0]).toContain(slug);
  });

  test("reports a node that is its own prerequisite as one cycle", () => {
    const problems = graphProblems(graphOf(["a", null, ["a"]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a");
  });

  test("reports a two-node prerequisite cycle once, naming both nodes", () => {
    const problems = graphProblems(graphOf(["a", null, ["b"]], ["b", null, ["a"]]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a");
    expect(problems[0]).toContain("b");
  });

  test("reports a longer prerequisite cycle once", () => {
    const problems = graphProblems(graphOf(["a", null, ["c"]], ["b", null, ["a"]], ["c", null, ["b"]]));
    expect(problems).toHaveLength(1);
    for (const slug of ["a", "b", "c"]) expect(problems[0]).toContain(slug);
  });

  test("reports each independent violation separately", () => {
    const problems = graphProblems(graphOf(["a", "ghost"], ["b", null, ["ghost2"]]));
    expect(problems).toHaveLength(2);
  });

  test("does not change its input", () => {
    const parsed = graphOf(["a", "b"], ["b", "a"]);
    const before = structuredClone(parsed);
    graphProblems(parsed);
    expect(parsed).toEqual(before);
  });
});

describe("SkillTest (re-exported from ./domain)", () => {
  test("is the very same schema object as domain's, not a second definition", () => {
    expect(Object.is(SkillTest, domain.SkillTest)).toBe(true);
  });

  test("parses a realistic test", () => {
    expect(SkillTest.parse(skillTest()).direction).toBe("higher");
  });

  test("direction is higher or lower only", () => {
    expect(ok(SkillTest, { ...skillTest(), direction: "lower" })).toBe(true);
    expect(ok(SkillTest, { ...skillTest(), direction: "up" })).toBe(false);
  });
});

describe("Attribution (re-exported from ./domain)", () => {
  test("is the very same schema object as domain's", () => {
    expect(Object.is(Attribution, domain.Attribution)).toBe(true);
  });
});

describe("DrillSummary", () => {
  test("parses a realistic summary and keeps the listed fields", () => {
    expect(DrillSummary.parse(summary()) as unknown).toEqual(summary());
  });

  test.each([...Object.keys(summary())])("rejects a summary missing %s", (key) => {
    expect(ok(DrillSummary, without(summary(), key))).toBe(false);
  });

  test("carries a single `space`, not a list (the full list lives in content.conditions.spaces)", () => {
    expect(ok(DrillSummary, { ...summary(), space: ["yard"] })).toBe(false);
  });

  test("space is a primitives Space value", () => {
    expect(ok(DrillSummary, { ...summary(), space: "room" })).toBe(false);
  });

  test("level is a primitives ExperienceLevel value", () => {
    expect(ok(DrillSummary, { ...summary(), level: "expert" })).toBe(false);
  });

  test("equipment is a primitives Equipment value", () => {
    expect(ok(DrillSummary, { ...summary(), equipment: "markers" })).toBe(false);
  });

  test("status is a primitives TrustStatus value", () => {
    expect(ok(DrillSummary, { ...summary(), status: "VERIFIED" })).toBe(false);
    expect(ok(DrillSummary, { ...summary(), status: "ACADEMY_VERIFIED" })).toBe(true);
  });

  test("minutes is a positive integer, like the dose values in DrillContent", () => {
    expect(ok(DrillSummary, { ...summary(), minutes: 0 })).toBe(false);
    expect(ok(DrillSummary, { ...summary(), minutes: 7.5 })).toBe(false);
  });

  test("title is a LocalizedText: an empty one is rejected", () => {
    expect(ok(DrillSummary, { ...summary(), title: {} })).toBe(false);
  });

  test("versionId is an id string, not a number", () => {
    expect(ok(DrillSummary, { ...summary(), versionId: 12 })).toBe(false);
  });
});

describe("DrillDetail", () => {
  test("parses the current version with content, attribution, history and reviews", () => {
    const parsed = DrillDetail.parse(detail());
    expect(parsed.versionId).toBe("five-gate-slalom-v1");
    expect(parsed.content.dose.durationSec).toBe(60);
    expect(parsed.attribution.semver).toBe("1.0.0");
    expect(parsed.history[0]?.versionId).toBe("five-gate-slalom-v1");
    expect(parsed.reviews[0]?.to).toBe("REVIEWED");
  });

  test.each(["slug", "versionId", "content", "attribution", "history", "reviews"])("rejects a detail missing %s", (key) => {
    expect(ok(DrillDetail, without(detail(), key))).toBe(false);
  });

  test("history and reviews may be empty (a fresh drill)", () => {
    expect(ok(DrillDetail, { ...detail(), history: [], reviews: [] })).toBe(true);
  });

  test("content is primitives' DrillContent, reused as-is", () => {
    expect(Object.is(DrillDetail.shape.content, primitives.DrillContent)).toBe(true);
  });

  test("content inherits DrillContent's rules (a dose with no reps, sets or duration fails)", () => {
    expect(ok(DrillDetail, { ...detail(), content: { ...content(), dose: {} } })).toBe(false);
  });

  test("attribution is domain's Attribution, reused as-is", () => {
    expect(Object.is(DrillDetail.shape.attribution, domain.Attribution)).toBe(true);
  });

  test.each(["author", "source", "license", "createdAt", "semver"])("attribution needs %s", (key) => {
    expect(ok(DrillDetail, { ...detail(), attribution: without(attribution(), key) })).toBe(false);
  });

  test("attribution.sourceUrl is optional", () => {
    expect(ok(DrillDetail, { ...detail(), attribution: without(attribution(), "sourceUrl") })).toBe(true);
  });

  test("attribution.license is a known license id, with no silent default", () => {
    expect(ok(DrillDetail, { ...detail(), attribution: { ...attribution(), license: "MIT" } })).toBe(false);
    expect(ok(DrillDetail, { ...detail(), attribution: { ...attribution(), license: "CC0-1.0" } })).toBe(true);
  });

  test("attribution.semver must look like a semantic version", () => {
    expect(ok(DrillDetail, { ...detail(), attribution: { ...attribution(), semver: "1.0" } })).toBe(false);
    expect(ok(DrillDetail, { ...detail(), attribution: { ...attribution(), semver: "1.2.0-rc.1" } })).toBe(true);
  });

  test("attribution.createdAt must be a timestamp", () => {
    expect(ok(DrillDetail, { ...detail(), attribution: { ...attribution(), createdAt: "yesterday" } })).toBe(false);
  });

  test("attribution.sourceUrl must be http(s)", () => {
    expect(ok(DrillDetail, { ...detail(), attribution: { ...attribution(), sourceUrl: "ftp://x" } })).toBe(false);
  });

  test.each(["versionId", "semver", "createdAt"])("a history entry needs %s", (key) => {
    expect(ok(DrillDetail, { ...detail(), history: [without(historyEntry(), key)] })).toBe(false);
  });

  test("a history entry's note is optional", () => {
    expect(ok(DrillDetail, { ...detail(), history: [without(historyEntry(), "note")] })).toBe(true);
  });

  test("a history entry's semver must look like a semantic version", () => {
    expect(ok(DrillDetail, { ...detail(), history: [{ ...historyEntry(), semver: "one" }] })).toBe(false);
  });

  test("a history entry's createdAt must be a timestamp", () => {
    expect(ok(DrillDetail, { ...detail(), history: [{ ...historyEntry(), createdAt: "2026-09-01" }] })).toBe(false);
  });

  test.each(["reviewer", "orgLabel", "from", "to", "note", "at"])("a review needs %s", (key) => {
    expect(ok(DrillDetail, { ...detail(), reviews: [without(review(), key)] })).toBe(false);
  });

  test("a review's orgLabel may be an empty string", () => {
    expect(ok(DrillDetail, { ...detail(), reviews: [{ ...review(), orgLabel: "" }] })).toBe(true);
  });

  test("a review's `at` must be a timestamp", () => {
    expect(ok(DrillDetail, { ...detail(), reviews: [{ ...review(), at: "01.09.2026" }] })).toBe(false);
  });

  test("a review's `from` is a TrustStatus", () => {
    expect(ok(DrillDetail, { ...detail(), reviews: [{ ...review(), from: "GOLD" }] })).toBe(false);
  });

  test("a review's `to` is a TrustStatus", () => {
    expect(ok(DrillDetail, { ...detail(), reviews: [{ ...review(), to: "GOLD" }] })).toBe(false);
  });
});

describe("DrillListResponse", () => {
  test("parses a page with facets, so the library needs no second enum call", () => {
    const parsed = DrillListResponse.parse(list());
    expect(parsed.items[0]?.slug).toBe("five-gate-slalom");
    expect(parsed.facets.skills[0]).toEqual({ slug: "dribbling", names: { en: "Dribbling" }, count: 3 });
    expect(parsed.facets.statuses).toHaveLength(2);
    expect(parsed.nextCursor).toBeNull();
  });

  test("keeps the paginated() envelope: a cursor string and an optional total", () => {
    expect(ok(DrillListResponse, { ...list(), nextCursor: "abc", total: 40 })).toBe(true);
  });

  test("the paginated() envelope requires nextCursor", () => {
    expect(ok(DrillListResponse, without(list(), "nextCursor"))).toBe(false);
  });

  test("an empty page is valid", () => {
    expect(ok(DrillListResponse, { ...list(), items: [] })).toBe(true);
  });

  test.each(["items", "facets"])("rejects a response missing %s", (key) => {
    expect(ok(DrillListResponse, without(list(), key))).toBe(false);
  });

  test.each(["skills", "statuses", "equipment", "levels"])("rejects facets missing %s", (key) => {
    expect(ok(DrillListResponse, { ...list(), facets: without(facets(), key) })).toBe(false);
  });

  test("items are DrillSummary rows", () => {
    expect(ok(DrillListResponse, { ...list(), items: [without(summary(), "versionId")] })).toBe(false);
  });

  test("a skill facet's localized names are optional", () => {
    const skills = [{ slug: "dribbling", count: 3 }];
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), skills } })).toBe(true);
  });

  test("a skill facet's names, when present, must be a LocalizedText", () => {
    const skills = [{ slug: "dribbling", names: {}, count: 3 }];
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), skills } })).toBe(false);
  });

  test("a skill facet needs a slug", () => {
    const skills = [{ names: { en: "Dribbling" }, count: 3 }];
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), skills } })).toBe(false);
  });

  test("a skill facet needs a count", () => {
    const skills = [{ slug: "dribbling", names: { en: "Dribbling" } }];
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), skills } })).toBe(false);
  });

  test("a skill facet's count is a non-negative integer", () => {
    const negative = [{ slug: "dribbling", count: -1 }];
    const fractional = [{ slug: "dribbling", count: 1.5 }];
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), skills: negative } })).toBe(false);
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), skills: fractional } })).toBe(false);
  });

  test.each(["statuses", "equipment", "levels"])("a %s facet needs a count", (key) => {
    const entries = [{ value: key === "statuses" ? "COMMUNITY" : key === "equipment" ? "cones" : "beginner" }];
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), [key]: entries } })).toBe(false);
  });

  test.each(["statuses", "equipment", "levels"])("a %s facet needs a value", (key) => {
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), [key]: [{ count: 1 }] } })).toBe(false);
  });

  test("a status facet value is checked against TrustStatus", () => {
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), statuses: [{ value: "GOLD", count: 1 }] } })).toBe(false);
  });

  test("an equipment facet value is checked against Equipment", () => {
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), equipment: [{ value: "markers", count: 1 }] } })).toBe(false);
  });

  test("a level facet value is checked against ExperienceLevel", () => {
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), levels: [{ value: "expert", count: 1 }] } })).toBe(false);
  });

  test("a level facet's count is a non-negative integer", () => {
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), levels: [{ value: "beginner", count: -1 }] } })).toBe(false);
  });

  test("a status facet's count is a non-negative integer", () => {
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), statuses: [{ value: "COMMUNITY", count: -1 }] } })).toBe(false);
  });

  test("an equipment facet's count is a non-negative integer", () => {
    expect(ok(DrillListResponse, { ...list(), facets: { ...facets(), equipment: [{ value: "cones", count: 0.5 }] } })).toBe(false);
  });
});

describe("DrillListQuery (derived from the library consumer; not pinned beyond these cases)", () => {
  test("accepts an empty query and a filtered one, coercing limit from its string form", () => {
    expect(DrillListQuery.parse({})).toEqual({});
    expect(DrillListQuery.parse({ skill: "dribbling", status: "REVIEWED", locale: "kk", limit: "20" })).toEqual({
      skill: "dribbling",
      status: "REVIEWED",
      locale: "kk",
      limit: 20,
    });
  });

  test("rejects a filter of the wrong type", () => {
    expect(ok(DrillListQuery, { status: "gold" })).toBe(false);
  });
});

describe("CommonsExport", () => {
  test("parses a full export with a graph, tests and drills", () => {
    const parsed = CommonsExport.parse(exported());
    expect(parsed.sports[0]?.slug).toBe("football");
    expect(parsed.sports[0]?.drills[0]?.attribution.license).toBe("CC-BY-SA-4.0");
    expect(parsed.sports[0]?.graph.nodes).toHaveLength(2);
    expect(parsed.sports[0]?.tests[0]?.slug).toBe("juggling-max-touches");
  });

  test("keeps the snake_case keys of the published format", () => {
    expect(Object.keys(CommonsExport.parse(exported())).sort()).toEqual(
      ["attribution_notice", "generated_at", "license", "schema_version", "sports"].sort(),
    );
  });

  test.each(["schema_version", "license", "attribution_notice", "generated_at", "sports"])("rejects an export missing %s", (key) => {
    expect(ok(CommonsExport, without(exported(), key))).toBe(false);
  });

  test("camelCase generatedAt does not stand in for generated_at", () => {
    const { generated_at, ...rest } = exported();
    expect(ok(CommonsExport, { ...rest, generatedAt: generated_at })).toBe(false);
  });

  test("schema_version must look like a semantic version", () => {
    expect(ok(CommonsExport, { ...exported(), schema_version: "v1" })).toBe(false);
  });

  test("license must be a known id", () => {
    expect(ok(CommonsExport, { ...exported(), license: "MIT" })).toBe(false);
  });

  test("license has no silent default", () => {
    expect(ok(CommonsExport, without(exported(), "license"))).toBe(false);
  });

  test("generated_at must be a timestamp", () => {
    expect(ok(CommonsExport, { ...exported(), generated_at: "today" })).toBe(false);
  });

  test("attribution_notice must not be blank (a blank notice defeats the licence)", () => {
    expect(ok(CommonsExport, { ...exported(), attribution_notice: "" })).toBe(false);
  });

  test("an export can be empty of sports", () => {
    expect(ok(CommonsExport, { ...exported(), sports: [] })).toBe(true);
  });

  test.each(["slug", "name", "graph", "tests", "drills"])("a sport needs %s", (key) => {
    expect(ok(CommonsExport, { ...exported(), sports: [without(sport(), key)] })).toBe(false);
  });

  test("a sport's name is a LocalizedText", () => {
    expect(ok(CommonsExport, { ...exported(), sports: [{ ...sport(), name: {} }] })).toBe(false);
  });

  test("a drill inside the export is validated as a DrillDetail", () => {
    const sports = [{ ...sport(), drills: [{ ...detail(), reviews: [{ nope: 1 }] }] }];
    expect(ok(CommonsExport, { ...exported(), sports })).toBe(false);
  });

  test("a test inside the export is validated as a SkillTest", () => {
    const sports = [{ ...sport(), tests: [{ ...skillTest(), direction: "up" }] }];
    expect(ok(CommonsExport, { ...exported(), sports })).toBe(false);
  });

  test("the graph inside the export is validated as a SkillGraph", () => {
    const sports = [{ ...sport(), graph: without(graph(), "version") }];
    expect(ok(CommonsExport, { ...exported(), sports })).toBe(false);
  });

  test("a partial graph is a valid export graph (integrity is graphProblems' job)", () => {
    const sports = [{ ...sport(), graph: graph([node({ parent: "ghost" })]) }];
    expect(ok(CommonsExport, { ...exported(), sports })).toBe(true);
  });
});

describe("responses ignore fields the server adds later", () => {
  const cases: Array<[string, z.ZodType, unknown]> = [
    ["SkillNode", SkillNode, node()],
    ["SkillGraph", SkillGraph, graph()],
    ["DrillSummary", DrillSummary, summary()],
    ["DrillDetail", DrillDetail, detail()],
    ["DrillListResponse", DrillListResponse, list()],
    ["CommonsExport", CommonsExport, exported()],
  ];

  test.each(cases)("%s strips an unknown top-level key without failing", (_name, schema, payload) => {
    const parsed = schema.parse({ ...(payload as object), addedLater: 1 });
    expect(parsed).not.toHaveProperty("addedLater");
  });

  test("nested review, history, facet and sport objects strip unknown keys too", () => {
    const parsed = CommonsExport.parse({
      ...exported(),
      sports: [
        {
          ...sport(),
          addedLater: 1,
          drills: [{ ...detail(), reviews: [{ ...review(), addedLater: 1 }], history: [{ ...historyEntry(), addedLater: 1 }] }],
        },
      ],
    });
    expect(parsed.sports[0]).not.toHaveProperty("addedLater");
    expect(parsed.sports[0]?.drills[0]?.reviews[0]).not.toHaveProperty("addedLater");
    expect(parsed.sports[0]?.drills[0]?.history[0]).not.toHaveProperty("addedLater");
    const page = DrillListResponse.parse({ ...list(), facets: { ...facets(), addedLater: [] } });
    expect(page.facets).not.toHaveProperty("addedLater");
  });
});

describe("ENDPOINTS", () => {
  test("every endpoint is a public GET", () => {
    for (const endpoint of Object.values(ENDPOINTS)) {
      expect(endpoint.method).toBe("GET");
      expect(endpoint.public).toBe(true);
    }
  });

  test("listDrills returns a DrillListResponse for a DrillListQuery", () => {
    expect(ENDPOINTS.listDrills.response).toBe(DrillListResponse);
    expect(ENDPOINTS.listDrills.query).toBe(DrillListQuery);
  });

  test("listDrills accepts the optional ?locale", () => {
    expect(ok(ENDPOINTS.listDrills.query, { locale: "kk" })).toBe(true);
    expect(ok(ENDPOINTS.listDrills.query, { locale: "de" })).toBe(false);
  });

  test("getDrill returns a DrillDetail", () => {
    expect(ENDPOINTS.getDrill.response).toBe(DrillDetail);
  });

  test("every :param in the getDrill path has a params key, and the slug is required", () => {
    const names = [...ENDPOINTS.getDrill.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    expect(names).toEqual(Object.keys(ENDPOINTS.getDrill.params.shape));
    expect(ok(ENDPOINTS.getDrill.params, { slug: "five-gate-slalom" })).toBe(true);
    expect(ok(ENDPOINTS.getDrill.params, {})).toBe(false);
  });

  test("getDrill accepts the optional ?locale", () => {
    expect(ok(ENDPOINTS.getDrill.query, {})).toBe(true);
    expect(ok(ENDPOINTS.getDrill.query, { locale: "ru" })).toBe(true);
    expect(ok(ENDPOINTS.getDrill.query, { locale: "de" })).toBe(false);
  });

  test("the export is served at /api/commons/export.json as application/json", () => {
    expect(ENDPOINTS.export).toMatchObject({
      method: "GET",
      path: "/api/commons/export.json",
      contentType: "application/json",
    });
    expect(ENDPOINTS.export.response).toBe(CommonsExport);
  });

  test("the slice exposes no graph endpoint (the graph travels inside the export)", () => {
    expect(Object.keys(ENDPOINTS).filter((name) => /graph/i.test(name))).toEqual([]);
  });
});

describe("web-bundle safety", () => {
  test("commons.ts imports only zod, ./primitives and ./domain", () => {
    const source = readFileSync(join(import.meta.dir, "commons.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/^\s*import\s+(["'])([^"']+)\1/gm),
      ...source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(["zod", "./primitives", "./domain"]).toContain(specifier);
  });
});
