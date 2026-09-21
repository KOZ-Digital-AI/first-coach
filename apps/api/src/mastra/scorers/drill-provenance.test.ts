// fc-mol-zo6.5: the drill-provenance scorer. Pure: no network, no key, no clock.
// A plan item that cannot be traced to an approved (published) drill version scores 0.
import { describe, expect, test } from "bun:test";
import { drillProvenance } from "./drill-provenance";

// The approved candidate set, in the shape listPublishedVersions returns (only the fields the scorer reads).
const KNOWN = [
  { versionId: "v-wall", slug: "wall-passes", content: { title: { en: "Wall passes", ru: "Передачи в стену", kk: "Қабырғаға берілістер" } } },
  { versionId: "v-cone", slug: "cone-weave", content: { title: { en: "Cone weave" } } },
  { versionId: "v-juggle", slug: "juggling-basics", content: {} },
];

const item = (drillVersionId: unknown, extra: Record<string, unknown> = {}) => ({
  drillVersionId,
  minutes: 8,
  reason: "Good for your ball control today.",
  ...extra,
});
const plan = (...items: unknown[]) => ({ items });
const kinds = (output: unknown): string[] => drillProvenance(output, KNOWN).flagged.map((flag) => flag.kind);

describe("drillProvenance: a grounded output", () => {
  test("every id is a known version -> score 1 and nothing flagged", () => {
    const result = drillProvenance(plan(item("v-wall"), item("v-cone"), item("v-juggle")), KNOWN);
    expect(result.score).toBe(1);
    expect(result.flagged).toEqual([]);
    expect(result.itemScores).toEqual([1, 1, 1]);
  });

  test("a title that belongs to the item's own drill is grounded, in any locale", () => {
    expect(drillProvenance(plan(item("v-wall", { title: "Wall passes" })), KNOWN).score).toBe(1);
    expect(drillProvenance(plan(item("v-wall", { title: "Передачи в стену" })), KNOWN).score).toBe(1);
    expect(drillProvenance(plan(item("v-wall", { title: "Қабырғаға берілістер" })), KNOWN).score).toBe(1);
  });

  test("title matching ignores case and surrounding or repeated whitespace", () => {
    expect(drillProvenance(plan(item("v-wall", { title: "  WALL   passes " })), KNOWN).score).toBe(1);
  });

  test("the slug counts as a name (the tools show it when a drill has no title)", () => {
    expect(drillProvenance(plan(item("v-juggle", { title: "juggling-basics" })), KNOWN).score).toBe(1);
  });

  test("the alternative title keys are checked too", () => {
    expect(drillProvenance(plan(item("v-wall", { drillTitle: "Wall passes" })), KNOWN).score).toBe(1);
    expect(drillProvenance(plan(item("v-wall", { drillTitle: "Dragon flip" })), KNOWN).score).toBe(0);
  });

  test("an absent or null title makes no claim", () => {
    expect(drillProvenance(plan(item("v-wall", { title: null }), item("v-cone", { title: undefined })), KNOWN).score).toBe(1);
  });

  test("known drills may be any iterable (a Set)", () => {
    expect(drillProvenance(plan(item("v-wall")), new Set(KNOWN)).score).toBe(1);
  });
});

describe("drillProvenance: an invented drill", () => {
  test("an invented drill id is flagged and the score is 0", () => {
    const result = drillProvenance(plan(item("v-wall"), item("v-dragon")), KNOWN);
    expect(result.score).toBe(0);
    expect(result.flagged).toEqual([{ kind: "drill_id", index: 1, value: "v-dragon" }]);
    expect(result.itemScores).toEqual([1, 0]);
  });

  test("an invented drill title on a real id is flagged", () => {
    const result = drillProvenance(plan(item("v-wall", { title: "Dragon flip" })), KNOWN);
    expect(result.score).toBe(0);
    expect(result.flagged).toEqual([{ kind: "drill_title", index: 0, value: "Dragon flip" }]);
    expect(result.itemScores).toEqual([0]);
  });

  test("the real title of a DIFFERENT known drill is still not this item's title", () => {
    expect(kinds(plan(item("v-wall", { title: "Cone weave" })))).toEqual(["drill_title"]);
  });

  test("a near-miss id is unknown (no fuzzy matching)", () => {
    expect(kinds(plan(item("V-WALL"), item("v-wall "), item("v-wal")))).toEqual(["drill_id", "drill_id", "drill_id"]);
  });

  test("object-prototype names are not known ids", () => {
    expect(kinds(plan(item("constructor"), item("__proto__"), item("toString")))).toEqual(["drill_id", "drill_id", "drill_id"]);
  });

  test("an unknown id is reported once: its title is not judged against a drill it does not have", () => {
    expect(kinds(plan(item("v-dragon", { title: "Dragon flip" })))).toEqual(["drill_id"]);
  });

  test("every bad item is flagged, with its own index; the good ones keep score 1", () => {
    const result = drillProvenance(plan(item("nope-1"), item("v-cone"), item("v-wall", { title: "Nope" }), item("nope-2")), KNOWN);
    expect(result.flagged.map((f) => [f.index, f.kind])).toEqual([
      [0, "drill_id"],
      [2, "drill_title"],
      [3, "drill_id"],
    ]);
    expect(result.itemScores).toEqual([0, 1, 0, 0]);
    expect(result.score).toBe(0);
  });
});

describe("drillProvenance: fails closed", () => {
  test("an item with no drillVersionId cannot be traced", () => {
    const result = drillProvenance(plan({ minutes: 8, reason: "x", title: "Wall passes" }), KNOWN);
    expect(result.score).toBe(0);
    // A missing id is an id that is not known: "drill_id". ("item" is for an item that is not an object.)
    expect(result.flagged.map((f) => f.kind)).toEqual(["drill_id"]);
  });

  test("a non-string id (number, null, object) cannot be traced", () => {
    for (const id of [7, null, undefined, {}, ["v-wall"], ""]) {
      expect(drillProvenance(plan(item(id)), KNOWN).score).toBe(0);
    }
  });

  test("an item that is not an object cannot be traced", () => {
    for (const bad of ["v-wall", 3, null, undefined, ["v-wall"]]) {
      const result = drillProvenance(plan(bad), KNOWN);
      expect(result.score).toBe(0);
      expect(result.itemScores).toEqual([0]);
      expect(result.flagged.map((f) => f.kind)).toEqual(["item"]);
    }
  });

  test("a title that is not a string is flagged", () => {
    expect(kinds(plan(item("v-wall", { title: 42 })))).toEqual(["drill_title"]);
  });

  test("output that is not a plan scores 0 with an output flag", () => {
    for (const bad of [undefined, null, "v-wall", 42, [], {}, { items: "v-wall" }, { items: null }, { plan: [item("v-wall")] }]) {
      const result = drillProvenance(bad, KNOWN);
      expect(result.score).toBe(0);
      expect(result.flagged.map((f) => f.kind)).toEqual(["output"]);
      expect(result.itemScores).toEqual([]);
    }
  });

  test("an empty plan proves nothing: score 0", () => {
    expect(drillProvenance(plan(), KNOWN).score).toBe(0);
  });

  test("with no known drills nothing can be grounded", () => {
    expect(drillProvenance(plan(item("v-wall")), []).score).toBe(0);
  });

  test("a known drill entry without a versionId grounds nothing", () => {
    const broken = [{ slug: "wall-passes", content: { title: { en: "Wall passes" } } }] as unknown as typeof KNOWN;
    expect(drillProvenance(plan(item(undefined, { title: "Wall passes" })), broken).score).toBe(0);
  });
});

describe("drillProvenance: a result fit for logging", () => {
  test("it is plain data: a JSON round trip changes nothing", () => {
    const result = drillProvenance(plan(item("v-wall"), item("v-dragon", { title: "x" })), KNOWN);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("it does not modify its inputs", () => {
    const output = plan(item("v-wall", { title: "Wall passes" }), item("v-dragon"));
    const outputBefore = structuredClone(output);
    const knownBefore = structuredClone(KNOWN);
    drillProvenance(output, KNOWN);
    expect(output).toEqual(outputBefore);
    expect(KNOWN).toEqual(knownBefore);
  });

  test("the same input always gives the same result", () => {
    const output = plan(item("v-wall"), item("v-dragon"));
    expect(drillProvenance(output, KNOWN)).toEqual(drillProvenance(output, KNOWN));
  });
});
