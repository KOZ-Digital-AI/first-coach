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
import { ENDPOINTS as ONBOARDING, StartResponse } from "../../shared/onboarding";
import type { BaselineResult, StartRequest } from "../../shared/onboarding";
import { ENDPOINTS, TodaySession } from "../../shared/session";
import type { SwapRequest } from "../../shared/session";

// POST /api/player/today/swap answers the updated TodaySession (fc-mol-urn.11: its items carry each drill's track and
// level). This file pins only that; the picker's rule is planner/swap.test.ts. Every test runs the real createApp on a
// fresh in-memory database migrated with the real migrations and loaded with the REAL seed (config/commons), with the
// REAL Better Auth handler and the REAL start and today routes mounted next to the route under test. Players are real
// anonymous sign-ins that onboard through POST /api/player/start (the technique of player-start.routes.test.ts). No fake
// sessions, no mocked repository, no fixture data in the route: the drills below are the seed's.

const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILES = ["player-swap.routes.ts", "player-today.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const TODAY = ENDPOINTS.getToday.path;
const SWAP = ENDPOINTS.postSwap.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

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
  dir = mkdtempSync(join(tmpdir(), "player-swap-routes-"));
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

async function todayOk(player: Player): Promise<TodaySession> {
  const res = await app.request(TODAY, { headers: { cookie: player.cookie } });
  expect(res.status).toBe(200);
  return TodaySession.parse(await res.json());
}

const swap = (player: Player, body: SwapRequest) =>
  app.request(SWAP, { method: "POST", headers: { "content-type": "application/json", cookie: player.cookie }, body: JSON.stringify(body) });

/** The first swap of today's session that the real seed lets through (an item x direction), with what it answered. */
async function swapSomething(player: Player, session: TodaySession): Promise<{ itemId: string; direction: SwapRequest["direction"]; answer: TodaySession }> {
  for (const item of session.items) {
    for (const direction of ["easier", "harder"] as const) {
      const res = await swap(player, { itemId: item.itemId, direction });
      if (res.status === 200) return { itemId: item.itemId, direction, answer: TodaySession.parse(await res.json()) };
    }
  }
  throw new Error("the seed offers no swap for this session: the premise of these tests is broken");
}

const primarySkillOf = (versionId: string): string | undefined =>
  (
    db
      .query(
        `SELECT s.slug AS slug FROM drill_versions v
           JOIN drill_skills ds ON ds.drill_id = v.drill_id AND ds.is_primary = 1
           JOIN skills s ON s.id = ds.skill_id
          WHERE v.id = ?`,
      )
      .get(versionId) as { slug: string } | null
  )?.slug;

const levelOf = (versionId: string): string => (db.query("SELECT level FROM drill_versions WHERE id = ?").get(versionId) as { level: string }).level;

// --- tests --------------------------------------------------------------------------------------

describe("POST /api/player/today/swap: each item's track and level (fc-mol-urn.11)", () => {
  test("the answer's items carry their drill's primary skill slug and version level, the swapped one the REPLACEMENT's", async () => {
    const player = await onboardedPlayer();
    const before = await todayOk(player);
    const { itemId, answer } = await swapSomething(player, before);

    expect(answer.id).toBe(before.id);
    expect(answer.items.length).toBe(before.items.length);
    for (const item of answer.items) {
      expect(primarySkillOf(item.drillVersionId)).toBeDefined();
      expect(item.track).toBe(primarySkillOf(item.drillVersionId)!);
      expect(item.level).toBe(levelOf(item.drillVersionId) as typeof item.level);
    }
    const replaced = before.items.find((item) => item.itemId === itemId)!;
    const replacement = answer.items.find((item) => item.itemId === itemId)!;
    expect(replacement.drillVersionId).not.toBe(replaced.drillVersionId);
  });

  test("the answer is what GET /api/player/today says next, track and level included", async () => {
    const player = await onboardedPlayer();
    const { answer } = await swapSomething(player, await todayOk(player));
    const viaGet = await todayOk(player);
    expect(answer.items.map((item) => [item.itemId, item.track, item.level])).toEqual(viaGet.items.map((item) => [item.itemId, item.track, item.level]));
  });
});
