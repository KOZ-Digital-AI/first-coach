// Seed content test for config/commons/football/drills/ball-mastery.json (fc-mol-f2u.6).
//
// The file is AUTHORED content: the founding drill set of the Ball mastery track, twelve drills,
// every text in Kazakh, Russian and English. These tests check the shape the criteria fix
// (schema, count, three locales everywhere, coverage numbers, attribution, references) and a few
// language, safety and consistency heuristics. They do NOT pin drill names, wording or any count
// beyond the criteria.
//
// What the seed schema cannot carry (see SeedDrillBase): a per-drill skill list (the drill's skill
// is the file's `track`), a trust status (the seed loader stamps COMMUNITY on new drills),
// numbered instruction steps (one text whose lines are numbered) and free-text progression /
// regression (they are drill slugs, so they must resolve within the drills the seed loader sees).
//
// Source of the content requirements: the spec sections 13, 15 and 16 in the repo's
// `message (7).txt`, PRODUCT.md (children from about 6, Kazakh first among equals, safe
// unsupervised) and CONTENT-LICENSE.md (original wording only).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateGraph } from "../../src/commons/graph";
import { SLUG_PATTERN, SeedDrillTrackFile, SeedSkillGraphFile } from "../../src/commons/seed-schema";
import type { SeedDrill } from "../../src/commons/seed-schema";
import { AGE_MAX, AGE_MIN } from "../../src/shared/domain";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DRILLS_PATH = join(ROOT, "config", "commons", "football", "drills", "ball-mastery.json");
const GRAPH_PATH = join(ROOT, "config", "commons", "football", "skill-graph.json");

const TRACK = "ball-mastery";
const SLUG_PREFIX = "ball-mastery-";
const LOCALES = ["kk", "ru", "en"] as const;

// Letters that exist in Kazakh but not in Russian.
const KAZAKH_ONLY = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;
const CYRILLIC = /[Ѐ-ӿ]/;

async function loadRaw(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

async function loadDrills(): Promise<SeedDrill[]> {
  const parsed = SeedDrillTrackFile.safeParse(await loadRaw(DRILLS_PATH));
  if (!parsed.success) throw new Error(`schema invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data.drills;
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

type Text = Record<(typeof LOCALES)[number], string>;

/** The numbered lines of an instruction text, e.g. ["1. Stand tall.", "2. Tap the ball."]. */
const stepsOf = (instructions: string): string[] => instructions.split("\n");

/** Every progression and regression link of the file as [from, to, kind]. */
const linksOf = (drills: SeedDrill[]) =>
  drills.flatMap((drill) => [
    ...(drill.progressionSlugs ?? []).map((to) => [drill.slug, to, "progression"] as const),
    ...(drill.regressionSlugs ?? []).map((to) => [drill.slug, to, "regression"] as const),
  ]);

describe("ball-mastery.json: schema and identity", () => {
  test("the file exists and is valid JSON", async () => {
    expect(await Bun.file(DRILLS_PATH).exists()).toBe(true);
    expect(await loadRaw(DRILLS_PATH)).toBeObject();
  });

  test("parses with SeedDrillTrackFile for the football sport and the ball-mastery track", async () => {
    const parsed = SeedDrillTrackFile.safeParse(await loadRaw(DRILLS_PATH));
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

  test("every slug is kebab-case, starts with ball-mastery- and is unique", async () => {
    const drills = await loadDrills();
    for (const drill of drills) {
      expect(drill.slug, drill.slug).toMatch(SLUG_PATTERN);
      expect(drill.slug.startsWith(SLUG_PREFIX), `${drill.slug} needs the ${SLUG_PREFIX} prefix`).toBe(true);
      expect(drill.slug.length, `${drill.slug} has nothing after the prefix`).toBeGreaterThan(SLUG_PREFIX.length);
    }
    expect(new Set(drills.map((drill) => drill.slug)).size).toBe(drills.length);
  });

  test("licence, author, source and semver are those of the founding set", async () => {
    for (const drill of await loadDrills()) {
      expect(drill.license, drill.slug).toBe("CC-BY-SA-4.0");
      expect(drill.author, drill.slug).toBe("FIRST COACH Genesis");
      expect(drill.source, drill.slug).toBe("FIRST COACH Community Draft");
      expect(drill.semver, drill.slug).toBe("1.0.0");
    }
  });
});

describe("ball-mastery.json: skill and graph integrity", () => {
  test("the track is a top-level skill of skill-graph.json", async () => {
    const graph = SeedSkillGraphFile.parse(await loadRaw(GRAPH_PATH));
    const track = graph.nodes.find((node) => node.slug === TRACK);
    expect(track, `skill ${TRACK}`).toBeDefined();
    expect(track!.parent).toBeNull();
  });

  test("validateGraph finds no dangling skill, progression or regression in the file", async () => {
    const graph = SeedSkillGraphFile.parse(await loadRaw(GRAPH_PATH));
    const drills = (await loadDrills()).map((drill) => ({
      slug: drill.slug,
      skill: TRACK,
      progression: drill.progressionSlugs,
      regression: drill.regressionSlugs,
    }));
    const report = validateGraph(graph.nodes, drills);
    if (!report.ok) console.error(JSON.stringify(report.problems, null, 2));
    expect(report.problems).toEqual([]);
  });
});

describe("ball-mastery.json: progression and regression", () => {
  test("every drill links to at least one other drill of the file, never to itself or twice to the same one", async () => {
    const drills = await loadDrills();
    const slugs = new Set(drills.map((drill) => drill.slug));
    for (const drill of drills) {
      const targets = [...(drill.progressionSlugs ?? []), ...(drill.regressionSlugs ?? [])];
      expect(targets.length, `${drill.slug} has no progression or regression`).toBeGreaterThanOrEqual(1);
      expect(new Set(targets).size, `${drill.slug} lists a drill twice`).toBe(targets.length);
      for (const target of targets) {
        expect(target, `${drill.slug} points at itself`).not.toBe(drill.slug);
        expect(slugs.has(target), `${drill.slug} points at unknown drill ${target}`).toBe(true);
      }
    }
  });

  test("a progression never leads to an easier drill and a regression never to a harder one", async () => {
    const drills = await loadDrills();
    const level = new Map(drills.map((drill) => [drill.slug, drill.level] as const));
    for (const [from, to, kind] of linksOf(drills)) {
      if (kind === "progression") expect(level.get(to)!, `${from} -> ${to}`).toBeGreaterThanOrEqual(level.get(from)!);
      else expect(level.get(to)!, `${from} -> ${to}`).toBeLessThanOrEqual(level.get(from)!);
    }
  });

  test("progressions form no loop, so a child always has a next step or an end", async () => {
    const drills = await loadDrills();
    const next = new Map(drills.map((drill) => [drill.slug, drill.progressionSlugs ?? []] as const));
    const state = new Map<string, "open" | "done">();
    const visit = (slug: string, trail: string[]): void => {
      if (state.get(slug) === "done") return;
      expect(state.get(slug), `progression loop: ${[...trail, slug].join(" -> ")}`).not.toBe("open");
      state.set(slug, "open");
      for (const target of next.get(slug) ?? []) visit(target, [...trail, slug]);
      state.set(slug, "done");
    };
    for (const drill of drills) visit(drill.slug, []);
  });

  test("a progression and the matching regression agree: if A progresses to B then B regresses to A", async () => {
    const drills = await loadDrills();
    const by = new Map(drills.map((drill) => [drill.slug, drill] as const));
    for (const [from, to, kind] of linksOf(drills)) {
      const back = kind === "progression" ? by.get(to)!.regressionSlugs : by.get(to)!.progressionSlugs;
      expect(back ?? [], `${from} ${kind} -> ${to} has no way back`).toContain(from);
    }
  });
});

describe("ball-mastery.json: ranges and coverage", () => {
  test("level is 1-3, minutes 3-8, ages inside the schema bounds", async () => {
    for (const drill of await loadDrills()) {
      expect([1, 2, 3], `${drill.slug} level`).toContain(drill.level);
      expect(drill.minutes, `${drill.slug} minutes`).toBeGreaterThanOrEqual(3);
      expect(drill.minutes, `${drill.slug} minutes`).toBeLessThanOrEqual(8);
      expect(drill.ageMin, `${drill.slug} ageMin`).toBeGreaterThanOrEqual(AGE_MIN);
      expect(drill.ageMax, `${drill.slug} ageMax`).toBeLessThanOrEqual(AGE_MAX);
      expect(drill.ageMin, `${drill.slug} ages`).toBeLessThanOrEqual(drill.ageMax);
    }
  });

  test("every level 1-3 has at least three drills", async () => {
    const drills = await loadDrills();
    for (const level of [1, 2, 3]) {
      expect(drills.filter((drill) => drill.level === level).length, `level ${level}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("at least four drills need only a ball, fit a 3x3 m space and start at age 7 or younger", async () => {
    const fits = (await loadDrills()).filter(
      (drill) => drill.equipment === "ball" && drill.space === "home_3x3" && drill.ageMin <= 7,
    );
    expect(fits.length).toBeGreaterThanOrEqual(4);
  });

  test("at least one drill needs no equipment", async () => {
    expect((await loadDrills()).filter((drill) => drill.equipment === "nothing").length).toBeGreaterThanOrEqual(1);
  });

  test("every drill states its partner flag explicitly", async () => {
    for (const drill of await loadDrills()) expect(typeof drill.partner, drill.slug).toBe("boolean");
  });

  test("the dose is reps or a duration that fits the drill's minutes", async () => {
    for (const drill of await loadDrills()) {
      const { reps, durationSec } = drill.dose;
      expect(reps !== undefined || durationSec !== undefined, `${drill.slug} needs reps or durationSec`).toBe(true);
      if (durationSec !== undefined) expect(durationSec, `${drill.slug} durationSec`).toBeLessThanOrEqual(drill.minutes * 60);
    }
  });

  test("equipment, space and partner stay consistent with what the texts mention", async () => {
    for (const drill of await loadDrills()) {
      const words = [drill.title, drill.goal, drill.instructions, ...(drill.mistakes ?? []), ...(drill.safety ?? [])]
        .map((text) => text.en.toLowerCase())
        .join(" ");
      if (/\bwall\b/.test(words)) expect(["ball_wall", "full_field"], `${drill.slug} mentions a wall`).toContain(drill.equipment);
      if (/\b(cones?|markers?)\b/.test(words)) expect(["cones", "full_field"], `${drill.slug} mentions cones`).toContain(drill.equipment);
      if (drill.equipment === "nothing") expect(/\b(cones?|markers?|wall)\b/.test(words), `${drill.slug} needs nothing`).toBe(false);
      if (drill.partner === true) expect(/\b(partner|friend|parent)\b/.test(words), `${drill.slug} names no partner`).toBe(true);
      if (drill.partner === false) expect(/\bpartner\b/.test(words), `${drill.slug} mentions a partner`).toBe(false);
    }
  });
});

describe("ball-mastery.json: the content each drill carries", () => {
  test("every drill has a title, goal, numbered instructions, mistakes, safety, progression and regression", async () => {
    const raw = (await loadRaw(DRILLS_PATH)) as { drills: Record<string, unknown>[] };
    for (const drill of raw.drills) {
      for (const key of ["title", "goal", "instructions"]) expect(isText(drill[key]), `${drill.slug} ${key}`).toBe(true);
      for (const key of ["mistakes", "safety"]) {
        expect(Array.isArray(drill[key]), `${drill.slug} ${key}`).toBe(true);
        expect((drill[key] as unknown[]).length, `${drill.slug} ${key}`).toBeGreaterThanOrEqual(1);
      }
    }
    const drills = await loadDrills();
    expect(drills.filter((drill) => (drill.progressionSlugs ?? []).length > 0).length).toBeGreaterThanOrEqual(1);
    expect(drills.filter((drill) => (drill.regressionSlugs ?? []).length > 0).length).toBeGreaterThanOrEqual(1);
  });

  test("instructions are numbered steps 1, 2, 3 ... one per line, in every language", async () => {
    for (const drill of await loadDrills()) {
      for (const locale of LOCALES) {
        const steps = stepsOf(drill.instructions[locale]);
        expect(steps.length, `${drill.slug}.${locale} steps`).toBeGreaterThanOrEqual(3);
        expect(steps.length, `${drill.slug}.${locale} steps`).toBeLessThanOrEqual(6);
        steps.forEach((step, index) => {
          expect(step.startsWith(`${index + 1}. `), `${drill.slug}.${locale} step ${index + 1}: ${step}`).toBe(true);
          expect(step.slice(3).trim().length, `${drill.slug}.${locale} step ${index + 1} is empty`).toBeGreaterThan(5);
        });
      }
      expect(stepsOf(drill.instructions.kk).length, `${drill.slug} kk/en step count`).toBe(stepsOf(drill.instructions.en).length);
      expect(stepsOf(drill.instructions.ru).length, `${drill.slug} ru/en step count`).toBe(stepsOf(drill.instructions.en).length);
    }
  });

  test("every drill has at least two mistakes and two safety notes", async () => {
    for (const drill of await loadDrills()) {
      expect((drill.mistakes ?? []).length, `${drill.slug} mistakes`).toBeGreaterThanOrEqual(2);
      expect((drill.safety ?? []).length, `${drill.slug} safety`).toBeGreaterThanOrEqual(2);
    }
  });

  test("titles, goals, mistakes and safety notes are unique across the file, not one line copied onto every drill", async () => {
    const drills = await loadDrills();
    const unique = (label: string, values: string[]) =>
      expect(new Set(values.map((value) => value.toLowerCase())).size, label).toBe(values.length);
    unique("titles", drills.map((drill) => drill.title.en));
    unique("goals", drills.map((drill) => drill.goal.en));
    unique("mistakes", drills.flatMap((drill) => (drill.mistakes ?? []).map((text) => text.en)));
    unique("safety notes", drills.flatMap((drill) => (drill.safety ?? []).map((text) => text.en)));
  });

  test("safe unsupervised: every drill carries a warm-up cue and nothing asks for heading or hard shots", async () => {
    for (const drill of await loadDrills()) {
      const safety = (drill.safety ?? []).map((text) => text.en).join(" ");
      expect(/warm|loosen|shake|stretch/i.test(safety), `${drill.slug} has no warm-up cue`).toBe(true);
      const all = [drill.title, drill.goal, drill.instructions, ...(drill.mistakes ?? []), ...(drill.safety ?? [])]
        .map((text) => text.en)
        .join(" ");
      expect(/\bheading\b|\bheaders?\b|\bbicycle kick\b|\bslide tackle\b|\bkick (it )?(as )?hard\b|\bblast\b/i.test(all), `${drill.slug} asks for something unsafe`).toBe(false);
    }
  });
});

describe("ball-mastery.json: three locales everywhere", () => {
  test("every text object anywhere in the file has kk, ru and en, non-blank and nothing else", async () => {
    const raw = await loadRaw(DRILLS_PATH);
    const leaves = textLeaves(raw);
    const drills = await loadDrills();
    // Not vacuous: every drill contributes a title, goal, instructions, two mistakes and two notes.
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
    for (const { path, text } of textLeaves(await loadRaw(DRILLS_PATH))) {
      const { kk, ru, en } = text as Text;
      if (en.length <= 3) continue;
      expect(kk, `${path}: kk is a copy of en`).not.toBe(en);
      expect(ru, `${path}: ru is a copy of en`).not.toBe(en);
      expect(kk, `${path}: kk is a copy of ru`).not.toBe(ru);
    }
  });

  test("kk and ru are written in Cyrillic with no untranslated English words; en has no Cyrillic", async () => {
    for (const { path, text } of textLeaves(await loadRaw(DRILLS_PATH))) {
      const { kk, ru, en } = text as Text;
      expect(CYRILLIC.test(kk), `${path}.kk has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(ru), `${path}.ru has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(en), `${path}.en contains Cyrillic`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(kk), `${path}.kk has a Latin word: ${kk}`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(ru), `${path}.ru has a Latin word: ${ru}`).toBe(false);
    }
  });

  test("kk text carries Kazakh letters and ru text carries none", async () => {
    for (const { path, text } of textLeaves(await loadRaw(DRILLS_PATH))) {
      const { kk, ru } = text as Text;
      // A longer Kazakh sentence with none of ә ғ қ ң ө ұ ү һ і is almost surely Russian.
      if (kk.length >= 30) expect(KAZAKH_ONLY.test(kk), `${path}.kk has no Kazakh letter: ${kk}`).toBe(true);
      expect(KAZAKH_ONLY.test(ru), `${path}.ru has a Kazakh letter: ${ru}`).toBe(false);
    }
  });

  test("the graph's second-person 'you' form is kept: no formal Russian 'вы' and no Kazakh 'сіз' forms", async () => {
    for (const { path, text } of textLeaves(await loadRaw(DRILLS_PATH))) {
      const { kk, ru } = text as Text;
      expect(/(^|[^а-яё])(вы|вам|вас|ваш\p{L}*)(?![а-яё])/iu.test(ru), `${path}.ru uses the formal form: ${ru}`).toBe(false);
      expect(/(^|[^а-яәғқңөұүһі])(сіз\p{L}*)/iu.test(kk), `${path}.kk uses the formal form: ${kk}`).toBe(false);
      expect(/ыңыз|іңіз|ыңыздар|іңіздер/i.test(kk), `${path}.kk uses a formal ending: ${kk}`).toBe(false);
    }
  });

  test("texts are short enough for a child and carry no placeholder markers", async () => {
    for (const { path, text } of textLeaves(await loadRaw(DRILLS_PATH))) {
      for (const locale of LOCALES) {
        const value = text[locale] as string;
        // An instruction text is several numbered lines; every line, like any other text, stays short.
        for (const line of value.split("\n")) {
          expect(line.length, `${path}.${locale} is too long`).toBeLessThanOrEqual(240);
        }
        expect(/todo|tbd|lorem|xxx|\?\?\?/i.test(value), `${path}.${locale} looks like a placeholder`).toBe(false);
      }
    }
  });
});
