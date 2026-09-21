import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as domain from "./domain";
import {
  AGE_MAX,
  AGE_MIN,
  Attribution,
  CalendarDate,
  Count,
  DAYS_PER_WEEK,
  FOCUS_MAX,
  FOCUS_MIN,
  MINUTES_PER_SESSION,
  PlayerProfile,
  PlayerProfileShape,
  PlayerProfileView,
  ROADMAP_WEEKS,
  Roadmap,
  SKILL_LEVEL_MAX,
  SKILL_LEVEL_MIN,
  Semver,
  SkillTest,
  TEST_DIRECTIONS,
  TestDirection,
  Timestamp,
} from "./domain";
import type { EndpointSpec } from "./domain";
import { LICENSE_IDS } from "./primitives";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const profile: domain.PlayerProfile = {
  age: 12,
  level: "beginner",
  goal: "control",
  equipment: "ball",
  space: "yard",
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: "ru",
};

const focusItem = (skill: string): domain.Roadmap["focus"][number] => ({
  skill,
  level: 1,
  targetLevel: 2,
  reason: "Weakest area on the test.",
});

const roadmap: domain.Roadmap = {
  currentLevelLabel: "Foundation",
  tracks: [
    { skill: "ball-control", level: 2, source: "test" },
    { skill: "passing", level: 1, source: "self" },
  ],
  goal: "control",
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [focusItem("passing"), focusItem("ball-control")],
};

const skillTest: domain.SkillTest = {
  slug: "juggling-30s",
  skill: "ball-control",
  metric: "Touches in 30 seconds",
  unit: "touches",
  direction: "higher",
  protocol: { ru: "Жонглируй 30 секунд.", en: "Juggle for 30 seconds." },
  equipment: "ball",
};

const attribution: domain.Attribution = {
  author: "First Coach Academy",
  source: "Community drill library",
  sourceUrl: "https://example.org/drills/juggling",
  license: "CC-BY-4.0",
  createdAt: "2026-09-01T10:00:00Z",
  semver: "1.0.0",
};

describe("player bounds", () => {
  test("constants are the ones the criteria fix", () => {
    expect(AGE_MIN).toBe(5);
    expect(AGE_MAX).toBe(99);
    expect([...DAYS_PER_WEEK]).toEqual([2, 3, 4, 5, 6]);
    expect([...MINUTES_PER_SESSION]).toEqual([10, 15, 20, 30, 45]);
    expect(ROADMAP_WEEKS).toBe(4);
    expect([SKILL_LEVEL_MIN, SKILL_LEVEL_MAX]).toEqual([1, 5]);
    expect([FOCUS_MIN, FOCUS_MAX]).toEqual([2, 3]);
  });
});

describe("PlayerProfile (request, strict)", () => {
  test("parses a realistic profile and returns it unchanged", () => {
    expect(PlayerProfile.parse(profile)).toEqual(profile);
  });

  test("the shape has exactly the nine profile fields", () => {
    expect(Object.keys(PlayerProfileShape).sort()).toEqual(
      ["age", "daysPerWeek", "equipment", "goal", "level", "locale", "minutesPerSession", "partner", "space"],
    );
  });

  test.each([5, 6, 99])("accepts age %p", (age) => {
    expect(ok(PlayerProfile, { ...profile, age })).toBe(true);
  });
  test.each([4, 100])("rejects age %p", (age) => {
    expect(ok(PlayerProfile, { ...profile, age })).toBe(false);
  });
  test("rejects a fractional age", () => {
    expect(ok(PlayerProfile, { ...profile, age: 12.5 })).toBe(false);
  });

  test.each([2, 3, 4, 5, 6])("accepts daysPerWeek %p", (daysPerWeek) => {
    expect(ok(PlayerProfile, { ...profile, daysPerWeek })).toBe(true);
  });
  test.each([1, 7])("rejects daysPerWeek %p", (daysPerWeek) => {
    expect(ok(PlayerProfile, { ...profile, daysPerWeek })).toBe(false);
  });
  test("rejects a fractional daysPerWeek", () => {
    expect(ok(PlayerProfile, { ...profile, daysPerWeek: 3.5 })).toBe(false);
  });

  test.each([10, 15, 20, 30, 45])("accepts minutesPerSession %p", (minutesPerSession) => {
    expect(ok(PlayerProfile, { ...profile, minutesPerSession })).toBe(true);
  });
  test("rejects minutesPerSession 25", () => {
    expect(ok(PlayerProfile, { ...profile, minutesPerSession: 25 })).toBe(false);
  });

  test.each([...Object.keys(profile)])("requires %s", (key) => {
    expect(ok(PlayerProfile, without(profile, key))).toBe(false);
  });

  test.each([
    ["level", "expert-plus"],
    ["goal", "scoring-everything"],
    ["equipment", "jetpack"],
    ["space", "moon"],
    ["locale", "de"],
    ["partner", "yes"],
  ])("rejects an unknown %s value", (key, value) => {
    expect(ok(PlayerProfile, { ...profile, [key]: value })).toBe(false);
  });

  test.each(["name", "email", "birthDate", "id"])("rejects the key %s", (key) => {
    const result = PlayerProfile.safeParse({ ...profile, [key]: "x" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(["unrecognized_keys"]);
  });

  test(".pick().partial() stays legal (no object-level refinement)", () => {
    const partial = PlayerProfile.pick({ age: true, level: true }).partial();
    expect(ok(partial, {})).toBe(true);
    expect(ok(partial, { age: 12 })).toBe(true);
    expect(ok(partial, { level: "basic" })).toBe(true);
    expect(ok(partial, { level: "expert-plus" })).toBe(false);
  });

  test(".omit() and .partial() stay legal", () => {
    expect(ok(PlayerProfile.omit({ locale: true }), without(profile, "locale"))).toBe(true);
    expect(ok(PlayerProfile.partial(), {})).toBe(true);
  });
});

describe("PlayerProfileView (response, unknown keys stripped)", () => {
  test("parses a realistic profile", () => {
    expect(PlayerProfileView.parse(profile)).toEqual(profile);
  });

  test("strips an unknown server key such as id", () => {
    const parsed = PlayerProfileView.parse({ ...profile, id: "usr_1" });
    expect(parsed).toEqual(profile);
    expect("id" in parsed).toBe(false);
  });

  test("still rejects a missing field", () => {
    expect(ok(PlayerProfileView, without({ ...profile, id: "usr_1" }, "goal"))).toBe(false);
  });

  test.each([4, 100])("still rejects age %p", (age) => {
    expect(ok(PlayerProfileView, { ...profile, age })).toBe(false);
  });
  test.each([1, 7])("still rejects daysPerWeek %p", (daysPerWeek) => {
    expect(ok(PlayerProfileView, { ...profile, daysPerWeek })).toBe(false);
  });
  test("still rejects minutesPerSession 25", () => {
    expect(ok(PlayerProfileView, { ...profile, minutesPerSession: 25 })).toBe(false);
  });

  test(".pick().partial() stays legal (no object-level refinement)", () => {
    const partial = PlayerProfileView.pick({ age: true, level: true }).partial();
    expect(ok(partial, {})).toBe(true);
    expect(ok(partial, { age: 12 })).toBe(true);
    expect(ok(partial, { level: "expert-plus" })).toBe(false);
  });
});

describe("Roadmap", () => {
  test("parses a realistic roadmap and returns it unchanged", () => {
    expect(Roadmap.parse(roadmap)).toEqual(roadmap);
  });

  test("weeks is exactly 4", () => {
    expect(ok(Roadmap, { ...roadmap, weeks: 4 })).toBe(true);
    expect(ok(Roadmap, { ...roadmap, weeks: 3 })).toBe(false);
    expect(ok(Roadmap, { ...roadmap, weeks: 5 })).toBe(false);
  });

  test.each([2, 6])("accepts sessionsPerWeek %p", (sessionsPerWeek) => {
    expect(ok(Roadmap, { ...roadmap, sessionsPerWeek })).toBe(true);
  });
  test.each([1, 7])("rejects sessionsPerWeek %p", (sessionsPerWeek) => {
    expect(ok(Roadmap, { ...roadmap, sessionsPerWeek })).toBe(false);
  });

  test.each([10, 15, 20, 30, 45])("accepts minutesPerSession %p", (minutesPerSession) => {
    expect(ok(Roadmap, { ...roadmap, minutesPerSession })).toBe(true);
  });
  test("rejects minutesPerSession 25", () => {
    expect(ok(Roadmap, { ...roadmap, minutesPerSession: 25 })).toBe(false);
  });

  test.each([2, 3])("accepts %p focus items", (count) => {
    const focus = ["a", "b", "c"].slice(0, count).map(focusItem);
    expect(ok(Roadmap, { ...roadmap, focus })).toBe(true);
  });
  test("rejects 1 focus item", () => {
    expect(ok(Roadmap, { ...roadmap, focus: [focusItem("a")] })).toBe(false);
  });
  test("rejects 4 focus items", () => {
    expect(ok(Roadmap, { ...roadmap, focus: ["a", "b", "c", "d"].map(focusItem) })).toBe(false);
  });

  test.each([1, 5])("accepts track level %p", (level) => {
    expect(ok(Roadmap, { ...roadmap, tracks: [{ skill: "ball-control", level, source: "test" }] })).toBe(true);
  });
  test.each([0, 6])("rejects track level %p", (level) => {
    expect(ok(Roadmap, { ...roadmap, tracks: [{ skill: "ball-control", level, source: "test" }] })).toBe(false);
  });
  test("rejects a fractional track level", () => {
    expect(ok(Roadmap, { ...roadmap, tracks: [{ skill: "ball-control", level: 2.5, source: "test" }] })).toBe(false);
  });

  test.each(["test", "self"])("accepts track source %p", (source) => {
    expect(ok(Roadmap, { ...roadmap, tracks: [{ skill: "ball-control", level: 2, source }] })).toBe(true);
  });
  test("rejects a track source outside test|self", () => {
    expect(ok(Roadmap, { ...roadmap, tracks: [{ skill: "ball-control", level: 2, source: "coach" }] })).toBe(false);
  });
  test("requires a track skill", () => {
    expect(ok(Roadmap, { ...roadmap, tracks: [{ level: 2, source: "test" }] })).toBe(false);
  });

  test.each([0, 6])("rejects focus level %p", (level) => {
    expect(ok(Roadmap, { ...roadmap, focus: [{ ...focusItem("a"), level }, focusItem("b")] })).toBe(false);
  });
  test.each([0, 6])("rejects focus targetLevel %p", (targetLevel) => {
    expect(ok(Roadmap, { ...roadmap, focus: [{ ...focusItem("a"), targetLevel }, focusItem("b")] })).toBe(false);
  });
  test("accepts focus levels at both ends of the range", () => {
    const focus = [{ ...focusItem("a"), level: 1, targetLevel: 5 }, { ...focusItem("b"), level: 5, targetLevel: 5 }];
    expect(ok(Roadmap, { ...roadmap, focus })).toBe(true);
  });
  test.each(["skill", "level", "targetLevel", "reason"])("requires focus %s", (key) => {
    expect(ok(Roadmap, { ...roadmap, focus: [without(focusItem("a"), key), focusItem("b")] })).toBe(false);
  });
  test("rejects an empty focus reason", () => {
    expect(ok(Roadmap, { ...roadmap, focus: [{ ...focusItem("a"), reason: "" }, focusItem("b")] })).toBe(false);
  });

  test("rejects an empty currentLevelLabel", () => {
    expect(ok(Roadmap, { ...roadmap, currentLevelLabel: "" })).toBe(false);
  });
  test("rejects an unknown goal", () => {
    expect(ok(Roadmap, { ...roadmap, goal: "scoring-everything" })).toBe(false);
  });
  test.each(["currentLevelLabel", "tracks", "goal", "weeks", "sessionsPerWeek", "minutesPerSession", "focus"])(
    "requires %s",
    (key) => {
      expect(ok(Roadmap, without(roadmap, key))).toBe(false);
    },
  );
});

describe("TestDirection and SkillTest", () => {
  test("directions are higher and lower", () => {
    expect([...TEST_DIRECTIONS]).toEqual(["higher", "lower"]);
    expect(ok(TestDirection, "higher")).toBe(true);
    expect(ok(TestDirection, "lower")).toBe(true);
    expect(ok(TestDirection, "up")).toBe(false);
  });

  test("parses a realistic skill test and returns it unchanged", () => {
    expect(SkillTest.parse(skillTest)).toEqual(skillTest);
  });

  test("accepts direction lower", () => {
    expect(ok(SkillTest, { ...skillTest, direction: "lower" })).toBe(true);
  });
  test("rejects an unknown direction", () => {
    expect(ok(SkillTest, { ...skillTest, direction: "up" })).toBe(false);
  });

  test("requires a protocol", () => {
    expect(ok(SkillTest, without(skillTest, "protocol"))).toBe(false);
  });
  test("accepts a protocol in a single locale", () => {
    expect(ok(SkillTest, { ...skillTest, protocol: { kk: "30 секунд жонглинг." } })).toBe(true);
  });
  test("rejects a protocol with only blank text", () => {
    expect(ok(SkillTest, { ...skillTest, protocol: { en: "   " } })).toBe(false);
  });
  test("rejects a protocol that is a plain string", () => {
    expect(ok(SkillTest, { ...skillTest, protocol: "Juggle for 30 seconds." })).toBe(false);
  });

  test("requires equipment", () => {
    expect(ok(SkillTest, without(skillTest, "equipment"))).toBe(false);
  });
  test("rejects unknown equipment", () => {
    expect(ok(SkillTest, { ...skillTest, equipment: "jetpack" })).toBe(false);
  });

  test.each(["slug", "skill", "metric", "unit", "direction"])("requires %s", (key) => {
    expect(ok(SkillTest, without(skillTest, key))).toBe(false);
  });
  test.each(["metric", "unit", "slug", "skill"])("rejects an empty %s", (key) => {
    expect(ok(SkillTest, { ...skillTest, [key]: "" })).toBe(false);
  });
});

describe("Attribution", () => {
  test("parses a realistic attribution and returns it unchanged", () => {
    expect(Attribution.parse(attribution)).toEqual(attribution);
  });

  test("sourceUrl is optional", () => {
    expect(ok(Attribution, without(attribution, "sourceUrl"))).toBe(true);
  });
  test.each(["not a url", "ftp://example.org/drill", "javascript:alert(1)"])("rejects sourceUrl %p", (sourceUrl) => {
    expect(ok(Attribution, { ...attribution, sourceUrl })).toBe(false);
  });

  test("a payload without license fails (no default masks it)", () => {
    expect(ok(Attribution, without(attribution, "license"))).toBe(false);
  });
  test("rejects an unknown license id", () => {
    expect(ok(Attribution, { ...attribution, license: "MIT" })).toBe(false);
  });
  test.each([...LICENSE_IDS])("accepts license %s and keeps it as given", (license) => {
    expect(Attribution.parse({ ...attribution, license }).license).toBe(license);
  });

  test.each(["author", "source", "createdAt", "semver"])("requires %s", (key) => {
    expect(ok(Attribution, without(attribution, key))).toBe(false);
  });
  test.each(["author", "source"])("rejects an empty %s", (key) => {
    expect(ok(Attribution, { ...attribution, [key]: "" })).toBe(false);
  });
  test("rejects a createdAt that is a date only", () => {
    expect(ok(Attribution, { ...attribution, createdAt: "2026-09-01" })).toBe(false);
  });
  test("rejects a malformed semver", () => {
    expect(ok(Attribution, { ...attribution, semver: "1.0" })).toBe(false);
  });
});

describe("Semver", () => {
  test.each(["1.0.0", "0.12.3", "10.20.30", "1.0.0-beta.1", "2.1.0-rc-2"])("accepts %s", (version) => {
    expect(ok(Semver, version)).toBe(true);
  });
  test.each(["1.0", "1", "v1.0.0", "1.0.0.0", "1.0.0-", "a.b.c", "1.0.0 ", " 1.0.0", ""])("rejects %p", (version) => {
    expect(ok(Semver, version)).toBe(false);
  });
});

describe("Timestamp", () => {
  test.each(["2026-09-01T10:00:00Z", "2026-09-01T10:00:00+05:00", "2026-09-01T10:00:00.123-03:30"])(
    "accepts %s",
    (value) => {
      expect(ok(Timestamp, value)).toBe(true);
    },
  );
  test.each(["2026-09-01T10:00:00", "2026-09-01", "2026-09-01 10:00:00Z", "yesterday", "", 1788256800])(
    "rejects %p",
    (value) => {
      expect(ok(Timestamp, value)).toBe(false);
    },
  );
});

describe("CalendarDate", () => {
  test.each(["2026-09-01", "2024-02-29"])("accepts %s", (value) => {
    expect(ok(CalendarDate, value)).toBe(true);
  });
  test.each(["2026-13-01", "2026-02-30", "2026-9-1", "2026-09-01T10:00:00Z", "01.09.2026", ""])(
    "rejects %p",
    (value) => {
      expect(ok(CalendarDate, value)).toBe(false);
    },
  );
});

describe("Count", () => {
  test.each([0, 1, 250])("accepts %p", (value) => {
    expect(ok(Count, value)).toBe(true);
  });
  test.each([-1, 1.5, "3", null, Number.NaN])("rejects %p", (value) => {
    expect(ok(Count, value)).toBe(false);
  });
});

describe("EndpointSpec (type-only)", () => {
  test("accepts a realistic set of endpoints via satisfies (checked by the typecheck)", () => {
    const sample = {
      getThing: {
        method: "GET",
        path: "/things/:id",
        params: z.object({ id: z.string() }),
        query: z.object({ verbose: z.string().optional() }),
        response: z.object({ ok: z.boolean() }),
        status: 200,
      },
      createThing: {
        method: "POST",
        path: "/things",
        request: z.object({ name: z.string() }),
        response: z.object({ ok: z.boolean() }),
        status: 201,
        contentType: "application/json",
        public: true,
      },
      minimal: { method: "DELETE", path: "/things/:id" },
    } as const satisfies Record<string, EndpointSpec>;
    expect(Object.keys(sample)).toEqual(["getThing", "createThing", "minimal"]);
  });

  test("rejects bad specs at compile time", () => {
    // @ts-expect-error method must be one of GET|POST|PUT|PATCH|DELETE
    const badMethod = { x: { method: "TRACE", path: "/x" } } as const satisfies Record<string, EndpointSpec>;
    // @ts-expect-error path is required
    const noPath = { x: { method: "GET" } } as const satisfies Record<string, EndpointSpec>;
    // @ts-expect-error public may only be true
    const publicFalse = { x: { method: "GET", path: "/x", public: false } } as const satisfies Record<string, EndpointSpec>;
    // @ts-expect-error status must be a number
    const badStatus = { x: { method: "GET", path: "/x", status: "200" } } as const satisfies Record<string, EndpointSpec>;
    expect([badMethod, noPath, publicFalse, badStatus]).toHaveLength(4);
  });

  test("the module exports no runtime EndpointSpec value", () => {
    expect("EndpointSpec" in domain).toBe(false);
    expect(Object.keys(domain)).not.toContain("EndpointSpec");
  });
});

describe("web-bundle safety", () => {
  const source = readFileSync(join(import.meta.dir, "domain.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("imports nothing but zod and ./primitives", () => {
    const specifiers = [...code.matchAll(/\b(?:from|import)\s+(["'])([^"']+)\1/g)].map((match) => match[2]);
    expect(specifiers).toContain("zod");
    expect(specifiers).toContain("./primitives");
    for (const specifier of specifiers) expect(["zod", "./primitives"]).toContain(specifier);
  });

  test("uses no dynamic import, require, or node/bun globals", () => {
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\b(?:Bun|process)\./);
  });
});
