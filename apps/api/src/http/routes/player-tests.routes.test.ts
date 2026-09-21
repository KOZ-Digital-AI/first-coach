import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import type { PlayerProfile, Roadmap } from "../../shared/domain";
import { ENDPOINTS, TestResultsResponse } from "../../shared/journey";
import type { TestResult, TestResultsRequest } from "../../shared/journey";
import { ENDPOINTS as ONBOARDING, StartResponse } from "../../shared/onboarding";
import type { BaselineResult } from "../../shared/onboarding";
import { PROBLEM_CONTENT_TYPE } from "../../shared/primitives";

// POST /api/player/test-results (fc-mol-0bt.5): the retest batch. Every test runs the real createApp on a
// fresh in-memory database migrated with the real migrations and loaded with the REAL football seed, with
// the real Better Auth handler and the merged start and journey routes mounted next to the route under test.
// Sessions are real anonymous sign-ins; players onboard through the real POST /api/player/start. Nothing is
// mocked or faked. The clock is pinned with setSystemTime so every timestamp is exact.
//
// Levels below are hand-computed from the real seed thresholds (config/commons/football/tests.json) for age
// 12 (band from10to13):
//   juggling-max-touches   [5, 12, 25, 50]      wall-passing-60s  [15, 28, 40, 52]
//   ball-mastery-30s       [30, 50, 70, 95]     weak-foot-passes  [3, 5, 7, 9]
//   slalom-time (lower)    [12, 10, 8.5, 7]     (time + 1 s per error)
//
// Readings the criteria leave open, pinned here (each is also stated in the route module):
//   * The levels are re-estimated from the player's LATEST non-skipped stored result per test, so a later, lower
//     result lowers the track (the roadmap says where the player is now).
//   * The contract's `value: z.number()` allows negatives; the route refuses them (a measured time, count or
//     score is never below 0): 422 at /results/<i>/value.
//   * Bounds the contract leaves open: at most 50 results per batch (422 at /results), a body of at most 32 KiB
//     (413 problem), both checked before anything is written.
//   * A clientUuid already stored for ANOTHER player is dropped, never taken over (the schema makes it unique
//     across players); the response still derives only from the caller's own rows.

const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILES = ["player-tests.routes.ts", "player-journey.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PATH = ENDPOINTS.postTestResults.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const T0 = new Date("2026-03-10T12:00:00.000Z");
const DAY_MS = 86_400_000;

let dir: string;
let db: Database;
let app: Hono;
let seq: number;
const savedEnv: Record<string, string | undefined> = {};

async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTE_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(SOURCE_DIR, file))};\n`);
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

beforeEach(async () => {
  setSystemTime(T0);
  seq = 0;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "player-tests-routes-"));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  app = await buildApp();
});

afterEach(() => {
  setSystemTime();
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// --- real sessions ---------------------------------------------------------------------------------

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

// --- requests --------------------------------------------------------------------------------------

/** `body` is JSON-encoded unless it is already a string (to send malformed JSON verbatim). */
const retest = (cookie: string | undefined, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

type Problem = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { pointer: string; detail: string }[];
};

const expectProblem = async (res: Response, status: number): Promise<Problem> => {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Problem;
  expect(body.status).toBe(status);
  return body;
};

// --- data ------------------------------------------------------------------------------------------

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

const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** The baseline of the start route's own tests: levels juggling 4, passing 2, ball-mastery 5, dribbling 3, weak-foot 2. */
const baseline = (): BaselineResult[] => [
  { testSlug: "juggling-max-touches", value: 30, clientUuid: uuid() },
  { testSlug: "wall-passing-60s", value: 20, clientUuid: uuid() },
  { testSlug: "ball-mastery-30s", value: 95, clientUuid: uuid() },
  { testSlug: "slalom-time", value: 9, errors: 1, clientUuid: uuid() },
  { testSlug: "weak-foot-passes", value: 4, clientUuid: uuid() },
];

/** A player who has onboarded through the real start route (at the pinned clock). */
async function onboarded(results: BaselineResult[] = baseline(), profile: PlayerProfile = PROFILE): Promise<{ player: Player; start: StartResponse }> {
  const player = await signInPlayer();
  const res = await app.request(ONBOARDING.start.path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: player.cookie },
    body: JSON.stringify({ profile, baseline: results }),
  });
  expect(res.status).toBe(200);
  return { player, start: StartResponse.parse(await res.json()) };
}

const result = (testSlug: string, value: number, extra: Partial<TestResult> = {}): TestResult => ({ testSlug, value, clientUuid: uuid(), ...extra });
const batch = (...results: TestResult[]): TestResultsRequest => ({ results });

const levelsOf = (roadmap: Roadmap): Record<string, number> => Object.fromEntries(roadmap.tracks.map((track) => [track.skill, track.level]));
const focusOf = (roadmap: Roadmap): string[] => roadmap.focus.map((entry) => entry.skill);

const count = (table: string, where = "1 = 1", ...params: string[]): number =>
  (db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;

const retestOk = async (player: Player, body: TestResultsRequest): Promise<TestResultsResponse> => {
  const res = await retest(player.cookie, body);
  expect(res.status).toBe(200);
  return TestResultsResponse.parse(await res.json());
};

test("the route serves the contract's path with the contract's method", () => {
  expect(ENDPOINTS.postTestResults.method).toBe("POST");
  expect(PATH).toBe("/api/player/test-results");
});

// --- happy path: a better result raises the level and changes the roadmap --------------------------

describe("POST /api/player/test-results, a better retest", () => {
  test("raises the track level, changes the roadmap focus, and answers {journey, roadmap} for the session player", async () => {
    const { player, start } = await onboarded();
    expect(levelsOf(start.roadmap)["passing-first-touch"]).toBe(2);
    expect(focusOf(start.roadmap)).toEqual(["dribbling", "passing-first-touch", "weak-foot"]);

    setSystemTime(new Date(T0.getTime() + 8 * DAY_MS));
    const body = await retestOk(player, batch(result("wall-passing-60s", 60)));

    // 60 passes at age 12 clears every boundary [15, 28, 40, 52]: level 5.
    expect(levelsOf(body.roadmap)).toEqual({
      "ball-mastery": 5,
      "juggling-coordination": 4,
      dribbling: 3,
      "passing-first-touch": 5,
      "weak-foot": 2,
    });
    expect(body.roadmap.tracks.find((track) => track.skill === "passing-first-touch")?.source).toBe("test");
    // passing left the three weakest; the goal track stays first, weak-foot stays, juggling (4) comes in.
    expect(focusOf(body.roadmap)).toEqual(["dribbling", "weak-foot", "juggling-coordination"]);
    expect(body.roadmap).not.toEqual(start.roadmap);

    // the journey is the player's own, in the same response: the retest is on the test's history.
    const passing = body.journey.tests.find((test) => test.testSlug === "wall-passing-60s");
    expect(passing).toMatchObject({
      history: [
        { value: 20, at: T0.toISOString() },
        { value: 60, at: new Date(T0.getTime() + 8 * DAY_MS).toISOString() },
      ],
      previous: 20,
      latest: 60,
      personalBest: 60,
    });
    expect(passing?.changePct).toBe(200);
    expect(body.journey.metrics.skillsImproving).toBe(1);
    expect(body.journey.tree.length).toBeGreaterThan(0);
  });

  test("stores the result and the rebuilt roadmap: the stored roadmap is the one answered, and GET /api/player/me agrees", async () => {
    const { player } = await onboarded();
    const body = await retestOk(player, batch(result("wall-passing-60s", 60, { attempts: 2, errors: 0 })));

    expect(count("test_results")).toBe(6);
    expect(count("test_results", "player_id = ? AND test_slug = 'wall-passing-60s'", player.id)).toBe(2);
    expect(count("roadmaps", "player_id = ?", player.id)).toBe(2);
    const latest = db.query("SELECT json FROM roadmaps WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(player.id) as { json: string };
    expect(JSON.parse(latest.json)).toEqual(body.roadmap);

    const me = await app.request("/api/player/me", { headers: { cookie: player.cookie } });
    expect(StartResponse.parse(await me.json()).roadmap).toEqual(body.roadmap);
  });

  test("a batch of several tests re-estimates every one of them in one call", async () => {
    const { player } = await onboarded();
    const body = await retestOk(player, batch(result("weak-foot-passes", 9), result("slalom-time", 6.5, { errors: 0 }), result("wall-passing-60s", 30)));
    const levels = levelsOf(body.roadmap);
    expect(levels["passing-first-touch"]).toBe(3); // 30 >= 15, 28
    expect(levels.dribbling).toBe(5); // 6.5 s <= 12, 10, 8.5, 7
    expect(levels["weak-foot"]).toBe(5); // 9 of 10 clears [3, 5, 7, 9]
    expect(count("test_results")).toBe(8);
  });

  test("the LATEST stored result decides: a later, lower result lowers the track again", async () => {
    const { player } = await onboarded();
    setSystemTime(new Date(T0.getTime() + DAY_MS));
    await retestOk(player, batch(result("wall-passing-60s", 60)));
    setSystemTime(new Date(T0.getTime() + 2 * DAY_MS));
    const worse = await retestOk(player, batch(result("wall-passing-60s", 16)));
    expect(levelsOf(worse.roadmap)["passing-first-touch"]).toBe(2); // 16 >= 15 only
    const passing = worse.journey.tests.find((test) => test.testSlug === "wall-passing-60s");
    expect(passing?.history.map((point) => point.value)).toEqual([20, 60, 16]);
    expect(passing?.personalBest).toBe(60);
  });

  test("a test skipped at the baseline becomes a measured track (source test) after its first retest", async () => {
    const results = baseline();
    results[1] = { testSlug: "wall-passing-60s", value: 0, skipped: true, clientUuid: results[1]!.clientUuid };
    const { player, start } = await onboarded(results);
    expect(start.roadmap.tracks.find((track) => track.skill === "passing-first-touch")).toEqual({ skill: "passing-first-touch", level: 2, source: "self" });
    const body = await retestOk(player, batch(result("wall-passing-60s", 45)));
    expect(body.roadmap.tracks.find((track) => track.skill === "passing-first-touch")).toEqual({ skill: "passing-first-touch", level: 4, source: "test" });
  });

  test("timestamps are canonical ISO 8601 UTC with milliseconds", async () => {
    const { player } = await onboarded();
    setSystemTime(new Date("2026-03-11T08:30:15.123Z"));
    const body = await retestOk(player, batch(result("wall-passing-60s", 40)));
    const row = db.query("SELECT recorded_at FROM test_results WHERE player_id = ? ORDER BY id DESC LIMIT 1").get(player.id) as { recorded_at: string };
    expect(row.recorded_at).toBe("2026-03-11T08:30:15.123Z");
    const passing = body.journey.tests.find((test) => test.testSlug === "wall-passing-60s");
    expect(passing?.history.at(-1)?.at).toBe("2026-03-11T08:30:15.123Z");
  });
});

// --- idempotency ---------------------------------------------------------------------------------------

describe("POST /api/player/test-results, replay", () => {
  test("a replay with the same clientUuids is a 200 with the SAME response and creates no duplicate row", async () => {
    const { player } = await onboarded();
    const request = batch(result("wall-passing-60s", 60), result("weak-foot-passes", 6));
    const first = await retestOk(player, request);
    const rows = count("test_results");
    const roadmaps = count("roadmaps");
    expect(rows).toBe(7);

    const second = await retestOk(player, request);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(count("test_results")).toBe(rows);
    expect(count("roadmaps")).toBe(roadmaps);
    const third = await retestOk(player, request);
    expect(third).toEqual(first);
    expect(count("test_results")).toBe(rows);
    expect(count("roadmaps")).toBe(roadmaps);
  });

  test("a replayed clientUuid keeps the first stored value: the retry's numbers change nothing", async () => {
    const { player } = await onboarded();
    const original = result("wall-passing-60s", 60);
    const first = await retestOk(player, batch(original));
    const replay = await retestOk(player, batch({ ...original, value: 1 }));
    expect(replay).toEqual(first);
    expect(db.query("SELECT value FROM test_results WHERE client_uuid = ?").get(original.clientUuid)).toEqual({ value: 60 });
    expect(count("test_results")).toBe(6);
  });

  test("a batch that mixes a replayed and a new entry stores only the new one", async () => {
    const { player } = await onboarded();
    const first = result("wall-passing-60s", 30);
    await retestOk(player, batch(first));
    expect(count("test_results")).toBe(6);
    await retestOk(player, batch(first, result("weak-foot-passes", 6)));
    expect(count("test_results")).toBe(7);
  });

  test("the same clientUuid twice inside one batch is stored once", async () => {
    const { player } = await onboarded();
    const twice = result("wall-passing-60s", 30);
    await retestOk(player, batch(twice, twice));
    expect(count("test_results", "client_uuid = ?", twice.clientUuid)).toBe(1);
  });
});

// --- 422: nothing is written --------------------------------------------------------------------------------

describe("POST /api/player/test-results, invalid requests", () => {
  const untouched = async (player: Player, run: () => Promise<void>) => {
    const before = { results: count("test_results"), roadmaps: count("roadmaps") };
    await run();
    expect(count("test_results")).toBe(before.results);
    expect(count("roadmaps")).toBe(before.roadmaps);
    expect(count("test_results", "player_id = ?", player.id)).toBe(5);
  };

  test("an unknown test slug is a 422 problem with the pointer /results/<index>/testSlug and nothing is stored", async () => {
    const { player } = await onboarded();
    await untouched(player, async () => {
      const problem = await expectProblem(
        await retest(player.cookie, batch(result("wall-passing-60s", 60), result("no-such-test", 5), result("weak-foot-passes", 6))),
        422,
      );
      expect(problem.errors?.map((error) => error.pointer)).toEqual(["/results/1/testSlug"]);
      for (const error of problem.errors ?? []) expect(error.detail.length).toBeGreaterThan(0);
    });
  });

  test("a negative value is a 422 problem with the pointer /results/<index>/value and nothing is stored", async () => {
    const { player } = await onboarded();
    await untouched(player, async () => {
      const problem = await expectProblem(await retest(player.cookie, batch(result("wall-passing-60s", 60), result("weak-foot-passes", -1))), 422);
      expect(problem.errors?.map((error) => error.pointer)).toEqual(["/results/1/value"]);
    });
  });

  test("zero is a valid value (a measured zero), negative zero-adjacent values are not", async () => {
    const { player } = await onboarded();
    await retestOk(player, batch(result("juggling-max-touches", 0)));
    await expectProblem(await retest(player.cookie, batch(result("juggling-max-touches", -0.001))), 422);
  });

  test("every invalid entry is listed, each with its own pointer", async () => {
    const { player } = await onboarded();
    await untouched(player, async () => {
      const problem = await expectProblem(
        await retest(player.cookie, batch(result("wall-passing-60s", -5), result("no-such-test", 5), result("weak-foot-passes", 6, { clientUuid: "not-a-uuid" }))),
        422,
      );
      const pointers = problem.errors?.map((error) => error.pointer) ?? [];
      expect(pointers).toEqual(expect.arrayContaining(["/results/0/value", "/results/1/testSlug", "/results/2/clientUuid"]));
    });
  });

  test("the contract's own rules are 422 too: no results, a fractional or negative count, an unknown key", async () => {
    const { player } = await onboarded();
    await untouched(player, async () => {
      const empty = await expectProblem(await retest(player.cookie, { results: [] }), 422);
      expect(empty.errors?.map((error) => error.pointer)).toContain("/results");
      const counts = await expectProblem(
        await retest(player.cookie, batch(result("wall-passing-60s", 5, { attempts: 1.5, errors: -1 }))),
        422,
      );
      expect(counts.errors?.map((error) => error.pointer)).toEqual(expect.arrayContaining(["/results/0/attempts", "/results/0/errors"]));
      const extra = await expectProblem(await retest(player.cookie, { results: [{ ...result("wall-passing-60s", 5), skipped: true }] }), 422);
      expect(extra.errors?.map((error) => error.pointer)).toContain("/results/0/skipped");
    });
  });

  test("a body that is not a JSON object is a 400 problem", async () => {
    const { player } = await onboarded();
    await untouched(player, async () => {
      await expectProblem(await retest(player.cookie, "{not json"), 400);
      await expectProblem(await retest(player.cookie, "[]"), 400);
      await expectProblem(await retest(player.cookie, "null"), 400);
      await expectProblem(await retest(player.cookie), 400);
    });
  });
});

// --- bounds -----------------------------------------------------------------------------------------------

describe("POST /api/player/test-results, bounds", () => {
  test("a batch may hold 50 results: 50 are stored, 51 are a 422 at /results and nothing is stored", async () => {
    const { player } = await onboarded();
    const many = (n: number) => batch(...Array.from({ length: n }, (_, i) => result("wall-passing-60s", 10 + i)));
    const problem = await expectProblem(await retest(player.cookie, many(51)), 422);
    expect(problem.errors?.map((error) => error.pointer)).toEqual(["/results"]);
    expect(count("test_results")).toBe(5);
    await retestOk(player, many(50));
    expect(count("test_results")).toBe(55);
  });

  test("a body over 32 KiB is a 413 problem and nothing is stored, with or without a content-length header", async () => {
    const { player } = await onboarded();
    const huge = JSON.stringify({ ...batch(result("wall-passing-60s", 60)), padding: "x".repeat(64 * 1024) });
    await expectProblem(await retest(player.cookie, huge), 413);
    await expectProblem(await retest(player.cookie, huge, { "content-length": String(huge.length) }), 413);
    // a header that lies about a small body is judged by what it declares: fail closed
    await expectProblem(await retest(player.cookie, JSON.stringify(batch(result("wall-passing-60s", 60))), { "content-length": String(10 * 1024 * 1024) }), 413);
    expect(count("test_results")).toBe(5);
    expect(count("roadmaps")).toBe(1);
  });

  test("a normal body with a truthful content-length is read", async () => {
    const { player } = await onboarded();
    const body = JSON.stringify(batch(result("wall-passing-60s", 60)));
    const res = await retest(player.cookie, body, { "content-length": String(body.length) });
    expect(res.status).toBe(200);
  });
});

// --- who may call, and whose data ------------------------------------------------------------------------------

describe("POST /api/player/test-results, access", () => {
  test("no session is a 401 problem whatever the body holds, and nothing is stored", async () => {
    await onboarded();
    await expectProblem(await retest(undefined, batch(result("wall-passing-60s", 60))), 401);
    await expectProblem(await retest(undefined, "{not json"), 401);
    await expectProblem(await retest("better-auth.session_token=forged", batch(result("wall-passing-60s", 60))), 401);
    expect(count("test_results")).toBe(5);
  });

  test("a player who has not onboarded gets a 404 problem and nothing is stored", async () => {
    const player = await signInPlayer();
    await expectProblem(await retest(player.cookie, batch(result("wall-passing-60s", 60))), 404);
    expect(count("test_results")).toBe(0);
    expect(count("roadmaps")).toBe(0);
    expect(count("player_profiles")).toBe(0);
  });

  test("the player is always the session's: a playerId in the body is a 422 and never read", async () => {
    const { player: victim } = await onboarded();
    const attacker = await signInPlayer();
    const problem = await expectProblem(await retest(attacker.cookie, { ...batch(result("wall-passing-60s", 60)), playerId: victim.id }), 422);
    expect(problem.errors?.map((error) => error.pointer)).toContain("/playerId");
    const nested = await expectProblem(await retest(attacker.cookie, { results: [{ ...result("wall-passing-60s", 60), playerId: victim.id }] }), 422);
    expect(nested.errors?.map((error) => error.pointer)).toContain("/results/0/playerId");
    expect(count("test_results", "player_id = ?", victim.id)).toBe(5);
  });

  test("results are stored for the session player only and another player's plan and journey do not move", async () => {
    const { player: first, start: firstStart } = await onboarded();
    const { player: second } = await onboarded(baseline());
    const before = JSON.stringify(await (await app.request("/api/player/journey", { headers: { cookie: first.cookie } })).json());

    const body = await retestOk(second, batch(result("wall-passing-60s", 60)));
    expect(count("test_results", "player_id = ?", second.id)).toBe(6);
    expect(count("test_results", "player_id = ?", first.id)).toBe(5);
    expect(count("roadmaps", "player_id = ?", first.id)).toBe(1);
    expect(levelsOf(body.roadmap)["passing-first-touch"]).toBe(5);

    const me = await app.request("/api/player/me", { headers: { cookie: first.cookie } });
    expect(StartResponse.parse(await me.json()).roadmap).toEqual(firstStart.roadmap);
    const after = JSON.stringify(await (await app.request("/api/player/journey", { headers: { cookie: first.cookie } })).json());
    expect(after).toBe(before);
  });

  test("a clientUuid that belongs to another player is dropped, never taken over, and never changes the caller's plan", async () => {
    const { player: owner } = await onboarded();
    const { player: other, start: otherStart } = await onboarded(baseline());
    const stolen = result("wall-passing-60s", 60);
    await retestOk(owner, batch(stolen));

    const body = await retestOk(other, batch({ ...stolen, value: 1 }));
    expect(db.query("SELECT player_id, value FROM test_results WHERE client_uuid = ?").get(stolen.clientUuid)).toEqual({ player_id: owner.id, value: 60 });
    expect(count("test_results", "player_id = ?", other.id)).toBe(5);
    expect(body.roadmap).toEqual(otherStart.roadmap);
  });
});
