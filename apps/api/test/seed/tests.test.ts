// Seed content test for config/commons/football/tests.json (fc-mol-f2u.5).
//
// The file is AUTHORED content: the five baseline skill tests of spec section 7 (juggling, wall
// passing, ball mastery, slalom, weak foot), one per skill track, each with a protocol in Kazakh,
// Russian and English, a metric, a unit, a direction, the equipment it needs and the level
// thresholds per age band that the planner uses to estimate level 1-5. These tests check the shape
// the criteria fix (schema, five tests, one per track, direction and equipment per test, three
// locales everywhere, thresholds present and strictly monotonic) plus a few consistency and
// realism heuristics. They do NOT pin test slugs, wording or the threshold numbers themselves.
//
// A test's `skill` is a skill slug of the sport (the seed loader checks it against the graph);
// the criteria say each test "names its track", so here it is one of the five top-level tracks.
//
// Content-level rules the schema does not check (asserted below):
//   - across age bands an older band never asks for less than a younger one at the same level
//     (higher-is-better: each boundary >=; lower-is-better: <=);
//   - a "successes out of N attempts" test cannot have a boundary above N.
//
// Source of the content requirements: the spec section 7 in the original product brief,
// PRODUCT.md (children from about 6, Kazakh first among equals, safe unsupervised) and
// CONTENT-LICENSE.md (original wording only).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SeedSkillGraphFile, SeedTestsFile, THRESHOLD_BANDS, THRESHOLD_LEVELS } from "../../src/commons/seed-schema";
import type { SeedTest } from "../../src/commons/seed-schema";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const TESTS_PATH = join(ROOT, "config", "commons", "football", "tests.json");
const GRAPH_PATH = join(ROOT, "config", "commons", "football", "skill-graph.json");

const TRACKS = ["ball-mastery", "dribbling", "passing-first-touch", "weak-foot", "juggling-coordination"];
const LOCALES = ["kk", "ru", "en"] as const;
type Text = Record<(typeof LOCALES)[number], string>;

// What the criteria fix for each test, keyed by the track it belongs to (spec section 7).
interface Expectation {
  direction: "higher" | "lower";
  equipment: readonly string[];
  metric: RegExp;
  unit: RegExp;
}
const EXPECTED: Record<string, Expectation> = {
  // Juggling: maximum consecutive touches.
  "juggling-coordination": { direction: "higher", equipment: ["ball"], metric: /consecutive|in a row/i, unit: /touch/i },
  // Wall passing: successful passes in 60 seconds, needs a wall.
  "passing-first-touch": { direction: "higher", equipment: ["ball_wall"], metric: /pass/i, unit: /pass/i },
  // Ball mastery: touches in 30 seconds.
  "ball-mastery": { direction: "higher", equipment: ["ball"], metric: /touch/i, unit: /touch/i },
  // Slalom: completion time (errors are counted apart), needs cones.
  dribbling: { direction: "lower", equipment: ["cones"], metric: /time/i, unit: /^s(ec(onds?)?)?$/i },
  // Weak foot: successful passes out of a fixed number of attempts.
  "weak-foot": { direction: "higher", equipment: ["ball", "ball_wall"], metric: /pass/i, unit: /pass/i },
};

// Letters that exist in Kazakh but not in Russian.
const KAZAKH_ONLY = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/;
const CYRILLIC = /[Ѐ-ӿ]/;

async function loadRaw(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

async function loadTests(): Promise<SeedTest[]> {
  const parsed = SeedTestsFile.safeParse(await loadRaw(TESTS_PATH));
  if (!parsed.success) throw new Error(`schema invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data.tests;
}

async function loadGraphNodes() {
  const parsed = SeedSkillGraphFile.safeParse(await loadRaw(GRAPH_PATH));
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

/** The numbered lines of a protocol, e.g. ["1. Stand tall.", "2. Tap the ball."]. */
const stepsOf = (protocol: string): string[] => protocol.split("\n");

const byTrack = (tests: SeedTest[], track: string): SeedTest => {
  const found = tests.find((each) => each.skill === track);
  if (found === undefined) throw new Error(`no test names the track ${track}`);
  return found;
};

describe("tests.json: schema and identity", () => {
  test("the file exists and is valid JSON", async () => {
    expect(await Bun.file(TESTS_PATH).exists()).toBe(true);
    expect(await loadRaw(TESTS_PATH)).toBeObject();
  });

  test("parses with SeedTestsFile for the football sport", async () => {
    const parsed = SeedTestsFile.safeParse(await loadRaw(TESTS_PATH));
    if (!parsed.success) console.error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sport).toBe("football");
  });

  test("defines exactly five tests with unique slugs", async () => {
    const tests = await loadTests();
    expect(tests).toHaveLength(5);
    expect(new Set(tests.map((each) => each.slug)).size).toBe(5);
  });

  test("there is one test per track: every track is named by exactly one test", async () => {
    const tests = await loadTests();
    expect(tests.map((each) => each.skill).sort()).toEqual([...TRACKS].sort());
  });

  test("every test's skill is a top-level track of the football skill graph", async () => {
    const nodes = await loadGraphNodes();
    const trackSlugs = new Set(nodes.filter((node) => node.parent === null).map((node) => node.slug));
    for (const each of await loadTests()) {
      expect(trackSlugs.has(each.skill), `${each.slug} names the track ${each.skill}`).toBe(true);
    }
  });
});

describe("tests.json: metric, unit, direction and equipment per test", () => {
  for (const track of TRACKS) {
    const expected = EXPECTED[track]!;

    test(`the ${track} test is ${expected.direction}-is-better and needs ${expected.equipment.join(" or ")}`, async () => {
      const each = byTrack(await loadTests(), track);
      expect(each.direction, `${each.slug} direction`).toBe(expected.direction);
      expect(expected.equipment, `${each.slug} equipment`).toContain(each.equipment);
    });

    test(`the ${track} test names a metric and a unit that match what it measures`, async () => {
      const each = byTrack(await loadTests(), track);
      expect(each.metric.trim(), `${each.slug} metric`).toMatch(expected.metric);
      expect(each.unit.trim(), `${each.slug} unit`).toMatch(expected.unit);
    });
  }

  test("the protocol states the fixed number the criteria give: 60 s for wall passing, 30 s for ball mastery", async () => {
    const tests = await loadTests();
    for (const [track, seconds] of [
      ["passing-first-touch", "60"],
      ["ball-mastery", "30"],
    ] as const) {
      const each = byTrack(tests, track);
      for (const locale of LOCALES) {
        expect(each.protocol[locale], `${each.slug} ${locale} names ${seconds} seconds`).toMatch(
          new RegExp(`(?:^|[^\\d])${seconds}(?:[^\\d]|$)`),
        );
      }
    }
  });

  test("the slalom protocol lays out the cones (a distance in metres) and says how errors are counted", async () => {
    const each = byTrack(await loadTests(), "dribbling");
    const distance = /\d(?:[.,]\d)?\s?(?:m|м)(?![\p{L}])/u;
    for (const locale of LOCALES) {
      expect(each.protocol[locale], `${locale} gives a distance in metres`).toMatch(distance);
    }
    expect(each.protocol.en).toMatch(/error/i);
    expect(each.protocol.ru).toMatch(/ошиб/i);
    expect(each.protocol.kk).toMatch(/қате/i);
  });

  test("the weak-foot protocol states a fixed number of attempts, the same in every locale", async () => {
    const each = byTrack(await loadTests(), "weak-foot");
    const attempts = attemptsOf(each);
    expect(Number.isInteger(attempts)).toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(5);
    for (const locale of LOCALES) {
      expect(each.protocol[locale], `${locale} names ${attempts} attempts`).toMatch(
        new RegExp(`(?:^|[^\\d])${attempts}(?:[^\\d]|$)`),
      );
    }
  });
});

/** The attempts of the weak-foot test: the number before "passes" / "attempts" in its English protocol. */
function attemptsOf(each: SeedTest): number {
  const found = each.protocol.en.match(/(\d+)\s+(?:passes|attempts|tries)/i);
  if (found === null) throw new Error(`${each.slug} protocol names no number of attempts`);
  return Number(found[1]);
}

describe("tests.json: level thresholds", () => {
  test("every test carries thresholds for all three age bands, each with exactly four finite numbers", async () => {
    for (const each of await loadTests()) {
      expect(each.thresholds, `${each.slug} thresholds`).toBeDefined();
      const bands = each.thresholds!;
      expect(Object.keys(bands).sort(), `${each.slug} bands`).toEqual([...THRESHOLD_BANDS].sort());
      for (const band of THRESHOLD_BANDS) {
        expect(bands[band], `${each.slug} ${band}`).toHaveLength(THRESHOLD_LEVELS);
        for (const value of bands[band]) {
          expect(Number.isFinite(value), `${each.slug} ${band} ${value}`).toBe(true);
          expect(value, `${each.slug} ${band} is positive`).toBeGreaterThan(0);
        }
      }
    }
  });

  test("boundaries are strictly monotonic in the test's direction, band by band", async () => {
    for (const each of await loadTests()) {
      for (const band of THRESHOLD_BANDS) {
        const values = each.thresholds![band];
        for (let index = 1; index < values.length; index++) {
          const [previous, current] = [values[index - 1]!, values[index]!];
          if (each.direction === "higher") {
            expect(current, `${each.slug} ${band}[${index}] must be above ${previous}`).toBeGreaterThan(previous);
          } else {
            expect(current, `${each.slug} ${band}[${index}] must be below ${previous}`).toBeLessThan(previous);
          }
        }
      }
    }
  });

  test("an older band never asks for less than a younger one at the same level", async () => {
    for (const each of await loadTests()) {
      const { upTo9, from10to13, from14 } = each.thresholds!;
      const order = [
        ["upTo9", upTo9, "from10to13", from10to13],
        ["from10to13", from10to13, "from14", from14],
      ] as const;
      for (const [youngerName, younger, olderName, older] of order) {
        older.forEach((value, index) => {
          const label = `${each.slug}: ${olderName}[${index}] vs ${youngerName}[${index}]`;
          if (each.direction === "higher") expect(value, label).toBeGreaterThanOrEqual(younger[index]!);
          else expect(value, label).toBeLessThanOrEqual(younger[index]!);
        });
      }
    }
  });

  test("older bands are not all identical to the youngest: age changes at least one boundary", async () => {
    for (const each of await loadTests()) {
      const { upTo9, from14 } = each.thresholds!;
      expect(from14, `${each.slug}: from14 differs from upTo9`).not.toEqual(upTo9);
    }
  });

  test("count tests use whole numbers, slalom times are believable seconds", async () => {
    for (const each of await loadTests()) {
      for (const band of THRESHOLD_BANDS) {
        for (const value of each.thresholds![band]) {
          if (each.direction === "higher") expect(Number.isInteger(value), `${each.slug} ${band} ${value}`).toBe(true);
          else {
            expect(value, `${each.slug} ${band} ${value} s`).toBeGreaterThanOrEqual(2);
            expect(value, `${each.slug} ${band} ${value} s`).toBeLessThanOrEqual(60);
          }
        }
      }
    }
  });

  test("weak-foot boundaries cannot exceed the number of attempts", async () => {
    const each = byTrack(await loadTests(), "weak-foot");
    const attempts = attemptsOf(each);
    for (const band of THRESHOLD_BANDS) {
      for (const value of each.thresholds![band]) expect(value, `${band} ${value}`).toBeLessThanOrEqual(attempts);
    }
  });

  test("boundaries are realistic for children: a level 2 is reachable and the top level is not absurd", async () => {
    for (const each of await loadTests()) {
      if (each.direction !== "higher") continue;
      const { upTo9, from14 } = each.thresholds!;
      // Level 2 for the youngest must be within a beginner's reach; level 5 for the oldest is finite and modest.
      expect(upTo9[0], `${each.slug} upTo9 level 2`).toBeLessThanOrEqual(25);
      expect(from14[THRESHOLD_LEVELS - 1]!, `${each.slug} from14 level 5`).toBeLessThanOrEqual(200);
    }
  });
});

describe("tests.json: protocols", () => {
  test("a protocol is short numbered steps, the same number of steps in every locale", async () => {
    for (const each of await loadTests()) {
      const counts = LOCALES.map((locale) => stepsOf(each.protocol[locale]).length);
      expect(counts[0], `${each.slug} kk vs en steps`).toBe(counts[2]!);
      expect(counts[1], `${each.slug} ru vs en steps`).toBe(counts[2]!);
      expect(counts[2]!, `${each.slug} steps`).toBeGreaterThanOrEqual(5);
      expect(counts[2]!, `${each.slug} steps`).toBeLessThanOrEqual(9);
      for (const locale of LOCALES) {
        stepsOf(each.protocol[locale]).forEach((line, index) => {
          expect(line.startsWith(`${index + 1}. `), `${each.slug}.${locale} step ${index + 1}: ${line}`).toBe(true);
          expect(line.length, `${each.slug}.${locale} step ${index + 1} is too long`).toBeLessThanOrEqual(260);
        });
      }
    }
  });

  test("a protocol says when to rest and stays safe (en mentions rest and a safety cue)", async () => {
    for (const each of await loadTests()) {
      expect(each.protocol.en, `${each.slug} rest`).toMatch(/rest|pause|break/i);
      expect(each.protocol.en, `${each.slug} safety`).toMatch(/safe|stop|away from|flat|dry|windows?|road|traffic|people/i);
    }
  });

  test("a protocol works for a parent to run: it names the equipment or space it needs", async () => {
    for (const each of await loadTests()) {
      if (each.equipment === "cones") expect(each.protocol.en, each.slug).toMatch(/cone/i);
      if (each.equipment === "ball_wall") expect(each.protocol.en, each.slug).toMatch(/wall/i);
      expect(each.protocol.en, each.slug).toMatch(/ball/i);
    }
  });
});

describe("tests.json: three locales everywhere", () => {
  test("every text object anywhere in the file has kk, ru and en, non-blank and nothing else", async () => {
    const raw = await loadRaw(TESTS_PATH);
    const leaves = textLeaves(raw);
    const tests = await loadTests();
    // Not vacuous: every test carries a protocol.
    expect(leaves.length).toBeGreaterThanOrEqual(tests.length);
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
    for (const { path, text } of textLeaves(await loadRaw(TESTS_PATH))) {
      const { kk, ru, en } = text as Text;
      if (en.length <= 3) continue;
      expect(kk, `${path}: kk is a copy of en`).not.toBe(en);
      expect(ru, `${path}: ru is a copy of en`).not.toBe(en);
      expect(kk, `${path}: kk is a copy of ru`).not.toBe(ru);
    }
  });

  test("kk and ru are written in Cyrillic with no untranslated English words; en has no Cyrillic", async () => {
    for (const { path, text } of textLeaves(await loadRaw(TESTS_PATH))) {
      const { kk, ru, en } = text as Text;
      expect(CYRILLIC.test(kk), `${path}.kk has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(ru), `${path}.ru has no Cyrillic`).toBe(true);
      expect(CYRILLIC.test(en), `${path}.en contains Cyrillic`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(kk), `${path}.kk has a Latin word: ${kk}`).toBe(false);
      expect(/[A-Za-z]{3,}/.test(ru), `${path}.ru has a Latin word: ${ru}`).toBe(false);
    }
  });

  test("kk text carries Kazakh letters and ru text carries none", async () => {
    for (const { path, text } of textLeaves(await loadRaw(TESTS_PATH))) {
      const { kk, ru } = text as Text;
      if (kk.length >= 30) expect(KAZAKH_ONLY.test(kk), `${path}.kk has no Kazakh letter: ${kk}`).toBe(true);
      expect(KAZAKH_ONLY.test(ru), `${path}.ru has a Kazakh letter: ${ru}`).toBe(false);
    }
  });

  test("texts carry no placeholder markers and stay under a page", async () => {
    for (const { path, text } of textLeaves(await loadRaw(TESTS_PATH))) {
      for (const locale of LOCALES) {
        const value = text[locale] as string;
        expect(value.length, `${path}.${locale} is too long`).toBeLessThanOrEqual(1200);
        expect(/todo|tbd|lorem|xxx|\?\?\?/i.test(value), `${path}.${locale} looks like a placeholder`).toBe(false);
      }
    }
  });
});
