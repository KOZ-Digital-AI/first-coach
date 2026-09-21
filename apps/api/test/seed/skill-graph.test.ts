// Seed content test for config/commons/football/skill-graph.json (fc-mol-f2u.4).
//
// The file is AUTHORED content: five top-level tracks with 3-6 ordered sub-skill nodes each,
// every text in Kazakh, Russian and English. These tests check the shape the criteria fix
// (schema, integrity, ranges, three locales everywhere, ordering) and a few language and
// consistency heuristics. They do NOT pin node names or exact counts beyond the criteria's ranges.
//
// Source of the content requirements: the spec sections 3 and 15 in the repo's `message (7).txt`,
// PRODUCT.md (children from about 6, Kazakh first among equals, safety) and CONTENT-LICENSE.md
// (original wording only).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateGraph } from "../../src/commons/graph";
import { SeedSkillGraphFile } from "../../src/commons/seed-schema";
import type { SeedSkillNode } from "../../src/commons/seed-schema";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const GRAPH_PATH = join(ROOT, "config", "commons", "football", "skill-graph.json");

const TRACKS = ["ball-mastery", "dribbling", "passing-first-touch", "weak-foot", "juggling-coordination"];
const LOCALES = ["kk", "ru", "en"] as const;

// Letters that exist in Kazakh but not in Russian.
const KAZAKH_ONLY = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;
const CYRILLIC = /[Ѐ-ӿ]/;

async function loadRaw(): Promise<unknown> {
  return JSON.parse(await Bun.file(GRAPH_PATH).text());
}

async function loadNodes(): Promise<SeedSkillNode[]> {
  const parsed = SeedSkillGraphFile.safeParse(await loadRaw());
  if (!parsed.success) throw new Error(`schema invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data.nodes;
}

const isText = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  LOCALES.some((locale) => locale in (value as Record<string, unknown>));

/** Every text object (an object carrying any of kk/ru/en) with its JSON path, found generically. */
function textLeaves(value: unknown, path = "$"): { path: string; text: Record<string, unknown> }[] {
  if (isText(value)) return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => textLeaves(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => textLeaves(item, `${path}.${key}`));
  }
  return [];
}

/** Every text of a node, for the node-local property checks. */
const nodeTexts = (node: SeedSkillNode) => [
  node.names,
  ...node.levels,
  ...node.outcomes,
  ...node.mistakes,
  ...node.safety,
];

const tracksOf = (nodes: SeedSkillNode[]) => nodes.filter((node) => node.parent === null);
const subSkillsOf = (nodes: SeedSkillNode[]) => nodes.filter((node) => node.parent !== null);

describe("skill-graph.json: schema and graph integrity", () => {
  test("the file exists and is valid JSON", async () => {
    expect(await Bun.file(GRAPH_PATH).exists()).toBe(true);
    expect(await loadRaw()).toBeObject();
  });

  test("parses with SeedSkillGraphFile for the football sport", async () => {
    const parsed = SeedSkillGraphFile.safeParse(await loadRaw());
    if (!parsed.success) console.error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sport).toBe("football");
      expect(parsed.data.version.trim()).not.toBe("");
    }
  });

  test("validateGraph reports no problems and orders every node", async () => {
    const nodes = await loadNodes();
    const report = validateGraph(nodes, []);
    if (!report.ok) console.error(JSON.stringify(report.problems, null, 2));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.order).toHaveLength(nodes.length);
  });

  test("every slug is unique and no node lists itself as parent or prerequisite", async () => {
    const nodes = await loadNodes();
    expect(new Set(nodes.map((node) => node.slug)).size).toBe(nodes.length);
    for (const node of nodes) {
      expect(node.parent).not.toBe(node.slug);
      expect(node.prerequisites.map((each) => each.skill)).not.toContain(node.slug);
    }
  });
});

describe("skill-graph.json: tracks and sub-skills", () => {
  test("has exactly the five football tracks as the top-level nodes", async () => {
    const nodes = await loadNodes();
    expect(tracksOf(nodes).map((node) => node.slug).sort()).toEqual([...TRACKS].sort());
  });

  test("lists the tracks in the criteria order with increasing `order`", async () => {
    const tracks = tracksOf(await loadNodes());
    expect(tracks.map((node) => node.slug)).toEqual(TRACKS);
    for (let index = 1; index < tracks.length; index++) {
      expect(tracks[index]!.order).toBeGreaterThan(tracks[index - 1]!.order);
    }
  });

  test("has 15-30 sub-skill nodes in total", async () => {
    const count = subSkillsOf(await loadNodes()).length;
    expect(count).toBeGreaterThanOrEqual(15);
    expect(count).toBeLessThanOrEqual(30);
  });

  test("every track has 3-6 sub-skills and every sub-skill hangs directly under a track", async () => {
    const nodes = await loadNodes();
    for (const track of TRACKS) {
      const children = nodes.filter((node) => node.parent === track);
      expect(children.length, `sub-skills of ${track}`).toBeGreaterThanOrEqual(3);
      expect(children.length, `sub-skills of ${track}`).toBeLessThanOrEqual(6);
    }
    for (const node of subSkillsOf(nodes)) expect(TRACKS).toContain(node.parent as string);
  });

  test("sub-skills of a track are ordered: `order` strictly increases in file order", async () => {
    const nodes = await loadNodes();
    for (const track of TRACKS) {
      const children = nodes.filter((node) => node.parent === track);
      for (let index = 1; index < children.length; index++) {
        expect(children[index]!.order, `order in ${track}`).toBeGreaterThan(children[index - 1]!.order);
      }
    }
  });
});

describe("skill-graph.json: prerequisites", () => {
  test("a prerequisite always comes earlier in the file, so the graph reads bottom-up", async () => {
    const nodes = await loadNodes();
    const position = new Map(nodes.map((node, index) => [node.slug, index] as const));
    for (const node of nodes) {
      for (const prerequisite of node.prerequisites) {
        expect(position.get(prerequisite.skill), `${node.slug} needs ${prerequisite.skill}`).toBeDefined();
        expect(position.get(prerequisite.skill)!, `${node.slug} needs ${prerequisite.skill}`).toBeLessThan(
          position.get(node.slug)!,
        );
      }
    }
  });

  test("tracks have no prerequisites and no node requires a track", async () => {
    const nodes = await loadNodes();
    const trackSlugs = new Set(tracksOf(nodes).map((node) => node.slug));
    for (const node of nodes) {
      if (node.parent === null) expect(node.prerequisites).toEqual([]);
      for (const prerequisite of node.prerequisites) expect(trackSlugs.has(prerequisite.skill)).toBe(false);
    }
  });

  test("the first sub-skill of a track has no in-track prerequisite; every later one has one that is earlier in it", async () => {
    const nodes = await loadNodes();
    for (const track of TRACKS) {
      const children = nodes.filter((node) => node.parent === track);
      const inTrack = (node: SeedSkillNode) =>
        node.prerequisites.filter((each) => children.some((child) => child.slug === each.skill));
      expect(inTrack(children[0]!), `first sub-skill of ${track}`).toEqual([]);
      children.slice(1).forEach((child, index) => {
        const earlier = new Set(children.slice(0, index + 1).map((each) => each.slug));
        const required = inTrack(child);
        expect(required.length, `${child.slug} needs an in-track prerequisite`).toBeGreaterThan(0);
        for (const each of required) expect(earlier.has(each.skill), `${child.slug} needs ${each.skill}`).toBe(true);
      });
    }
  });

  test("cross-track prerequisites are few", async () => {
    const nodes = await loadNodes();
    const parentOf = new Map(nodes.map((node) => [node.slug, node.parent] as const));
    const cross = subSkillsOf(nodes).flatMap((node) =>
      node.prerequisites.filter((each) => parentOf.get(each.skill) !== node.parent),
    );
    expect(cross.length).toBeLessThanOrEqual(8);
  });

  test("the sub-skill age minimum never drops below that of its in-track prerequisites", async () => {
    const nodes = await loadNodes();
    const bySlug = new Map(nodes.map((node) => [node.slug, node] as const));
    for (const node of subSkillsOf(nodes)) {
      for (const prerequisite of node.prerequisites) {
        const required = bySlug.get(prerequisite.skill)!;
        expect(node.ageMin, `${node.slug} vs ${required.slug}`).toBeGreaterThanOrEqual(required.ageMin);
      }
    }
  });

  test("the first sub-skill of every track suits young children (ageMin <= 8)", async () => {
    const nodes = await loadNodes();
    for (const track of TRACKS) {
      expect(nodes.find((node) => node.parent === track)!.ageMin, track).toBeLessThanOrEqual(8);
    }
  });
});

describe("skill-graph.json: every node carries the full content", () => {
  test("every node has five levels and at least one outcome, mistake and safety note", async () => {
    for (const node of await loadNodes()) {
      expect(node.levels, `${node.slug} levels`).toHaveLength(5);
      expect(node.outcomes.length, `${node.slug} outcomes`).toBeGreaterThanOrEqual(1);
      expect(node.mistakes.length, `${node.slug} mistakes`).toBeGreaterThanOrEqual(1);
      expect(node.safety.length, `${node.slug} safety`).toBeGreaterThanOrEqual(1);
    }
  });

  test("the five level descriptions of a node are all different", async () => {
    for (const node of await loadNodes()) {
      expect(new Set(node.levels.map((text) => text.en)).size, `${node.slug} levels`).toBe(5);
    }
  });

  test("equipment stays consistent with what the texts mention", async () => {
    for (const node of await loadNodes()) {
      const words = nodeTexts(node)
        .map((text) => text.en.toLowerCase())
        .join(" ");
      if (/\bwall\b/.test(words)) {
        expect(["ball_wall", "full_field"], `${node.slug} mentions a wall`).toContain(node.equipment);
      }
      if (/\b(cones?|markers?)\b/.test(words)) {
        expect(["cones", "full_field"], `${node.slug} mentions cones`).toContain(node.equipment);
      }
    }
  });

  test("names are unique and every mistake is unique across the graph", async () => {
    const nodes = await loadNodes();
    const names = nodes.map((node) => node.names.en.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const mistakes = nodes.flatMap((node) => node.mistakes.map((text) => text.en.toLowerCase()));
    expect(new Set(mistakes).size).toBe(mistakes.length);
  });

  test("safety notes are varied, not one boilerplate line copied onto every node", async () => {
    const nodes = await loadNodes();
    const counts = new Map<string, number>();
    for (const node of nodes) {
      for (const text of new Set(node.safety.map((each) => each.en.toLowerCase()))) {
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    }
    expect(counts.size).toBeGreaterThanOrEqual(15);
    for (const [text, count] of counts) expect(count, text).toBeLessThanOrEqual(3);
  });
});

describe("skill-graph.json: three locales everywhere", () => {
  test("every text object anywhere in the file has kk, ru and en, non-blank and nothing else", async () => {
    const raw = await loadRaw();
    const leaves = textLeaves(raw);
    const nodes = await loadNodes();
    // Not vacuous: every node contributes at least its name, five levels, an outcome, a mistake and a note.
    expect(leaves.length).toBeGreaterThanOrEqual(nodes.length * 9);
    for (const { path, text } of leaves) {
      expect(Object.keys(text).sort(), path).toEqual([...LOCALES].sort());
      for (const locale of LOCALES) {
        const value = text[locale];
        expect(typeof value, `${path}.${locale}`).toBe("string");
        expect((value as string).trim(), `${path}.${locale}`).not.toBe("");
        expect(value, `${path}.${locale} has stray whitespace`).toBe((value as string).trim());
        expect(value as string, `${path}.${locale} has a double space`).not.toContain("  ");
      }
    }
  });

  test("kk and ru are real translations, not copies: they differ from en and from each other", async () => {
    for (const { path, text } of textLeaves(await loadRaw())) {
      const { kk, ru, en } = text as Record<(typeof LOCALES)[number], string>;
      if (en.length <= 3) continue;
      expect(kk, `${path}: kk is a copy of en`).not.toBe(en);
      expect(ru, `${path}: ru is a copy of en`).not.toBe(en);
      expect(kk, `${path}: kk is a copy of ru`).not.toBe(ru);
    }
  });

  test("kk and ru are written in Cyrillic with no untranslated English words; en has no Cyrillic", async () => {
    for (const { path, text } of textLeaves(await loadRaw())) {
      const { kk, ru, en } = text as Record<(typeof LOCALES)[number], string>;
      expect(CYRILLIC.test(kk), `${path}.kk has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(ru), `${path}.ru has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(en), `${path}.en contains Cyrillic`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(kk), `${path}.kk has a Latin word: ${kk}`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(ru), `${path}.ru has a Latin word: ${ru}`).toBe(false);
    }
  });

  test("kk text carries Kazakh letters and ru text carries none", async () => {
    for (const { path, text } of textLeaves(await loadRaw())) {
      const { kk, ru } = text as Record<(typeof LOCALES)[number], string>;
      // A longer Kazakh sentence with none of ә ғ қ ң ө ұ ү һ і is almost surely Russian.
      if (kk.length >= 30) expect(KAZAKH_ONLY.test(kk), `${path}.kk has no Kazakh letter: ${kk}`).toBe(true);
      expect(KAZAKH_ONLY.test(ru), `${path}.ru has a Kazakh letter: ${ru}`).toBe(false);
    }
  });

  test("texts are short enough for a child and carry no placeholder markers", async () => {
    for (const { path, text } of textLeaves(await loadRaw())) {
      for (const locale of LOCALES) {
        const value = text[locale] as string;
        expect(value.length, `${path}.${locale} is too long`).toBeLessThanOrEqual(240);
        expect(/todo|tbd|lorem|xxx|\?\?\?/i.test(value), `${path}.${locale} looks like a placeholder`).toBe(false);
      }
    }
  });
});
