import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import type { MastraModelConfig } from "@mastra/core/llm";
import { MockLanguageModelV4 } from "ai/test";
import { Hono } from "hono";
import { updateSettings } from "../../admin/settings";
import type { AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import type { CoachToolDeps } from "../../mastra/tools/coach-tools";
import { AI_PLAN_TIMEOUT_MS, AiPlanResponse, ENDPOINTS } from "../../shared/ai";
import type { AiFallbackCode } from "../../shared/ai";
import type { PlayerProfile } from "../../shared/domain";
import { ENDPOINTS as ONBOARDING } from "../../shared/onboarding";
import type { BaselineResult, StartRequest } from "../../shared/onboarding";
import { ENDPOINTS as SESSION, TodaySession } from "../../shared/session";
import type { SessionEvent } from "../../shared/session";
import { register as registerAuth } from "./auth.routes";
import { createAiPlanRegister } from "./player-ai-plan.routes";
import type { AiPlanRouteOptions, CoachAgentLike } from "./player-ai-plan.routes";
import { register as registerEvents } from "./player-events.routes";
import { register as registerStart } from "./player-start.routes";
import { register as registerToday } from "./player-today.routes";

// fc-mol-zo6.7: POST /api/player/today/ai-plan. No test touches the network or needs an OpenAI key: the coach agent is
// an injected fake (or, in one wiring test, the real Mastra coach agent on a stub model), and the key state is an
// injected env. Every test runs the real route modules on a fresh in-memory database migrated with the real migrations
// and loaded with the REAL seed (config/commons), with the REAL Better Auth handler and the REAL start, today and events
// routes mounted next to the route under test. Players are real anonymous sign-ins that onboard through
// POST /api/player/start (the technique of player-swap.routes.test.ts).
//
// Player PROFILE below: age 12, basic, ball, yard, 20 minutes. On the seed that is 43 candidates and a deterministic
// session of 4 drills / 19 minutes, item-1 being a 3-minute warm-up (probed before these tests were written).

const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const AI_PLAN = ENDPOINTS.aiPlan.path;
const TODAY = SESSION.getToday.path;
const EVENTS = SESSION.postSessionEvents.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
/** An env with a key configured (never a real one: the agent is a fake). */
const KEY_ENV = { OPENAI_API_KEY: "sk-test-not-a-real-key" };

let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

/** Mounts the routes under test on a bare Hono; `options` are the AI route's injected dependencies. */
async function boot(options: AiPlanRouteOptions): Promise<void> {
  const deps: AppDeps = { db, version: "test" };
  app = new Hono();
  for (const register of [registerAuth, registerStart, registerToday, registerEvents]) await register(app, deps);
  await createAiPlanRegister(options)(app, deps);
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// --- real sessions and onboarding --------------------------------------------------------------

/** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Player = { cookie: string; id: string };

async function signInPlayer(): Promise<Player> {
  const res = await app.request("/api/auth/sign-in/anonymous", {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN },
    body: "{}",
  });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

const PROFILE: PlayerProfile = {
  age: 12,
  level: "basic",
  goal: "dribbling",
  equipment: "ball",
  space: "yard",
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: "ru",
};

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const baseline = (first: number): BaselineResult[] => [
  { testSlug: "juggling-max-touches", value: 30, attempts: 3, clientUuid: uuid(first) },
  { testSlug: "wall-passing-60s", value: 20, clientUuid: uuid(first + 1) },
  { testSlug: "ball-mastery-30s", value: 95, clientUuid: uuid(first + 2) },
  { testSlug: "slalom-time", value: 9, errors: 1, clientUuid: uuid(first + 3) },
  { testSlug: "weak-foot-passes", value: 4, clientUuid: uuid(first + 4) },
];

let nextUuid = 1;

/** A signed-in player who has onboarded through POST /api/player/start. */
async function onboardedPlayer(over: Partial<PlayerProfile> = {}): Promise<Player> {
  const player = await signInPlayer();
  const body: StartRequest = { profile: { ...PROFILE, ...over }, baseline: baseline(nextUuid) };
  nextUuid += 10;
  const res = await app.request(ONBOARDING.start.path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: player.cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return player;
}

// --- the fake agent ------------------------------------------------------------------------------

interface FakeCall {
  /** What the route built the agent from: the server's candidate set, graph, levels and locale. */
  deps: CoachToolDeps;
  prompt: string;
  signal: AbortSignal | undefined;
}

type Usage = { inputTokens?: number; outputTokens?: number };

/** An injected agent: `answer` is what generate() resolves with as the structured object. */
function fakeAgent(answer: (call: FakeCall) => unknown, usage?: Usage) {
  const calls: FakeCall[] = [];
  let made = 0;
  const createAgent = (deps: CoachToolDeps): CoachAgentLike => {
    made += 1;
    return {
      generate: async (prompt, options) => {
        const call: FakeCall = { deps, prompt, signal: options?.abortSignal };
        calls.push(call);
        const object = await answer(call);
        return { object, ...(usage === undefined ? {} : { usage }) };
      },
    };
  };
  return { createAgent, calls, made: () => made };
}

const budgetOf = (prompt: string): number => Number(/Time budget for the drills: (\d+) minutes/.exec(prompt)?.[1]);
const offeredIds = (call: FakeCall): string[] => call.deps.candidates.map((c) => c.versionId);

/** A valid two-drill plan on the first two offered candidates, filling the budget the prompt names. */
function validPlan(call: FakeCall): unknown {
  const budget = budgetOf(call.prompt);
  const first = Math.floor(budget / 2);
  const [a, b] = call.deps.candidates;
  return {
    items: [
      { drillVersionId: a!.versionId, minutes: first, reason: "Builds your first touch." },
      { drillVersionId: b!.versionId, minutes: budget - first, reason: "Trains control on the move." },
    ],
  };
}

// --- requests and reads --------------------------------------------------------------------------

const post = (player: Player | null, body: unknown = {}, query = ""): Promise<Response> =>
  Promise.resolve(
    app.request(AI_PLAN + query, {
      method: "POST",
      headers: { "content-type": "application/json", ...(player === null ? {} : { cookie: player.cookie }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

/** GET /api/player/today as raw JSON (creates the day's session on the first call). */
async function todayRaw(player: Player, query = ""): Promise<Record<string, unknown>> {
  const res = await app.request(TODAY + query, { headers: { cookie: player.cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const todayOk = async (player: Player): Promise<TodaySession> => TodaySession.parse(await todayRaw(player));

interface StoredItem {
  itemId: string;
  drillVersionId: string;
  minutes: number;
  reason?: string;
  done: boolean;
}

const storedItems = (sessionId: string): StoredItem[] =>
  JSON.parse((db.query("SELECT items FROM sessions WHERE id = ?").get(sessionId) as { items: string }).items) as StoredItem[];
const rawItemsColumn = (sessionId: string): string => (db.query("SELECT items FROM sessions WHERE id = ?").get(sessionId) as { items: string }).items;
const plannerColumn = (sessionId: string): string => (db.query("SELECT planner FROM sessions WHERE id = ?").get(sessionId) as { planner: string }).planner;
const drillOf = (versionId: string): string => (db.query("SELECT drill_id FROM drill_versions WHERE id = ?").get(versionId) as { drill_id: string }).drill_id;

interface CallRow {
  id: number;
  player_id: string | null;
  kind: string;
  model: string;
  profile_hash: string | null;
  candidate_ids: string;
  chosen_ids: string;
  validator_result: string | null;
  fallback_code: string | null;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
}

const callRows = (): CallRow[] => db.query("SELECT * FROM ai_calls ORDER BY id").all() as CallRow[];

/** Marks the items done through the real events route, as the client does. */
async function finish(player: Player, session: TodaySession, itemIds: string[]): Promise<void> {
  const events: SessionEvent[] = itemIds.map((itemId, index) => ({
    clientUuid: uuid(900_000 + nextUuid++ + index),
    sessionId: session.id,
    type: "drill_done",
    itemId,
    at: new Date().toISOString(),
  }));
  const res = await app.request(EVENTS, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: player.cookie },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
}

/** The answer of a failed AI attempt: 200, the deterministic session UNCHANGED plus the fallback code; nothing stored. */
async function expectFallback(res: Response, player: Player, before: Record<string, unknown>, code: AiFallbackCode): Promise<void> {
  expect(res.status).toBe(200);
  const raw = await res.json();
  const parsed = AiPlanResponse.parse(raw);
  expect(parsed.planner).toBe("rules");
  expect(raw).toEqual({ ...before, fallback: { code } });
  expect(await todayRaw(player)).toEqual(before);
}

// --- the happy path -------------------------------------------------------------------------------

describe("POST /api/player/today/ai-plan: a valid plan", () => {
  test("is stored with planner ai, a reason on every item, and answered as the contract's AI session", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const before = await todayOk(player);
    expect(before.planner).toBe("rules");

    const res = await post(player);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.json();
    const answer = AiPlanResponse.parse(raw);
    expect(answer.planner).toBe("ai");
    expect((raw as { fallback?: unknown }).fallback).toBeUndefined();
    expect(agent.calls.length).toBe(1);

    const plan = validPlan(agent.calls[0]!) as { items: { drillVersionId: string; minutes: number; reason: string }[] };
    expect(answer.id).toBe(before.id);
    expect(answer.date).toBe(before.date);
    expect(answer.items.map((item) => [item.drillVersionId, item.minutes, item.reason])).toEqual(plan.items.map((item) => [item.drillVersionId, item.minutes, item.reason]));
    for (const item of answer.items) {
      expect(item.done).toBe(false);
      expect(item.content.goal).toBeDefined(); // the full drill view, as GET serves it
      expect(item.attribution.license).toBeDefined();
    }
    expect(answer.totalMinutes).toBe(20);

    // stored: the day's session row is now the AI plan, and GET says the same thing
    expect(plannerColumn(before.id)).toBe("ai");
    expect(storedItems(before.id).map((i) => [i.drillVersionId, i.minutes, i.reason, i.done])).toEqual(plan.items.map((i) => [i.drillVersionId, i.minutes, i.reason, false]));
    expect(await todayRaw(player)).toEqual(raw as Record<string, unknown>);
  });

  test("the agent is built from the server's candidate set, and the same set is logged", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    await todayOk(player);
    await post(player);

    const call = agent.calls[0]!;
    expect(call.deps.candidates.length).toBe(43);
    expect(new Set(offeredIds(call)).size).toBe(43); // one version per drill
    expect(call.deps.locale).toBe("ru"); // the profile's locale
    expect(call.prompt).toContain("Time budget for the drills: 20 minutes.");
    expect(JSON.parse(callRows()[0]!.candidate_ids)).toEqual(offeredIds(call));
  });

  test("writes one ai_calls row: ids, hash and codes only, the tokens the agent reported, and a latency", async () => {
    const agent = fakeAgent(validPlan, { inputTokens: 11, outputTokens: 7 });
    await boot({ createAgent: agent.createAgent, env: { ...KEY_ENV, OPENAI_MODEL: "gpt-test" } });
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    await post(player);

    const rows = callRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    const plan = validPlan(agent.calls[0]!) as { items: { drillVersionId: string }[] };
    expect(row.player_id).toBe(player.id);
    expect(row.kind).toBe("plan");
    expect(row.model).toBe("openai/gpt-test");
    expect(row.profile_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(row.chosen_ids)).toEqual(plan.items.map((i) => i.drillVersionId));
    expect(row.validator_result).toBe("ok");
    expect(row.fallback_code).toBeNull();
    expect(row.tokens_in).toBe(11);
    expect(row.tokens_out).toBe(7);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.profile_hash).not.toContain(session.id);
  });

  test("a token count the agent did not report is logged as NULL", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    await post(player);
    expect(callRows()[0]!.tokens_in).toBeNull();
    expect(callRows()[0]!.tokens_out).toBeNull();
  });

  test("the profile hash is of the profile alone: equal for equal profiles, different for a different one", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const a = await onboardedPlayer();
    const b = await onboardedPlayer();
    const c = await onboardedPlayer({ age: 8 });
    await post(a);
    await post(b);
    await post(c);
    const [ra, rb, rc] = callRows();
    expect(ra!.player_id).toBe(a.id);
    expect(rb!.player_id).toBe(b.id);
    expect(ra!.profile_hash).toBe(rb!.profile_hash!);
    expect(rc!.profile_hash).not.toBe(ra!.profile_hash!);
  });

  test("the reasons' language is the requested locale (?locale), else the profile's", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    await todayOk(player);
    // a second request on a day is answered from the store (see below), so use two players for the two locales
    const other = await onboardedPlayer();
    await post(player);
    await post(other, {}, "?locale=kk");
    expect(agent.calls[0]!.prompt).toContain("Russian");
    expect(agent.calls[1]!.prompt).toContain("Kazakh");
    expect(agent.calls[1]!.deps.locale).toBe("kk");
  });

  test("an empty body is a plan request without a note", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const res = await post(player, "");
    expect(res.status).toBe(200);
    expect(AiPlanResponse.parse(await res.json()).planner).toBe("ai");
    expect(agent.calls[0]!.prompt).not.toContain("player_note");
  });
});

// --- the player's note ----------------------------------------------------------------------------

describe("POST /api/player/today/ai-plan: the note", () => {
  test("reaches the agent only inside a data block, and is stored and logged nowhere", async () => {
    // a marker no seed drill text contains (the seed says "ankle" in its safety notes, so the bead's own example would not do)
    const note = "my zqx7-marker leg is tired";
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    const res = await post(player, { note });
    expect(res.status).toBe(200);

    expect(agent.calls[0]!.prompt).toContain(`<data field="player_note">${note}</data>`);
    expect(JSON.stringify(callRows())).not.toContain("zqx7");
    expect(rawItemsColumn(session.id)).not.toContain("zqx7");
    expect(JSON.stringify(await res.json())).not.toContain("zqx7");
  });

  test("a note of exactly 200 characters is accepted", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    expect((await post(player, { note: "x".repeat(200) })).status).toBe(200);
    expect(agent.calls.length).toBe(1);
  });
});

// --- refused requests ---------------------------------------------------------------------------------

describe("POST /api/player/today/ai-plan: requests the route refuses (the agent is never built)", () => {
  test("a note of 201 characters is a 422 problem naming /note", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const res = await post(player, { note: "x".repeat(201) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: { pointer: string }[] };
    expect(body.errors?.map((e) => e.pointer)).toContain("/note");
    expect(agent.made()).toBe(0);
    expect(callRows()).toEqual([]);
  });

  test("a body that names a player is a 422: the player is the session's, never the request's", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const other = await onboardedPlayer();
    const res = await post(player, { note: "hi", playerId: other.id });
    expect(res.status).toBe(422);
    expect(agent.made()).toBe(0);
    expect(callRows()).toEqual([]);
  });

  test("a body that is not JSON is a 400", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const res = await post(player, "{not json");
    expect(res.status).toBe(400);
    expect(agent.made()).toBe(0);
  });

  test("no session is a 401 (no-store), and the agent is never built", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const res = await post(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(agent.made()).toBe(0);
    expect(callRows()).toEqual([]);
  });

  test("a player who is not onboarded is a 404 problem, not an AI attempt", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await signInPlayer();
    const res = await post(player);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(agent.made()).toBe(0);
    expect(callRows()).toEqual([]);
  });
});

// --- AI-side failures are never an error status -------------------------------------------------------

describe("POST /api/player/today/ai-plan: AI-side failures answer 200 with the deterministic session and a code", () => {
  test("an invented drill id: the deterministic session, invalid_output, nothing stored", async () => {
    const agent = fakeAgent((call) => {
      const plan = validPlan(call) as { items: { drillVersionId: string }[] };
      plan.items[0]!.drillVersionId = "invented-drill-v9.9.9";
      return plan;
    });
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    const rawBefore = rawItemsColumn(before.id as string);

    await expectFallback(await post(player), player, before, "invalid_output");
    expect(rawItemsColumn(before.id as string)).toBe(rawBefore);
    expect(plannerColumn(before.id as string)).toBe("rules");
    expect(agent.calls.length).toBe(1); // no retry loop

    const row = callRows()[0]!;
    expect(row.fallback_code).toBe("invalid_output");
    expect(row.chosen_ids).toBe("[]");
    expect(row.validator_result).toContain("unknown_id");
    expect(row.candidate_ids).not.toContain("invented");
  });

  test("a real drill that is not one of the server's candidates is refused as well", async () => {
    const agent = fakeAgent((call) => {
      const offered = new Set(offeredIds(call));
      const outsider = (db.query("SELECT id FROM drill_versions").all() as { id: string }[]).find((r) => !offered.has(r.id))!.id;
      const plan = validPlan(call) as { items: { drillVersionId: string }[] };
      plan.items[1]!.drillVersionId = outsider;
      return plan;
    });
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    await expectFallback(await post(player), player, before, "invalid_output");
  });

  test("a plan over the time budget is refused by the validator", async () => {
    const agent = fakeAgent((call) => {
      const [a, b] = call.deps.candidates;
      return {
        items: [
          { drillVersionId: a!.versionId, minutes: 15, reason: "Long one." },
          { drillVersionId: b!.versionId, minutes: 15, reason: "Another long one." },
        ],
      };
    });
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    await expectFallback(await post(player), player, before, "invalid_output");
    expect(callRows()[0]!.validator_result).toContain("total_minutes");
  });

  test("an answer that is not an AiPlan at all is invalid_output", async () => {
    const agent = fakeAgent(() => undefined);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    await expectFallback(await post(player), player, before, "invalid_output");
  });

  test("a slow agent: timeout after the injected limit, the agent's signal aborted, the late answer ignored", async () => {
    let lateAnswer = false;
    const agent = fakeAgent(async (call) => {
      await Bun.sleep(300); // ignores the signal on purpose
      lateAnswer = true;
      return validPlan(call);
    });
    await boot({ createAgent: agent.createAgent, env: KEY_ENV, timeoutMs: 40 });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    const started = performance.now();

    const res = await post(player);
    const elapsed = performance.now() - started;
    await expectFallback(res, player, before, "timeout");
    expect(elapsed).toBeLessThan(250); // answered at the limit, not when the agent finished
    expect(agent.calls[0]!.signal?.aborted).toBe(true);

    await Bun.sleep(350);
    expect(lateAnswer).toBe(true);
    expect(await todayRaw(player)).toEqual(before); // the late plan changed nothing
    expect(plannerColumn(before.id as string)).toBe("rules");

    const row = callRows()[0]!;
    expect(row.fallback_code).toBe("timeout");
    expect(row.validator_result).toBeNull();
    expect(row.tokens_in).toBeNull();
    expect(row.latency_ms).toBeGreaterThanOrEqual(30);
    expect(row.latency_ms).toBeLessThan(250);
  });

  test("an agent that honours the abort signal is a timeout too", async () => {
    const agent = fakeAgent(
      (call) =>
        new Promise((_, reject) => {
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
        }),
    );
    await boot({ createAgent: agent.createAgent, env: KEY_ENV, timeoutMs: 30 });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    await expectFallback(await post(player), player, before, "timeout");
  });

  test("the default hard timeout is 20 seconds", async () => {
    expect(AI_PLAN_TIMEOUT_MS).toBe(20_000);
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const spy = spyOn(globalThis, "setTimeout");
    try {
      const res = await post(player);
      expect(res.status).toBe(200);
      expect(spy.mock.calls.map((call) => call[1])).toContain(20_000);
    } finally {
      spy.mockRestore();
    }
  });

  test("a provider error (the agent throws): 200, provider_error, one attempt", async () => {
    const agent = fakeAgent(() => {
      throw new Error("429 rate limited: sk-secret-provider-detail");
    });
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    const res = await post(player);
    await expectFallback(res, player, before, "provider_error");
    expect(agent.calls.length).toBe(1);
    expect(JSON.stringify(callRows())).not.toContain("sk-secret");
    expect(callRows()[0]!.fallback_code).toBe("provider_error");
    expect(callRows()[0]!.validator_result).toBeNull();
  });

  test("an agent that cannot even be built is a provider_error, not a 500", async () => {
    await boot({
      createAgent: () => {
        throw new Error("the provider module failed to load");
      },
      env: KEY_ENV,
    });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    await expectFallback(await post(player), player, before, "provider_error");
  });

  test("no key: no_key, and the agent is never built or called", async () => {
    const agent = fakeAgent(validPlan);
    for (const env of [{}, { OPENAI_API_KEY: "   " }]) {
      db.close();
      db = openDatabase(":memory:");
      migrate(db, MIGRATIONS_DIR);
      loadSeed(db, SEED_DIR);
      await boot({ createAgent: agent.createAgent, env });
      const player = await onboardedPlayer();
      const before = await todayRaw(player);
      await expectFallback(await post(player), player, before, "no_key");
      expect(callRows()[0]!.fallback_code).toBe("no_key");
      expect(callRows()[0]!.validator_result).toBeNull();
      expect(callRows()[0]!.tokens_in).toBeNull();
    }
    expect(agent.made()).toBe(0);
    expect(agent.calls.length).toBe(0);
  });

  test("the AI planner setting off: disabled, the agent never called, even with a key", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    updateSettings(db, { aiPlannerEnabled: false });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    await expectFallback(await post(player), player, before, "disabled");
    expect(agent.made()).toBe(0);
    expect(callRows()[0]!.fallback_code).toBe("disabled");
  });

  test("setting off and no key at once: disabled wins", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: {} });
    updateSettings(db, { aiPlannerEnabled: false });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    await expectFallback(await post(player), player, before, "disabled");
  });

  test("every fallback is logged with the player, the kind and the offered candidates, and never a chosen id", async () => {
    const agent = fakeAgent(() => {
      throw new Error("down");
    });
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    await post(player);
    const row = callRows()[0]!;
    expect(row.player_id).toBe(player.id);
    expect(row.kind).toBe("plan");
    expect(JSON.parse(row.candidate_ids)).toEqual(offeredIds(agent.calls[0]!));
    expect(row.chosen_ids).toBe("[]");
    expect(row.profile_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// --- finished items --------------------------------------------------------------------------------------

describe("POST /api/player/today/ai-plan: finished items are never altered", () => {
  test("a finished item stays byte for byte, first; the AI plans only the rest, from candidates that exclude it", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const before = await todayOk(player);
    const warmup = before.items[0]!;
    expect(warmup.itemId).toBe("item-1");
    await finish(player, before, ["item-1"]);
    const doneBefore = storedItems(before.id)[0]!;
    expect(doneBefore.done).toBe(true);
    const doneRaw = JSON.stringify(doneBefore);

    const res = await post(player);
    expect(res.status).toBe(200);
    const answer = AiPlanResponse.parse(await res.json());
    expect(answer.planner).toBe("ai");

    const call = agent.calls[0]!;
    expect(budgetOf(call.prompt)).toBe(20 - warmup.minutes); // only the unfinished part is planned
    expect(call.deps.candidates.map((c) => c.drillId)).not.toContain(drillOf(warmup.drillVersionId));

    const stored = storedItems(before.id);
    expect(JSON.stringify(stored[0])).toBe(doneRaw);
    expect(stored.length).toBe(3);
    expect(answer.items[0]!.itemId).toBe("item-1");
    expect(answer.items[0]!.done).toBe(true);
    expect(answer.items.slice(1).every((item) => item.done === false)).toBe(true);
    expect(answer.totalMinutes).toBe(20);
    // the dropped unfinished items' ids (item-2..item-4) are not reused by the new ones
    expect(stored.slice(1).map((i) => i.itemId)).toEqual(["item-5", "item-6"]);
  });

  test("an item finished WHILE the agent runs is kept as finished and not duplicated by the plan", async () => {
    let session!: TodaySession;
    let player!: Player;
    let doneRaw = "";
    const agent = fakeAgent(async (call) => {
      await finish(player, session, ["item-2"]);
      doneRaw = JSON.stringify(storedItems(session.id).find((i) => i.itemId === "item-2"));
      const budget = budgetOf(call.prompt);
      const inPlan = session.items[1]!;
      const other = call.deps.candidates.find((c) => c.drillId !== drillOf(inPlan.drillVersionId) && !session.items.some((i) => i.drillVersionId === c.versionId))!;
      // the plan re-chooses item-2's drill (an unfinished item's drill is a candidate when the agent is asked)
      expect(offeredIds(call)).toContain(inPlan.drillVersionId);
      return {
        items: [
          { drillVersionId: inPlan.drillVersionId, minutes: inPlan.minutes, reason: "Keep going with this one." },
          { drillVersionId: other.versionId, minutes: budget - inPlan.minutes, reason: "Then something new." },
        ],
      };
    });
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    player = await onboardedPlayer();
    session = await todayOk(player);

    const res = await post(player);
    expect(res.status).toBe(200);
    const stored = storedItems(session.id);
    const item2 = stored.filter((i) => i.itemId === "item-2");
    expect(item2.length).toBe(1);
    expect(JSON.stringify(item2[0])).toBe(doneRaw);
    expect(item2[0]!.done).toBe(true);
    expect(stored.filter((i) => drillOf(i.drillVersionId) === drillOf(session.items[1]!.drillVersionId)).length).toBe(1);
  });

  test("nothing left to plan (the finished items fill the budget): the agent is not called; the session is answered unchanged", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    // a stored state the swap route can produce: everything finished, 21 minutes in all
    const done = session.items.map((item, index) => ({
      itemId: item.itemId,
      drillVersionId: item.drillVersionId,
      minutes: index === 0 ? item.minutes + 2 : item.minutes,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
      done: true,
    }));
    db.query("UPDATE sessions SET items = ? WHERE id = ?").run(JSON.stringify(done), session.id);
    const before = await todayRaw(player);
    expect(before.totalMinutes).toBe(21);

    await expectFallback(await post(player), player, before, "invalid_output");
    expect(agent.made()).toBe(0);
    expect(callRows()[0]!.validator_result).toBe("nothing_to_plan");
    expect(callRows()[0]!.fallback_code).toBe("invalid_output");
  });

  test("no candidate at all (the trust floor excludes every drill): the agent is not called", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    updateSettings(db, { minStatusByAgeBand: { u14: "ACADEMY_VERIFIED" } });
    const player = await onboardedPlayer();
    const before = await todayRaw(player);
    expect(before.items).toEqual([]);

    await expectFallback(await post(player), player, before, "invalid_output");
    expect(agent.made()).toBe(0);
    expect(callRows()[0]!.validator_result).toBe("nothing_to_plan");
  });
});

// --- other players and repeats ------------------------------------------------------------------------------

describe("POST /api/player/today/ai-plan: whose session, and how often", () => {
  test("only the caller's session changes, and only the caller is logged", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const a = await onboardedPlayer();
    const b = await onboardedPlayer();
    const sessionB = await todayRaw(b);
    const rawB = rawItemsColumn(sessionB.id as string);

    const res = await post(a);
    expect(AiPlanResponse.parse(await res.json()).planner).toBe("ai");
    expect(rawItemsColumn(sessionB.id as string)).toBe(rawB);
    expect(plannerColumn(sessionB.id as string)).toBe("rules");
    expect(await todayRaw(b)).toEqual(sessionB);
    expect(callRows().map((r) => r.player_id)).toEqual([a.id]);
  });

  test("a first call of the day creates the session, as GET does, and plans it", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer(); // no GET yet
    const res = await post(player);
    expect(AiPlanResponse.parse(await res.json()).planner).toBe("ai");
    expect(db.query("SELECT count(*) AS n FROM sessions WHERE player_id = ?").get(player.id)).toEqual({ n: 1 });
  });

  test("a second request the same day answers the stored AI session without another agent call (one paid call per day)", async () => {
    const agent = fakeAgent(validPlan);
    await boot({ createAgent: agent.createAgent, env: KEY_ENV });
    const player = await onboardedPlayer();
    const first = await (await post(player)).json();
    const second = await post(player);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first as Record<string, unknown>);
    expect(agent.calls.length).toBe(1);
    const rows = callRows();
    expect(rows.length).toBe(2); // every request is logged
    expect(rows[1]!.validator_result).toBe("already_planned");
    expect(rows[1]!.fallback_code).toBeNull();
    expect(rows[1]!.chosen_ids).toBe("[]");
  });
});

// --- the real agent, on a stub model -----------------------------------------------------------------------------

describe("POST /api/player/today/ai-plan: the default agent is the real coach agent", () => {
  test("on a stub model (no network) it plans, reports its tokens, and the model was offered only the three read-only tools", async () => {
    const usage = {
      inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 7, text: 7, reasoning: 0 },
    };
    let planText = "";
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: planText }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      }),
    });
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetches += 1;
      return realFetch(...args);
    }) as typeof fetch;
    try {
      await boot({ env: KEY_ENV, model: model as unknown as MastraModelConfig });
      const player = await onboardedPlayer();
      const session = await todayOk(player);
      planText = JSON.stringify({
        items: [
          { drillVersionId: session.items[0]!.drillVersionId, minutes: 10, reason: "Warm up first." },
          { drillVersionId: session.items[1]!.drillVersionId, minutes: 10, reason: "Then dribble." },
        ],
      });

      const res = await post(player, { note: "fresh legs" });
      expect(res.status).toBe(200);
      const answer = AiPlanResponse.parse(await res.json());
      expect(answer.planner).toBe("ai");
      expect(answer.items.map((i) => [i.drillVersionId, i.minutes])).toEqual([
        [session.items[0]!.drillVersionId, 10],
        [session.items[1]!.drillVersionId, 10],
      ]);
      expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("Time budget for the drills: 20 minutes.");
      expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain('<data field=\\"player_note\\">fresh legs</data>');
      expect((model.doGenerateCalls[0]?.tools ?? []).map((t) => t.name).sort()).toEqual(["getProgress", "getSkillGraph", "listCandidateDrills"]);
      expect(callRows()[0]!.tokens_in).toBe(11);
      expect(callRows()[0]!.tokens_out).toBe(7);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
