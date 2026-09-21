import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { SKILL_LEVEL_MAX, SKILL_LEVEL_MIN } from "../shared/domain";
import { DrillContent, EQUIPMENT, LICENSE_IDS, LOCALES, SPACES } from "../shared/primitives";
import { SkillNode, SkillTest } from "../shared/commons";
import {
  SeedDrill,
  SeedDrillBase,
  SeedDrillTrackFile,
  SeedRubricsFile,
  SeedSkillGraphFile,
  SeedSkillNode,
  SeedSkillNodeBase,
  SeedTestsFile,
} from "./seed-schema";

type Path = (string | number)[];

/** The paths of every issue the schema reports, or null when the value parses. */
const issuePaths = (schema: z.ZodType, value: unknown): Path[] | null => {
  const result = schema.safeParse(value);
  return result.success ? null : result.error.issues.map((issue) => issue.path as Path);
};

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

/** A complete kk/ru/en text. */
const text = (kk: string, ru: string, en: string) => ({ kk, ru, en });

// Local factories: every call builds a fresh, valid payload so a case mutates ONE field.
const drill = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "wall-passes",
  title: text("Қабырғаға пас беру", "Пасы в стену", "Wall passes"),
  goal: text("Пас беру дәлдігі", "Точность паса", "Passing accuracy"),
  instructions: text(
    "Допты қабырғаға дәл соғып, қайтқан допты тоқтатпай қайта беріңіз.",
    "Бейте мяч в стену и возвращайте его без остановки.",
    "Strike the ball at the wall and return it first time.",
  ),
  dose: { reps: 20, sets: 3 },
  mistakes: [text("Тірек аяқ алыс тұр", "Опорная нога далеко", "Plant foot too far away")],
  safety: [text("Айналаңыз бос болсын", "Уберите людей с линии удара", "Keep the space clear")],
  progressionSlugs: ["wall-passes-weak-foot"],
  regressionSlugs: ["wall-passes-close"],
  minutes: 10,
  level: 1,
  ageMin: 7,
  ageMax: 16,
  equipment: "ball_wall",
  space: "yard",
  partner: false,
  license: "CC-BY-SA-4.0",
  author: "First Coach",
  source: "First Coach commons",
  sourceUrl: "https://example.org/drills/wall-passes",
  semver: "1.0.0",
  ...overrides,
});

const trackFile = (drills: unknown[] = [drill(), drill({ slug: "wall-passes-close" })]) => ({
  sport: "football",
  track: "passing",
  drills,
});

const node = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "juggling",
  parent: "ball-control" as string | null,
  order: 2,
  names: text("Допты ұстау", "Жонглирование", "Juggling"),
  levels: [text("Бір рет", "Один раз", "One touch"), text("Екі рет", "Два раза", "Two touches")],
  prerequisites: [{ skill: "ball-control", minLevel: 1 }],
  ageMin: 7,
  ageMax: 16,
  equipment: "ball",
  safety: [text("Айналаңыз бос болсын", "Свободное место вокруг", "Clear the space")],
  outcomes: [text("Он рет қатарынан", "Десять раз подряд", "Ten in a row")],
  mistakes: [text("Тым биік соғу", "Слишком высокий удар", "Kicking too high")],
  ...overrides,
});

const rootNode = () =>
  node({ slug: "ball-control", parent: null, order: 1, names: text("Допты бақылау", "Контроль мяча", "Ball control"), prerequisites: [] });

const graphFile = (nodes: unknown[] = [rootNode(), node()]) => ({ sport: "football", version: "0.1.0", nodes });

const skillTest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: "juggling-max",
  skill: "ball-control",
  metric: "consecutive touches",
  unit: "touches",
  direction: "higher",
  protocol: text("Допты жерге түсірмей ұстаңыз", "Не роняйте мяч на землю", "Keep the ball off the ground"),
  equipment: "ball",
  ...overrides,
});

const testsFile = (tests: unknown[] = [skillTest(), skillTest({ slug: "wall-passes-30s" })]) => ({
  sport: "football",
  tests,
});

const rubric = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  skill: "ball-control",
  level: 1,
  criteria: text("Допты екі рет ұстайды", "Удерживает мяч два раза", "Holds the ball twice"),
  ...overrides,
});

const rubricsFile = (rubrics: unknown[] = [rubric(), rubric({ level: 2 })]) => ({ sport: "football", rubrics });

describe("a valid sample passes", () => {
  test.each([
    ["skill-graph.json", SeedSkillGraphFile, graphFile()],
    ["tests.json", SeedTestsFile, testsFile()],
    ["drill track file", SeedDrillTrackFile, trackFile()],
    ["rubrics.json", SeedRubricsFile, rubricsFile()],
  ] as const)("%s", (_name, schema, sample) => {
    const result = (schema as z.ZodType).safeParse(sample);
    if (!result.success) throw new Error(JSON.stringify(result.error.issues));
    // Nothing is stripped or defaulted: the parsed data is the sample.
    expect(result.data).toEqual(sample);
  });

  test("a drill without any optional field passes", () => {
    let minimal = drill();
    for (const key of ["mistakes", "safety", "progressionSlugs", "regressionSlugs", "partner", "sourceUrl"]) {
      minimal = without(minimal, key);
    }
    expect(issuePaths(SeedDrillTrackFile, trackFile([minimal]))).toBeNull();
  });

  test("the bounds themselves are accepted: level 1 and 3, age 5 and 99, ageMin equal to ageMax", () => {
    for (const overrides of [{ level: 1 }, { level: 3 }, { ageMin: 5 }, { ageMax: 99 }, { ageMin: 12, ageMax: 12 }]) {
      expect(issuePaths(SeedDrillTrackFile, trackFile([drill(overrides)]))).toBeNull();
    }
  });
});

describe("three locales are required and non-empty on every LocalizedText", () => {
  const missingKk = (
    build: (broken: { ru: string; en: string }) => unknown,
    schema: z.ZodType,
    path: Path,
  ): [name: string, schema: z.ZodType, input: unknown, path: Path] => [
    path.join("."),
    schema,
    build({ ru: "Мәтін", en: "Text" }),
    [...path, "kk"],
  ];

  test.each([
    missingKk((t) => trackFile([drill({ title: t })]), SeedDrillTrackFile, ["drills", 0, "title"]),
    missingKk((t) => trackFile([drill({ goal: t })]), SeedDrillTrackFile, ["drills", 0, "goal"]),
    missingKk((t) => trackFile([drill({ instructions: t })]), SeedDrillTrackFile, ["drills", 0, "instructions"]),
    missingKk((t) => trackFile([drill({ mistakes: [t] })]), SeedDrillTrackFile, ["drills", 0, "mistakes", 0]),
    missingKk((t) => trackFile([drill({ safety: [t] })]), SeedDrillTrackFile, ["drills", 0, "safety", 0]),
    missingKk((t) => graphFile([node({ names: t })]), SeedSkillGraphFile, ["nodes", 0, "names"]),
    missingKk((t) => graphFile([node({ levels: [t] })]), SeedSkillGraphFile, ["nodes", 0, "levels", 0]),
    missingKk((t) => graphFile([node({ safety: [t] })]), SeedSkillGraphFile, ["nodes", 0, "safety", 0]),
    missingKk((t) => graphFile([node({ outcomes: [t] })]), SeedSkillGraphFile, ["nodes", 0, "outcomes", 0]),
    missingKk((t) => graphFile([node({ mistakes: [t] })]), SeedSkillGraphFile, ["nodes", 0, "mistakes", 0]),
    missingKk((t) => testsFile([skillTest({ protocol: t })]), SeedTestsFile, ["tests", 0, "protocol"]),
    missingKk((t) => rubricsFile([rubric({ criteria: t })]), SeedRubricsFile, ["rubrics", 0, "criteria"]),
  ])("a missing kk text fails at %s.kk", (_name, schema, input, path) => {
    expect(issuePaths(schema, input)).toEqual([path]);
  });

  test.each([...LOCALES])("a drill title missing %s fails at that locale", (locale) => {
    const title = without(text("Қабырға", "Стена", "Wall"), locale);
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ title })]))).toEqual([["drills", 0, "title", locale]]);
  });

  test.each([...LOCALES])("an empty %s string fails at that locale", (locale) => {
    const title = { ...text("Қабырға", "Стена", "Wall"), [locale]: "" };
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ title })]))).toEqual([["drills", 0, "title", locale]]);
  });

  test("a whitespace-only string counts as empty", () => {
    const title = { ...text("Қабырға", "Стена", "Wall"), ru: "   \n\t " };
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ title })]))).toEqual([["drills", 0, "title", "ru"]]);
  });
});

describe("drill numbers", () => {
  test("a duration of 0 minutes fails at minutes", () => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ minutes: 0 })]))).toEqual([["drills", 0, "minutes"]]);
  });

  test.each([0, 4])("level %d is outside 1-3 and fails at level", (level) => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ level })]))).toEqual([["drills", 0, "level"]]);
  });

  test("ageMin 4 is below 5 and fails at ageMin", () => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ ageMin: 4 })]))).toEqual([["drills", 0, "ageMin"]]);
  });

  test("ageMax 100 is above 99 and fails at ageMax", () => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ ageMax: 100 })]))).toEqual([["drills", 0, "ageMax"]]);
  });

  test("ageMin above ageMax fails at ageMax", () => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ ageMin: 30, ageMax: 20 })]))).toEqual([
      ["drills", 0, "ageMax"],
    ]);
  });
});

describe("skill node age range", () => {
  test("ageMin 4 fails at ageMin", () => {
    expect(issuePaths(SeedSkillGraphFile, graphFile([node({ ageMin: 4 })]))).toEqual([["nodes", 0, "ageMin"]]);
  });

  test("ageMax 100 fails at ageMax", () => {
    expect(issuePaths(SeedSkillGraphFile, graphFile([node({ ageMax: 100 })]))).toEqual([["nodes", 0, "ageMax"]]);
  });

  test("ageMin above ageMax fails at ageMax", () => {
    expect(issuePaths(SeedSkillGraphFile, graphFile([node({ ageMin: 30, ageMax: 20 })]))).toEqual([
      ["nodes", 0, "ageMax"],
    ]);
  });
});

describe("equipment and space come from the primitives", () => {
  test.each([
    ["a drill equipment", SeedDrillTrackFile, trackFile([drill({ equipment: "jetpack" })]), ["drills", 0, "equipment"]],
    ["a drill space", SeedDrillTrackFile, trackFile([drill({ space: "moon" })]), ["drills", 0, "space"]],
    ["a node equipment", SeedSkillGraphFile, graphFile([node({ equipment: "jetpack" })]), ["nodes", 0, "equipment"]],
    ["a test equipment", SeedTestsFile, testsFile([skillTest({ equipment: "jetpack" })]), ["tests", 0, "equipment"]],
  ] as const)("an unknown value for %s fails at its path", (_name, schema, input, path) => {
    expect(issuePaths(schema as z.ZodType, input)).toEqual([[...path]]);
  });

  test.each([...EQUIPMENT])("primitives equipment %s is accepted on a drill", (equipment) => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ equipment })]))).toBeNull();
  });

  test.each([...SPACES])("primitives space %s is accepted on a drill", (space) => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ space })]))).toBeNull();
  });
});

describe("licence comes from the SPDX enum and is required", () => {
  test("an unknown licence fails at license", () => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ license: "WTFPL" })]))).toEqual([
      ["drills", 0, "license"],
    ]);
  });

  test("a missing licence fails at license instead of taking the primitives default", () => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([without(drill(), "license")]))).toEqual([
      ["drills", 0, "license"],
    ]);
  });

  test.each([...LICENSE_IDS])("licence %s is accepted", (license) => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ license })]))).toBeNull();
  });
});

describe("attribution and test fields keep the wire rules", () => {
  test.each([
    ["an empty author", trackFile([drill({ author: "" })]), ["drills", 0, "author"]],
    ["an empty source", trackFile([drill({ source: "" })]), ["drills", 0, "source"]],
    ["a source URL that is not a URL", trackFile([drill({ sourceUrl: "wall passes" })]), ["drills", 0, "sourceUrl"]],
    ["a semver such as v1", trackFile([drill({ semver: "v1" })]), ["drills", 0, "semver"]],
  ] as const)("%s fails at its path", (_name, input, path) => {
    expect(issuePaths(SeedDrillTrackFile, input)).toEqual([[...path]]);
  });

  test("a test direction other than higher or lower fails at direction", () => {
    expect(issuePaths(SeedTestsFile, testsFile([skillTest({ direction: "sideways" })]))).toEqual([
      ["tests", 0, "direction"],
    ]);
  });

  test("an empty test metric fails at metric", () => {
    expect(issuePaths(SeedTestsFile, testsFile([skillTest({ metric: "" })]))).toEqual([["tests", 0, "metric"]]);
  });

  test.each([SKILL_LEVEL_MIN - 1, SKILL_LEVEL_MAX + 1])("a rubric level of %d fails at level", (level) => {
    expect(issuePaths(SeedRubricsFile, rubricsFile([rubric({ level })]))).toEqual([["rubrics", 0, "level"]]);
  });
});

describe("slugs are kebab-case", () => {
  test.each([
    ["a drill slug", SeedDrillTrackFile, trackFile([drill({ slug: "Bad_Slug" })]), ["drills", 0, "slug"]],
    [
      "a drill progression slug",
      SeedDrillTrackFile,
      trackFile([drill({ progressionSlugs: ["Bad_Slug"] })]),
      ["drills", 0, "progressionSlugs", 0],
    ],
    [
      "a drill regression slug",
      SeedDrillTrackFile,
      trackFile([drill({ regressionSlugs: ["Bad_Slug"] })]),
      ["drills", 0, "regressionSlugs", 0],
    ],
    ["a track", SeedDrillTrackFile, { ...trackFile(), track: "Bad_Slug" }, ["track"]],
    ["a drill file sport", SeedDrillTrackFile, { ...trackFile(), sport: "Bad_Slug" }, ["sport"]],
    ["a node slug", SeedSkillGraphFile, graphFile([node({ slug: "Bad_Slug" })]), ["nodes", 0, "slug"]],
    ["a node parent", SeedSkillGraphFile, graphFile([node({ parent: "Bad_Slug" })]), ["nodes", 0, "parent"]],
    [
      "a node prerequisite skill",
      SeedSkillGraphFile,
      graphFile([node({ prerequisites: [{ skill: "Bad_Slug", minLevel: 1 }] })]),
      ["nodes", 0, "prerequisites", 0, "skill"],
    ],
    ["a graph sport", SeedSkillGraphFile, { ...graphFile(), sport: "Bad_Slug" }, ["sport"]],
    ["a test slug", SeedTestsFile, testsFile([skillTest({ slug: "Bad_Slug" })]), ["tests", 0, "slug"]],
    ["a test skill", SeedTestsFile, testsFile([skillTest({ skill: "Bad_Slug" })]), ["tests", 0, "skill"]],
    ["a tests file sport", SeedTestsFile, { ...testsFile(), sport: "Bad_Slug" }, ["sport"]],
    ["a rubric skill", SeedRubricsFile, rubricsFile([rubric({ skill: "Bad_Slug" })]), ["rubrics", 0, "skill"]],
    ["a rubrics file sport", SeedRubricsFile, { ...rubricsFile(), sport: "Bad_Slug" }, ["sport"]],
  ] as const)("%s in snake_case with capitals fails at its path", (_name, schema, input, path) => {
    expect(issuePaths(schema as z.ZodType, input)).toEqual([[...path]]);
  });

  test.each(["Ball-Control", "ball_control", "-ball", "ball-", "ball--control", "ball control", ""])(
    "the drill slug %p fails",
    (slug) => {
      expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ slug })]))).toEqual([["drills", 0, "slug"]]);
    },
  );

  test.each(["ball", "ball-control", "juggling-3", "3-touch"])("the drill slug %p passes", (slug) => {
    expect(issuePaths(SeedDrillTrackFile, trackFile([drill({ slug })]))).toBeNull();
  });
});

describe("slugs are unique per file", () => {
  test("a duplicate drill slug fails at the duplicate", () => {
    const file = trackFile([drill(), drill({ slug: "another-drill" }), drill({ slug: "wall-passes" })]);
    expect(issuePaths(SeedDrillTrackFile, file)).toEqual([["drills", 2, "slug"]]);
  });

  test("every later repeat of a slug is reported, the first use is not", () => {
    const file = trackFile([drill(), drill(), drill()]);
    expect(issuePaths(SeedDrillTrackFile, file)).toEqual([
      ["drills", 1, "slug"],
      ["drills", 2, "slug"],
    ]);
  });

  test("a duplicate node slug fails at the duplicate", () => {
    expect(issuePaths(SeedSkillGraphFile, graphFile([rootNode(), node(), node()]))).toEqual([["nodes", 2, "slug"]]);
  });

  test("a duplicate test slug fails at the duplicate", () => {
    expect(issuePaths(SeedTestsFile, testsFile([skillTest(), skillTest()]))).toEqual([["tests", 1, "slug"]]);
  });

  test("the same slug in two different files is fine", () => {
    expect(ok(SeedDrillTrackFile, trackFile([drill()]))).toBe(true);
    expect(ok(SeedDrillTrackFile, trackFile([drill({ slug: "wall-passes-close" }), drill()]))).toBe(true);
  });
});

describe("unrefined base objects", () => {
  test("SeedDrillBase supports pick() and the picked fields still validate", () => {
    const picked = SeedDrillBase.pick({ slug: true, minutes: true });
    expect(picked.safeParse({ slug: "wall-passes", minutes: 10 }).success).toBe(true);
    expect(picked.safeParse({ slug: "wall-passes", minutes: 0 }).success).toBe(false);
  });

  test("SeedSkillNodeBase supports pick() and the picked fields still validate", () => {
    const picked = SeedSkillNodeBase.pick({ slug: true, ageMin: true });
    expect(picked.safeParse({ slug: "juggling", ageMin: 7 }).success).toBe(true);
    expect(picked.safeParse({ slug: "Bad_Slug", ageMin: 7 }).success).toBe(false);
  });

  test("the refined SeedDrill and SeedSkillNode still enforce the age order", () => {
    expect(issuePaths(SeedDrill, drill({ ageMin: 30, ageMax: 20 }))).toEqual([["ageMax"]]);
    expect(issuePaths(SeedSkillNode, node({ ageMin: 30, ageMax: 20 }))).toEqual([["ageMax"]]);
  });
});

describe("seed data converts to the wire contracts", () => {
  test("a parsed node is a valid SkillNode", () => {
    const parsed = SeedSkillGraphFile.parse(graphFile());
    for (const seedNode of parsed.nodes) expect(SkillNode.safeParse(seedNode).success).toBe(true);
  });

  test("a parsed test is a valid SkillTest", () => {
    const parsed = SeedTestsFile.parse(testsFile());
    for (const seedTest of parsed.tests) expect(SkillTest.safeParse(seedTest).success).toBe(true);
  });

  test("a parsed drill's own fields build a valid DrillContent", () => {
    const [seedDrill] = SeedDrillTrackFile.parse(trackFile()).drills;
    if (seedDrill === undefined) throw new Error("expected one drill");
    const content = {
      title: seedDrill.title,
      goal: seedDrill.goal,
      instructions: seedDrill.instructions,
      dose: seedDrill.dose,
      mistakes: seedDrill.mistakes ?? [],
      conditions: {
        equipment: seedDrill.equipment,
        spaces: [seedDrill.space],
        partner: seedDrill.partner ?? false,
        ageMin: seedDrill.ageMin,
        ageMax: seedDrill.ageMax,
      },
      safety: seedDrill.safety ?? [],
    };
    expect(DrillContent.safeParse(content).success).toBe(true);
  });
});
