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
import { SESSION_REASON_FILL, SESSION_REASON_FOCUS, SESSION_REASON_WARMUP } from "../../planner/session";
import { ingestEvents } from "../../player/events";
import type { PlayerProfile } from "../../shared/domain";
import { ENDPOINTS as ONBOARDING, StartResponse } from "../../shared/onboarding";
import type { BaselineResult, StartRequest } from "../../shared/onboarding";
import { PROBLEM_CONTENT_TYPE } from "../../shared/primitives";
import type { Locale } from "../../shared/primitives";
import { ENDPOINTS, TodaySession } from "../../shared/session";

// Every test runs the real createApp on a fresh in-memory database migrated with the real migrations and
// loaded with the REAL seed (config/commons), with the REAL Better Auth handler and the REAL start route
// mounted next to the route under test. Players are real anonymous sign-ins that onboard through
// POST /api/player/start (the technique of player-start.routes.test.ts). No fake sessions, no mocked
// repository, no fixture data in the route: the drills below are the seed's.

const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILES = ["player-today.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const TODAY = ENDPOINTS.getToday.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const DAY_MS = 86_400_000;

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
  dir = mkdtempSync(join(tmpdir(), "player-today-routes-"));
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

type Options = { cookie?: string; locale?: string; timeZone?: string; query?: string };

const today = (options: Options = {}) =>
  app.request(`${TODAY}${options.query ?? (options.locale === undefined ? "" : `?locale=${options.locale}`)}`, {
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.timeZone === undefined ? {} : { "x-timezone": options.timeZone }),
    },
  });

async function todayOk(player: Player, options: Omit<Options, "cookie"> = {}): Promise<TodaySession> {
  const res = await today({ ...options, cookie: player.cookie });
  expect(res.status).toBe(200);
  return TodaySession.parse(await res.json());
}

type Problem = { type: string; title: string; status: number; detail?: string; errors?: { pointer: string; detail: string }[] };

const expectProblem = async (res: Response, status: number): Promise<Problem> => {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Problem;
  expect(body.status).toBe(status);
  return body;
};

// --- db helpers ---------------------------------------------------------------------------------

const sessionRows = (playerId: string) =>
  db.query("SELECT id, date, planner, graph_version, items, finished_at FROM sessions WHERE player_id = ? ORDER BY date").all(playerId) as Array<{
    id: string;
    date: string;
    planner: string;
    graph_version: string;
    items: string;
    finished_at: string | null;
  }>;

type VersionRow = { id: string; drill_id: string; status: string; semver: string; author_name: string; minutes: number };
const versionRow = (versionId: string): VersionRow =>
  db.query("SELECT id, drill_id, status, semver, author_name, minutes FROM drill_versions WHERE id = ?").get(versionId) as VersionRow;

const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/** The calendar day it is now in a fixed-offset zone. */
const dayAtOffset = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 10);

const usable = (text: string | undefined): boolean => typeof text === "string" && text.trim() !== "";

// --- tests --------------------------------------------------------------------------------------

test("the route serves the contract's path with the contract's method", () => {
  expect(ENDPOINTS.getToday.method).toBe("GET");
  expect(TODAY).toBe("/api/player/today");
});

describe("GET /api/player/today: access", () => {
  test("no cookie is a 401 problem and is never cached", async () => {
    const res = await today();
    await expectProblem(res, 401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a signed-in player who has not onboarded gets a 404 'not onboarded' problem, never cached, and nothing is stored", async () => {
    const player = await signInPlayer();
    const res = await today({ cookie: player.cookie });
    const body = await expectProblem(res, 404);
    expect(`${body.title} ${body.detail ?? ""}`).toMatch(/not onboarded/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(sessionRows(player.id)).toEqual([]);
  });

  test("a query the contract refuses is a 400 problem with a pointer, and a player id cannot be named", async () => {
    const player = await onboardedPlayer();
    const bad = await expectProblem(await today({ cookie: player.cookie, locale: "de" }), 400);
    expect(bad.errors?.map((e) => e.pointer)).toContain("/locale");
    await expectProblem(await today({ cookie: player.cookie, query: "?playerId=someone-else" }), 400);
    expect(sessionRows(player.id)).toEqual([]);
  });
});

describe("GET /api/player/today: creating today's session", () => {
  test("the first call creates and stores a session for the player's UTC date, complete enough to train offline", async () => {
    const player = await onboardedPlayer();
    const before = dayAtOffset(0);
    const res = await today({ cookie: player.cookie });
    const after = dayAtOffset(0);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const session = TodaySession.parse(await res.json());

    expect([before, after]).toContain(session.date);
    expect(session.planner).toBe("rules");
    expect(session.items.length).toBeGreaterThan(0);
    // The budget window of the picker: minutesPerSession 20 -> 18..23.
    expect(session.totalMinutes).toBeGreaterThanOrEqual(PROFILE.minutesPerSession - 2);
    expect(session.totalMinutes).toBeLessThanOrEqual(PROFILE.minutesPerSession + 3);
    expect(session.items.reduce((sum, item) => sum + item.minutes, 0) + (session.skillTest === undefined ? 0 : 2)).toBe(session.totalMinutes);
    expect(new Set(session.items.map((item) => item.itemId)).size).toBe(session.items.length);
    expect(new Set(session.items.map((item) => item.drillVersionId)).size).toBe(session.items.length);
    expect(session.items.every((item) => item.done === false)).toBe(true);
    // Each item says why it is there, and the session opens with a warm-up.
    const reasons = [SESSION_REASON_WARMUP, SESSION_REASON_FOCUS, SESSION_REASON_FILL];
    expect(session.items.every((item) => item.reason !== undefined && reasons.includes(item.reason))).toBe(true);
    expect(session.items[0]!.reason).toBe(SESSION_REASON_WARMUP);
    expect(session.roadmapSummary).toEqual({
      currentLevelLabel: player.start.roadmap.currentLevelLabel,
      focus: player.start.roadmap.focus,
      sessionsPerWeek: player.start.roadmap.sessionsPerWeek,
      minutesPerSession: player.start.roadmap.minutesPerSession,
    });
    const graphVersion = (db.query("SELECT graph_version AS v FROM sports WHERE slug = 'football'").get() as { v: string }).v;
    expect(session.graphVersion).toBe(graphVersion);

    const rows = sessionRows(player.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: session.id, date: session.date, planner: "rules", graph_version: graphVersion, finished_at: null });
    const stored = JSON.parse(rows[0]!.items) as Array<{ itemId: string; drillVersionId: string; reason?: string }>;
    expect(stored.map((item) => [item.itemId, item.drillVersionId])).toEqual(session.items.map((item) => [item.itemId, item.drillVersionId]));
    expect(stored.map((item) => item.reason)).toEqual(session.items.map((item) => item.reason));
  });

  test("every item carries its version's own status, attribution and minutes, and a drill version that exists", async () => {
    const player = await onboardedPlayer();
    const session = await todayOk(player);
    for (const item of session.items) {
      const row = versionRow(item.drillVersionId);
      expect(item.status as string).toBe(row.status);
      expect(item.minutes).toBe(row.minutes);
      expect(item.attribution.semver).toBe(row.semver);
      expect(item.attribution.author).toBe(row.author_name);
      expect(usable(item.content.goal.ru) || usable(item.content.goal.kk) || usable(item.content.goal.en)).toBe(true);
    }
  });

  test("the second call returns the same session and stores no second one", async () => {
    const player = await onboardedPlayer();
    const first = await todayOk(player);
    const second = await todayOk(player);
    expect(second).toEqual(first);
    expect(sessionRows(player.id)).toHaveLength(1);
  });

  test("the session's done state is kept: a drill done through the event log shows as done", async () => {
    const player = await onboardedPlayer();
    const first = await todayOk(player);
    const target = first.items[0]!;
    ingestEvents(db, player.id, [
      { clientUuid: uuid(900_001), sessionId: first.id, type: "drill_done", itemId: target.itemId, at: new Date().toISOString() },
    ]);
    const second = await todayOk(player);
    expect(second.id).toBe(first.id);
    expect(second.items.find((item) => item.itemId === target.itemId)?.done).toBe(true);
    expect(second.items.filter((item) => item.done)).toHaveLength(1);
  });
});

describe("GET /api/player/today: content in the requested locale and en", () => {
  test.each<Locale>(["kk", "ru", "en"])("locale=%s: every drill text has the requested locale and en filled", async (locale) => {
    const player = await onboardedPlayer();
    const session = await todayOk(player, { locale });
    expect(session.items.length).toBeGreaterThan(0);
    for (const { content } of session.items) {
      for (const text of [content.goal, content.instructions]) {
        expect(usable(text[locale])).toBe(true);
        expect(usable(text.en)).toBe(true);
      }
      for (const text of [...content.mistakes, ...content.progressions, ...content.regressions, ...content.safety]) {
        expect(usable(text[locale])).toBe(true);
        expect(usable(text.en)).toBe(true);
      }
    }
  });

  test("the requested locale changes the wording, not the session; without ?locale the profile's locale is used", async () => {
    const player = await onboardedPlayer({ locale: "kk" });
    const fromProfile = await todayOk(player);
    const asRu = await todayOk(player, { locale: "ru" });
    expect(asRu.id).toBe(fromProfile.id);
    expect(asRu.items.map((i) => i.drillVersionId)).toEqual(fromProfile.items.map((i) => i.drillVersionId));
    const kk = fromProfile.items[0]!.content;
    const ru = asRu.items[0]!.content;
    expect(usable(kk.goal.kk)).toBe(true);
    expect(usable(ru.goal.ru)).toBe(true);
    expect(kk.goal.en).toBe(ru.goal.en);
  });
});

describe("GET /api/player/today: a text that lacks the requested locale", () => {
  test("is filled requested -> ru -> en in the requested locale's slot and in en; the default locale is the profile's", async () => {
    const player = await onboardedPlayer({ locale: "kk" });
    const first = await todayOk(player);
    const old = versionRow(first.items[0]!.drillVersionId);
    // A version of that drill whose goal and instructions exist in ru only, and the session pointed at it.
    db.query(
      `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space, partner, age_min, age_max,
                                   level, minutes, license, author_name, author_user_id, source, source_url, origin, change_summary, created_at)
       SELECT 'ru-only-version', drill_id, '8.8.8', id, status,
              json_remove(content, '$.goal.kk', '$.goal.en', '$.instructions.kk', '$.instructions.en'),
              equipment, space, partner, age_min, age_max, level, minutes, license, author_name, author_user_id, source, source_url,
              'seed', NULL, created_at
         FROM drill_versions WHERE id = ?`,
    ).run(old.id);
    db.query("UPDATE sessions SET items = json_set(items, '$[0].drillVersionId', 'ru-only-version') WHERE player_id = ?").run(player.id);

    const profileLocale = (await todayOk(player)).items[0]!.content; // no ?locale: the profile's kk
    const goalRu = profileLocale.goal.ru;
    expect(usable(goalRu)).toBe(true);
    expect(profileLocale.goal.kk).toBe(goalRu);
    expect(profileLocale.goal.en).toBe(goalRu);
    expect(profileLocale.instructions.kk).toBe(profileLocale.instructions.ru);
    expect(profileLocale.instructions.en).toBe(profileLocale.instructions.ru);

    const asEn = (await todayOk(player, { locale: "en" })).items[0]!.content;
    expect(asEn.goal.en).toBe(goalRu);
    expect(asEn.goal.ru).toBe(goalRu);
  });
});

describe("GET /api/player/today: the stored session keeps its drill version ids", () => {
  test("a newly published version of a drill in today's session does not alter it", async () => {
    const player = await onboardedPlayer();
    const first = await todayOk(player);
    const target = first.items[0]!;
    const old = versionRow(target.drillVersionId);

    // Publish 9.9.9 of that drill with different content and make it the drill's current version.
    db.query(
      `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space, partner, age_min, age_max,
                                   level, minutes, license, author_name, author_user_id, source, source_url, origin, change_summary, created_at)
       SELECT 'newer-version', drill_id, '9.9.9', id, status, json_set(content, '$.goal.ru', 'CHANGED AFTER THE SESSION'), equipment, space,
              partner, age_min, age_max, level, minutes, license, author_name, author_user_id, source, source_url, 'contribution', NULL,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         FROM drill_versions WHERE id = ?`,
    ).run(old.id);
    db.query("UPDATE drills SET current_version_id = 'newer-version' WHERE id = ?").run(old.drill_id);

    const second = await todayOk(player, { locale: "ru" });
    expect(second.id).toBe(first.id);
    expect(second.items.map((i) => i.drillVersionId)).toEqual(first.items.map((i) => i.drillVersionId));
    expect(second.items[0]!.content.goal.ru).not.toBe("CHANGED AFTER THE SESSION");
    expect(second.items[0]!.content).toEqual((await todayOk(player, { locale: "ru" })).items[0]!.content);
    expect(second.items[0]!.attribution.semver).toBe(old.semver);
    const stored = JSON.parse(sessionRows(player.id)[0]!.items) as Array<{ drillVersionId: string }>;
    expect(stored.map((item) => item.drillVersionId)).toEqual(first.items.map((item) => item.drillVersionId));
  });
});

describe("GET /api/player/today: the player's local date", () => {
  test("X-Timezone picks the calendar day: UTC+14 and UTC-11 name different days, each with its own session", async () => {
    const player = await onboardedPlayer();
    const ahead = await todayOk(player, { timeZone: "Pacific/Kiritimati" });
    const behind = await todayOk(player, { timeZone: "Pacific/Pago_Pago" });
    expect([dayAtOffset(14)]).toContain(ahead.date);
    expect([dayAtOffset(-11)]).toContain(behind.date);
    expect(ahead.date).not.toBe(behind.date);
    expect(ahead.id).not.toBe(behind.id);
    expect(sessionRows(player.id).map((row) => row.date)).toEqual([behind.date, ahead.date]);
    // Asking again in the same zone is the same session.
    expect((await todayOk(player, { timeZone: "Pacific/Kiritimati" })).id).toBe(ahead.id);
  });

  test.each(["", "Mars/Olympus", "not a zone", "+14:00"])("an absent, blank or invalid X-Timezone (%p) means UTC and is never an error", async (zone) => {
    const player = await onboardedPlayer();
    const before = dayAtOffset(0);
    const session = await todayOk(player, zone === "" ? {} : { timeZone: zone });
    expect([before, dayAtOffset(0)]).toContain(session.date);
  });
});

describe("GET /api/player/today: own player only", () => {
  test("two players get two different sessions, and each call returns only the caller's own", async () => {
    const a = await onboardedPlayer();
    const b = await onboardedPlayer();
    const sessionA = await todayOk(a);
    const sessionB = await todayOk(b);
    expect(sessionA.id).not.toBe(sessionB.id);
    expect(sessionRows(a.id).map((r) => r.id)).toEqual([sessionA.id]);
    expect(sessionRows(b.id).map((r) => r.id)).toEqual([sessionB.id]);
    expect((await todayOk(a)).id).toBe(sessionA.id);
    expect((await todayOk(b)).id).toBe(sessionB.id);
  });
});

describe("GET /api/player/today: how the session is picked", () => {
  test("the drills done in the player's previous sessions are deprioritised, drills merely listed there are not", async () => {
    const player = await onboardedPlayer();
    const first = await todayOk(player);
    const usedIds = first.items.map((item) => item.drillVersionId);
    const yesterday = dayBefore(first.date);

    // Replaces the player's sessions by one yesterday that lists the drills of the first session.
    const seedYesterday = (done: boolean): void => {
      db.query("DELETE FROM sessions WHERE player_id = ?").run(player.id);
      db.query("INSERT INTO sessions (id, player_id, date, planner, graph_version, items) VALUES ('yesterday', ?1, ?2, 'rules', ?3, ?4)").run(
        player.id,
        yesterday,
        first.graphVersion,
        JSON.stringify(usedIds.map((id, index) => ({ itemId: `item-${index + 1}`, drillVersionId: id, minutes: 5, done }))),
      );
    };

    // Same player and date: with no drill done yesterday the picker is deterministic and gives the same drills again.
    seedYesterday(false);
    const notDone = await todayOk(player);
    expect(notDone.date).toBe(first.date);
    expect(notDone.items.map((item) => item.drillVersionId)).toEqual(usedIds);

    seedYesterday(true);
    const varied = await todayOk(player);
    expect(varied.date).toBe(first.date);
    expect(varied.items.length).toBeGreaterThan(0);
    for (const id of usedIds) expect(varied.items.map((item) => item.drillVersionId)).not.toContain(id);
  });

  test("a due retest becomes the session's skillTest, a test the player has the kit for, and its 2 minutes count", async () => {
    const player = await onboardedPlayer();
    // The baseline was recorded 40 days ago: every retest interval has passed.
    db.query("UPDATE test_results SET recorded_at = ? WHERE player_id = ?").run(new Date(Date.now() - 40 * DAY_MS).toISOString(), player.id);

    const session = await todayOk(player);
    expect(session.skillTest).toBeDefined();
    // The player owns "ball": the wall (wall-passing-60s, weak-foot-passes) and cones (slalom-time) tests are not for them.
    expect(["juggling-max-touches", "ball-mastery-30s"]).toContain(session.skillTest!.slug);
    expect(session.skillTest!.equipment).toBe("ball");
    expect(session.items.reduce((sum, item) => sum + item.minutes, 0) + 2).toBe(session.totalMinutes);
    expect(session.totalMinutes).toBeGreaterThanOrEqual(PROFILE.minutesPerSession - 2);
    expect(session.totalMinutes).toBeLessThanOrEqual(PROFILE.minutesPerSession + 3);
    expect(session.items.every((item) => !("skillTest" in item))).toBe(true);

    // The session is stable: asking again gives the same skill test and total.
    expect(await todayOk(player)).toEqual(session);
  });

  test("a retest that is due only for kit the player lacks (wall, cones) is not offered", async () => {
    const player = await onboardedPlayer();
    db.query("UPDATE test_results SET recorded_at = ? WHERE player_id = ? AND test_slug IN ('slalom-time', 'wall-passing-60s', 'weak-foot-passes')").run(
      new Date(Date.now() - 40 * DAY_MS).toISOString(),
      player.id,
    );
    expect((await todayOk(player)).skillTest).toBeUndefined();
  });

  test("with no retest due there is no skillTest", async () => {
    const player = await onboardedPlayer();
    expect((await todayOk(player)).skillTest).toBeUndefined();
  });
});
