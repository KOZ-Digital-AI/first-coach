import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BaselineResult, ENDPOINTS, OnboardingOptions, StartRequest, StartResponse } from "./onboarding";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const UUID_A = "3f2b8c1e-5d4a-4b7e-9a61-0c2d7e8f9a10";
const UUID_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// Local factories: each call returns a fresh, valid payload to mutate one field at a time.
const profile = () => ({
  age: 12,
  level: "beginner",
  goal: "control",
  equipment: "ball",
  space: "yard",
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: "ru",
});

const takenTest = () => ({
  testSlug: "juggling-max-touches",
  value: 14,
  attempts: 3,
  errors: 0,
  clientUuid: UUID_A,
});

// A skipped test still carries `value` (the criteria require it); the client sends 0.
const skippedTest = () => ({ testSlug: "wall-pass-60", value: 0, skipped: true, clientUuid: UUID_B });

const startRequest = () => ({ profile: profile(), baseline: [takenTest(), skippedTest()] });

const roadmap = () => ({
  currentLevelLabel: "Foundation",
  tracks: [
    { skill: "ball-control", level: 2, source: "test" },
    { skill: "passing", level: 1, source: "self" },
  ],
  goal: "control",
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: "passing", level: 1, targetLevel: 2, reason: "One of the weakest areas in your baseline." },
    { skill: "ball-control", level: 2, targetLevel: 3, reason: "This is your stated goal." },
  ],
});

const startResponse = () => ({ profile: profile(), roadmap: roadmap() });

const skillTest = () => ({
  slug: "juggling-max-touches",
  skill: "juggling",
  metric: "Max consecutive touches",
  unit: "touches",
  direction: "higher",
  protocol: { ru: "Жонглируйте без падения мяча.", en: "Juggle without letting the ball drop." },
  equipment: "ball",
});

const options = () => ({
  levels: ["beginner", "basic", "intermediate"],
  goals: ["control", "dribbling", "passing"],
  equipment: ["nothing", "ball", "cones"],
  spaces: ["home_3x3", "yard", "field"],
  partner: [false, true],
  daysPerWeek: [2, 3, 4, 5, 6],
  minutesPerSession: [10, 15, 20, 30, 45],
  tests: [skillTest()],
});

describe("OnboardingOptions", () => {
  test("parses a realistic options payload", () => {
    expect(OnboardingOptions.parse(options()).tests[0]?.slug).toBe("juggling-max-touches");
  });

  test.each(Object.keys(options()))("rejects options missing %s", (key) => {
    expect(ok(OnboardingOptions, without(options(), key))).toBe(false);
  });

  test.each([
    ["levels", "expert"],
    ["goals", "dribble-fast"],
    ["equipment", "markers"],
    ["spaces", "room"],
    ["partner", "yes"],
  ])("rejects a %s option outside its enum (%p)", (key, bad) => {
    expect(ok(OnboardingOptions, { ...options(), [key]: [bad] })).toBe(false);
  });

  test("accepts every daysPerWeek value 2..6", () => {
    expect(ok(OnboardingOptions, { ...options(), daysPerWeek: [2, 3, 4, 5, 6] })).toBe(true);
  });

  test.each([1, 7])("rejects a daysPerWeek option of %p (outside 2..6)", (bad) => {
    expect(ok(OnboardingOptions, { ...options(), daysPerWeek: [3, bad] })).toBe(false);
  });

  test("accepts the five fixed minutesPerSession values", () => {
    expect(ok(OnboardingOptions, { ...options(), minutesPerSession: [10, 15, 20, 30, 45] })).toBe(true);
  });

  test.each([5, 25, 60])("rejects a minutesPerSession option of %p (not in 10,15,20,30,45)", (bad) => {
    expect(ok(OnboardingOptions, { ...options(), minutesPerSession: [20, bad] })).toBe(false);
  });

  test("partner options are booleans", () => {
    expect(ok(OnboardingOptions, { ...options(), partner: [false] })).toBe(true);
    expect(ok(OnboardingOptions, { ...options(), partner: [false, true] })).toBe(true);
  });

  test("a test entry needs its localized protocol", () => {
    expect(ok(OnboardingOptions, { ...options(), tests: [without(skillTest(), "protocol")] })).toBe(false);
  });

  test("a test entry needs its required equipment", () => {
    expect(ok(OnboardingOptions, { ...options(), tests: [without(skillTest(), "equipment")] })).toBe(false);
  });

  test("ignores fields the server adds later", () => {
    expect(OnboardingOptions.parse({ ...options(), extra: 1 })).not.toHaveProperty("extra");
  });
});

describe("StartRequest profile", () => {
  test("parses a realistic request with a taken and a skipped test", () => {
    expect(StartRequest.parse(startRequest()).baseline).toHaveLength(2);
  });

  const withProfile = (patch: Record<string, unknown>) => ({ ...startRequest(), profile: { ...profile(), ...patch } });

  test.each([5, 12, 99])("accepts age %p", (age) => {
    expect(ok(StartRequest, withProfile({ age }))).toBe(true);
  });

  test("rejects age 4 (below 5)", () => {
    expect(ok(StartRequest, withProfile({ age: 4 }))).toBe(false);
  });

  test("rejects age 100 (above 99)", () => {
    expect(ok(StartRequest, withProfile({ age: 100 }))).toBe(false);
  });

  test.each([2, 6])("accepts daysPerWeek %p", (daysPerWeek) => {
    expect(ok(StartRequest, withProfile({ daysPerWeek }))).toBe(true);
  });

  test("rejects daysPerWeek 1 (below 2)", () => {
    expect(ok(StartRequest, withProfile({ daysPerWeek: 1 }))).toBe(false);
  });

  test("rejects daysPerWeek 7 (above 6)", () => {
    expect(ok(StartRequest, withProfile({ daysPerWeek: 7 }))).toBe(false);
  });

  test.each([10, 15, 20, 30, 45])("accepts minutesPerSession %p", (minutesPerSession) => {
    expect(ok(StartRequest, withProfile({ minutesPerSession }))).toBe(true);
  });

  test("rejects minutesPerSession 25 (not one of the five)", () => {
    expect(ok(StartRequest, withProfile({ minutesPerSession: 25 }))).toBe(false);
  });

  test.each(Object.keys(profile()))("rejects a profile missing %s", (key) => {
    expect(ok(StartRequest, { ...startRequest(), profile: without(profile(), key) })).toBe(false);
  });

  test.each(["name", "email", "birthDate"])("rejects an unknown profile key %s (no PII)", (key) => {
    expect(ok(StartRequest, withProfile({ [key]: "x" }))).toBe(false);
  });

  test("rejects an unknown top-level request key", () => {
    expect(ok(StartRequest, { ...startRequest(), extra: 1 })).toBe(false);
  });

  test("rejects a request without a profile", () => {
    expect(ok(StartRequest, without(startRequest(), "profile"))).toBe(false);
  });

  test("rejects a request without a baseline", () => {
    expect(ok(StartRequest, without(startRequest(), "baseline"))).toBe(false);
  });

  test("accepts an empty baseline (a player may take no test)", () => {
    expect(ok(StartRequest, { ...startRequest(), baseline: [] })).toBe(true);
  });

  test("puts a failing baseline field at its own pointer", () => {
    const bad = { ...startRequest(), baseline: [takenTest(), { ...takenTest(), clientUuid: "abc" }] };
    const result = StartRequest.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["baseline", 1, "clientUuid"]);
  });
});

describe("BaselineResult", () => {
  test("a taken test with value, attempts and errors parses", () => {
    expect(BaselineResult.parse(takenTest())).toMatchObject({ value: 14, attempts: 3, errors: 0 });
  });

  test("attempts, errors and skipped are optional", () => {
    expect(ok(BaselineResult, { testSlug: "juggling-max-touches", value: 14, clientUuid: UUID_A })).toBe(true);
  });

  test("a skipped test sent with value 0 parses", () => {
    expect(BaselineResult.parse(skippedTest())).toMatchObject({ value: 0, skipped: true });
  });

  test("a value of 0 is a real result", () => {
    expect(ok(BaselineResult, { ...takenTest(), value: 0 })).toBe(true);
  });

  test("value is required, even on a skipped test", () => {
    expect(ok(BaselineResult, without(skippedTest(), "value"))).toBe(false);
  });

  test("rejects a non-numeric value", () => {
    expect(ok(BaselineResult, { ...takenTest(), value: "14" })).toBe(false);
  });

  test("rejects a non-boolean skipped flag", () => {
    expect(ok(BaselineResult, { ...skippedTest(), skipped: "yes" })).toBe(false);
  });

  test("rejects a missing clientUuid", () => {
    expect(ok(BaselineResult, without(takenTest(), "clientUuid"))).toBe(false);
  });

  test("rejects a clientUuid that is not a uuid", () => {
    expect(ok(BaselineResult, { ...takenTest(), clientUuid: "abc" })).toBe(false);
  });

  test("rejects a missing testSlug", () => {
    expect(ok(BaselineResult, without(takenTest(), "testSlug"))).toBe(false);
  });

  test("rejects a fractional attempts count", () => {
    expect(ok(BaselineResult, { ...takenTest(), attempts: 1.5 })).toBe(false);
  });

  test("rejects a negative errors count", () => {
    expect(ok(BaselineResult, { ...takenTest(), errors: -1 })).toBe(false);
  });

  test("rejects an unknown key", () => {
    expect(ok(BaselineResult, { ...takenTest(), notes: "x" })).toBe(false);
  });

  test("a batch has no maximum size", () => {
    const baseline = Array.from({ length: 100 }, () => ({ ...takenTest(), clientUuid: crypto.randomUUID() }));
    expect(ok(StartRequest, { ...startRequest(), baseline })).toBe(true);
  });
});

describe("StartResponse", () => {
  test("parses a realistic response", () => {
    expect(StartResponse.parse(startResponse()).roadmap.weeks).toBe(4);
  });

  test("rejects a response without a roadmap", () => {
    expect(ok(StartResponse, without(startResponse(), "roadmap"))).toBe(false);
  });

  test("rejects a response without a profile", () => {
    expect(ok(StartResponse, without(startResponse(), "profile"))).toBe(false);
  });

  test("a server-added profile key (id) is stripped, not rejected", () => {
    const parsed = StartResponse.parse({ ...startResponse(), profile: { ...profile(), id: "p_1" } });
    expect(parsed.profile).not.toHaveProperty("id");
    expect(parsed.profile.age).toBe(12);
  });

  test("the response profile still enforces the age bound", () => {
    expect(ok(StartResponse, { ...startResponse(), profile: { ...profile(), age: 4 } })).toBe(false);
  });

  test("the roadmap is the domain Roadmap (a 5-week plan is rejected)", () => {
    expect(ok(StartResponse, { ...startResponse(), roadmap: { ...roadmap(), weeks: 5 } })).toBe(false);
  });

  test("ignores fields the server adds later", () => {
    expect(StartResponse.parse({ ...startResponse(), extra: 1 })).not.toHaveProperty("extra");
  });
});

describe("ENDPOINTS", () => {
  test("getOptions is the anonymous GET /api/onboarding/:sport", () => {
    expect(ENDPOINTS.getOptions).toMatchObject({ method: "GET", path: "/api/onboarding/:sport", public: true });
    expect(ENDPOINTS.getOptions.response).toBe(OnboardingOptions);
  });

  test("start is POST /api/player/start and is not anonymous", () => {
    expect(ENDPOINTS.start).toMatchObject({ method: "POST", path: "/api/player/start" });
    expect(ENDPOINTS.start.request).toBe(StartRequest);
    expect(ENDPOINTS.start.response).toBe(StartResponse);
    expect("public" in ENDPOINTS.start).toBe(false);
  });

  test("every :param in the getOptions path has a params key", () => {
    const names = [...ENDPOINTS.getOptions.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    expect(names).toEqual(Object.keys(ENDPOINTS.getOptions.params.shape));
  });

  test("the sport param is required", () => {
    expect(ok(ENDPOINTS.getOptions.params, { sport: "football" })).toBe(true);
    expect(ok(ENDPOINTS.getOptions.params, {})).toBe(false);
  });

  test("the locale query is optional and must be a known locale", () => {
    expect(ok(ENDPOINTS.getOptions.query, {})).toBe(true);
    expect(ok(ENDPOINTS.getOptions.query, { locale: "kk" })).toBe(true);
    expect(ok(ENDPOINTS.getOptions.query, { locale: "de" })).toBe(false);
  });

  test("the mutation carries no locale query (it relies on Accept-Language)", () => {
    expect("query" in ENDPOINTS.start).toBe(false);
  });
});

describe("web-bundle safety", () => {
  test("onboarding.ts imports only zod, ./primitives and ./domain", () => {
    const source = readFileSync(join(import.meta.dir, "onboarding.ts"), "utf8");
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
