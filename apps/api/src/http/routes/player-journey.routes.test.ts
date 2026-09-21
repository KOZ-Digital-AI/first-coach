import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { getSkillGraph } from "../../commons/repo";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import { ingestEvents } from "../../player/events";
import { ROADMAP_WEEKS } from "../../shared/domain";
import { ENDPOINTS, Journey } from "../../shared/journey";
import type { SessionEvent } from "../../shared/session";

// GET /api/player/journey (fc-mol-0bt.4). Every test runs the real createApp on a fresh in-memory database
// migrated with the real migrations and loaded with the REAL football seed (config/commons), with the REAL
// Better Auth handler mounted next to the route under test. Sessions are real cookies from /api/auth/*
// (anonymous players and a sign-up); nothing is faked. Sessions and events are written by the merged
// ingestEvents; profiles, roadmaps and test results are rows (the profile repository is another bead's).
//
// The clock is pinned with setSystemTime (the route reads `new Date()`), so "today" is NOW for every test.
//
// Readings the criteria leave open, pinned here (each is also stated in the route module):
//   * completedDrillCounts: the seed links every drill to its TRACK only (drill_skills is_primary = the track),
//     so a drill cannot be told to belong to one sub-skill. The count of a track's completed drills (items
//     with done = true, over all the player's sessions, drill version -> drill -> primary skill -> track) is
//     therefore what each sub-skill of that track is credited with; mastery is then decided by the track level.
//   * levels / focus are the player's LATEST stored roadmap (roadmaps, newest created_at then id); a profile
//     with no roadmap (after a plan reset) derives the tree from an empty roadmap.
//   * `locale`: the ?locale query (the contract has it); when absent the profile's locale.
//   * Time zone: the X-Timezone header, IANA, validated with Intl; absent or invalid means UTC.

const ROUTES_DIR_FILES = ["player-journey.routes.ts", "auth.routes.ts"] as const;
const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PATH = ENDPOINTS.getJourney.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const NOW = new Date("2026-03-10T12:00:00.000Z");
const TRACKS = ["ball-mastery", "dribbling", "passing-first-touch", "weak-foot", "juggling-coordination"];

let dir: string;
let db: Database;
let app: Hono;
let seq: number;
const savedEnv: Record<string, string | undefined> = {};

async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTES_DIR_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(SOURCE_DIR, file))};\n`);
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

beforeEach(async () => {
  setSystemTime(NOW);
  seq = 0;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "player-journey-routes-"));
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

// --- real sessions ------------------------------------------------------------------------------

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN },
    body: JSON.stringify(body),
  });

const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Actor = { cookie: string; id: string };

async function signInPlayer(): Promise<Actor> {
  const res = await post("/api/auth/sign-in/anonymous", {});
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

async function signUpContributor(): Promise<Actor> {
  const res = await post("/api/auth/sign-up/email", {
    name: "Coach",
    email: "contrib@example.com",
    password: "correct-horse-battery",
  });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

// --- data helpers ---------------------------------------------------------------------------------

const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function onboard(playerId: string, locale: "kk" | "ru" | "en" = "ru"): void {
  db.run(
    `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
     VALUES (?, 12, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, ?)`,
    [playerId, locale],
  );
}

/** A valid stored roadmap: `levels` maps a track to its level (others are 1). */
function storeRoadmap(playerId: string, levels: Record<string, number>, createdAt: string, focus: string[] = ["ball-mastery", "dribbling"]): void {
  const roadmap = {
    currentLevelLabel: "Basic",
    tracks: TRACKS.map((skill) => ({ skill, level: levels[skill] ?? 1, source: "test" })),
    goal: "dribbling",
    weeks: ROADMAP_WEEKS,
    sessionsPerWeek: 3,
    minutesPerSession: 20,
    focus: focus.map((skill) => ({ skill, level: 1, targetLevel: 2, reason: "test" })),
  };
  db.run("INSERT INTO roadmaps (player_id, json, graph_version, created_at) VALUES (?, ?, 'v', ?)", [playerId, JSON.stringify(roadmap), createdAt]);
}

/** The current version ids of the first `n` drills whose primary skill (track) is `track`. */
function versionsOf(track: string, n: number): string[] {
  const rows = db
    .query(
      `SELECT d.current_version_id AS id FROM drills d
         JOIN drill_skills ds ON ds.drill_id = d.id AND ds.is_primary = 1
         JOIN skills s ON s.id = ds.skill_id WHERE s.slug = ? ORDER BY d.slug LIMIT ?`,
    )
    .all(track, n) as Array<{ id: string }>;
  expect(rows).toHaveLength(n);
  return rows.map((r) => r.id);
}

/** A session with one item per drill version, none done. Items are `i1`, `i2`, ... */
function addSession(playerId: string, id: string, date: string, versionIds: string[]): void {
  const graphVersion = (db.query("SELECT graph_version FROM sports WHERE slug = 'football'").get() as { graph_version: string }).graph_version;
  const items = versionIds.map((drillVersionId, i) => ({
    itemId: `i${i + 1}`,
    drillVersionId,
    minutes: 5,
    done: false,
    content: { goal: { en: "g" } },
  }));
  db.run("INSERT INTO sessions (id, player_id, date, planner, graph_version, items) VALUES (?, ?, ?, 'rules', ?, ?)", [id, playerId, date, graphVersion, JSON.stringify(items)]);
}

const event = (sessionId: string, type: SessionEvent["type"], at: string, itemId?: string): SessionEvent => ({
  clientUuid: uuid(),
  sessionId,
  type,
  at,
  ...(itemId === undefined ? {} : { itemId }),
});

/** Marks the first `done` items of the session done, then finishes it at `at`. */
function completeSession(playerId: string, sessionId: string, at: string, done: number): void {
  const events: SessionEvent[] = [];
  for (let i = 1; i <= done; i++) events.push(event(sessionId, "drill_done", at, `i${i}`));
  events.push(event(sessionId, "session_finished", at));
  ingestEvents(db, playerId, events);
}

function addResult(playerId: string, testSlug: string, value: number, recordedAt: string): void {
  db.run("INSERT INTO test_results (player_id, test_slug, value, recorded_at, client_uuid) VALUES (?, ?, ?, ?, ?)", [playerId, testSlug, value, recordedAt, uuid()]);
}

// --- requests -------------------------------------------------------------------------------------

const get = (cookie?: string, opts: { query?: string; timeZone?: string } = {}) =>
  app.request(`${PATH}${opts.query ?? ""}`, {
    headers: { ...(cookie ? { cookie } : {}), ...(opts.timeZone === undefined ? {} : { "x-timezone": opts.timeZone }) },
  });

const journeyOf = async (res: Response): Promise<Journey> => {
  expect(res.status).toBe(200);
  return Journey.parse(await res.json());
};

const problemOf = async (res: Response) => {
  const body = (await res.json()) as { type: string; title: string; status: number; detail?: string; errors?: { pointer: string; detail: string }[] };
  return { contentType: res.headers.get("content-type"), body };
};

const nodeState = (journey: Journey, track: string, slug: string) =>
  journey.tree.find((t) => t.track === track)?.nodes.find((n) => n.slug === slug)?.state;

// --- contract -------------------------------------------------------------------------------------

test("the route serves the contract's path and method", () => {
  expect(ENDPOINTS.getJourney.method).toBe("GET");
  expect(PATH).toBe("/api/player/journey");
});

// --- authentication ---------------------------------------------------------------------------------

describe("who may read the journey", () => {
  test("no cookie is a 401 problem+json", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    const { contentType, body } = await problemOf(res);
    expect(contentType).toContain("application/problem+json");
    expect(body).toMatchObject({ title: "Unauthorized", status: 401 });
  });

  test("a forged session cookie is a 401", async () => {
    const res = await get("better-auth.session_token=Zm9yZ2VkLXRva2Vu.Zm9yZ2VkLXNpZ25hdHVyZQ");
    expect(res.status).toBe(401);
  });

  test("an anonymous player is allowed", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    expect((await get(player.cookie)).status).toBe(200);
  });

  test("a signed-up (non-anonymous) player is allowed too", async () => {
    const player = await signUpContributor();
    onboard(player.id);
    expect((await get(player.cookie)).status).toBe(200);
  });

  test("a player without a profile is a 404 problem+json saying so", async () => {
    const player = await signInPlayer();
    const res = await get(player.cookie);
    expect(res.status).toBe(404);
    const { contentType, body } = await problemOf(res);
    expect(contentType).toContain("application/problem+json");
    expect(body).toMatchObject({ title: "Not Found", status: 404 });
    expect(body.detail).toMatch(/not onboarded/i);
  });
});

// --- the response ---------------------------------------------------------------------------------

describe("an onboarded player with one finished session", () => {
  test("the response validates against the contract and shows FIRST_SESSION", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    addSession(player.id, "s1", "2026-03-10", versionsOf("ball-mastery", 3));
    completeSession(player.id, "s1", "2026-03-10T09:00:00.000Z", 3);

    const res = await get(player.cookie);
    expect(res.headers.get("content-type")).toContain("application/json");
    const journey = await journeyOf(res);

    expect(journey.metrics).toMatchObject({ sessionsCompleted: 1, minutesTrained: 15, streakDays: 1 });
    expect(journey.milestones).toContainEqual({ key: "FIRST_SESSION", achievedAt: "2026-03-10T09:00:00.000Z" });
    expect(journey.milestones.map((m) => m.key)).not.toContain("TEN_TRAINING_DAYS");
    expect(journey.tests).toEqual([]);
    expect(journey.retestsDue).toEqual([]);
  });

  test("one response carries the whole tree: the sport's five tracks, each with named nodes", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    const journey = await journeyOf(await get(player.cookie));
    expect(journey.tree.map((t) => t.track)).toEqual(TRACKS);
    for (const track of journey.tree) expect(track.nodes.length).toBeGreaterThan(0);
  });
});

describe("the skill tree", () => {
  test("a fresh player (profile, no roadmap) has each track's first node training and the rest locked", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    const journey = await journeyOf(await get(player.cookie));
    for (const track of journey.tree) {
      expect(track.nodes[0]!.state).toBe("training");
      for (const node of track.nodes.slice(1)) expect(node.state).toBe("locked");
    }
  });

  test("mastered needs the track level above the node and 3 completed drills of the track", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    storeRoadmap(player.id, { "ball-mastery": 4 }, "2026-03-01T00:00:00.000Z");
    addSession(player.id, "s1", "2026-03-10", versionsOf("ball-mastery", 3));
    completeSession(player.id, "s1", "2026-03-10T09:00:00.000Z", 3);

    const journey = await journeyOf(await get(player.cookie));
    expect(nodeState(journey, "ball-mastery", "basic-touches")).toBe("mastered");
    expect(nodeState(journey, "ball-mastery", "inside-touches")).toBe("mastered");
    expect(nodeState(journey, "ball-mastery", "outside-touches")).toBe("mastered");
    expect(nodeState(journey, "ball-mastery", "alternating-touches")).toBe("training");
    expect(nodeState(journey, "ball-mastery", "direction-change")).toBe("locked");
    // Another track's level did not move.
    expect(nodeState(journey, "dribbling", "close-dribbling")).toBe("training");
  });

  test("two completed drills are not enough to master a node", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    storeRoadmap(player.id, { "ball-mastery": 4 }, "2026-03-01T00:00:00.000Z");
    addSession(player.id, "s1", "2026-03-10", versionsOf("ball-mastery", 3));
    completeSession(player.id, "s1", "2026-03-10T09:00:00.000Z", 2);

    const journey = await journeyOf(await get(player.cookie));
    expect(nodeState(journey, "ball-mastery", "basic-touches")).toBe("training");
    expect(journey.tree.flatMap((t) => t.nodes).filter((n) => n.state === "mastered")).toEqual([]);
  });

  test("a drill that was undone is not a completed drill", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    storeRoadmap(player.id, { "ball-mastery": 4 }, "2026-03-01T00:00:00.000Z");
    addSession(player.id, "s1", "2026-03-10", versionsOf("ball-mastery", 3));
    completeSession(player.id, "s1", "2026-03-10T09:00:00.000Z", 3);
    ingestEvents(db, player.id, [event("s1", "drill_undone", "2026-03-10T09:30:00.000Z", "i3")]);

    const journey = await journeyOf(await get(player.cookie));
    expect(nodeState(journey, "ball-mastery", "basic-touches")).toBe("training");
  });

  test("completed drills of another track do not master this track", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    storeRoadmap(player.id, { "ball-mastery": 4, dribbling: 4 }, "2026-03-01T00:00:00.000Z");
    addSession(player.id, "s1", "2026-03-10", versionsOf("dribbling", 3));
    completeSession(player.id, "s1", "2026-03-10T09:00:00.000Z", 3);

    const journey = await journeyOf(await get(player.cookie));
    expect(nodeState(journey, "dribbling", "close-dribbling")).toBe("mastered");
    expect(nodeState(journey, "ball-mastery", "basic-touches")).toBe("training");
  });

  test("the LATEST stored roadmap decides the levels", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    storeRoadmap(player.id, { "ball-mastery": 4 }, "2026-03-01T00:00:00.000Z");
    storeRoadmap(player.id, { "ball-mastery": 1 }, "2026-03-05T00:00:00.000Z");
    addSession(player.id, "s1", "2026-03-10", versionsOf("ball-mastery", 3));
    completeSession(player.id, "s1", "2026-03-10T09:00:00.000Z", 3);

    const journey = await journeyOf(await get(player.cookie));
    expect(nodeState(journey, "ball-mastery", "basic-touches")).toBe("training");
  });

  test("the roadmap's focus makes a named sub-skill train", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    storeRoadmap(player.id, {}, "2026-03-01T00:00:00.000Z", ["dribbling-turns", "weak-foot-passing"]);

    const journey = await journeyOf(await get(player.cookie));
    expect(nodeState(journey, "dribbling", "dribbling-turns")).toBe("training");
    expect(nodeState(journey, "weak-foot", "weak-foot-passing")).toBe("training");
    expect(nodeState(journey, "dribbling", "slalom-dribbling")).toBe("locked");
  });
});

describe("the tests", () => {
  test("the player's own results appear with the sign-corrected change (slalom 30s -> 24s is +20)", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    addResult(player.id, "slalom-time", 30, "2026-03-01T10:00:00.000Z");
    addResult(player.id, "slalom-time", 24, "2026-03-05T10:00:00.000Z");

    const journey = await journeyOf(await get(player.cookie));
    const slalom = journey.tests.find((t) => t.testSlug === "slalom-time");
    expect(slalom).toMatchObject({ previous: 30, latest: 24, changePct: 20, personalBest: 24, direction: "lower" });
    expect(journey.metrics.skillsImproving).toBe(1);
    expect(journey.retestsDue).toEqual([]);
  });

  test("a result older than its retest interval is due", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    addResult(player.id, "ball-mastery-30s", 40, "2026-03-01T10:00:00.000Z");
    const journey = await journeyOf(await get(player.cookie));
    expect(journey.retestsDue).toEqual(["ball-mastery-30s"]);
  });
});

// --- another player's data --------------------------------------------------------------------------

describe("only the caller's own history", () => {
  test("another player's sessions, drills, roadmap and results never reach this player", async () => {
    const mine = await signInPlayer();
    const other = await signInPlayer();
    onboard(mine.id);
    onboard(other.id);
    storeRoadmap(other.id, { "ball-mastery": 4 }, "2026-03-01T00:00:00.000Z");
    addSession(other.id, "other-s1", "2026-03-10", versionsOf("ball-mastery", 3));
    completeSession(other.id, "other-s1", "2026-03-10T09:00:00.000Z", 3);
    addResult(other.id, "slalom-time", 30, "2026-03-01T10:00:00.000Z");
    addResult(other.id, "slalom-time", 24, "2026-03-05T10:00:00.000Z");

    const own = await journeyOf(await get(mine.cookie));
    expect(own.metrics).toEqual({ sessionsCompleted: 0, minutesTrained: 0, streakDays: 0, skillsImproving: 0 });
    expect(own.milestones).toEqual([]);
    expect(own.tests).toEqual([]);
    expect(own.tree.flatMap((t) => t.nodes).filter((n) => n.state === "mastered")).toEqual([]);

    // Positive control: the other player's own request does show that history.
    const theirs = await journeyOf(await get(other.cookie));
    expect(theirs.metrics.sessionsCompleted).toBe(1);
    expect(theirs.milestones.map((m) => m.key)).toContain("FIRST_SESSION");
    expect(nodeState(theirs, "ball-mastery", "basic-touches")).toBe("mastered");
  });
});

// --- time zone ---------------------------------------------------------------------------------------

describe("X-Timezone", () => {
  // One session finished 2026-03-08T22:00Z; "now" is 2026-03-10T12:00Z. In UTC that is two days ago (no streak);
  // in Asia/Almaty (UTC+5) it is 2026-03-09 03:00, yesterday (a streak of 1).
  function oneOldSession(playerId: string): void {
    addSession(playerId, "s1", "2026-03-08", versionsOf("ball-mastery", 1));
    completeSession(playerId, "s1", "2026-03-08T22:00:00.000Z", 1);
  }

  test("the streak counts calendar days in the player's zone", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    oneOldSession(player.id);

    expect((await journeyOf(await get(player.cookie, { timeZone: "Asia/Almaty" }))).metrics.streakDays).toBe(1);
    expect((await journeyOf(await get(player.cookie))).metrics.streakDays).toBe(0);
  });

  test("an invalid zone is UTC, not an error", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    oneOldSession(player.id);

    const utc = await journeyOf(await get(player.cookie));
    for (const bad of ["Mars/Olympus", "", "not a zone"]) {
      expect(await journeyOf(await get(player.cookie, { timeZone: bad }))).toEqual(utc);
    }
  });

  test("milestones count training days in the player's zone", async () => {
    // Ten finished sessions: a pair (22:00Z on D, 03:00Z on D+1) every other day for five pairs. In UTC that is ten
    // distinct days; in UTC+5 each pair falls on one local day, so five.
    const player = await signInPlayer();
    onboard(player.id);
    const pairs = [
      ["2026-02-10T22:00:00.000Z", "2026-02-11T03:00:00.000Z"],
      ["2026-02-12T22:00:00.000Z", "2026-02-13T03:00:00.000Z"],
      ["2026-02-14T22:00:00.000Z", "2026-02-15T03:00:00.000Z"],
      ["2026-02-16T22:00:00.000Z", "2026-02-17T03:00:00.000Z"],
      ["2026-02-18T22:00:00.000Z", "2026-02-19T03:00:00.000Z"],
    ];
    pairs.flat().forEach((at, i) => {
      const id = `t${i}`;
      addSession(player.id, id, `2026-02-${String(10 + i).padStart(2, "0")}`, versionsOf("ball-mastery", 1));
      completeSession(player.id, id, at, 0);
    });

    const utc = await journeyOf(await get(player.cookie));
    expect(utc.milestones).toContainEqual({ key: "TEN_TRAINING_DAYS", achievedAt: "2026-02-19T03:00:00.000Z" });
    const almaty = await journeyOf(await get(player.cookie, { timeZone: "Asia/Almaty" }));
    expect(almaty.milestones.map((m) => m.key)).not.toContain("TEN_TRAINING_DAYS");
    expect(almaty.milestones.map((m) => m.key)).toContain("FIRST_SESSION");
  });
});

// --- locale -------------------------------------------------------------------------------------------

describe("locale", () => {
  const nameOf = (locale: "kk" | "ru" | "en", slug: string): string =>
    getSkillGraph(db, "football", locale)!.nodes.find((n) => n.slug === slug)!.names[locale]!;

  test("?locale names the tree's nodes", async () => {
    const player = await signInPlayer();
    onboard(player.id, "ru");
    for (const locale of ["kk", "en"] as const) {
      const journey = await journeyOf(await get(player.cookie, { query: `?locale=${locale}` }));
      const node = journey.tree.find((t) => t.track === "ball-mastery")!.nodes[0]!;
      expect(node.name).toBe(nameOf(locale, "basic-touches"));
    }
    expect(nameOf("kk", "basic-touches")).not.toBe(nameOf("en", "basic-touches"));
  });

  test("without ?locale the profile's locale names the nodes", async () => {
    const player = await signInPlayer();
    onboard(player.id, "kk");
    const journey = await journeyOf(await get(player.cookie));
    expect(journey.tree.find((t) => t.track === "ball-mastery")!.nodes[0]!.name).toBe(nameOf("kk", "basic-touches"));
  });

  test("an unknown locale, or an unknown query key, is a 400 problem with a pointer", async () => {
    const player = await signInPlayer();
    onboard(player.id);
    for (const query of ["?locale=xx", "?lang=en"]) {
      const res = await get(player.cookie, { query });
      expect(res.status).toBe(400);
      const { contentType, body } = await problemOf(res);
      expect(contentType).toContain("application/problem+json");
      expect(body.errors?.length).toBeGreaterThan(0);
    }
    const bad = await problemOf(await get(player.cookie, { query: "?locale=xx" }));
    expect(bad.body.errors?.[0]?.pointer).toBe("/locale");
  });
});
