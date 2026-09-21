import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const readme = (): string => readFileSync(join(repoRoot, "README.md"), "utf8");

const MISSION = "Every child deserves a great first coach.";

// One heading (levels 1-3) per topic, matched case-insensitively by keyword.
const topics: Array<[string, RegExp]> = [
  ["mission", /^#{1,3} .*mission/im],
  ["the two open parts (software and commons)", /^#{1,3} .*two open parts/im],
  ["running locally", /^#{1,3} .*run locally/im],
  ["using the commons in another app", /^#{1,3} .*commons.*another app|^#{1,3} .*another app.*commons/im],
  ["contributing without GitHub", /^#{1,3} .*contribut.*without github/im],
  ["honesty rule for AI-drafted content", /^#{1,3} .*honesty/im],
  ["no copying commercial material", /^#{1,3} .*no copying.*commercial|^#{1,3} .*commercial.*material/im],
];

describe("README.md (contributor README)", () => {
  test("states the mission sentence", () => {
    expect(readme()).toContain(MISSION);
  });

  test("has a top-level title naming FIRST COACH", () => {
    expect(readme()).toMatch(/^# .*FIRST COACH/m);
  });

  for (const [topic, heading] of topics) {
    test(`has a heading for ${topic}`, () => {
      expect(readme()).toMatch(heading);
    });
  }

  test("mission sentence sits under the mission heading", () => {
    const text = readme();
    const heading = text.match(/^#{1,3} .*mission.*$/im);
    expect(heading).not.toBeNull();
    const after = text.slice((heading?.index ?? 0) + (heading?.[0].length ?? 0));
    const nextHeading = after.search(/^#{1,3} /m);
    const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
    expect(section).toContain(MISSION);
  });
});
