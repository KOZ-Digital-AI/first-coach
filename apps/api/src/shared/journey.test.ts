import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DAYS_PER_WEEK, MINUTES_PER_SESSION } from "./domain";
import type { PlayerProfileView, Roadmap } from "./domain";
import {
  ENDPOINTS,
  Journey,
  JourneyQuery,
  PatchProfileRequest,
  PatchProfileResponse,
  ResetPlanResponse,
  TestResultsRequest,
  TestResultsResponse,
} from "./journey";
import type { Journey as JourneyType } from "./journey";

// --- Local factories: a realistic payload, then ONE violation per negative case ------

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = (value: object, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const AT = "2026-09-14T10:00:00Z";
const UUID_A = "3f2b8c1e-5d4a-4b7e-9a61-0c2d7e8f9a10";
const UUID_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const makeJourney = (): JourneyType => ({
  metrics: { sessionsCompleted: 7, minutesTrained: 140, streakDays: 3, skillsImproving: 2 },
  tree: [
    {
      track: "juggling",
      nodes: [
        { slug: "bounce-juggle", name: "Bounce juggle", state: "mastered", level: 1 },
        { slug: "juggle-ladder", name: "Ladder 3-5-7", state: "training", level: 2 },
        { slug: "alternating-feet", name: "Alternating feet", state: "locked", level: 3 },
      ],
    },
  ],
  tests: [
    {
      testSlug: "juggling-max-touches",
      name: "Juggling",
      unit: "touches",
      direction: "higher",
      history: [
        { value: 14, at: AT },
        { value: 21, at: "2026-09-21T10:00:00Z" },
      ],
      previous: 14,
      latest: 21,
      changePct: 50,
      personalBest: 21,
      retestDueAt: "2026-09-28T10:00:00Z",
    },
  ],
  milestones: [{ key: "first-session", achievedAt: AT }, { key: "ten-sessions" }],
  retestsDue: ["wall-pass-60"],
});

const makeProfile = (): PlayerProfileView => ({
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

const makeRoadmap = (): Roadmap => ({
  currentLevelLabel: "Foundation",
  tracks: [{ skill: "ball", level: 2, source: "test" }],
  goal: "control",
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: "passing", level: 1, targetLevel: 2, reason: "Weakest area." },
    { skill: "ball", level: 2, targetLevel: 3, reason: "Your goal." },
  ],
});

const makeResult = () => ({ testSlug: "juggling-max-touches", value: 21, attempts: 3, errors: 0, clientUuid: UUID_A });

/** The journey with `patch` merged into its single test row. */
const journeyWithTest = (patch: Record<string, unknown>) => {
  const journey = makeJourney();
  return { ...journey, tests: [{ ...journey.tests[0], ...patch }] };
};

/** The journey with its first tree node replaced by `node`. */
const journeyWithNode = (node: Record<string, unknown>) => ({
  ...makeJourney(),
  tree: [{ track: "juggling", nodes: [node] }],
});

// --- Journey (GET /api/player/journey) -----------------------------------------------

describe("Journey: one response for the whole dashboard", () => {
  test("parses a realistic dashboard and keeps the values", () => {
    const parsed = Journey.parse(makeJourney());
    expect(parsed.metrics).toEqual({ sessionsCompleted: 7, minutesTrained: 140, streakDays: 3, skillsImproving: 2 });
    expect(parsed.tree[0]?.nodes).toHaveLength(3);
    expect(parsed.tests[0]?.changePct).toBe(50);
    expect(parsed.tests[0]?.history).toHaveLength(2);
    expect(parsed.milestones[0]?.achievedAt).toBe(AT);
    expect(parsed.retestsDue).toEqual(["wall-pass-60"]);
  });

  test("a brand-new player's dashboard (all empty lists, zero metrics) parses", () => {
    const empty = {
      metrics: { sessionsCompleted: 0, minutesTrained: 0, streakDays: 0, skillsImproving: 0 },
      tree: [],
      tests: [],
      milestones: [],
      retestsDue: [],
    };
    expect(ok(Journey, empty)).toBe(true);
  });

  test.each(["metrics", "tree", "tests", "milestones", "retestsDue"])("rejects a journey missing %s", (key) => {
    expect(ok(Journey, without(makeJourney(), key))).toBe(false);
  });

  test("unknown server keys are stripped at the top level and inside a test row", () => {
    const journey = makeJourney();
    const parsed = Journey.parse({ ...journey, extra: 1, tests: [{ ...journey.tests[0], serverOnly: true }] });
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed.tests[0]).not.toHaveProperty("serverOnly");
  });
});

describe("Journey.metrics", () => {
  test.each(["sessionsCompleted", "minutesTrained", "streakDays", "skillsImproving"])("rejects metrics missing %s", (key) => {
    expect(ok(Journey, { ...makeJourney(), metrics: without(makeJourney().metrics, key) })).toBe(false);
  });

  test.each(["sessionsCompleted", "minutesTrained", "streakDays", "skillsImproving"])("rejects a negative %s", (key) => {
    expect(ok(Journey, { ...makeJourney(), metrics: { ...makeJourney().metrics, [key]: -1 } })).toBe(false);
  });

  test.each(["sessionsCompleted", "minutesTrained", "streakDays", "skillsImproving"])("rejects a fractional %s", (key) => {
    expect(ok(Journey, { ...makeJourney(), metrics: { ...makeJourney().metrics, [key]: 2.5 } })).toBe(false);
  });

  test("a zero streak is valid (the streak broke)", () => {
    expect(ok(Journey, { ...makeJourney(), metrics: { ...makeJourney().metrics, streakDays: 0 } })).toBe(true);
  });
});

describe("Journey.tree", () => {
  test.each(["mastered", "training", "locked"])("accepts node state %p", (state) => {
    const parsed = Journey.parse(journeyWithNode({ slug: "a", name: "A", state, level: 1 }));
    expect(parsed.tree[0]?.nodes[0]?.state).toBe(state);
  });

  test("rejects the node state 'expired'", () => {
    expect(ok(Journey, journeyWithNode({ slug: "a", name: "A", state: "expired", level: 1 }))).toBe(false);
  });

  test.each(["slug", "name", "state", "level"])("rejects a tree node missing %s", (key) => {
    expect(ok(Journey, journeyWithNode(without(makeJourney().tree[0]!.nodes[0]!, key)))).toBe(false);
  });

  test("rejects a track with no nodes key", () => {
    expect(ok(Journey, { ...makeJourney(), tree: [{ track: "juggling" }] })).toBe(false);
  });

  test("rejects a track with no track slug", () => {
    expect(ok(Journey, { ...makeJourney(), tree: [{ nodes: [] }] })).toBe(false);
  });

  test("rejects a negative node level", () => {
    expect(ok(Journey, journeyWithNode({ slug: "a", name: "A", state: "training", level: -1 }))).toBe(false);
  });

  test("rejects a fractional node level", () => {
    expect(ok(Journey, journeyWithNode({ slug: "a", name: "A", state: "training", level: 1.5 }))).toBe(false);
  });

  test("rejects a blank node name", () => {
    expect(ok(Journey, journeyWithNode({ slug: "a", name: "", state: "training", level: 1 }))).toBe(false);
  });

  test("a track may have no nodes yet", () => {
    expect(ok(Journey, { ...makeJourney(), tree: [{ track: "juggling", nodes: [] }] })).toBe(true);
  });
});

describe("Journey.tests", () => {
  // tests[] lists only tests with at least one result, so personalBest is always present.
  test.each(["testSlug", "name", "unit", "direction", "history", "personalBest"])("rejects a test row missing %s", (key) => {
    expect(ok(Journey, { ...makeJourney(), tests: [without(makeJourney().tests[0]!, key)] })).toBe(false);
  });

  test("a test taken once carries only the required fields (previous, latest, changePct, retestDueAt omitted)", () => {
    const first = {
      testSlug: "wall-pass-60",
      name: "Wall passes",
      unit: "passes",
      direction: "higher",
      history: [{ value: 9, at: AT }],
      personalBest: 9,
    };
    const parsed = Journey.parse({ ...makeJourney(), tests: [first] });
    expect(parsed.tests[0]?.personalBest).toBe(9);
    expect(parsed.tests[0]?.previous).toBeUndefined();
    expect(parsed.tests[0]?.changePct).toBeUndefined();
  });

  test.each(["previous", "latest", "changePct", "retestDueAt"])("%s is optional", (key) => {
    expect(ok(Journey, journeyWithTest({ [key]: undefined }))).toBe(true);
  });

  test("a negative changePct is a real regression, not an error", () => {
    expect(Journey.parse(journeyWithTest({ changePct: -12.5 })).tests[0]?.changePct).toBe(-12.5);
  });

  test.each(["higher", "lower"])("accepts direction %p", (direction) => {
    expect(Journey.parse(journeyWithTest({ direction })).tests[0]?.direction).toBe(direction);
  });

  test("rejects an unknown direction", () => {
    expect(ok(Journey, journeyWithTest({ direction: "up" }))).toBe(false);
  });

  test("rejects a history point with no timestamp", () => {
    expect(ok(Journey, journeyWithTest({ history: [{ value: 3 }] }))).toBe(false);
  });

  test("rejects a history point with no value", () => {
    expect(ok(Journey, journeyWithTest({ history: [{ at: AT }] }))).toBe(false);
  });

  test("rejects a history point with a non-timestamp 'at'", () => {
    expect(ok(Journey, journeyWithTest({ history: [{ value: 3, at: "Monday" }] }))).toBe(false);
  });

  test("rejects a history point with a non-numeric value", () => {
    expect(ok(Journey, journeyWithTest({ history: [{ value: "3", at: AT }] }))).toBe(false);
  });

  test("rejects a non-timestamp retestDueAt", () => {
    expect(ok(Journey, journeyWithTest({ retestDueAt: "next week" }))).toBe(false);
  });

  test("rejects a non-numeric personalBest", () => {
    expect(ok(Journey, journeyWithTest({ personalBest: "21" }))).toBe(false);
  });

  test("rejects a blank unit", () => {
    expect(ok(Journey, journeyWithTest({ unit: "" }))).toBe(false);
  });
});

describe("Journey.milestones and retestsDue", () => {
  test("a milestone without achievedAt is not yet achieved and parses", () => {
    const parsed = Journey.parse({ ...makeJourney(), milestones: [{ key: "ten-sessions" }] });
    expect(parsed.milestones[0]?.achievedAt).toBeUndefined();
  });

  test("rejects a milestone without a key", () => {
    expect(ok(Journey, { ...makeJourney(), milestones: [{ achievedAt: AT }] })).toBe(false);
  });

  test("rejects a milestone whose achievedAt is not a timestamp", () => {
    expect(ok(Journey, { ...makeJourney(), milestones: [{ key: "x", achievedAt: "soon" }] })).toBe(false);
  });

  test("retestsDue is a list of test slugs and may be empty", () => {
    expect(ok(Journey, { ...makeJourney(), retestsDue: [] })).toBe(true);
    expect(Journey.parse({ ...makeJourney(), retestsDue: ["a", "b"] }).retestsDue).toEqual(["a", "b"]);
  });

  test("rejects a retestsDue entry that is not a string", () => {
    expect(ok(Journey, { ...makeJourney(), retestsDue: [1] })).toBe(false);
  });
});

describe("Journey compares the player only with themselves", () => {
  const FORBIDDEN = /rank|percentile|leaderboard|others|peer|cohort|compar|versus/i;

  /** Every property name anywhere in a JSON Schema document. */
  const propertyNames = (node: unknown, into = new Set<string>()): Set<string> => {
    if (Array.isArray(node)) {
      for (const item of node) propertyNames(item, into);
    } else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "properties" && value !== null && typeof value === "object") {
          for (const name of Object.keys(value)) into.add(name);
        }
        propertyNames(value, into);
      }
    }
    return into;
  };

  test("the key walker sees the schema and would catch a comparison field", () => {
    const seen = propertyNames(z.toJSONSchema(Journey, { io: "output" }));
    expect(seen.has("personalBest")).toBe(true);
    expect(seen.has("streakDays")).toBe(true);
    expect(seen.has("retestsDue")).toBe(true);
    const bad = propertyNames(z.toJSONSchema(z.object({ vsOthersPercentile: z.number() }), { io: "output" }));
    expect([...bad].some((name) => FORBIDDEN.test(name))).toBe(true);
  });

  test("no Journey key mentions rank, percentile, leaderboard, others, peers, cohort or comparison", () => {
    const names = propertyNames(z.toJSONSchema(Journey, { io: "output" }));
    expect([...names].filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});

// --- POST /api/player/test-results ----------------------------------------------------------

describe("TestResultsRequest: batch retest", () => {
  test("parses a batch with two results", () => {
    const request = { results: [makeResult(), { ...makeResult(), testSlug: "wall-pass-60", clientUuid: UUID_B }] };
    const parsed = TestResultsRequest.parse(request);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[1]?.clientUuid).toBe(UUID_B);
  });

  test("attempts and errors are optional", () => {
    const parsed = TestResultsRequest.parse({ results: [{ testSlug: "a", value: 1, clientUuid: UUID_A }] });
    expect(parsed.results[0]?.attempts).toBeUndefined();
    expect(parsed.results[0]?.errors).toBeUndefined();
  });

  test("a batch larger than any small number has no maximum", () => {
    const results = Array.from({ length: 500 }, (_, index) => ({
      testSlug: "a",
      value: index,
      clientUuid: crypto.randomUUID(),
    }));
    expect(ok(TestResultsRequest, { results })).toBe(true);
  });

  test("rejects an empty batch", () => {
    expect(ok(TestResultsRequest, { results: [] })).toBe(false);
  });

  test("rejects a request with no results key", () => {
    expect(ok(TestResultsRequest, {})).toBe(false);
  });

  test("rejects a result with no value", () => {
    expect(ok(TestResultsRequest, { results: [without(makeResult(), "value")] })).toBe(false);
  });

  test("rejects a result with no clientUuid (idempotency key)", () => {
    expect(ok(TestResultsRequest, { results: [without(makeResult(), "clientUuid")] })).toBe(false);
  });

  test("rejects a result whose clientUuid is not a uuid", () => {
    expect(ok(TestResultsRequest, { results: [{ ...makeResult(), clientUuid: "1" }] })).toBe(false);
  });

  test("rejects a result with no testSlug", () => {
    expect(ok(TestResultsRequest, { results: [without(makeResult(), "testSlug")] })).toBe(false);
  });

  test("rejects a non-numeric value", () => {
    expect(ok(TestResultsRequest, { results: [{ ...makeResult(), value: "21" }] })).toBe(false);
  });

  test("rejects a negative errors count", () => {
    expect(ok(TestResultsRequest, { results: [{ ...makeResult(), errors: -1 }] })).toBe(false);
  });

  test("rejects a fractional attempts count", () => {
    expect(ok(TestResultsRequest, { results: [{ ...makeResult(), attempts: 1.5 }] })).toBe(false);
  });

  test("rejects an unknown key on a result", () => {
    expect(ok(TestResultsRequest, { results: [{ ...makeResult(), skipped: true }] })).toBe(false);
  });

  test("rejects an unknown key on the request", () => {
    expect(ok(TestResultsRequest, { results: [makeResult()], extra: 1 })).toBe(false);
  });
});

describe("TestResultsResponse: the updated journey and roadmap", () => {
  test("parses journey and roadmap", () => {
    const parsed = TestResultsResponse.parse({ journey: makeJourney(), roadmap: makeRoadmap() });
    expect(parsed.journey.metrics.sessionsCompleted).toBe(7);
    expect(parsed.roadmap.weeks).toBe(4);
  });

  test("rejects a response with no journey", () => {
    expect(ok(TestResultsResponse, { roadmap: makeRoadmap() })).toBe(false);
  });

  test("rejects a response with no roadmap", () => {
    expect(ok(TestResultsResponse, { journey: makeJourney() })).toBe(false);
  });

  test("rejects a null roadmap (a retest always has a plan)", () => {
    expect(ok(TestResultsResponse, { journey: makeJourney(), roadmap: null })).toBe(false);
  });

  test("unknown server keys are stripped", () => {
    const parsed = TestResultsResponse.parse({ journey: makeJourney(), roadmap: makeRoadmap(), extra: 1 });
    expect(parsed).not.toHaveProperty("extra");
  });
});

// --- PATCH /api/player/profile ----------------------------------------------------------------

describe("PatchProfileRequest", () => {
  const full = {
    goal: "passing",
    equipment: "cones",
    space: "field",
    partner: true,
    daysPerWeek: 4,
    minutesPerSession: 30,
    locale: "kk",
  } as const;

  test("all seven listed fields parse together and keep their values", () => {
    expect(PatchProfileRequest.parse(full)).toEqual(full);
  });

  test.each(Object.entries(full))("%s alone is a valid patch", (key, value) => {
    expect(PatchProfileRequest.parse({ [key]: value })).toEqual({ [key]: value });
  });

  test("an empty patch parses (nothing to change)", () => {
    expect(PatchProfileRequest.parse({})).toEqual({});
  });

  test("age cannot be patched", () => {
    expect(ok(PatchProfileRequest, { age: 12 })).toBe(false);
  });

  test("level cannot be patched", () => {
    expect(ok(PatchProfileRequest, { level: "basic" })).toBe(false);
  });

  test.each(["name", "email", "birthDate"])("an unknown key %s is rejected", (key) => {
    expect(ok(PatchProfileRequest, { [key]: "x" })).toBe(false);
  });

  test("rejects an unknown goal", () => {
    expect(ok(PatchProfileRequest, { goal: "shooting" })).toBe(false);
  });

  test("rejects an unknown equipment", () => {
    expect(ok(PatchProfileRequest, { equipment: "markers" })).toBe(false);
  });

  test("rejects an unknown space", () => {
    expect(ok(PatchProfileRequest, { space: "room" })).toBe(false);
  });

  test("rejects a non-boolean partner", () => {
    expect(ok(PatchProfileRequest, { partner: "yes" })).toBe(false);
  });

  test("rejects daysPerWeek above the maximum", () => {
    expect(ok(PatchProfileRequest, { daysPerWeek: DAYS_PER_WEEK[DAYS_PER_WEEK.length - 1] + 1 })).toBe(false);
  });

  test("rejects daysPerWeek below the minimum", () => {
    expect(ok(PatchProfileRequest, { daysPerWeek: DAYS_PER_WEEK[0] - 1 })).toBe(false);
  });

  test("rejects a minutesPerSession that is not an offered length", () => {
    const offered = new Set<number>(MINUTES_PER_SESSION);
    const notOffered = [7, 25, 60].find((minutes) => !offered.has(minutes));
    expect(notOffered).toBeDefined();
    expect(ok(PatchProfileRequest, { minutesPerSession: notOffered })).toBe(false);
  });

  test("rejects an unknown locale", () => {
    expect(ok(PatchProfileRequest, { locale: "de" })).toBe(false);
  });
});

describe("PatchProfileResponse: the updated profile and roadmap", () => {
  test("parses a profile with a roadmap", () => {
    const parsed = PatchProfileResponse.parse({ profile: makeProfile(), roadmap: makeRoadmap() });
    expect(parsed.profile.goal).toBe("control");
    expect(parsed.roadmap?.weeks).toBe(4);
  });

  test("a null roadmap parses (a patch after a plan reset has no roadmap yet)", () => {
    const parsed = PatchProfileResponse.parse({ profile: makeProfile(), roadmap: null });
    expect(parsed.roadmap).toBeNull();
  });

  test("rejects a response with the roadmap key missing (null, not omitted)", () => {
    expect(ok(PatchProfileResponse, { profile: makeProfile() })).toBe(false);
  });

  test("rejects a response with no profile", () => {
    expect(ok(PatchProfileResponse, { roadmap: makeRoadmap() })).toBe(false);
  });

  test("rejects a profile missing a field", () => {
    expect(ok(PatchProfileResponse, { profile: without(makeProfile(), "age"), roadmap: null })).toBe(false);
  });

  test("rejects an invalid roadmap", () => {
    expect(ok(PatchProfileResponse, { profile: makeProfile(), roadmap: { ...makeRoadmap(), weeks: 3 } })).toBe(false);
  });

  test("unknown server keys on the profile are stripped, not rejected", () => {
    const parsed = PatchProfileResponse.parse({ profile: { ...makeProfile(), id: "p1" }, roadmap: null });
    expect(parsed.profile).not.toHaveProperty("id");
  });
});

// --- POST /api/player/plan/reset ------------------------------------------------------------------

describe("ResetPlanResponse: redo the baseline", () => {
  test("returns the profile and a null roadmap", () => {
    const parsed = ResetPlanResponse.parse({ profile: makeProfile(), roadmap: null });
    expect(parsed.roadmap).toBeNull();
    expect(parsed.profile.age).toBe(12);
  });

  test("rejects a non-null roadmap", () => {
    expect(ok(ResetPlanResponse, { profile: makeProfile(), roadmap: makeRoadmap() })).toBe(false);
  });

  test("rejects a response with the roadmap key missing (null, not omitted)", () => {
    expect(ok(ResetPlanResponse, { profile: makeProfile() })).toBe(false);
  });

  test("rejects a response with no profile", () => {
    expect(ok(ResetPlanResponse, { roadmap: null })).toBe(false);
  });

  test("rejects a profile missing a field", () => {
    expect(ok(ResetPlanResponse, { profile: without(makeProfile(), "level"), roadmap: null })).toBe(false);
  });
});

// --- ENDPOINTS --------------------------------------------------------------------------------------

describe("ENDPOINTS", () => {
  test("getJourney: GET /api/player/journey with an optional ?locale, answering Journey", () => {
    expect(ENDPOINTS.getJourney).toMatchObject({ method: "GET", path: "/api/player/journey" });
    expect(ENDPOINTS.getJourney.response).toBe(Journey);
    expect(ENDPOINTS.getJourney.query).toBe(JourneyQuery);
    expect(ok(JourneyQuery, {})).toBe(true);
    expect(JourneyQuery.parse({ locale: "kk" })).toEqual({ locale: "kk" });
  });

  test("the journey query rejects an unknown locale", () => {
    expect(ok(JourneyQuery, { locale: "de" })).toBe(false);
  });

  test("the journey query rejects an unknown key", () => {
    expect(ok(JourneyQuery, { locale: "kk", page: 2 })).toBe(false);
  });

  test("postTestResults: POST /api/player/test-results", () => {
    expect(ENDPOINTS.postTestResults).toMatchObject({ method: "POST", path: "/api/player/test-results" });
    expect(ENDPOINTS.postTestResults.request).toBe(TestResultsRequest);
    expect(ENDPOINTS.postTestResults.response).toBe(TestResultsResponse);
  });

  test("patchProfile: PATCH /api/player/profile", () => {
    expect(ENDPOINTS.patchProfile).toMatchObject({ method: "PATCH", path: "/api/player/profile" });
    expect(ENDPOINTS.patchProfile.request).toBe(PatchProfileRequest);
    expect(ENDPOINTS.patchProfile.response).toBe(PatchProfileResponse);
  });

  test("resetPlan: POST /api/player/plan/reset with no request body", () => {
    expect(ENDPOINTS.resetPlan).toMatchObject({ method: "POST", path: "/api/player/plan/reset" });
    expect(ENDPOINTS.resetPlan.response).toBe(ResetPlanResponse);
    expect(ENDPOINTS.resetPlan).not.toHaveProperty("request");
  });

  test("every endpoint is authenticated (none is marked public)", () => {
    for (const endpoint of Object.values(ENDPOINTS)) expect(endpoint).not.toHaveProperty("public");
  });

  test("locale is a query on the GET only; mutations carry no locale query", () => {
    for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
      if (name !== "getJourney") expect(endpoint).not.toHaveProperty("query");
    }
  });
});

// --- Web-bundle safety ----------------------------------------------------------------------------------

describe("web-bundle safety", () => {
  const source = readFileSync(join(import.meta.dir, "journey.ts"), "utf8");

  test("imports only zod, ./primitives and ./domain", () => {
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/^\s*import\s+(["'])([^"']+)\1/gm),
      ...source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(["zod", "./primitives", "./domain"]).toContain(specifier);
  });

  test("does not use toJSONSchema (only the test walks the JSON Schema)", () => {
    expect(source).not.toContain("toJSONSchema");
  });
});
