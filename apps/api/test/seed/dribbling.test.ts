// Seed content test for config/commons/football/drills/dribbling.json (fc-mol-f2u.7).
//
// The file is AUTHORED content: the founding drill set of the Dribbling track, every text in
// Kazakh, Russian and English. These tests check the shape the criteria fix (schema, count,
// three locales everywhere, coverage numbers, attribution) plus safety, language and consistency
// heuristics. They do NOT pin drill titles, ids beyond the prefix, or texts.
//
// What the seed schema (apps/api/src/commons/seed-schema.ts) carries, and what it does not:
//   - `track` is the drills' primary skill (the loader maps it to drill_skills). A drill has no
//     per-drill sub-skill field, so "every skill slug exists in skill-graph.json" is checked on
//     `track`, and through validateGraph on every drill's (skill, progression, regression).
//   - progression / regression are DRILL SLUGS (`progressionSlugs`, `regressionSlugs`), not text.
//   - "required conditions" are the structured `equipment`, `space`, `partner`, `ageMin/ageMax`.
//   - The schema carries no trust `status`: the loader starts every new drill as COMMUNITY, so
//     the status criterion cannot be asserted on the file.
//   - `instructions` is one text; the numbered steps are its lines ("1. ...\n2. ...").
//
// Source of the content requirements: the spec sections 13 and 16 in the repo's `message (7).txt`,
// PRODUCT.md (children from about 6, Kazakh first among equals), CONTENT-LICENSE.md (original
// wording only) and the clarifications of the bead (safe for unsupervised children).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateGraph } from "../../src/commons/graph";
import { SeedDrillTrackFile, SeedSkillGraphFile } from "../../src/commons/seed-schema";
import type { SeedDrill, SeedSkillNode } from "../../src/commons/seed-schema";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DRILLS_PATH = join(ROOT, "config", "commons", "football", "drills", "dribbling.json");
const GRAPH_PATH = join(ROOT, "config", "commons", "football", "skill-graph.json");

const TRACK = "dribbling";
const SLUG_PREFIX = "dribbling-";
const LOCALES = ["kk", "ru", "en"] as const;

// Letters that exist in Kazakh but not in Russian.
const KAZAKH_ONLY = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;
const CYRILLIC = /[Ѐ-ӿ]/;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

async function loadFile() {
  const raw = await readJson(DRILLS_PATH);
  const parsed = SeedDrillTrackFile.safeParse(raw);
  if (!parsed.success) throw new Error(`schema invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data;
}

async function loadDrills(): Promise<SeedDrill[]> {
  return (await loadFile()).drills;
}

async function loadGraphNodes(): Promise<SeedSkillNode[]> {
  const parsed = SeedSkillGraphFile.safeParse(await readJson(GRAPH_PATH));
  if (!parsed.success) throw new Error(`skill graph invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
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

/** All English text of a drill, lower-cased, for the consistency heuristics. */
const englishOf = (drill: SeedDrill): string =>
  [drill.title, drill.goal, drill.instructions, ...(drill.mistakes ?? []), ...(drill.safety ?? [])]
    .map((text) => text.en)
    .join(" ")
    .toLowerCase();

const linksOf = (drill: SeedDrill) => ({
  progression: drill.progressionSlugs ?? [],
  regression: drill.regressionSlugs ?? [],
});

describe("dribbling.json: schema, count and identity", () => {
  test("the file exists and is valid JSON", async () => {
    expect(await Bun.file(DRILLS_PATH).exists()).toBe(true);
    expect(await readJson(DRILLS_PATH)).toBeObject();
  });

  test("parses with SeedDrillTrackFile for the football sport and the dribbling track", async () => {
    const parsed = SeedDrillTrackFile.safeParse(await readJson(DRILLS_PATH));
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

  test("every slug starts with the track prefix, is unique, and is not also a skill slug", async () => {
    const drills = await loadDrills();
    const skillSlugs = new Set((await loadGraphNodes()).map((node) => node.slug));
    for (const drill of drills) {
      expect(drill.slug.startsWith(SLUG_PREFIX), `${drill.slug} lacks the ${SLUG_PREFIX} prefix`).toBe(true);
      expect(drill.slug.length, `${drill.slug} has nothing after the prefix`).toBeGreaterThan(SLUG_PREFIX.length);
      expect(skillSlugs.has(drill.slug), `${drill.slug} is also a skill slug`).toBe(false);
    }
    expect(new Set(drills.map((drill) => drill.slug)).size).toBe(drills.length);
  });

  test("licence, author, source and semver are exactly the founding values", async () => {
    for (const drill of await loadDrills()) {
      expect(drill.license, drill.slug).toBe("CC-BY-SA-4.0");
      expect(drill.author, drill.slug).toBe("FIRST COACH Genesis");
      expect(drill.source, drill.slug).toBe("FIRST COACH Community Draft");
      expect(drill.semver, drill.slug).toBe("1.0.0");
    }
  });
});

describe("dribbling.json: skills, progressions and regressions resolve", () => {
  test("the track is the dribbling track skill of the football graph", async () => {
    const file = await loadFile();
    const node = (await loadGraphNodes()).find((each) => each.slug === file.track);
    expect(node, `skill ${file.track}`).toBeDefined();
    expect(node!.parent, "a track node has no parent").toBeNull();
  });

  test("validateGraph finds no dangling skill, progression or regression for these drills", async () => {
    const file = await loadFile();
    const nodes = await loadGraphNodes();
    const report = validateGraph(
      nodes,
      file.drills.map((drill) => ({
        slug: drill.slug,
        skill: file.track,
        progression: drill.progressionSlugs,
        regression: drill.regressionSlugs,
      })),
    );
    if (!report.ok) console.error(JSON.stringify(report.problems, null, 2));
    expect(report.problems).toEqual([]);
  });

  test("no drill links to itself and every drill has a progression or a regression", async () => {
    for (const drill of await loadDrills()) {
      const { progression, regression } = linksOf(drill);
      expect(progression, `${drill.slug} progression`).not.toContain(drill.slug);
      expect(regression, `${drill.slug} regression`).not.toContain(drill.slug);
      expect(progression.length + regression.length, `${drill.slug} has no link`).toBeGreaterThan(0);
      expect(new Set(progression).size, `${drill.slug} repeats a progression`).toBe(progression.length);
      expect(new Set(regression).size, `${drill.slug} repeats a regression`).toBe(regression.length);
    }
  });

  test("a progression is never easier and a regression never harder than the drill itself", async () => {
    const drills = await loadDrills();
    const level = new Map(drills.map((drill) => [drill.slug, drill.level] as const));
    for (const drill of drills) {
      const { progression, regression } = linksOf(drill);
      for (const slug of progression) expect(level.get(slug)!, `${drill.slug} -> ${slug}`).toBeGreaterThanOrEqual(drill.level);
      for (const slug of regression) expect(level.get(slug)!, `${drill.slug} <- ${slug}`).toBeLessThanOrEqual(drill.level);
    }
  });

  test("progressions never loop back to an earlier drill", async () => {
    const drills = await loadDrills();
    const next = new Map(drills.map((drill) => [drill.slug, linksOf(drill).progression] as const));
    const state = new Map<string, "open" | "done">();
    const visit = (slug: string, trail: string[]): void => {
      if (state.get(slug) === "done") return;
      expect(state.get(slug), `progression loop: ${[...trail, slug].join(" -> ")}`).toBeUndefined();
      state.set(slug, "open");
      for (const target of next.get(slug) ?? []) visit(target, [...trail, slug]);
      state.set(slug, "done");
    };
    for (const drill of drills) visit(drill.slug, []);
  });
});

describe("dribbling.json: coverage", () => {
  test("every level 1-3 has at least three drills", async () => {
    const drills = await loadDrills();
    for (const level of [1, 2, 3]) {
      expect(drills.filter((drill) => drill.level === level).length, `drills of level ${level}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("every drill takes 3-8 minutes and its dose fits into that time", async () => {
    for (const drill of await loadDrills()) {
      expect(drill.minutes, drill.slug).toBeGreaterThanOrEqual(3);
      expect(drill.minutes, drill.slug).toBeLessThanOrEqual(8);
      const timed = (drill.dose.durationSec ?? 0) * (drill.dose.sets ?? 1);
      expect(timed, `${drill.slug} dose is longer than its minutes`).toBeLessThanOrEqual(drill.minutes * 60);
    }
  });

  test("at least four drills need only a ball, fit a 3x3 m space and start at age 7 or younger", async () => {
    const fitting = (await loadDrills()).filter(
      (drill) => drill.equipment === "ball" && drill.space === "home_3x3" && drill.ageMin <= 7,
    );
    expect(fitting.length).toBeGreaterThanOrEqual(4);
  });

  test("at least one drill needs no equipment, and its texts do not use a ball", async () => {
    const bare = (await loadDrills()).filter((drill) => drill.equipment === "nothing");
    expect(bare.length).toBeGreaterThanOrEqual(1);
    for (const drill of bare) expect(/\bball\b/.test(englishOf(drill)), `${drill.slug} mentions a ball`).toBe(false);
  });

  test("age ranges are sane and start no earlier than the track skill", async () => {
    const trackAge = (await loadGraphNodes()).find((node) => node.slug === TRACK)!.ageMin;
    for (const drill of await loadDrills()) {
      expect(drill.ageMin, drill.slug).toBeGreaterThanOrEqual(trackAge);
      expect(drill.ageMax, drill.slug).toBeGreaterThanOrEqual(drill.ageMin);
    }
  });

  test("equipment stays consistent with what the texts mention", async () => {
    for (const drill of await loadDrills()) {
      const words = englishOf(drill);
      if (/\b(cones?|markers?)\b/.test(words)) {
        expect(["cones", "full_field"], `${drill.slug} mentions cones`).toContain(drill.equipment);
      }
      if (/\bwall\b/.test(words)) {
        expect(["ball_wall", "full_field"], `${drill.slug} mentions a wall`).toContain(drill.equipment);
      }
    }
  });

  test("a partner drill is flagged as one and vice versa", async () => {
    for (const drill of await loadDrills()) {
      const mentionsPartner = /\b(partner|friend|parent)\b/.test(
        [drill.title, drill.goal, drill.instructions].map((text) => text.en).join(" ").toLowerCase(),
      );
      expect(drill.partner === true, `${drill.slug} partner flag vs text`).toBe(mentionsPartner);
    }
  });
});

describe("dribbling.json: every drill carries the full content", () => {
  test("every drill has at least two observable mistakes and at least two safety notes", async () => {
    for (const drill of await loadDrills()) {
      expect((drill.mistakes ?? []).length, `${drill.slug} mistakes`).toBeGreaterThanOrEqual(2);
      expect((drill.safety ?? []).length, `${drill.slug} safety`).toBeGreaterThanOrEqual(2);
    }
  });

  test("instructions are numbered steps, the same number of steps in every language", async () => {
    for (const drill of await loadDrills()) {
      const counts = LOCALES.map((locale) => {
        const lines = drill.instructions[locale].split("\n");
        lines.forEach((line, index) => {
          expect(line.startsWith(`${index + 1}. `), `${drill.slug}.${locale} step ${index + 1}: "${line}"`).toBe(true);
          expect(line.slice(`${index + 1}. `.length).trim(), `${drill.slug}.${locale} step ${index + 1} is empty`).not.toBe("");
        });
        return lines.length;
      });
      expect(counts[0], `${drill.slug} steps`).toBeGreaterThanOrEqual(3);
      expect(counts[0], `${drill.slug} steps`).toBeLessThanOrEqual(7);
      expect(counts, `${drill.slug} steps per language`).toEqual([counts[0], counts[0], counts[0]]);
    }
  });

  test("titles and mistakes are unique across the file", async () => {
    const drills = await loadDrills();
    for (const locale of LOCALES) {
      const titles = drills.map((drill) => drill.title[locale].toLowerCase());
      expect(new Set(titles).size, `${locale} titles`).toBe(titles.length);
    }
    const mistakes = drills.flatMap((drill) => (drill.mistakes ?? []).map((text) => text.en.toLowerCase()));
    expect(new Set(mistakes).size).toBe(mistakes.length);
  });
});

describe("dribbling.json: safe for unsupervised children", () => {
  test("safety notes are varied, never one boilerplate line copied onto several drills", async () => {
    const drills = await loadDrills();
    const notes = drills.flatMap((drill) => (drill.safety ?? []).map((text) => text.en.toLowerCase()));
    expect(new Set(notes).size, "every safety note is different").toBe(notes.length);
    for (const locale of LOCALES) {
      const local = drills.flatMap((drill) => (drill.safety ?? []).map((text) => text[locale].toLowerCase()));
      expect(new Set(local).size, `${locale} safety notes`).toBe(local.length);
    }
  });

  test("every drill has a warm-up cue among its safety notes", async () => {
    for (const drill of await loadDrills()) {
      const cue = (drill.safety ?? []).some((text) => /\bwarm/i.test(text.en));
      expect(cue, `${drill.slug} has no warm-up cue`).toBe(true);
    }
  });

  test("no heading, tackling or shooting anywhere", async () => {
    for (const drill of await loadDrills()) {
      const hit = /\b(heading|headers?|tackl\w*|shoot\w*|shots?|volleys?|bicycle|slide)\b/.exec(englishOf(drill));
      expect(hit?.[0], `${drill.slug} mentions a risky action`).toBeUndefined();
    }
  });

  test("a drill in more than 3x3 m says where to stop or stay, and a partner drill sets a distance", async () => {
    for (const drill of await loadDrills()) {
      const safety = (drill.safety ?? []).map((text) => text.en).join(" ").toLowerCase();
      if (drill.space !== "home_3x3") {
        expect(/\b(road|street|fence|wall|edge|boundary|line|area|square|lane|away|clear|flat)\b/.test(safety), `${drill.slug} names no boundary or hazard`).toBe(true);
      }
      if (drill.partner === true) {
        expect(/\b(metres?|meters?|apart|distance|still|stand)\b/.test(safety), `${drill.slug} sets no distance for the partner`).toBe(true);
      }
    }
  });
});

describe("dribbling.json: three locales everywhere", () => {
  test("every text object anywhere in the file has kk, ru and en, non-blank and nothing else", async () => {
    const raw = await readJson(DRILLS_PATH);
    const leaves = textLeaves(raw);
    const drills = await loadDrills();
    // Not vacuous: every drill contributes a title, goal, instructions, two mistakes and two safety notes.
    expect(leaves.length).toBeGreaterThanOrEqual(drills.length * 7);
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
    for (const { path, text } of textLeaves(await readJson(DRILLS_PATH))) {
      const { kk, ru, en } = text as Record<(typeof LOCALES)[number], string>;
      if (en.length <= 3) continue;
      expect(kk, `${path}: kk is a copy of en`).not.toBe(en);
      expect(ru, `${path}: ru is a copy of en`).not.toBe(en);
      expect(kk, `${path}: kk is a copy of ru`).not.toBe(ru);
    }
  });

  test("kk and ru are written in Cyrillic with no untranslated English words; en has no Cyrillic", async () => {
    for (const { path, text } of textLeaves(await readJson(DRILLS_PATH))) {
      const { kk, ru, en } = text as Record<(typeof LOCALES)[number], string>;
      expect(CYRILLIC.test(kk), `${path}.kk has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(ru), `${path}.ru has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(en), `${path}.en contains Cyrillic`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(kk), `${path}.kk has a Latin word: ${kk}`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(ru), `${path}.ru has a Latin word: ${ru}`).toBe(false);
    }
  });

  test("kk text carries Kazakh letters and ru text carries none", async () => {
    for (const { path, text } of textLeaves(await readJson(DRILLS_PATH))) {
      const { kk, ru } = text as Record<(typeof LOCALES)[number], string>;
      // A longer Kazakh sentence with none of ә ғ қ ң ө ұ ү һ і is almost surely Russian.
      if (kk.length >= 30) expect(KAZAKH_ONLY.test(kk), `${path}.kk has no Kazakh letter: ${kk}`).toBe(true);
      expect(KAZAKH_ONLY.test(ru), `${path}.ru has a Kazakh letter: ${ru}`).toBe(false);
    }
  });

  test("texts are short enough for a child and carry no placeholder markers", async () => {
    const raw = await readJson(DRILLS_PATH);
    for (const { path, text } of textLeaves(raw)) {
      // Instructions hold up to seven numbered steps in one text.
      const limit = path.endsWith(".instructions") ? 800 : 240;
      for (const locale of LOCALES) {
        const value = text[locale] as string;
        expect(value.length, `${path}.${locale} is too long`).toBeLessThanOrEqual(limit);
        expect(/todo|tbd|lorem|xxx|\?\?\?/i.test(value), `${path}.${locale} looks like a placeholder`).toBe(false);
      }
    }
  });
});
