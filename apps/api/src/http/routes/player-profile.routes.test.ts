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
import type { PlayerProfile } from "../../shared/domain";
import { ENDPOINTS, PatchProfileResponse, ResetPlanResponse } from "../../shared/journey";
import { ENDPOINTS as ONBOARDING, StartResponse } from "../../shared/onboarding";
import type { BaselineResult, StartRequest } from "../../shared/onboarding";
import { PROBLEM_CONTENT_TYPE } from "../../shared/primitives";
import { ENDPOINTS as SESSION, TodaySession } from "../../shared/session";

// Every test runs the real createApp on a fresh in-memory database migrated with the real migrations and
// loaded with the REAL seed (config/commons), with the REAL Better Auth handler and the REAL start and today
// routes mounted next to the routes under test. Players are real anonymous sign-ins that onboard through
// POST /api/player/start; "the next session" is what GET /api/player/today answers after the change (the
// technique of player-today.routes.test.ts). No fake sessions, no mocked repository.

const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILES = ["player-profile.routes.ts", "player-today.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const DAY_MS = 86_400_000;
const PATCH = ENDPOINTS.patchProfile.path;
const RESET = ENDPOINTS.resetPlan.path;
const ME = "/api/player/me";

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

/** A real createApp that mounts only the routes under test and the real Better Auth handler. */
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
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "player-profile-routes-"));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  app = await buildApp();
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

/** Five real football tests; `first` keeps the client uuids of different players apart. */
const baseline = (first: number): BaselineResult[] => [
  { testSlug: "juggling-max-touches", value: 30, attempts: 3, clientUuid: uuid(first) },
  { testSlug: "wall-passing-60s", value: 20, clientUuid: uuid(first + 1) },
  { testSlug: "ball-mastery-30s", value: 95, clientUuid: uuid(first + 2) },
  { testSlug: "slalom-time", value: 9, errors: 1, clientUuid: uuid(first + 3) },
  { testSlug: "weak-foot-passes", value: 4, clientUuid: uuid(first + 4) },
];

let nextUuid = 1;

/** A signed-in player who has onboarded; returns what /start answered. */
async function onboardedPlayer(over: Partial<PlayerProfile> = {}): Promise<Player & { start: StartResponse }> {
  const player = await signInPlayer();
  const body: StartRequest = { profile: { ...PROFILE, ...over }, baseline: baseline(nextUuid) };
  nextUuid += 10;
  const res = await app.request(ONBOARDING.start.path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: player.cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return { ...player, start: StartResponse.parse(await res.json()) };
}

// --- requests -----------------------------------------------------------------------------------

type Options = { cookie?: string; timeZone?: string };

const headersOf = (options: Options, json: boolean): Record<string, string> => ({
  ...(json ? { "content-type": "application/json" } : {}),
  ...(options.cookie ? { cookie: options.cookie } : {}),
  ...(options.timeZone === undefined ? {} : { "x-timezone": options.timeZone }),
});

/** PATCH with a raw body (a string is sent as is, anything else as JSON). */
const patchRaw = (body: unknown, options: Options = {}) =>
  app.request(PATCH, { method: "PATCH", headers: headersOf(options, true), body: typeof body === "string" ? body : JSON.stringify(body) });

const patch = (player: Player, body: unknown, options: Omit<Options, "cookie"> = {}) => patchRaw(body, { ...options, cookie: player.cookie });

const reset = (options: Options = {}) => app.request(RESET, { method: "POST", headers: headersOf(options, false) });

async function patchOk(player: Player, body: unknown, options: Omit<Options, "cookie"> = {}): Promise<PatchProfileResponse> {
  const res = await patch(player, body, options);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return PatchProfileResponse.parse(await res.json());
}

async function resetOk(player: Player, options: Omit<Options, "cookie"> = {}): Promise<ResetPlanResponse> {
  const res = await reset({ ...options, cookie: player.cookie });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return ResetPlanResponse.parse(await res.json());
}

const today = (player: Player, options: Omit<Options, "cookie"> = {}) =>
  app.request(SESSION.getToday.path, { headers: headersOf({ ...options, cookie: player.cookie }, false) });

async function todayOk(player: Player, options: Omit<Options, "cookie"> = {}): Promise<TodaySession> {
  const res = await today(player, options);
  expect(res.status).toBe(200);
  return TodaySession.parse(await res.json());
}

type Problem = { type: string; title: string; status: number; detail?: string; errors?: { pointer: string; detail: string }[] };

const expectProblem = async (res: Response, status: number): Promise<Problem> => {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as Problem;
  expect(body.status).toBe(status);
  return body;
};

// --- db helpers ---------------------------------------------------------------------------------

type SessionRow = { id: string; date: string; items: string; finished_at: string | null };
const sessionRows = (playerId: string): SessionRow[] =>
  db.query("SELECT id, date, items, finished_at FROM sessions WHERE player_id = ? ORDER BY date").all(playerId) as SessionRow[];

const roadmapRows = (playerId: string) =>
  db.query("SELECT id, json, graph_version, created_at FROM roadmaps WHERE player_id = ? ORDER BY created_at, id").all(playerId) as Array<{
    id: number;
    json: string;
    graph_version: string;
    created_at: string;
  }>;

const resultRows = (playerId: string) =>
  db.query("SELECT * FROM test_results WHERE player_id = ? ORDER BY id").all(playerId) as Array<Record<string, unknown>>;

const profileRow = (playerId: string) => db.query("SELECT * FROM player_profiles WHERE player_id = ?").get(playerId) as Record<string, unknown> | null;

const equipmentOf = (versionId: string): string => (db.query("SELECT equipment FROM drill_versions WHERE id = ?").get(versionId) as { equipment: string }).equipment;

/** The calendar day it is now in a fixed-offset zone. */
const dayAtOffset = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 10);
const shiftDay = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Inserts an (unfinished) session row of the player for `date`, as GET /today would store it. */
function insertSession(playerId: string, id: string, date: string, finishedAt: string | null = null): void {
  db.query("INSERT INTO sessions (id, player_id, date, planner, graph_version, items, finished_at) VALUES (?1, ?2, ?3, 'rules', 'g', '[]', ?4)").run(
    id,
    playerId,
    date,
    finishedAt,
  );
}

// --- tests --------------------------------------------------------------------------------------

test("the routes serve the contract's paths and methods", () => {
  expect(ENDPOINTS.patchProfile.method).toBe("PATCH");
  expect(PATCH).toBe("/api/player/profile");
  expect(ENDPOINTS.resetPlan.method).toBe("POST");
  expect(RESET).toBe("/api/player/plan/reset");
});

describe("access", () => {
  test("no cookie is a 401 problem on both routes, never cached, and nothing is written", async () => {
    const player = await onboardedPlayer();
    const before = { profile: profileRow(player.id), roadmaps: roadmapRows(player.id) };
    await expectProblem(await patchRaw({ minutesPerSession: 30 }), 401);
    await expectProblem(await reset(), 401);
    expect(profileRow(player.id)).toEqual(before.profile);
    expect(roadmapRows(player.id)).toEqual(before.roadmaps);
  });

  test("a signed-in player who has not onboarded gets a 404 'not onboarded' problem on both routes and nothing is stored", async () => {
    const player = await signInPlayer();
    for (const res of [await patch(player, { minutesPerSession: 30 }), await reset({ cookie: player.cookie })]) {
      const body = await expectProblem(res, 404);
      expect(`${body.title} ${body.detail ?? ""}`).toMatch(/not onboarded/i);
    }
    expect(profileRow(player.id)).toBeNull();
    expect(roadmapRows(player.id)).toEqual([]);
    expect(sessionRows(player.id)).toEqual([]);
  });
});

describe("PATCH /api/player/profile: the request", () => {
  test("a body that is not a JSON object is a 400 problem and nothing is written", async () => {
    const player = await onboardedPlayer();
    const before = profileRow(player.id);
    for (const body of ["not json", "[]", "null", '"text"', "5"]) {
      await expectProblem(await patch(player, body), 400);
    }
    expect(profileRow(player.id)).toEqual(before);
  });

  test.each([
    ["an unknown key", { minutesPerSession: 30, extra: 1 }, "/extra"],
    ["a player id", { playerId: "someone-else" }, "/playerId"],
    ["age (part of the baseline, not editable)", { age: 13 }, "/age"],
    ["level (part of the baseline, not editable)", { level: "beginner" }, "/level"],
    ["a minutes value the contract does not list", { minutesPerSession: 25 }, "/minutesPerSession"],
    ["a days value out of range", { daysPerWeek: 7 }, "/daysPerWeek"],
    ["an unknown equipment", { equipment: "jetpack" }, "/equipment"],
    ["an unknown locale", { locale: "de" }, "/locale"],
    ["a partner that is not a boolean", { partner: "yes" }, "/partner"],
  ])("%s is a 422 problem with a JSON Pointer, and nothing is written", async (_name, body, pointer) => {
    const player = await onboardedPlayer();
    await todayOk(player);
    const before = { profile: profileRow(player.id), roadmaps: roadmapRows(player.id), sessions: sessionRows(player.id) };
    const problem = await expectProblem(await patch(player, body), 422);
    expect(problem.errors?.map((e) => e.pointer)).toContain(pointer);
    expect(profileRow(player.id)).toEqual(before.profile);
    expect(roadmapRows(player.id)).toEqual(before.roadmaps);
    expect(sessionRows(player.id)).toEqual(before.sessions);
  });
});

describe("PATCH /api/player/profile: the change", () => {
  test("minutes 20 -> 30: the profile and roadmap carry 30 and the next session's total is the 30-minute window", async () => {
    const player = await onboardedPlayer();
    const before = await todayOk(player);
    expect(before.totalMinutes).toBeGreaterThanOrEqual(18);
    expect(before.totalMinutes).toBeLessThanOrEqual(23);

    const answer = await patchOk(player, { minutesPerSession: 30 });
    expect(answer.profile).toEqual({ ...PROFILE, minutesPerSession: 30 });
    expect(answer.roadmap?.minutesPerSession).toBe(30);

    // What is stored is what was answered.
    expect(profileRow(player.id)).toMatchObject({ minutes_per_session: 30, age: 12, goal: "dribbling", locale: "ru" });
    const me = StartResponse.parse(await (await app.request(ME, { headers: { cookie: player.cookie } })).json());
    expect(me.profile).toEqual(answer.profile);
    expect(me.roadmap).toEqual(answer.roadmap!);

    // Today's unfinished session is dropped; the next one is composed from the new plan.
    expect(sessionRows(player.id)).toEqual([]);
    const after = await todayOk(player);
    expect(after.id).not.toBe(before.id);
    expect(after.totalMinutes).toBeGreaterThanOrEqual(28);
    expect(after.totalMinutes).toBeLessThanOrEqual(33);
    expect(after.roadmapSummary.minutesPerSession).toBe(30);
    expect(sessionRows(player.id)).toHaveLength(1);
  });

  test("an equipment change removes the wall drills from the next session", async () => {
    const player = await onboardedPlayer({ equipment: "ball_wall", goal: "passing" });
    await todayOk(player);
    // The picker's choice among a track's drills is seeded by the (random) player id, so a session with a wall
    // drill is not guaranteed: store one that has two, as a wall player's session may (the technique of
    // player-today.routes.test.ts, which rewrites the stored items).
    const wall = db.query("SELECT id FROM drill_versions WHERE equipment = 'ball_wall' ORDER BY id LIMIT 2").all() as Array<{ id: string }>;
    expect(wall).toHaveLength(2);
    db.query("UPDATE sessions SET items = ?2 WHERE player_id = ?1").run(
      player.id,
      JSON.stringify(wall.map((row, index) => ({ itemId: `item-${index + 1}`, drillVersionId: row.id, minutes: 5, done: false }))),
    );
    const before = await todayOk(player);
    expect(before.items.map((item) => equipmentOf(item.drillVersionId))).toEqual(["ball_wall", "ball_wall"]);

    const answer = await patchOk(player, { equipment: "ball" });
    expect(answer.profile.equipment).toBe("ball");

    const after = await todayOk(player);
    expect(after.id).not.toBe(before.id);
    expect(after.items.length).toBeGreaterThan(0);
    expect(after.items.map((item) => equipmentOf(item.drillVersionId))).not.toContain("ball_wall");
  });

  test("the roadmap is rebuilt from the stored tracks and the patched profile, and kept as history", async () => {
    const player = await onboardedPlayer({ goal: "dribbling", daysPerWeek: 3 });
    const tracksBefore = player.start.roadmap.tracks;

    const answer = await patchOk(player, { goal: "passing", daysPerWeek: 5 });
    const roadmap = answer.roadmap!;
    expect(roadmap.goal).toBe("passing");
    expect(roadmap.sessionsPerWeek).toBe(5);
    expect(roadmap.focus[0]).toMatchObject({ skill: "passing-first-touch", reason: "goal" });
    expect(roadmap.tracks).toEqual(tracksBefore); // levels are the baseline's: a profile edit does not re-measure them
    expect(roadmap.weeks).toBe(player.start.roadmap.weeks);

    // Old plan kept, new plan is the latest and current.
    const rows = roadmapRows(player.id);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.json)).toEqual(player.start.roadmap);
    expect(JSON.parse(rows[1]!.json)).toEqual(roadmap);
    expect(rows[1]!.graph_version).toBe(rows[0]!.graph_version);
    const me = StartResponse.parse(await (await app.request(ME, { headers: { cookie: player.cookie } })).json());
    expect(me.roadmap).toEqual(roadmap);
    expect(me.profile.goal).toBe("passing");
  });

  test("fields not named are kept, and the baseline results are untouched", async () => {
    const player = await onboardedPlayer({ partner: true, locale: "kk" });
    const results = resultRows(player.id);
    const answer = await patchOk(player, { space: "field" });
    expect(answer.profile).toEqual({ ...PROFILE, partner: true, locale: "kk", space: "field" });
    expect(resultRows(player.id)).toEqual(results);
  });

  test("a patch that changes nothing writes nothing: same session (done kept), same roadmap rows", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    db.query("UPDATE sessions SET items = json_set(items, '$[0].done', json('true')) WHERE player_id = ?").run(player.id);
    const rows = roadmapRows(player.id);
    const profile = profileRow(player.id);

    for (const body of [{}, { minutesPerSession: 20, goal: "dribbling" }]) {
      const answer = await patchOk(player, body);
      expect(answer.profile).toEqual(PROFILE);
      expect(answer.roadmap).toEqual(player.start.roadmap);
    }
    expect(roadmapRows(player.id)).toEqual(rows);
    expect(profileRow(player.id)).toEqual(profile);
    const after = await todayOk(player);
    expect(after.id).toBe(session.id);
    expect(after.items[0]!.done).toBe(true);
  });

  test("only today's UNFINISHED session goes: a finished one and other days' sessions stay", async () => {
    const player = await onboardedPlayer();
    const date = dayAtOffset(0);
    insertSession(player.id, "yesterday", shiftDay(date, -1));
    insertSession(player.id, "tomorrow", shiftDay(date, 1));
    insertSession(player.id, "finished-today", date, new Date().toISOString());

    await patchOk(player, { minutesPerSession: 30 });
    expect(sessionRows(player.id).map((row) => row.id)).toEqual(["yesterday", "finished-today", "tomorrow"]);
  });

  test.each([
    ["Pacific/Kiritimati", 14],
    ["Pacific/Pago_Pago", -11],
    ["Mars/Olympus", 0], // an invalid zone means UTC, as GET /today
    ["", 0],
  ])("the day is the X-Timezone one: zone %p drops only the session of that local date", async (zone, offset) => {
    const player = await onboardedPlayer();
    const date = dayAtOffset(0);
    const days = [-2, -1, 0, 1, 2].map((n) => shiftDay(date, n));
    days.forEach((day, index) => insertSession(player.id, `s${index}`, day));

    await patchOk(player, { minutesPerSession: 30 }, zone === "" ? {} : { timeZone: zone });
    const gone = dayAtOffset(offset);
    expect(sessionRows(player.id).map((row) => row.date)).toEqual(days.filter((day) => day !== gone));
  });

  test("a stored roadmap that cannot be rebuilt fails closed: 500, nothing is changed, never cached", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    db.query("UPDATE roadmaps SET json = json_set(json, '$.tracks', json('[]')) WHERE player_id = ?").run(player.id);
    const before = { profile: profileRow(player.id), roadmaps: roadmapRows(player.id), sessions: sessionRows(player.id) };

    const res = await patch(player, { minutesPerSession: 30 });
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(profileRow(player.id)).toEqual(before.profile);
    expect(roadmapRows(player.id)).toEqual(before.roadmaps);
    expect(sessionRows(player.id)).toEqual(before.sessions);
    expect(sessionRows(player.id)[0]!.id).toBe(session.id);
  });
});

describe("POST /api/player/plan/reset", () => {
  test("clears the roadmap and today's unfinished session, keeps the profile and the whole test history", async () => {
    const player = await onboardedPlayer();
    await patchOk(player, { minutesPerSession: 30 }); // a second roadmap row: reset clears every one, not only the latest
    await todayOk(player);
    expect(roadmapRows(player.id)).toHaveLength(2);
    const results = resultRows(player.id);
    expect(results).toHaveLength(5);
    const profile = profileRow(player.id);

    const answer = await resetOk(player);
    expect(answer.roadmap).toBeNull();
    expect(answer.profile).toEqual({ ...PROFILE, minutesPerSession: 30 });

    expect(roadmapRows(player.id)).toEqual([]);
    expect(sessionRows(player.id)).toEqual([]);
    expect(resultRows(player.id)).toEqual(results); // history is kept, value for value
    expect(profileRow(player.id)).toEqual(profile);

    // The player is "not onboarded" again for the plan-bound routes until the baseline is redone.
    // (those two routes are not this bead's, so only their status is pinned here, not their headers)
    expect((await app.request(ME, { headers: { cookie: player.cookie } })).status).toBe(404);
    expect((await today(player)).status).toBe(404);
  });

  test("keeps a finished session and the sessions of other days, and a second reset is the same answer", async () => {
    const player = await onboardedPlayer();
    const date = dayAtOffset(0);
    insertSession(player.id, "yesterday", shiftDay(date, -1));
    insertSession(player.id, "finished-today", date, new Date().toISOString());
    insertSession(player.id, "tomorrow", shiftDay(date, 1));

    const first = await resetOk(player);
    expect(sessionRows(player.id).map((row) => row.id)).toEqual(["yesterday", "finished-today", "tomorrow"]);
    expect(await resetOk(player)).toEqual(first);
  });

  test("the day is the X-Timezone one", async () => {
    const player = await onboardedPlayer();
    const date = dayAtOffset(0);
    const days = [-2, -1, 0, 1, 2].map((n) => shiftDay(date, n));
    days.forEach((day, index) => insertSession(player.id, `s${index}`, day));

    await resetOk(player, { timeZone: "Pacific/Kiritimati" });
    expect(sessionRows(player.id).map((row) => row.date)).toEqual(days.filter((day) => day !== dayAtOffset(14)));
  });

  test("a PATCH after a reset updates the profile, builds no roadmap and answers roadmap null", async () => {
    const player = await onboardedPlayer();
    await resetOk(player);
    const answer = await patchOk(player, { minutesPerSession: 45, goal: "passing" });
    expect(answer.roadmap).toBeNull();
    expect(answer.profile).toEqual({ ...PROFILE, minutesPerSession: 45, goal: "passing" });
    expect(profileRow(player.id)).toMatchObject({ minutes_per_session: 45, goal: "passing" });
    expect(roadmapRows(player.id)).toEqual([]);
  });
});

describe("own player only", () => {
  test("a PATCH or a reset by one player leaves another player's profile, roadmap, sessions and results alone", async () => {
    const a = await onboardedPlayer();
    const b = await onboardedPlayer();
    await todayOk(a);
    await todayOk(b);
    const snapshotB = () => ({ profile: profileRow(b.id), roadmaps: roadmapRows(b.id), sessions: sessionRows(b.id), results: resultRows(b.id) });
    const before = snapshotB();

    await patchOk(a, { minutesPerSession: 30, goal: "passing" });
    expect(snapshotB()).toEqual(before);
    await resetOk(a);
    expect(snapshotB()).toEqual(before);
    expect(sessionRows(a.id)).toEqual([]);
    expect(roadmapRows(a.id)).toEqual([]);
  });
});
