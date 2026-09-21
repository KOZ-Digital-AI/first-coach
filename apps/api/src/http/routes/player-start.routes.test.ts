import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import { PlayerProfileView, Roadmap } from "../../shared/domain";
import type { PlayerProfile } from "../../shared/domain";
import { ENDPOINTS, StartResponse } from "../../shared/onboarding";
import type { BaselineResult, StartRequest } from "../../shared/onboarding";
import { PROBLEM_CONTENT_TYPE } from "../../shared/primitives";

// Every test runs the real createApp on a fresh in-memory database migrated with the real
// migrations and loaded with the REAL seed (config/commons), with the REAL Better Auth handler
// mounted next to the route under test. Sessions are real anonymous sign-ins through
// /api/auth/*, and each request carries the Set-Cookie it got back (the technique of
// admin-settings.routes.test.ts). No fake sessions, no mocked repository.
//
// The expected levels below are computed by hand from the real seed thresholds
// (config/commons/football/tests.json), so they pin the age band and the boundary rules.

const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILES = ["player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const START = ENDPOINTS.start.path;
const ME = "/api/player/me";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

/** A real createApp that mounts only the route under test and the real Better Auth handler. */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTE_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(SOURCE_DIR, file))};\n`);
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

async function freshDatabase(seed: boolean): Promise<void> {
  try {
    db?.close();
  } catch {
    // already closed
  }
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  if (seed) loadSeed(db, SEED_DIR);
  app = await buildApp();
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "player-start-routes-"));
  await freshDatabase(true);
});

afterEach(() => {
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

// --- real sessions ----------------------------------------------------------------------------

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

// --- requests ---------------------------------------------------------------------------------

/** `body` is JSON-encoded unless it is already a string (to send malformed JSON verbatim). */
const start = (cookie: string | undefined, body?: unknown) =>
  app.request(START, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const me = (cookie?: string) => app.request(ME, { headers: cookie ? { cookie } : {} });

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

// --- data -------------------------------------------------------------------------------------

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

/** Five real football tests. Age 12 (from10to13) yields 4, 2, 5, 3, 2 (hand-computed, see the table test). */
const baseline = (first = 1): BaselineResult[] => [
  { testSlug: "juggling-max-touches", value: 30, attempts: 3, clientUuid: uuid(first) },
  { testSlug: "wall-passing-60s", value: 20, clientUuid: uuid(first + 1) },
  { testSlug: "ball-mastery-30s", value: 95, clientUuid: uuid(first + 2) },
  { testSlug: "slalom-time", value: 9, errors: 1, clientUuid: uuid(first + 3) },
  { testSlug: "weak-foot-passes", value: 4, clientUuid: uuid(first + 4) },
];

const request = (over: Partial<PlayerProfile> = {}, results: BaselineResult[] = baseline()): StartRequest => ({
  profile: { ...PROFILE, ...over },
  baseline: results,
});

const levelsOf = (roadmap: Roadmap): Record<string, number> =>
  Object.fromEntries(roadmap.tracks.map((track) => [track.skill, track.level]));

const count = (table: string, where = "1 = 1", ...params: string[]): number =>
  (db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;

const startOk = async (player: Player, body: StartRequest): Promise<StartResponse> => {
  const res = await start(player.cookie, body);
  expect(res.status).toBe(200);
  return StartResponse.parse(await res.json());
};

test("the route serves the contract's path with the contract's method", () => {
  expect(ENDPOINTS.start.method).toBe("POST");
  expect(START).toBe("/api/player/start");
});

// --- happy path -----------------------------------------------------------------------------------

describe("POST /api/player/start, first call", () => {
  test("answers 200 with the profile and the roadmap the levels give, and stores profile, results and roadmap for the session player", async () => {
    const player = await signInPlayer();
    const res = await start(player.cookie, request());
    expect(res.status).toBe(200);
    const body = StartResponse.parse(await res.json());

    expect(body.profile).toEqual(PROFILE);
    expect(body.roadmap).toEqual({
      currentLevelLabel: "Intermediate", // mean (5 + 4 + 3 + 2 + 2) / 5 = 3.2
      tracks: [
        { skill: "ball-mastery", level: 5, source: "test" },
        { skill: "juggling-coordination", level: 4, source: "test" },
        { skill: "dribbling", level: 3, source: "test" }, // 9 s + 1 error = 10 s, inclusive boundary of level 3
        { skill: "passing-first-touch", level: 2, source: "test" },
        { skill: "weak-foot", level: 2, source: "test" },
      ],
      goal: "dribbling",
      weeks: 4,
      sessionsPerWeek: 3,
      minutesPerSession: 20,
      focus: [
        { skill: "dribbling", level: 3, targetLevel: 4, reason: "goal" },
        { skill: "passing-first-touch", level: 2, targetLevel: 3, reason: "weakest" },
        { skill: "weak-foot", level: 2, targetLevel: 3, reason: "weakest" },
      ],
    });

    const profileRows = db.query("SELECT * FROM player_profiles").all() as Record<string, unknown>[];
    expect(profileRows).toHaveLength(1);
    expect(profileRows[0]).toMatchObject({
      player_id: player.id,
      age: 12,
      level: "basic",
      goal: "dribbling",
      equipment: "ball",
      space: "yard",
      partner: 0,
      days_per_week: 3,
      minutes_per_session: 20,
      locale: "ru",
    });

    const results = db
      .query("SELECT player_id, test_slug, value, attempts, errors, skipped, client_uuid FROM test_results ORDER BY id")
      .all();
    expect(results).toEqual([
      { player_id: player.id, test_slug: "juggling-max-touches", value: 30, attempts: 3, errors: null, skipped: 0, client_uuid: uuid(1) },
      { player_id: player.id, test_slug: "wall-passing-60s", value: 20, attempts: null, errors: null, skipped: 0, client_uuid: uuid(2) },
      { player_id: player.id, test_slug: "ball-mastery-30s", value: 95, attempts: null, errors: null, skipped: 0, client_uuid: uuid(3) },
      { player_id: player.id, test_slug: "slalom-time", value: 9, attempts: null, errors: 1, skipped: 0, client_uuid: uuid(4) },
      { player_id: player.id, test_slug: "weak-foot-passes", value: 4, attempts: null, errors: null, skipped: 0, client_uuid: uuid(5) },
    ]);

    const roadmaps = db.query("SELECT player_id, json, graph_version FROM roadmaps").all() as {
      player_id: string;
      json: string;
      graph_version: string;
    }[];
    expect(roadmaps).toHaveLength(1);
    expect(roadmaps[0]!.player_id).toBe(player.id);
    expect(JSON.parse(roadmaps[0]!.json)).toEqual(body.roadmap);
    const sport = db.query("SELECT graph_version FROM sports WHERE slug = 'football'").get() as { graph_version: string };
    expect(roadmaps[0]!.graph_version).toBe(sport.graph_version);
  });

  test("the age band decides the levels: the same results give different tracks at 8, 12 and 16", async () => {
    const [young, middle, old] = [await signInPlayer(), await signInPlayer(), await signInPlayer()];
    const at8 = await startOk(young, request({ age: 8 }));
    // clientUuid is unique across ALL players, so each player sends their own uuids.
    const at12 = await startOk(middle, request({ age: 12 }, baseline(101)));
    const at16 = await startOk(old, request({ age: 16 }, baseline(201)));
    expect(levelsOf(at8.roadmap)).toEqual({
      "ball-mastery": 5,
      "juggling-coordination": 5,
      dribbling: 3,
      "passing-first-touch": 3,
      "weak-foot": 3,
    });
    expect(levelsOf(at12.roadmap)).toEqual({
      "ball-mastery": 5,
      "juggling-coordination": 4,
      dribbling: 3,
      "passing-first-touch": 2,
      "weak-foot": 2,
    });
    expect(levelsOf(at16.roadmap)).toEqual({
      "ball-mastery": 4,
      "juggling-coordination": 3,
      dribbling: 2,
      "passing-first-touch": 2,
      "weak-foot": 2,
    });
    expect(at8.profile.age).toBe(8);
  });

  test("a skipped test falls back to the self-assessed level (source self) and is stored as skipped with value 0", async () => {
    const player = await signInPlayer();
    const results = baseline();
    results[3] = { testSlug: "slalom-time", value: 0, skipped: true, clientUuid: uuid(4) };
    const { roadmap } = await startOk(player, request({ level: "intermediate" }, results));
    expect(roadmap.tracks.find((track) => track.skill === "dribbling")).toEqual({ skill: "dribbling", level: 3, source: "self" });
    expect(roadmap.tracks.find((track) => track.skill === "weak-foot")?.source).toBe("test");
    expect(db.query("SELECT value, skipped FROM test_results WHERE test_slug = 'slalom-time'").get()).toEqual({ value: 0, skipped: 1 });
  });

  test("an empty baseline is fine: every track is self-assessed and only the profile and the roadmap are stored", async () => {
    const player = await signInPlayer();
    const { roadmap } = await startOk(player, request({ level: "beginner", goal: "weakfoot" }, []));
    expect(roadmap.tracks).toHaveLength(5);
    expect(roadmap.tracks.every((track) => track.level === 1 && track.source === "self")).toBe(true);
    expect(roadmap.focus[0]).toEqual({ skill: "weak-foot", level: 1, targetLevel: 2, reason: "goal" });
    expect(count("test_results")).toBe(0);
    expect(count("roadmaps", "player_id = ?", player.id)).toBe(1);
    expect(count("player_profiles", "player_id = ?", player.id)).toBe(1);
  });
});

// --- replay and re-onboarding -----------------------------------------------------------------

describe("POST /api/player/start, replay", () => {
  test("a replay with the same clientUuids is a 200 with the SAME response and creates no duplicate row anywhere", async () => {
    const player = await signInPlayer();
    const first = await startOk(player, request());
    const second = await startOk(player, request());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(count("player_profiles")).toBe(1);
    expect(count("test_results")).toBe(5);
    expect(count("roadmaps")).toBe(1);
    const third = await startOk(player, request());
    expect(third).toEqual(first);
    expect(count("test_results")).toBe(5);
    expect(count("roadmaps")).toBe(1);
  });

  test("a replayed clientUuid keeps the first stored value: the response derives from what is stored, not from the retry's numbers", async () => {
    const player = await signInPlayer();
    const first = await startOk(player, request());
    const altered = baseline().map((result) => ({ ...result, value: 0 }));
    const replay = await startOk(player, request({}, altered));
    expect(replay).toEqual(first);
    expect(db.query("SELECT value FROM test_results WHERE client_uuid = ?").get(uuid(3))).toEqual({ value: 95 });
    expect(count("test_results")).toBe(5);
  });

  test("a second start with a new profile and new clientUuids replaces the plan: the profile is updated, the latest roadmap wins", async () => {
    const player = await signInPlayer();
    const first = await startOk(player, request());
    const second = await startOk(player, request({ age: 16, goal: "passing", daysPerWeek: 5 }, baseline(11)));
    expect(second.roadmap).not.toEqual(first.roadmap);
    expect(second.roadmap.goal).toBe("passing");
    expect(second.roadmap.sessionsPerWeek).toBe(5);
    expect(second.profile.age).toBe(16);
    expect(count("player_profiles")).toBe(1);
    expect(count("test_results")).toBe(10);

    const current = await me(player.cookie);
    expect(current.status).toBe(200);
    expect(StartResponse.parse(await current.json())).toEqual(second);
  });
});

// --- validation: 422 before anything is written ----------------------------------------------------

describe("POST /api/player/start, invalid requests", () => {
  const nothingWritten = () => {
    expect(count("player_profiles")).toBe(0);
    expect(count("test_results")).toBe(0);
    expect(count("roadmaps")).toBe(0);
  };

  test("age 3 is a 422 problem with the pointer /profile/age and nothing is stored", async () => {
    const player = await signInPlayer();
    const problem = await expectProblem(await start(player.cookie, request({ age: 3 })), 422);
    expect(problem.errors?.map((error) => error.pointer)).toContain("/profile/age");
    nothingWritten();
  });

  test("every invalid field is listed with its own pointer", async () => {
    const player = await signInPlayer();
    const body = {
      profile: { ...PROFILE, age: 3, daysPerWeek: 9 },
      baseline: [{ ...baseline()[0], clientUuid: "not-a-uuid" }],
    };
    const problem = await expectProblem(await start(player.cookie, body), 422);
    const pointers = problem.errors?.map((error) => error.pointer) ?? [];
    expect(pointers).toEqual(expect.arrayContaining(["/profile/age", "/profile/daysPerWeek", "/baseline/0/clientUuid"]));
    for (const error of problem.errors ?? []) expect(error.detail.length).toBeGreaterThan(0);
    nothingWritten();
  });

  test("an unknown key (a playerId, a name) is a 422 at that key: the player id is never read from the body", async () => {
    const [attacker, victim] = [await signInPlayer(), await signInPlayer()];
    const problem = await expectProblem(await start(attacker.cookie, { ...request(), playerId: victim.id }), 422);
    expect(problem.errors?.map((error) => error.pointer)).toContain("/playerId");
    const withName = await expectProblem(await start(attacker.cookie, { ...request(), profile: { ...PROFILE, name: "Aidar" } }), 422);
    expect(withName.errors?.map((error) => error.pointer)).toContain("/profile/name");
    nothingWritten();
  });

  test("an unknown test slug is a 422 at /baseline/<index>/testSlug and nothing is stored, not even the profile", async () => {
    const player = await signInPlayer();
    const results = baseline();
    results[2] = { testSlug: "no-such-test", value: 5, clientUuid: uuid(3) };
    const problem = await expectProblem(await start(player.cookie, request({}, results)), 422);
    expect(problem.errors?.map((error) => error.pointer)).toEqual(["/baseline/2/testSlug"]);
    nothingWritten();
  });

  test("a test of another sport is refused like an unknown one", async () => {
    db.run("INSERT INTO sports (id, slug, name, graph_version) VALUES ('hockey', 'hockey', '{}', 'v1')");
    db.run(
      "INSERT INTO skills (id, slug, sport_id, age_min, age_max, equipment, names) VALUES ('shooting', 'shooting', 'hockey', 5, 99, 'ball', '{}')",
    );
    db.run(
      "INSERT INTO skill_tests (id, slug, skill_id, metric, unit, direction, protocol, equipment) VALUES ('t1', 'hockey-shot-speed', 'shooting', 'speed', 'kmh', 'higher', '{}', 'ball')",
    );
    const player = await signInPlayer();
    const results = [...baseline().slice(0, 1), { testSlug: "hockey-shot-speed", value: 60, clientUuid: uuid(9) }];
    const problem = await expectProblem(await start(player.cookie, request({}, results)), 422);
    expect(problem.errors?.map((error) => error.pointer)).toEqual(["/baseline/1/testSlug"]);
    nothingWritten();
  });

  test("a body that is not JSON is a 400 problem and nothing is stored", async () => {
    const player = await signInPlayer();
    await expectProblem(await start(player.cookie, "{not json"), 400);
    await expectProblem(await start(player.cookie, "[]"), 400);
    await expectProblem(await start(player.cookie), 400);
    nothingWritten();
  });

  test("a database without the sport's seed answers 503 and stores nothing", async () => {
    await freshDatabase(false);
    const player = await signInPlayer();
    await expectProblem(await start(player.cookie, request()), 503);
    nothingWritten();
  });
});

// --- authentication ---------------------------------------------------------------------------------

describe("authentication", () => {
  test("no cookie is a 401 problem on both endpoints and nothing is stored", async () => {
    const problem = await expectProblem(await start(undefined, request()), 401);
    expect(problem.title).toBe("Unauthorized");
    await expectProblem(await me(), 401);
    expect(count("player_profiles")).toBe(0);
    expect(count("test_results")).toBe(0);
    expect(count("roadmaps")).toBe(0);
  });

  test("authentication runs before the body is read: an invalid or malformed body without a session is a 401, never a 400 or 422", async () => {
    for (const body of ["{not json", "[]", request({ age: 3 }), { profile: 1 }]) {
      await expectProblem(await start(undefined, body), 401);
    }
    expect(count("player_profiles")).toBe(0);
  });

  test("a forged session cookie is a 401", async () => {
    const forged = "better-auth.session_token=Zm9yZ2VkLXRva2Vu.Zm9yZ2VkLXNpZ25hdHVyZQ";
    await expectProblem(await start(forged, request()), 401);
    await expectProblem(await me(forged), 401);
    expect(count("player_profiles")).toBe(0);
  });
});

// --- GET /api/player/me ---------------------------------------------------------------------------

describe("GET /api/player/me", () => {
  test("before onboarding it is a 404 problem 'not onboarded'", async () => {
    const player = await signInPlayer();
    const problem = await expectProblem(await me(player.cookie), 404);
    expect(problem.detail ?? problem.title).toContain("not onboarded");
  });

  test("after onboarding it is a 200 equal to the start response, and it reads without writing", async () => {
    const player = await signInPlayer();
    const started = await startOk(player, request());
    const before = [count("player_profiles"), count("test_results"), count("roadmaps")];
    const res = await me(player.cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(started);
    expect(PlayerProfileView.safeParse((body as StartResponse).profile).success).toBe(true);
    expect(Roadmap.safeParse((body as StartResponse).roadmap).success).toBe(true);
    expect([count("player_profiles"), count("test_results"), count("roadmaps")]).toEqual(before);
  });
});

// --- owner isolation ---------------------------------------------------------------------------------

describe("owner isolation", () => {
  test("two players onboard side by side: each reads only their own data and each owns only their own rows", async () => {
    const [a, b] = [await signInPlayer(), await signInPlayer()];
    const resA = await startOk(a, request({ age: 12, goal: "dribbling" }, baseline(1)));
    const resB = await startOk(b, request({ age: 16, goal: "passing", locale: "kk", partner: true }, baseline(21)));

    expect(resA.profile.goal).toBe("dribbling");
    expect(resB.profile).toMatchObject({ age: 16, goal: "passing", locale: "kk", partner: true });

    expect(await (await me(a.cookie)).json()).toEqual(resA);
    expect(await (await me(b.cookie)).json()).toEqual(resB);

    expect(count("player_profiles")).toBe(2);
    for (const player of [a, b]) {
      expect(count("test_results", "player_id = ?", player.id)).toBe(5);
      expect(count("roadmaps", "player_id = ?", player.id)).toBe(1);
    }
    expect(db.query("SELECT DISTINCT client_uuid FROM test_results WHERE player_id = ? ORDER BY client_uuid").all(a.id)).toEqual(
      baseline(1).map((result) => ({ client_uuid: result.clientUuid })),
    );
  });

  test("a player who has not onboarded still gets a 404 while another player is onboarded", async () => {
    const [a, b] = [await signInPlayer(), await signInPlayer()];
    await startOk(a, request());
    await expectProblem(await me(b.cookie), 404);
  });

  test("a clientUuid already stored for another player is never rewritten or taken over: the row stays with its owner and the intruder's response ignores it", async () => {
    const [a, b] = [await signInPlayer(), await signInPlayer()];
    await startOk(a, request());
    const own = await startOk(b, request({ level: "beginner" }, [{ testSlug: "juggling-max-touches", value: 999, clientUuid: uuid(1) }]));

    expect(db.query("SELECT player_id, value FROM test_results WHERE client_uuid = ?").get(uuid(1))).toEqual({ player_id: a.id, value: 30 });
    expect(count("test_results", "player_id = ?", b.id)).toBe(0);
    expect(count("test_results")).toBe(5);
    expect(own.roadmap.tracks.every((track) => track.level === 1 && track.source === "self")).toBe(true);
  });

  test("a second start by one player never touches another player's profile, results or roadmap", async () => {
    const [a, b] = [await signInPlayer(), await signInPlayer()];
    const first = await startOk(a, request());
    const snapshot = () => ({
      profile: db.query("SELECT * FROM player_profiles WHERE player_id = ?").get(a.id),
      results: db.query("SELECT * FROM test_results WHERE player_id = ? ORDER BY id").all(a.id),
      roadmaps: db.query("SELECT * FROM roadmaps WHERE player_id = ? ORDER BY id").all(a.id),
    });
    const before = snapshot();
    await startOk(b, request({ age: 7, goal: "control", level: "beginner" }, baseline(31)));
    await startOk(b, request({ age: 9, goal: "passing" }, baseline(41)));
    expect(snapshot()).toEqual(before);
    expect(await (await me(a.cookie)).json()).toEqual(first);
  });
});

// --- the repository (injectable clock, ISO-ms timestamps) ------------------------------------------------------

describe("profile-repo", () => {
  test("timestamps come from the injected clock as ISO 8601 UTC with milliseconds, and created_at survives an update", async () => {
    const repo = await import("../../player/profile-repo");
    const t1 = new Date("2026-03-04T05:06:07.089Z");
    const t2 = new Date("2026-03-05T10:11:12.345Z");
    const id = "player-under-test";

    repo.upsertProfile(db, id, PROFILE, { now: () => t1 });
    repo.insertBaseline(db, id, baseline(), { now: () => t1 });
    repo.saveRoadmap(db, id, (await startOk(await signInPlayer(), request())).roadmap, "gv-1", { now: () => t1 });
    expect(db.query("SELECT created_at, updated_at FROM player_profiles WHERE player_id = ?").get(id)).toEqual({
      created_at: t1.toISOString(),
      updated_at: t1.toISOString(),
    });
    expect((db.query("SELECT DISTINCT recorded_at FROM test_results WHERE player_id = ?").all(id) as unknown[]).length).toBe(1);
    expect(db.query("SELECT recorded_at FROM test_results WHERE player_id = ? LIMIT 1").get(id)).toEqual({ recorded_at: t1.toISOString() });
    expect(db.query("SELECT created_at, graph_version FROM roadmaps WHERE player_id = ?").get(id)).toEqual({
      created_at: t1.toISOString(),
      graph_version: "gv-1",
    });

    const updated = repo.upsertProfile(db, id, { ...PROFILE, age: 13 }, { now: () => t2 });
    expect(updated.age).toBe(13);
    expect(db.query("SELECT created_at, updated_at FROM player_profiles WHERE player_id = ?").get(id)).toEqual({
      created_at: t1.toISOString(),
      updated_at: t2.toISOString(),
    });
    expect(count("test_results", "player_id = ?", id)).toBe(5); // an upsert never cascades the history away
    expect(count("roadmaps", "player_id = ?", id)).toBe(1);
  });
});
