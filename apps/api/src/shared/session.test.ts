import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  ENDPOINTS,
  OFFLINE_EVENT_MAX_AGE_DAYS,
  RoadmapSummary,
  SessionEvent,
  SessionEventsRequest,
  SessionEventsResponse,
  SwapRequest,
  TodaySession,
} from "./session";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

const makeSkillTest = (): Record<string, unknown> => ({
  slug: "juggling-max-touches",
  skill: "juggling",
  metric: "Max consecutive touches",
  unit: "touches",
  direction: "higher",
  protocol: { en: "Juggle without letting the ball drop." },
  equipment: "ball",
});

const makeSession = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "s-2026-09-21",
  date: "2026-09-21",
  planner: "rules",
  totalMinutes: 20,
  graphVersion: "0.1.0",
  items: [
    makeItem({ regressionOf: "weak-foot-50-v0" }),
    makeItem({
      itemId: "item-2",
      drillVersionId: "wall-passes-v2",
      reason: "Passing is one of your weakest areas",
      progressionOf: "wall-passes-v1",
    }),
  ],
  roadmapSummary: makeRoadmapSummary(),
  ...patch,
});

const AT = "2026-09-20T09:30:00+05:00";

const makeEvent = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientUuid: uuid(1),
  sessionId: "s-2026-09-21",
  type: "drill_done",
  itemId: "item-1",
  at: AT,
  ...patch,
});

const makeProgress = (): Record<string, unknown> => ({ sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 });

const makeEventsResponse = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: makeSession(),
  progress: makeProgress(),
  nextSessionDate: "2026-09-23",
  ...patch,
});

// --- TodaySession ---------------------------------------------------------------------------

describe("TodaySession", () => {
  test("parses a full session with a regression and a progression item", () => {
    const parsed = TodaySession.parse(makeSession());
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.regressionOf).toBe("weak-foot-50-v0");
    expect(parsed.items[1]?.progressionOf).toBe("wall-passes-v1");
    expect(parsed.items[1]?.reason).toBe("Passing is one of your weakest areas");
  });

  test("keeps each item's drill content so the session trains offline", () => {
    const parsed = TodaySession.parse(makeSession());
    expect(parsed.items[0]?.content.dose).toEqual({ reps: 50 });
    expect(parsed.items[0]?.content.instructions).toEqual({
      ru: "50 касаний внутренней стороной.",
      en: "50 inside touches.",
    });
  });

  test("an empty session parses (totalMinutes 0, no items)", () => {
    expect(ok(TodaySession, makeSession({ totalMinutes: 0, items: [] }))).toBe(true);
  });

  test.each(["rules", "ai"])("accepts planner %p", (planner) => {
    expect(ok(TodaySession, makeSession({ planner }))).toBe(true);
  });

  test("rejects planner 'human'", () => {
    expect(ok(TodaySession, makeSession({ planner: "human" }))).toBe(false);
  });

  test.each(["id", "date", "planner", "totalMinutes", "graphVersion", "items", "roadmapSummary"])(
    "rejects a session missing %s",
    (key) => {
      expect(ok(TodaySession, without(makeSession(), key))).toBe(false);
    },
  );

  test("rejects a timestamp as the session date", () => {
    expect(ok(TodaySession, makeSession({ date: "2026-09-21T10:00:00Z" }))).toBe(false);
  });

  test("rejects negative totalMinutes", () => {
    expect(ok(TodaySession, makeSession({ totalMinutes: -1 }))).toBe(false);
  });

  test("rejects fractional totalMinutes", () => {
    expect(ok(TodaySession, makeSession({ totalMinutes: 20.5 }))).toBe(false);
  });

  test("graphVersion is a string", () => {
    expect(ok(TodaySession, makeSession({ graphVersion: 1 }))).toBe(false);
  });

  test("skillTest is optional", () => {
    expect(ok(TodaySession, makeSession())).toBe(true);
  });

  test("a present skillTest is a full SkillTest", () => {
    const parsed = TodaySession.parse(makeSession({ skillTest: makeSkillTest() }));
    expect(parsed.skillTest?.slug).toBe("juggling-max-touches");
  });

  test("rejects a skillTest with an unknown direction", () => {
    expect(ok(TodaySession, makeSession({ skillTest: { ...makeSkillTest(), direction: "sideways" } }))).toBe(false);
  });

  test("ignores unknown server keys instead of failing (additive server changes)", () => {
    const parsed = TodaySession.parse(makeSession({ extra: 1, items: [makeItem({ extra: 2 })] }));
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed.items[0]).not.toHaveProperty("extra");
  });
});

describe("TodaySession items", () => {
  const withItem = (item: Record<string, unknown>) => makeSession({ items: [item] });

  test.each(["itemId", "drillVersionId", "minutes", "done", "content", "status", "attribution"])(
    "rejects an item missing %s",
    (key) => {
      expect(ok(TodaySession, withItem(without(makeItem(), key)))).toBe(false);
    },
  );

  test("reason, regressionOf and progressionOf are optional", () => {
    const parsed = TodaySession.parse(withItem(makeItem()));
    expect(parsed.items[0]?.reason).toBeUndefined();
    expect(parsed.items[0]?.regressionOf).toBeUndefined();
    expect(parsed.items[0]?.progressionOf).toBeUndefined();
  });

  test("rejects negative item minutes", () => {
    expect(ok(TodaySession, withItem(makeItem({ minutes: -1 })))).toBe(false);
  });

  test("rejects an item whose done flag is not a boolean", () => {
    expect(ok(TodaySession, withItem(makeItem({ done: "yes" })))).toBe(false);
  });

  test("rejects a status that is not a TrustStatus", () => {
    expect(ok(TodaySession, withItem(makeItem({ status: "VERIFIED" })))).toBe(false);
  });

  test("accepts a TrustStatus other than the default", () => {
    expect(ok(TodaySession, withItem(makeItem({ status: "ACADEMY_VERIFIED" })))).toBe(true);
  });

  test("the item content is a DrillContent (an empty dose is rejected)", () => {
    expect(ok(TodaySession, withItem(makeItem({ content: { ...makeContent(), dose: {} } })))).toBe(false);
  });

  test("the item attribution is an Attribution (license is required)", () => {
    expect(ok(TodaySession, withItem(makeItem({ attribution: without(makeAttribution(), "license") })))).toBe(false);
  });

  test("the item attribution is an Attribution (license must be a known id)", () => {
    expect(ok(TodaySession, withItem(makeItem({ attribution: { ...makeAttribution(), license: "MIT" } })))).toBe(false);
  });

  test("regressionOf is an id string", () => {
    expect(ok(TodaySession, withItem(makeItem({ regressionOf: 7 })))).toBe(false);
  });

  test("progressionOf is an id string", () => {
    expect(ok(TodaySession, withItem(makeItem({ progressionOf: 7 })))).toBe(false);
  });
});

describe("roadmapSummary", () => {
  test("the summary keys are pinned to what the session screen needs", () => {
    expect(Object.keys(RoadmapSummary.shape).sort()).toEqual([
      "currentLevelLabel",
      "focus",
      "minutesPerSession",
      "sessionsPerWeek",
    ]);
  });

  test.each(["currentLevelLabel", "focus", "sessionsPerWeek", "minutesPerSession"])(
    "rejects a session whose roadmapSummary lacks %s",
    (key) => {
      expect(ok(TodaySession, makeSession({ roadmapSummary: without(makeRoadmapSummary(), key) }))).toBe(false);
    },
  );

  test("keeps the focus entries", () => {
    const parsed = TodaySession.parse(makeSession());
    expect(parsed.roadmapSummary.focus.map((f) => f.skill)).toEqual(["weakfoot", "passing"]);
    expect(parsed.roadmapSummary.sessionsPerWeek).toBe(3);
  });
});

// --- Session events -------------------------------------------------------------------------

describe("SessionEvent", () => {
  test.each(["drill_done", "drill_undone", "result", "session_finished"])("accepts type %p", (type) => {
    expect(ok(SessionEvent, makeEvent({ type }))).toBe(true);
  });

  test("rejects an unknown event type", () => {
    expect(ok(SessionEvent, makeEvent({ type: "drill_skipped" }))).toBe(false);
  });

  test.each(["drill_done", "drill_undone", "result", "session_finished"])(
    "itemId is optional for type %p",
    (type) => {
      expect(ok(SessionEvent, without(makeEvent({ type }), "itemId"))).toBe(true);
    },
  );

  test("value is optional and, when given, kept", () => {
    expect(SessionEvent.parse(without(makeEvent({ type: "result" }), "value"))).not.toHaveProperty("value");
    expect(SessionEvent.parse(makeEvent({ type: "result", value: 21 })).value).toBe(21);
  });

  test("value is a number", () => {
    expect(ok(SessionEvent, makeEvent({ type: "result", value: "21" }))).toBe(false);
  });

  test.each(["clientUuid", "sessionId", "type", "at"])("rejects an event missing %s", (key) => {
    expect(ok(SessionEvent, without(makeEvent(), key))).toBe(false);
  });

  test("clientUuid must be a uuid", () => {
    expect(ok(SessionEvent, makeEvent({ clientUuid: "not-a-uuid" }))).toBe(false);
  });

  test("clientUuid is normalised to lower case (it is the idempotency key)", () => {
    const parsed = SessionEvent.parse(makeEvent({ clientUuid: "AAAAAAAA-0000-4000-8000-000000000001" }));
    expect(parsed.clientUuid).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });

  test("at accepts an offset timestamp", () => {
    expect(ok(SessionEvent, makeEvent({ at: "2026-08-25T18:00:00-07:00" }))).toBe(true);
  });

  test("at rejects a date without a time", () => {
    expect(ok(SessionEvent, makeEvent({ at: "2026-09-20" }))).toBe(false);
  });

  test("at rejects a timestamp without an offset", () => {
    expect(ok(SessionEvent, makeEvent({ at: "2026-09-20T09:30:00" }))).toBe(false);
  });

  test("rejects an unknown key on an event", () => {
    expect(ok(SessionEvent, makeEvent({ extra: true }))).toBe(false);
  });

  test("the offline window is 30 days", () => {
    expect(OFFLINE_EVENT_MAX_AGE_DAYS).toBe(30);
  });
});

describe("SessionEventsRequest", () => {
  const mixed = [
    makeEvent({ clientUuid: uuid(1), type: "drill_done", itemId: "item-1" }),
    makeEvent({ clientUuid: uuid(2), type: "drill_undone", itemId: "item-1" }),
    makeEvent({ clientUuid: uuid(3), type: "result", itemId: "item-2", value: 21 }),
    without(makeEvent({ clientUuid: uuid(4), type: "result", value: 12 }), "itemId"),
    without(makeEvent({ clientUuid: uuid(5), type: "session_finished" }), "itemId"),
  ];

  test("a batch with all four event types mixed parses", () => {
    const parsed = SessionEventsRequest.parse({ events: mixed });
    expect(parsed.events.map((e) => e.type)).toEqual([
      "drill_done",
      "drill_undone",
      "result",
      "result",
      "session_finished",
    ]);
  });

  test("a result without itemId (the skill test) and a value-less session_finished are kept as sent", () => {
    const parsed = SessionEventsRequest.parse({ events: mixed });
    expect(parsed.events[3]).toMatchObject({ type: "result", value: 12 });
    expect(parsed.events[3]).not.toHaveProperty("itemId");
    expect(parsed.events[4]).not.toHaveProperty("value");
    expect(parsed.events[4]).not.toHaveProperty("itemId");
  });

  test("rejects an empty batch", () => {
    expect(ok(SessionEventsRequest, { events: [] })).toBe(false);
  });

  test("a large offline backlog parses (no maximum)", () => {
    const backlog = Array.from({ length: 1000 }, (_, i) => makeEvent({ clientUuid: uuid(i + 1) }));
    expect(ok(SessionEventsRequest, { events: backlog })).toBe(true);
  });

  test("rejects a missing events array", () => {
    expect(ok(SessionEventsRequest, {})).toBe(false);
  });

  test("rejects an unknown top-level key", () => {
    expect(ok(SessionEventsRequest, { events: mixed, extra: true })).toBe(false);
  });

  test("one bad event fails the batch and the issue points at its index", () => {
    const result = SessionEventsRequest.safeParse({
      events: [mixed[0], without(makeEvent({ clientUuid: uuid(9) }), "clientUuid")],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["events", 1, "clientUuid"]);
  });
});

describe("SessionEventsResponse", () => {
  test("parses the updated session with progress and the next session date", () => {
    const parsed = SessionEventsResponse.parse(makeEventsResponse());
    expect(parsed.session.id).toBe("s-2026-09-21");
    expect(parsed.progress).toEqual({ sessionsCompleted: 4, minutesTrained: 80, streakDays: 2 });
    expect(parsed.nextSessionDate).toBe("2026-09-23");
  });

  test.each(["session", "progress", "nextSessionDate"])("rejects a response missing %s", (key) => {
    expect(ok(SessionEventsResponse, without(makeEventsResponse(), key))).toBe(false);
  });

  test("nextSessionDate is required and non-null", () => {
    expect(ok(SessionEventsResponse, makeEventsResponse({ nextSessionDate: null }))).toBe(false);
  });

  test("nextSessionDate is a calendar date", () => {
    expect(ok(SessionEventsResponse, makeEventsResponse({ nextSessionDate: "2026-09-23T10:00:00Z" }))).toBe(false);
  });

  test.each(["sessionsCompleted", "minutesTrained", "streakDays"])("progress.%s is required", (key) => {
    expect(ok(SessionEventsResponse, makeEventsResponse({ progress: without(makeProgress(), key) }))).toBe(false);
  });

  test.each(["sessionsCompleted", "minutesTrained", "streakDays"])("progress.%s rejects a negative count", (key) => {
    expect(ok(SessionEventsResponse, makeEventsResponse({ progress: { ...makeProgress(), [key]: -1 } }))).toBe(false);
  });

  test.each(["sessionsCompleted", "minutesTrained", "streakDays"])("progress.%s rejects a fraction", (key) => {
    expect(ok(SessionEventsResponse, makeEventsResponse({ progress: { ...makeProgress(), [key]: 1.5 } }))).toBe(false);
  });

  test("a brand-new player's zero progress parses", () => {
    const progress = { sessionsCompleted: 0, minutesTrained: 0, streakDays: 0 };
    expect(ok(SessionEventsResponse, makeEventsResponse({ progress }))).toBe(true);
  });

  test("the embedded session is validated as a TodaySession", () => {
    expect(ok(SessionEventsResponse, makeEventsResponse({ session: makeSession({ planner: "human" }) }))).toBe(false);
  });

  test("ignores unknown server keys", () => {
    expect(SessionEventsResponse.parse(makeEventsResponse({ extra: 1 }))).not.toHaveProperty("extra");
  });
});

// --- Swap ------------------------------------------------------------------------------------

describe("SwapRequest", () => {
  test.each(["easier", "harder"])("accepts direction %p", (direction) => {
    expect(ok(SwapRequest, { itemId: "item-1", direction })).toBe(true);
  });

  test("rejects direction 'sideways'", () => {
    expect(ok(SwapRequest, { itemId: "item-1", direction: "sideways" })).toBe(false);
  });

  test("requires itemId", () => {
    expect(ok(SwapRequest, { direction: "easier" })).toBe(false);
  });

  test("requires direction", () => {
    expect(ok(SwapRequest, { itemId: "item-1" })).toBe(false);
  });

  test("rejects an unknown key", () => {
    expect(ok(SwapRequest, { itemId: "item-1", direction: "easier", extra: true })).toBe(false);
  });
});

// --- Endpoints -------------------------------------------------------------------------------

describe("ENDPOINTS", () => {
  test("getToday is GET /api/player/today with an optional locale query", () => {
    expect(ENDPOINTS.getToday).toMatchObject({ method: "GET", path: "/api/player/today" });
    expect(ENDPOINTS.getToday.response).toBe(TodaySession);
    expect(ok(ENDPOINTS.getToday.query, {})).toBe(true);
    expect(ok(ENDPOINTS.getToday.query, { locale: "kk" })).toBe(true);
  });

  test("the locale query rejects an unknown locale", () => {
    expect(ok(ENDPOINTS.getToday.query, { locale: "de" })).toBe(false);
  });

  test("postSessionEvents is POST /api/player/session-events answering with the updated resource", () => {
    expect(ENDPOINTS.postSessionEvents).toMatchObject({ method: "POST", path: "/api/player/session-events" });
    expect(ENDPOINTS.postSessionEvents.request).toBe(SessionEventsRequest);
    expect(ENDPOINTS.postSessionEvents.response).toBe(SessionEventsResponse);
  });

  test("postSwap is POST /api/player/today/swap and its response is a TodaySession", () => {
    expect(ENDPOINTS.postSwap).toMatchObject({ method: "POST", path: "/api/player/today/swap" });
    expect(ENDPOINTS.postSwap.request).toBe(SwapRequest);
    expect(ENDPOINTS.postSwap.response).toBe(TodaySession);
    expect(ok(ENDPOINTS.postSwap.response, makeSession())).toBe(true);
  });

  test("no endpoint is public (the player is signed in)", () => {
    for (const endpoint of Object.values(ENDPOINTS)) expect(endpoint).not.toHaveProperty("public");
  });
});

// --- Web-bundle safety -----------------------------------------------------------------------

describe("web-bundle safety", () => {
  test("session.ts imports only zod, ./primitives and ./domain", () => {
    const source = readFileSync(join(import.meta.dir, "session.ts"), "utf8");
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
