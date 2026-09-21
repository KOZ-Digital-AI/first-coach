import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  AI_FALLBACK_CODES,
  AI_UNAVAILABLE,
  AiFallbackCode,
  AiPlan,
  AiPlanRequest,
  AiPlanResponse,
  ENDPOINTS,
  ExplainParams,
  ExplainRequest,
  ExplainResponse,
} from "./ai";
import { ProblemDetails } from "./primitives";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

// --- Local factories: realistic payloads, one field varied per negative case ------------------

const makeContent = (): Record<string, unknown> => ({
  title: { ru: "Слабая нога 50", en: "Weak Foot 50" },
  goal: { ru: "Улучшить контроль слабой ногой", en: "Control with the weaker foot" },
  instructions: { ru: "50 касаний внутренней стороной.", en: "50 inside touches." },
  dose: { reps: 50 },
  conditions: { equipment: "ball", spaces: ["yard"] },
});

const makeAttribution = (): Record<string, unknown> => ({
  author: "FIRST COACH Genesis",
  source: "FIRST COACH Genesis",
  license: "CC-BY-SA-4.0",
  createdAt: "2026-09-01T10:00:00Z",
  semver: "1.0.0",
});

const makeItem = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemId: "item-1",
  drillVersionId: "weak-foot-50-v1",
  minutes: 5,
  reason: "Your ankle is tired, so this drill keeps the load light",
  done: false,
  content: makeContent(),
  status: "COMMUNITY",
  attribution: makeAttribution(),
  ...patch,
});

const makeRoadmapSummary = (): Record<string, unknown> => ({
  currentLevelLabel: "Foundation",
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: "weakfoot", level: 1, targetLevel: 2, reason: "Your stated goal." },
    { skill: "passing", level: 1, targetLevel: 2, reason: "One of the weakest areas." },
  ],
});

const makeSession = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "s-2026-09-21",
  date: "2026-09-21",
  planner: "ai",
  totalMinutes: 10,
  graphVersion: "0.1.0",
  items: [
    makeItem(),
    makeItem({ itemId: "item-2", drillVersionId: "wall-passes-v2", reason: "Passing is next on your roadmap" }),
  ],
  roadmapSummary: makeRoadmapSummary(),
  ...patch,
});

/** An AI-planned session: planner "ai", a reason on every item, no fallback. */
const makeAiSession = (patch: Record<string, unknown> = {}): Record<string, unknown> => makeSession(patch);

/** The unchanged deterministic session: planner "rules", items carry no AI reason, plus the fallback. */
const makeRulesSession = (patch: Record<string, unknown> = {}): Record<string, unknown> =>
  makeSession({
    planner: "rules",
    items: [makeItem({ reason: undefined }), makeItem({ itemId: "item-2", drillVersionId: "wall-passes-v2", reason: undefined })],
    fallback: { code: "timeout" },
    ...patch,
  });

const makePlan = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  items: [
    { drillVersionId: "weak-foot-50-v1", minutes: 5, reason: "Light on the ankle" },
    { drillVersionId: "wall-passes-v2", minutes: 10, reason: "Passing is next on your roadmap" },
  ],
  ...patch,
});

const makePlanItem = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  drillVersionId: "weak-foot-50-v1",
  minutes: 5,
  reason: "Light on the ankle",
  ...patch,
});

const makeExplainResponse = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  text: "Touch the ball 50 times with the inside of your weaker foot.",
  aiGenerated: true,
  basedOnVersionId: "weak-foot-50-v1",
  ...patch,
});

// --- AiPlanRequest ---------------------------------------------------------------------------

describe("AiPlanRequest", () => {
  test("parses a note", () => {
    expect(AiPlanRequest.parse({ note: "my ankle is tired" })).toEqual({ note: "my ankle is tired" });
  });

  test("the note is optional", () => {
    expect(ok(AiPlanRequest, {})).toBe(true);
  });

  test("accepts a note of exactly 200 characters", () => {
    expect(ok(AiPlanRequest, { note: "a".repeat(200) })).toBe(true);
  });

  test("rejects a note of 201 characters", () => {
    expect(ok(AiPlanRequest, { note: "a".repeat(201) })).toBe(false);
  });

  test("rejects a non-string note", () => {
    expect(ok(AiPlanRequest, { note: 42 })).toBe(false);
  });

  test("rejects an unknown key", () => {
    expect(ok(AiPlanRequest, { note: "my ankle is tired", extra: true })).toBe(false);
  });
});

// --- AiFallbackCode --------------------------------------------------------------------------

describe("AiFallbackCode", () => {
  test("the code tuple is exactly the five criteria codes", () => {
    expect([...AI_FALLBACK_CODES]).toEqual(["no_key", "disabled", "timeout", "invalid_output", "provider_error"]);
  });

  test.each(["no_key", "disabled", "timeout", "invalid_output", "provider_error"])("accepts %p", (code) => {
    expect(ok(AiFallbackCode, code)).toBe(true);
  });

  test("rejects an unknown code", () => {
    expect(ok(AiFallbackCode, "quota_exceeded")).toBe(false);
  });
});

// --- AiPlanResponse --------------------------------------------------------------------------

describe("AiPlanResponse", () => {
  test("parses an AI-planned session with a reason on every item", () => {
    const parsed = AiPlanResponse.parse(makeAiSession());
    expect(parsed.planner).toBe("ai");
    expect(parsed.items.map((item) => item.reason)).toEqual([
      "Your ankle is tired, so this drill keeps the load light",
      "Passing is next on your roadmap",
    ]);
  });

  test("parses the deterministic session as planner rules with a fallback code", () => {
    expect(AiPlanResponse.parse(makeRulesSession())).toMatchObject({
      planner: "rules",
      fallback: { code: "timeout" },
    });
  });

  test("a rules session's items need no reason", () => {
    const parsed = AiPlanResponse.parse(makeRulesSession());
    expect(parsed.items.every((item) => item.reason === undefined)).toBe(true);
  });

  test.each([...AI_FALLBACK_CODES])("a rules session accepts fallback code %p", (code) => {
    expect(ok(AiPlanResponse, makeRulesSession({ fallback: { code } }))).toBe(true);
  });

  test("strips unknown server keys inside the fallback", () => {
    const parsed = AiPlanResponse.parse(makeRulesSession({ fallback: { code: "no_key", retryAfter: 30 } }));
    if (parsed.planner !== "rules") throw new Error("expected the rules variant");
    expect(parsed.fallback).toEqual({ code: "no_key" });
  });

  test("rejects an AI item without a reason", () => {
    const items = [makeItem(), without(makeItem({ itemId: "item-2", drillVersionId: "wall-passes-v2" }), "reason")];
    expect(ok(AiPlanResponse, makeAiSession({ items }))).toBe(false);
  });

  test("rejects an AI item with a blank reason", () => {
    const items = [makeItem(), makeItem({ itemId: "item-2", drillVersionId: "wall-passes-v2", reason: "" })];
    expect(ok(AiPlanResponse, makeAiSession({ items }))).toBe(false);
  });

  test("rejects an AI-planned session that carries a fallback", () => {
    expect(ok(AiPlanResponse, makeAiSession({ fallback: { code: "timeout" } }))).toBe(false);
  });

  test("rejects a rules session without a fallback", () => {
    expect(ok(AiPlanResponse, without(makeRulesSession(), "fallback"))).toBe(false);
  });

  test("rejects a rules session with an unknown fallback code", () => {
    expect(ok(AiPlanResponse, makeRulesSession({ fallback: { code: "quota_exceeded" } }))).toBe(false);
  });

  test("rejects a rules session whose fallback has no code", () => {
    expect(ok(AiPlanResponse, makeRulesSession({ fallback: {} }))).toBe(false);
  });

  test("rejects planner human", () => {
    expect(ok(AiPlanResponse, makeAiSession({ planner: "human" }))).toBe(false);
  });

  test("rejects a session without a planner", () => {
    expect(ok(AiPlanResponse, without(makeAiSession(), "planner"))).toBe(false);
  });

  test("still requires the rest of the session (roadmapSummary)", () => {
    expect(ok(AiPlanResponse, without(makeAiSession(), "roadmapSummary"))).toBe(false);
  });
});

// --- AiPlan (the structured output the LLM fills) --------------------------------------------

describe("AiPlan", () => {
  test("parses a plan of several items", () => {
    const parsed = AiPlan.parse(makePlan());
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]).toEqual({
      drillVersionId: "wall-passes-v2",
      minutes: 10,
      reason: "Passing is next on your roadmap",
    });
  });

  test("a single item is a plan", () => {
    expect(ok(AiPlan, makePlan({ items: [makePlanItem()] }))).toBe(true);
  });

  test("rejects an empty items list", () => {
    expect(ok(AiPlan, makePlan({ items: [] }))).toBe(false);
  });

  test("rejects a plan without items", () => {
    expect(ok(AiPlan, without(makePlan(), "items"))).toBe(false);
  });

  test("rejects zero minutes", () => {
    expect(ok(AiPlan, makePlan({ items: [makePlanItem({ minutes: 0 })] }))).toBe(false);
  });

  test("rejects fractional minutes", () => {
    expect(ok(AiPlan, makePlan({ items: [makePlanItem({ minutes: 7.5 })] }))).toBe(false);
  });

  test("rejects an item without minutes", () => {
    expect(ok(AiPlan, makePlan({ items: [without(makePlanItem(), "minutes")] }))).toBe(false);
  });

  test("rejects a blank reason", () => {
    expect(ok(AiPlan, makePlan({ items: [makePlanItem({ reason: "" })] }))).toBe(false);
  });

  test("rejects an item without a reason", () => {
    expect(ok(AiPlan, makePlan({ items: [without(makePlanItem(), "reason")] }))).toBe(false);
  });

  test("rejects a blank drillVersionId", () => {
    expect(ok(AiPlan, makePlan({ items: [makePlanItem({ drillVersionId: "" })] }))).toBe(false);
  });

  test("rejects an item without a drillVersionId", () => {
    expect(ok(AiPlan, makePlan({ items: [without(makePlanItem(), "drillVersionId")] }))).toBe(false);
  });

  test("rejects an unknown key on the plan", () => {
    expect(ok(AiPlan, makePlan({ note: "extra" }))).toBe(false);
  });

  test("rejects an unknown key on an item", () => {
    expect(ok(AiPlan, makePlan({ items: [makePlanItem({ extra: true })] }))).toBe(false);
  });
});

// --- ExplainRequest / ExplainParams ------------------------------------------------------------

describe("ExplainRequest", () => {
  test.each(["child", "default"])("parses audience %p", (audience) => {
    expect(ExplainRequest.parse({ locale: "kk", audience })).toEqual({ locale: "kk", audience });
  });

  test.each(["kk", "ru", "en"])("accepts locale %p", (locale) => {
    expect(ok(ExplainRequest, { locale, audience: "default" })).toBe(true);
  });

  test("rejects an unknown audience", () => {
    expect(ok(ExplainRequest, { locale: "en", audience: "adult" })).toBe(false);
  });

  test("rejects an unknown locale", () => {
    expect(ok(ExplainRequest, { locale: "de", audience: "child" })).toBe(false);
  });

  test("requires locale", () => {
    expect(ok(ExplainRequest, { audience: "child" })).toBe(false);
  });

  test("requires audience", () => {
    expect(ok(ExplainRequest, { locale: "en" })).toBe(false);
  });

  test("rejects an unknown key", () => {
    expect(ok(ExplainRequest, { locale: "en", audience: "child", extra: true })).toBe(false);
  });
});

describe("ExplainParams", () => {
  test("parses a versionId", () => {
    expect(ExplainParams.parse({ versionId: "weak-foot-50-v1" })).toEqual({ versionId: "weak-foot-50-v1" });
  });

  test("requires versionId", () => {
    expect(ok(ExplainParams, {})).toBe(false);
  });

  test("rejects a blank versionId", () => {
    expect(ok(ExplainParams, { versionId: "" })).toBe(false);
  });

  test("rejects an unknown key", () => {
    expect(ok(ExplainParams, { versionId: "weak-foot-50-v1", extra: true })).toBe(false);
  });
});

// --- ExplainResponse ---------------------------------------------------------------------------

describe("ExplainResponse", () => {
  test("parses an AI explanation marked aiGenerated true", () => {
    const parsed = ExplainResponse.parse(makeExplainResponse());
    expect(parsed.aiGenerated).toBe(true);
    expect(parsed.basedOnVersionId).toBe("weak-foot-50-v1");
    expect(parsed.text).toBe("Touch the ball 50 times with the inside of your weaker foot.");
  });

  test("rejects aiGenerated false", () => {
    expect(ok(ExplainResponse, makeExplainResponse({ aiGenerated: false }))).toBe(false);
  });

  test("rejects a missing aiGenerated", () => {
    expect(ok(ExplainResponse, without(makeExplainResponse(), "aiGenerated"))).toBe(false);
  });

  test("rejects blank text", () => {
    expect(ok(ExplainResponse, makeExplainResponse({ text: "" }))).toBe(false);
  });

  test("rejects missing text", () => {
    expect(ok(ExplainResponse, without(makeExplainResponse(), "text"))).toBe(false);
  });

  test("rejects a missing basedOnVersionId", () => {
    expect(ok(ExplainResponse, without(makeExplainResponse(), "basedOnVersionId"))).toBe(false);
  });

  test("rejects a blank basedOnVersionId", () => {
    expect(ok(ExplainResponse, makeExplainResponse({ basedOnVersionId: "" }))).toBe(false);
  });

  test("strips unknown server keys", () => {
    expect(ExplainResponse.parse(makeExplainResponse({ model: "x" }))).toEqual({
      text: "Touch the ball 50 times with the inside of your weaker foot.",
      aiGenerated: true,
      basedOnVersionId: "weak-foot-50-v1",
    });
  });
});

// --- The 503 problem -----------------------------------------------------------------------------

describe("ai_unavailable problem", () => {
  test("AI_UNAVAILABLE is the problem type ai_unavailable", () => {
    expect(AI_UNAVAILABLE).toBe("ai_unavailable");
  });

  test("a 503 problem body carrying it parses through primitives' ProblemDetails", () => {
    const parsed = ProblemDetails.parse({
      type: AI_UNAVAILABLE,
      title: "AI Coach is unavailable",
      status: 503,
    });
    expect(parsed.type).toBe("ai_unavailable");
    expect(parsed.status).toBe(503);
  });
});

// --- Endpoints -------------------------------------------------------------------------------

describe("ENDPOINTS", () => {
  test("aiPlan is POST /api/player/today/ai-plan answering with an AiPlanResponse", () => {
    expect(ENDPOINTS.aiPlan).toMatchObject({ method: "POST", path: "/api/player/today/ai-plan" });
    expect(ENDPOINTS.aiPlan.request).toBe(AiPlanRequest);
    expect(ENDPOINTS.aiPlan.response).toBe(AiPlanResponse);
  });

  test("explainDrill is POST /api/player/drills/:versionId/explain", () => {
    expect(ENDPOINTS.explainDrill).toMatchObject({ method: "POST", path: "/api/player/drills/:versionId/explain" });
    expect(ENDPOINTS.explainDrill.params).toBe(ExplainParams);
    expect(ENDPOINTS.explainDrill.request).toBe(ExplainRequest);
    expect(ENDPOINTS.explainDrill.response).toBe(ExplainResponse);
  });

  test("no endpoint is public (the player is signed in)", () => {
    for (const endpoint of Object.values(ENDPOINTS)) expect(endpoint).not.toHaveProperty("public");
  });
});

// --- Web-bundle safety -----------------------------------------------------------------------

describe("web-bundle safety", () => {
  test("ai.ts imports only zod, ./primitives, ./domain and ./session", () => {
    const source = readFileSync(join(import.meta.dir, "ai.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/^\s*import\s+(["'])([^"']+)\1/gm),
      ...source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(["zod", "./primitives", "./domain", "./session"]).toContain(specifier);
  });
});
