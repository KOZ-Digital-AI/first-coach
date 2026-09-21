// Seed content test for config/commons/football/drills/passing-first-touch.json (fc-mol-f2u.8).
//
// The file is AUTHORED content: the founding drill set of the Passing / first touch track,
// every text in Kazakh, Russian and English. These tests check the shape the criteria fix
// (schema, counts, ranges, three locales everywhere, coverage of equipment/space/age, links
// between drills) plus language and consistency heuristics. They do NOT pin drill titles or
// slugs beyond the `passing-` prefix, so a reviewer may rewrite wording without touching them.
//
// What the seed schema (apps/api/src/commons/seed-schema.ts) does and does not carry:
//   - A drill has NO per-drill skill field and NO status field. The skill a drill trains is the
//     file's `track` slug (the loader maps every drill to it as the primary skill), and the
//     loader stamps every new drill COMMUNITY. So "skill slugs exist" is asserted on `track`,
//     and the status criterion is met by the loader default; the strict schema would reject a
//     stray `status` key, which the schema test covers.
//   - `instructions` is ONE text per locale: the numbered steps live inside it, one per line.
//   - Progression and regression are lists of drill slugs, resolved by the seeding job.
//
// Source of the content requirements: the spec in the repo's `message (7).txt` (sections 2, 8,
// 16), PRODUCT.md (children from about 6, Kazakh first among equals, safety) and
// CONTENT-LICENSE.md (original wording only).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateGraph } from "../../src/commons/graph";
import { SeedDrillTrackFile, SeedSkillGraphFile } from "../../src/commons/seed-schema";
import type { SeedDrill } from "../../src/commons/seed-schema";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DRILLS_PATH = join(ROOT, "config", "commons", "football", "drills", "passing-first-touch.json");
const GRAPH_PATH = join(ROOT, "config", "commons", "football", "skill-graph.json");

const TRACK = "passing-first-touch";
const SLUG_PREFIX = "passing-";
const LOCALES = ["kk", "ru", "en"] as const;
const AGE_MIN_BOUND = 5;
const AGE_MAX_BOUND = 99;

// Letters that exist in Kazakh but not in Russian.
const KAZAKH_ONLY = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;
const CYRILLIC = /[Ѐ-ӿ]/;

async function loadRaw(): Promise<unknown> {
  return JSON.parse(await Bun.file(DRILLS_PATH).text());
}

async function loadDrills(): Promise<SeedDrill[]> {
  const parsed = SeedDrillTrackFile.safeParse(await loadRaw());
  if (!parsed.success) throw new Error(`schema invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data.drills;
}

async function loadGraphNodes() {
  const parsed = SeedSkillGraphFile.safeParse(JSON.parse(await Bun.file(GRAPH_PATH).text()));
  if (!parsed.success) throw new Error("skill-graph.json does not parse");
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

/** The English text of every text object of a drill (title, goal, instructions, mistakes, safety). */
const englishOf = (drill: SeedDrill): string =>
  [drill.title, drill.goal, drill.instructions, ...(drill.mistakes ?? []), ...(drill.safety ?? [])]
    .map((text) => text.en)
    .join("\n");

const stepsOf = (instructions: string): string[] => instructions.split("\n");

const isBallOnlySmall = (drill: SeedDrill): boolean =>
  drill.equipment === "ball" && drill.space === "home_3x3" && drill.ageMin <= 7 && drill.partner !== true;

describe("passing-first-touch.json: schema and identity", () => {
  test("the file exists and is valid JSON", async () => {
    expect(await Bun.file(DRILLS_PATH).exists()).toBe(true);
    expect(await loadRaw()).toBeObject();
  });

  test("parses with SeedDrillTrackFile for the football sport and the passing-first-touch track", async () => {
    const parsed = SeedDrillTrackFile.safeParse(await loadRaw());
    if (!parsed.success) console.error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sport).toBe("football");
      expect(parsed.data.track).toBe(TRACK);
    }
  });

  test("holds exactly 12 drills", async () => {
    expect(await loadDrills()).toHaveLength(12);
  });

  test("the track skill exists in skill-graph.json as a top-level track and has sub-skills", async () => {
    const nodes = await loadGraphNodes();
    const track = nodes.find((node) => node.slug === TRACK);
    expect(track, `${TRACK} is in the graph`).toBeDefined();
    expect(track!.parent).toBeNull();
    expect(nodes.filter((node) => node.parent === TRACK).length).toBeGreaterThan(0);
  });

  test("every slug starts with `passing-`, is unique, and is not the slug of a skill node", async () => {
    const drills = await loadDrills();
    const skillSlugs = new Set((await loadGraphNodes()).map((node) => node.slug));
    expect(new Set(drills.map((drill) => drill.slug)).size).toBe(drills.length);
    for (const drill of drills) {
      expect(drill.slug.startsWith(SLUG_PREFIX), `${drill.slug} needs the ${SLUG_PREFIX} prefix`).toBe(true);
      expect(skillSlugs.has(drill.slug), `${drill.slug} is also a skill slug`).toBe(false);
    }
  });

  test("licence, author, source and semver are the founding-draft attribution", async () => {
    for (const drill of await loadDrills()) {
      expect(drill.license, drill.slug).toBe("CC-BY-SA-4.0");
      expect(drill.author, drill.slug).toBe("FIRST COACH Genesis");
      expect(drill.source, drill.slug).toBe("FIRST COACH Community Draft");
      expect(drill.semver, drill.slug).toBe("1.0.0");
    }
  });

  test("the file does not carry a trust status (the loader makes every new drill COMMUNITY)", async () => {
    const raw = (await loadRaw()) as { drills: Record<string, unknown>[] };
    for (const drill of raw.drills) expect("status" in drill, String(drill.slug)).toBe(false);
  });
});

describe("passing-first-touch.json: ranges and coverage", () => {
  test("every drill lasts 3-8 minutes and has a level from 1 to 3", async () => {
    for (const drill of await loadDrills()) {
      expect(drill.minutes, `${drill.slug} minutes`).toBeGreaterThanOrEqual(3);
      expect(drill.minutes, `${drill.slug} minutes`).toBeLessThanOrEqual(8);
      expect([1, 2, 3], `${drill.slug} level`).toContain(drill.level);
    }
  });

  test("every level 1, 2 and 3 has at least 3 drills", async () => {
    const drills = await loadDrills();
    for (const level of [1, 2, 3]) {
      expect(drills.filter((drill) => drill.level === level).length, `drills of level ${level}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("age ranges sit within the product bounds and suit children", async () => {
    for (const drill of await loadDrills()) {
      expect(drill.ageMin, drill.slug).toBeGreaterThanOrEqual(AGE_MIN_BOUND);
      expect(drill.ageMax, drill.slug).toBeLessThanOrEqual(AGE_MAX_BOUND);
      expect(drill.ageMin, drill.slug).toBeLessThanOrEqual(drill.ageMax);
      expect(drill.ageMin, `${drill.slug} is aimed at children`).toBeLessThanOrEqual(10);
    }
  });

  test("at least 4 drills need only a ball, fit 3x3 m, suit age 7 and need neither wall nor partner", async () => {
    expect((await loadDrills()).filter(isBallOnlySmall).length).toBeGreaterThanOrEqual(4);
  });

  test("every ball-only drill of the track is a self-passing pattern: no wall, no partner", async () => {
    for (const drill of (await loadDrills()).filter((each) => each.equipment === "ball" && each.partner !== true)) {
      expect(/\b(wall|partner|friend|teammate|cones?|markers?)\b/i.test(englishOf(drill)), drill.slug).toBe(false);
    }
  });

  test("at least 1 drill needs no equipment at all", async () => {
    expect((await loadDrills()).filter((drill) => drill.equipment === "nothing").length).toBeGreaterThanOrEqual(1);
  });

  test("at least 4 drills use ball_wall, outdoors or in a hall, never in the 3x3 m room", async () => {
    const wall = (await loadDrills()).filter((drill) => drill.equipment === "ball_wall");
    expect(wall.length).toBeGreaterThanOrEqual(4);
    for (const drill of wall) expect(drill.space, drill.slug).not.toBe("home_3x3");
  });

  test("the wall, partner and cone words in the texts agree with the equipment and the partner flag", async () => {
    for (const drill of await loadDrills()) {
      const words = englishOf(drill);
      if (/\bwall\b/i.test(words)) expect(drill.equipment, `${drill.slug} mentions a wall`).toBe("ball_wall");
      if (drill.equipment === "ball_wall") expect(/\bwall\b/i.test(words), `${drill.slug} needs a wall`).toBe(true);
      if (/\b(partner|friend|teammate)\b/i.test(drill.instructions.en)) {
        expect(drill.partner, `${drill.slug} mentions a partner`).toBe(true);
      }
      if (drill.partner === true) {
        expect(/\b(partner|friend|teammate)\b/i.test(drill.instructions.en), `${drill.slug} needs a partner`).toBe(true);
      }
      if (/\b(cones?|markers?)\b/i.test(words)) {
        expect(["cones", "full_field"], `${drill.slug} mentions cones`).toContain(drill.equipment);
      }
    }
  });

  test("the drill without equipment does not mention a wall, cones or a partner", async () => {
    for (const drill of (await loadDrills()).filter((each) => each.equipment === "nothing")) {
      expect(/\b(wall|partner|friend|cones?|markers?)\b/i.test(englishOf(drill)), drill.slug).toBe(false);
      expect(drill.partner === true, drill.slug).toBe(false);
    }
  });
});

describe("passing-first-touch.json: every drill carries the full content", () => {
  test("the dose gives reps or a duration, and a timed dose fits into the minutes", async () => {
    for (const drill of await loadDrills()) {
      const { reps, durationSec, sets } = drill.dose;
      expect(reps !== undefined || durationSec !== undefined, `${drill.slug} dose`).toBe(true);
      if (durationSec !== undefined) {
        expect(durationSec * (sets ?? 1), `${drill.slug} dose exceeds its minutes`).toBeLessThanOrEqual(drill.minutes * 60);
      }
    }
  });

  test("the instructions are 3-8 numbered steps, one per line, the same number in every language", async () => {
    for (const drill of await loadDrills()) {
      const counts = LOCALES.map((locale) => {
        const steps = stepsOf(drill.instructions[locale]);
        steps.forEach((step, index) => {
          expect(step, `${drill.slug}.${locale} step ${index + 1}`).toMatch(new RegExp(`^${index + 1}\\. \\S`));
          expect(step.length, `${drill.slug}.${locale} step ${index + 1} is too long`).toBeLessThanOrEqual(220);
        });
        return steps.length;
      });
      expect(counts[0], `${drill.slug} steps`).toBeGreaterThanOrEqual(3);
      expect(counts[0], `${drill.slug} steps`).toBeLessThanOrEqual(8);
      expect(new Set(counts).size, `${drill.slug} step counts per language: ${counts.join("/")}`).toBe(1);
    }
  });

  test("every drill lists at least two common mistakes and at least one safety note", async () => {
    for (const drill of await loadDrills()) {
      expect((drill.mistakes ?? []).length, `${drill.slug} mistakes`).toBeGreaterThanOrEqual(2);
      expect((drill.safety ?? []).length, `${drill.slug} safety`).toBeGreaterThanOrEqual(1);
    }
  });

  test("titles, mistakes and safety notes are unique: no boilerplate copied onto every drill", async () => {
    const drills = await loadDrills();
    const lower = (texts: { en: string }[]) => texts.map((text) => text.en.toLowerCase());
    const titles = lower(drills.map((drill) => drill.title));
    expect(new Set(titles).size).toBe(titles.length);
    const mistakes = drills.flatMap((drill) => lower(drill.mistakes ?? []));
    expect(new Set(mistakes).size).toBe(mistakes.length);
    const safety = drills.flatMap((drill) => lower(drill.safety ?? []));
    expect(new Set(safety).size).toBe(safety.length);
  });

  test("a wall drill's safety says: soft ball, no windows, warm up first", async () => {
    for (const drill of (await loadDrills()).filter((each) => each.equipment === "ball_wall")) {
      const safety = (drill.safety ?? []).map((text) => text.en.toLowerCase()).join(" ");
      expect(safety, `${drill.slug} safety mentions windows`).toMatch(/window/);
      expect(safety, `${drill.slug} safety asks for a soft or gentle ball`).toMatch(/soft|gentl/);
      expect(safety, `${drill.slug} safety asks for a warm-up`).toMatch(/warm/);
    }
  });
});

describe("passing-first-touch.json: progression and regression", () => {
  test("every link is a drill of this file, never the drill itself, never repeated", async () => {
    const drills = await loadDrills();
    const slugs = new Set(drills.map((drill) => drill.slug));
    for (const drill of drills) {
      for (const list of [drill.progressionSlugs ?? [], drill.regressionSlugs ?? []]) {
        expect(new Set(list).size, `${drill.slug} repeats a link`).toBe(list.length);
        for (const target of list) {
          expect(target, `${drill.slug} links to itself`).not.toBe(drill.slug);
          expect(slugs.has(target), `${drill.slug} links to unknown drill ${target}`).toBe(true);
        }
      }
      const both = [...(drill.progressionSlugs ?? []), ...(drill.regressionSlugs ?? [])];
      expect(new Set(both).size, `${drill.slug} is both a progression and a regression`).toBe(both.length);
    }
  });

  test("validateGraph reports no dangling progression or regression", async () => {
    const drills = await loadDrills();
    const report = validateGraph(
      await loadGraphNodes(),
      drills.map((drill) => ({
        slug: drill.slug,
        skill: TRACK,
        progression: drill.progressionSlugs,
        regression: drill.regressionSlugs,
      })),
    );
    if (!report.ok) console.error(JSON.stringify(report.problems, null, 2));
    expect(report.problems).toEqual([]);
  });

  test("a progression is never easier and a regression never harder than the drill", async () => {
    const drills = await loadDrills();
    const levelOf = new Map(drills.map((drill) => [drill.slug, drill.level] as const));
    for (const drill of drills) {
      for (const target of drill.progressionSlugs ?? []) {
        expect(levelOf.get(target)!, `${drill.slug} -> ${target}`).toBeGreaterThanOrEqual(drill.level);
      }
      for (const target of drill.regressionSlugs ?? []) {
        expect(levelOf.get(target)!, `${drill.slug} -> ${target}`).toBeLessThanOrEqual(drill.level);
      }
    }
  });

  test("every drill has a way to make it harder or easier: level 1 can progress, level 3 can regress, level 2 both", async () => {
    for (const drill of await loadDrills()) {
      const up = (drill.progressionSlugs ?? []).length;
      const down = (drill.regressionSlugs ?? []).length;
      expect(up + down, `${drill.slug} has neither progression nor regression`).toBeGreaterThan(0);
      if (drill.level === 1) expect(up, `${drill.slug} progression`).toBeGreaterThan(0);
      if (drill.level === 2) expect(up > 0 && down > 0, `${drill.slug} needs both`).toBe(true);
      if (drill.level === 3) expect(down, `${drill.slug} regression`).toBeGreaterThan(0);
    }
  });
});

describe("passing-first-touch.json: three locales everywhere", () => {
  test("every text object anywhere in the file has kk, ru and en, non-blank and nothing else", async () => {
    const raw = await loadRaw();
    const leaves = textLeaves(raw);
    const drills = await loadDrills();
    // Not vacuous: every drill contributes its title, goal, instructions, two mistakes and a note.
    expect(leaves.length).toBeGreaterThanOrEqual(drills.length * 6);
    for (const { path, text } of leaves) {
      expect(Object.keys(text).sort(), path).toEqual([...LOCALES].sort());
      for (const locale of LOCALES) {
        const value = text[locale];
        expect(typeof value, `${path}.${locale}`).toBe("string");
        expect((value as string).trim(), `${path}.${locale}`).not.toBe("");
        expect(value, `${path}.${locale} has stray whitespace`).toBe((value as string).trim());
        expect(value as string, `${path}.${locale} has a double space`).not.toContain("  ");
        expect(value as string, `${path}.${locale} has an empty line`).not.toContain("\n\n");
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
      const isInstructions = path.endsWith(".instructions");
      for (const locale of LOCALES) {
        const value = text[locale] as string;
        expect(value.length, `${path}.${locale} is too long`).toBeLessThanOrEqual(isInstructions ? 900 : 240);
        expect(/todo|tbd|lorem|xxx|\?\?\?/i.test(value), `${path}.${locale} looks like a placeholder`).toBe(false);
      }
    }
  });
});
