import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { getSettings } from "../admin/settings";
import { createApp, type AppDeps } from "../app";
import { getSkillGraph, listPublishedVersions } from "../commons/repo";
import type { PublishedVersion } from "../commons/repo";
import { loadSeed } from "../commons/seed-loader";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { ingestEvents } from "../player/events";
import type { PlayerProfile } from "../shared/domain";
import { ENDPOINTS as ONBOARDING, StartResponse } from "../shared/onboarding";
import type { BaselineResult, StartRequest } from "../shared/onboarding";
import { PROBLEM_CONTENT_TYPE } from "../shared/primitives";
import type { LocalizedText } from "../shared/primitives";
import { ENDPOINTS, TodaySession } from "../shared/session";
import { EXPERIENCE_NUMBER, candidates } from "./candidates";
import type { Levels } from "./candidates";
import { pickSwap } from "./swap";

// Every test runs on a fresh in-memory database migrated with the real migrations and loaded with the REAL
// seed (config/commons). The route tests run the real createApp with the REAL Better Auth handler and the real
// start and today routes mounted next to the route under test; players are real anonymous sign-ins that
// onboard through POST /api/player/start (the technique of player-today.routes.test.ts). A session is created
// by the real GET /api/player/today and then pointed, in the database, at the seed drills a case needs (the
// composition of a session is random per player; a swap case must not depend on it). No mocked repository, no
// fixture data: every drill below is the seed's.

const ROUTES_DIR = resolve(import.meta.dir, "../http/routes");
const SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");
const ROUTE_FILES = ["player-swap.routes.ts", "player-today.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const SWAP = ENDPOINTS.postSwap.path;
const TODAY = ENDPOINTS.getToday.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const SPORT = "football";

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTE_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(ROUTES_DIR, file))};\n`);
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "swap-"));
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

// --- the real candidate pool ----------------------------------------------------------------------

interface PoolProfile {
  age: number;
  equipment: PlayerProfile["equipment"];
  space: PlayerProfile["space"];
  partner: boolean;
}

/** The planner's candidates for a profile and track levels, from the real seed, exactly as the session route builds them. */
function poolOf(profile: PoolProfile, levels: Levels): PublishedVersion[] {
  const graph = getSkillGraph(db, SPORT, "en");
  if (graph === null) throw new Error("the football skill graph is not seeded");
  return candidates(profile, levels, getSettings(db), listPublishedVersions(db, { sport: SPORT }), graph);
}

const TRACKS = ["ball-mastery", "dribbling", "juggling-coordination", "passing-first-touch", "weak-foot"] as const;
/** Every track at level 2: drills up to level 3 (intermediate) are offered. */
const LEVELS_2: Levels = Object.fromEntries(TRACKS.map((track) => [track, 2]));
const CONES_PLAYER: PoolProfile = { age: 12, equipment: "cones", space: "yard", partner: false };
const BALL_PLAYER: PoolProfile = { age: 12, equipment: "ball", space: "yard", partner: false };

const bySlug = (pool: readonly PublishedVersion[], slug: string): PublishedVersion => {
  const found = pool.find((v) => v.slug === slug);
  if (found === undefined) throw new Error(`${slug} is not in the pool`);
  return found;
};

const without = (pool: readonly PublishedVersion[], ...slugs: string[]): PublishedVersion[] => pool.filter((v) => !slugs.includes(v.slug));

const titleOf = (v: PublishedVersion): LocalizedText => v.content.title ?? {};
const sameText = (a: LocalizedText, b: LocalizedText): boolean =>
  (["kk", "ru", "en"] as const).some((locale) => a[locale] !== undefined && a[locale]!.trim() !== "" && a[locale] === b[locale]);
/** Independent of the implementation: is `candidate` listed among the subject's regressions (easier) or progressions (harder)? */
const isLinked = (subject: PublishedVersion, candidate: PublishedVersion, direction: "easier" | "harder"): boolean =>
  (direction === "easier" ? subject.content.regressions : subject.content.progressions).some((text) => sameText(text, titleOf(candidate)));

// --- pickSwap on the real seed ----------------------------------------------------------------------

describe("pickSwap: a candidate linked as the drill's regression (easier) or progression (harder)", () => {
  test("easier takes the drill's linked regression", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const zigzag = bySlug(pool, "dribbling-two-foot-zigzag");
    expect(pickSwap(zigzag, "easier", pool, new Set([zigzag.drillId]))?.slug).toBe("dribbling-freeze-and-go");
  });

  test("harder takes the drill's linked progression, even one of the same level", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const snail = bySlug(pool, "dribbling-snail-circle");
    expect(snail.level).toBe("beginner");
    const picked = pickSwap(snail, "harder", pool, new Set([snail.drillId]));
    expect(picked?.slug).toBe("dribbling-there-and-back");
    expect(picked?.level).toBe("beginner");
  });

  test("a linked regression beats a lower-level drill of the same skill", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const soleStop = bySlug(pool, "dribbling-sole-stop-turn");
    expect(pool.some((v) => v.track === "dribbling" && EXPERIENCE_NUMBER[v.level] < EXPERIENCE_NUMBER[soleStop.level])).toBe(true);
    // The linked regression (two-foot-zigzag) is of the SAME level: the link, not the level, decides.
    expect(pickSwap(soleStop, "easier", pool, new Set([soleStop.drillId]))?.slug).toBe("dribbling-two-foot-zigzag");
  });

  test("harder takes a linked progression of a higher level when it is the only link the player can do", () => {
    const pool = poolOf(BALL_PLAYER, LEVELS_2);
    const freeze = bySlug(pool, "dribbling-freeze-and-go");
    // Its progressions are two-foot-zigzag (ball) and five-cone-slalom (cones): a ball player has no cones.
    expect(pool.some((v) => v.slug === "dribbling-five-cone-slalom")).toBe(false);
    const picked = pickSwap(freeze, "harder", pool, new Set([freeze.drillId]));
    expect(picked?.slug).toBe("dribbling-two-foot-zigzag");
    expect(picked?.level).toBe("basic");
  });

  test("among several linked candidates the one nearest in minutes wins", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const freeze = bySlug(pool, "dribbling-freeze-and-go"); // 5 min; progressions: two-foot-zigzag 5 min, five-cone-slalom 7 min
    expect(bySlug(pool, "dribbling-five-cone-slalom").minutes).toBe(7);
    expect(pickSwap(freeze, "harder", pool, new Set([freeze.drillId]))?.slug).toBe("dribbling-two-foot-zigzag");
  });
});

describe("pickSwap: else the nearest lower/higher-level candidate of the same skill with similar minutes", () => {
  test("easier, no linked regression in the pool: the nearest lower level of the same skill, nearest in minutes", () => {
    const pool = without(poolOf(CONES_PLAYER, LEVELS_2), "dribbling-freeze-and-go");
    const zigzag = bySlug(pool, "dribbling-two-foot-zigzag");
    const picked = pickSwap(zigzag, "easier", pool, new Set([zigzag.drillId]));
    expect(picked).toBeDefined();
    expect(pool).toContain(picked!);
    expect(picked!.track).toBe(zigzag.track);
    expect(EXPERIENCE_NUMBER[picked!.level]).toBeLessThan(EXPERIENCE_NUMBER[zigzag.level]);
    const lower = pool.filter((v) => v.track === zigzag.track && EXPERIENCE_NUMBER[v.level] < EXPERIENCE_NUMBER[zigzag.level]);
    expect(lower.length).toBeGreaterThan(1);
    expect(Math.abs(picked!.minutes - zigzag.minutes)).toBe(Math.min(...lower.map((v) => Math.abs(v.minutes - zigzag.minutes))));
  });

  test("harder, no linked progression in the pool: the nearest HIGHER level of the same skill, not a further one", () => {
    const pool = without(poolOf(CONES_PLAYER, LEVELS_2), "dribbling-snail-circle");
    const quickFeet = bySlug(pool, "dribbling-quick-feet-look-around"); // beginner; its only progression is snail-circle
    const picked = pickSwap(quickFeet, "harder", pool, new Set([quickFeet.drillId]));
    expect(picked).toBeDefined();
    expect(picked!.track).toBe(quickFeet.track);
    // Level 2 (basic) is nearer than level 3, whatever the minutes: the pool holds both.
    expect(pool.some((v) => v.track === quickFeet.track && v.level === "intermediate")).toBe(true);
    expect(picked!.level).toBe("basic");
    const basic = pool.filter((v) => v.track === quickFeet.track && v.level === "basic");
    expect(Math.abs(picked!.minutes - quickFeet.minutes)).toBe(Math.min(...basic.map((v) => Math.abs(v.minutes - quickFeet.minutes))));
  });

  test("the fallback never leaves the skill: another skill's drill of a nearer level is not taken", () => {
    const pool = without(poolOf(CONES_PLAYER, LEVELS_2), "dribbling-freeze-and-go");
    const zigzag = bySlug(pool, "dribbling-two-foot-zigzag");
    expect(pool.some((v) => v.track !== "dribbling" && v.level === "beginner" && v.minutes === zigzag.minutes)).toBe(true);
    expect(pickSwap(zigzag, "easier", pool, new Set([zigzag.drillId]))?.track).toBe("dribbling");
  });
});

describe("pickSwap: no alternative", () => {
  test("easier than a beginner drill with no regression is undefined; harder than the top drill with no progression is undefined", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const quickFeet = bySlug(pool, "dribbling-quick-feet-look-around");
    expect(quickFeet.content.regressions).toEqual([]);
    expect(pickSwap(quickFeet, "easier", pool, new Set([quickFeet.drillId]))).toBeUndefined();
    const thighAndFoot = bySlug(pool, "juggling-thigh-and-foot");
    expect(thighAndFoot.content.progressions).toEqual([]);
    expect(pickSwap(thighAndFoot, "harder", pool, new Set([thighAndFoot.drillId]))).toBeUndefined();
    // A progression that is not a candidate is no link either: speed-dash-stop is a field drill, this player has a yard.
    const weave = bySlug(pool, "dribbling-tight-cone-weave");
    expect(pool.some((v) => v.slug === "dribbling-speed-dash-stop")).toBe(false);
    expect(pickSwap(weave, "harder", pool, new Set([weave.drillId]))).toBeUndefined();
  });

  test("an empty pool has no alternative", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const zigzag = bySlug(pool, "dribbling-two-foot-zigzag");
    expect(pickSwap(zigzag, "easier", [], new Set([zigzag.drillId]))).toBeUndefined();
    expect(pickSwap(zigzag, "harder", [], new Set([zigzag.drillId]))).toBeUndefined();
  });

  test("a drill already in the session is never the alternative", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const zigzag = bySlug(pool, "dribbling-two-foot-zigzag");
    const freeze = bySlug(pool, "dribbling-freeze-and-go");
    const picked = pickSwap(zigzag, "easier", pool, new Set([zigzag.drillId, freeze.drillId]));
    expect(picked).toBeDefined();
    expect(picked!.drillId).not.toBe(freeze.drillId);
    // With every lower drill of the skill taken there is nothing left.
    const lower = pool.filter((v) => v.track === "dribbling" && EXPERIENCE_NUMBER[v.level] < EXPERIENCE_NUMBER[zigzag.level]);
    const taken = new Set([zigzag.drillId, ...lower.map((v) => v.drillId)]);
    expect(pickSwap(zigzag, "easier", pool, taken)).toBeUndefined();
  });

  test("a drill that trains no skill has only its links to swap to", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const zigzag = { ...bySlug(pool, "dribbling-two-foot-zigzag"), track: null };
    expect(pickSwap(zigzag, "easier", pool, new Set([zigzag.drillId]))?.slug).toBe("dribbling-freeze-and-go");
    expect(pickSwap(zigzag, "easier", without(pool, "dribbling-freeze-and-go"), new Set([zigzag.drillId]))).toBeUndefined();
  });
});

describe("pickSwap: properties over the whole seed", () => {
  test.each(["easier", "harder"] as const)("%s: whatever the drill, the pick is a linked candidate or a strictly %s drill of the same skill, from the pool, never the drill itself", (direction) => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    let picks = 0;
    for (const subject of pool) {
      const picked = pickSwap(subject, direction, pool, new Set([subject.drillId]));
      if (picked === undefined) continue;
      picks += 1;
      expect(pool).toContain(picked);
      expect(picked.drillId).not.toBe(subject.drillId);
      const step = EXPERIENCE_NUMBER[picked.level] - EXPERIENCE_NUMBER[subject.level];
      const inDirection = direction === "easier" ? step < 0 : step > 0;
      expect(isLinked(subject, picked, direction) || (picked.track === subject.track && inDirection)).toBe(true);
    }
    expect(picks).toBeGreaterThan(20);
  });

  test("the pick does not depend on the order of the pool and the inputs are not touched", () => {
    const pool = poolOf(CONES_PLAYER, LEVELS_2);
    const before = JSON.stringify(pool);
    const inSession = new Set(["x"]);
    for (const subject of pool) {
      for (const direction of ["easier", "harder"] as const) {
        const a = pickSwap(subject, direction, pool, inSession);
        const b = pickSwap(subject, direction, [...pool].reverse(), inSession);
        expect(b?.versionId).toBe(a?.versionId);
      }
    }
    expect(JSON.stringify(pool)).toBe(before);
    expect([...inSession]).toEqual(["x"]);
  });
});

// --- the route: real sessions and onboarding --------------------------------------------------------

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
  equipment: "cones",
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

/** The candidate pool of an onboarded player, from their stored profile and roadmap levels. */
const playerPool = (player: Player & { start: StartResponse }): PublishedVersion[] =>
  poolOf(player.start.profile, Object.fromEntries(player.start.roadmap.tracks.map((track) => [track.skill, track.level])));

// --- requests -----------------------------------------------------------------------------------

type Options = { cookie?: string; timeZone?: string; query?: string; raw?: string };

const swap = (body: unknown, options: Options = {}) =>
  app.request(`${SWAP}${options.query ?? ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.timeZone === undefined ? {} : { "x-timezone": options.timeZone }),
    },
    body: options.raw ?? JSON.stringify(body),
  });

const today = (player: Player, timeZone?: string, query = "") =>
  app.request(`${TODAY}${query}`, { headers: { cookie: player.cookie, ...(timeZone === undefined ? {} : { "x-timezone": timeZone }) } });

async function todayOk(player: Player, timeZone?: string, query = ""): Promise<TodaySession> {
  const res = await today(player, timeZone, query);
  expect(res.status).toBe(200);
  return TodaySession.parse(await res.json());
}

async function swapOk(player: Player, body: { itemId: string; direction: "easier" | "harder" }, options: Omit<Options, "cookie"> = {}): Promise<TodaySession> {
  const res = await swap(body, { ...options, cookie: player.cookie });
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

type StoredItem = { itemId: string; drillVersionId: string; minutes: number; reason?: string; done: boolean; regressionOf?: string; progressionOf?: string };

const versionIdOf = (slug: string): string =>
  (db.query("SELECT current_version_id AS id FROM drills WHERE slug = ?").get(slug) as { id: string }).id;

const drillIdOfVersion = (versionId: string): string =>
  (db.query("SELECT drill_id AS id FROM drill_versions WHERE id = ?").get(versionId) as { id: string }).id;

const minutesOf = (slug: string): number =>
  (db.query("SELECT v.minutes AS m FROM drills d JOIN drill_versions v ON v.id = d.current_version_id WHERE d.slug = ?").get(slug) as { m: number }).m;

/** A stored item of a seed drill. */
const item = (itemId: string, slug: string, reason = "focus"): StoredItem => ({
  itemId,
  drillVersionId: versionIdOf(slug),
  minutes: minutesOf(slug),
  reason,
  done: false,
});

const sessionRows = (playerId: string) =>
  db.query("SELECT id, date, items, finished_at FROM sessions WHERE player_id = ? ORDER BY date").all(playerId) as Array<{
    id: string;
    date: string;
    items: string;
    finished_at: string | null;
  }>;

const storedItems = (playerId: string, sessionId?: string): StoredItem[] => {
  const rows = sessionRows(playerId).filter((row) => sessionId === undefined || row.id === sessionId);
  return JSON.parse(rows[0]!.items) as StoredItem[];
};

/** Creates today's session through the real route, then points its items at the given seed drills. */
async function sessionWith(player: Player, items: StoredItem[], timeZone?: string): Promise<TodaySession> {
  const created = await todayOk(player, timeZone);
  db.query("UPDATE sessions SET items = ?1 WHERE id = ?2 AND player_id = ?3").run(JSON.stringify(items), created.id, player.id);
  return todayOk(player, timeZone);
}

const slugOfVersion = (versionId: string): string =>
  (db.query("SELECT d.slug AS slug FROM drill_versions v JOIN drills d ON d.id = v.drill_id WHERE v.id = ?").get(versionId) as { slug: string }).slug;

const markDone = (player: Player, session: TodaySession, itemId: string, n: number): void => {
  ingestEvents(db, player.id, [{ clientUuid: uuid(900_000 + n), sessionId: session.id, type: "drill_done", itemId, at: new Date().toISOString() }]);
};

// --- tests --------------------------------------------------------------------------------------

test("the route serves the contract's path with the contract's method", () => {
  expect(ENDPOINTS.postSwap.method).toBe("POST");
  expect(SWAP).toBe("/api/player/today/swap");
});

describe("POST /api/player/today/swap: access and request", () => {
  test("no cookie is a 401 problem, whatever the body, and is never cached", async () => {
    await expectProblem(await swap({ itemId: "item-1", direction: "easier" }), 401);
    await expectProblem(await swap(undefined, { raw: "not json" }), 401);
  });

  test("a signed-in player who has not onboarded gets a 404 'not onboarded' problem and nothing is stored", async () => {
    const player = await signInPlayer();
    const body = await expectProblem(await swap({ itemId: "item-1", direction: "easier" }, { cookie: player.cookie }), 404);
    expect(`${body.title} ${body.detail ?? ""}`).toMatch(/not onboarded/i);
    expect(sessionRows(player.id)).toEqual([]);
  });

  test("a body that is not JSON is a 400; the contract's schema refuses the rest with a 422 and JSON Pointers; nothing is written", async () => {
    const player = await onboardedPlayer();
    const session = await sessionWith(player, [item("item-1", "dribbling-two-foot-zigzag")]);
    const before = sessionRows(player.id);

    await expectProblem(await swap(undefined, { cookie: player.cookie, raw: "not json" }), 400);
    await expectProblem(await swap(undefined, { cookie: player.cookie, raw: "" }), 400);
    await expectProblem(await swap(undefined, { cookie: player.cookie, raw: "[]" }), 422);

    const badDirection = await expectProblem(await swap({ itemId: "item-1", direction: "sideways" }, { cookie: player.cookie }), 422);
    expect(badDirection.errors?.map((e) => e.pointer)).toContain("/direction");
    const noItem = await expectProblem(await swap({ direction: "easier" }, { cookie: player.cookie }), 422);
    expect(noItem.errors?.map((e) => e.pointer)).toContain("/itemId");
    // Strict: nothing in the body can name another player or session.
    const foreign = await expectProblem(await swap({ itemId: "item-1", direction: "easier", playerId: "someone-else" }, { cookie: player.cookie }), 422);
    expect(foreign.errors?.map((e) => e.pointer)).toContain("/playerId");
    await expectProblem(await swap({ itemId: "item-1", direction: "easier", sessionId: session.id }, { cookie: player.cookie }), 422);

    expect(sessionRows(player.id)).toEqual(before);
  });

  test("an item that is not in today's session is a 404 problem and the session is untouched", async () => {
    const player = await onboardedPlayer();
    await sessionWith(player, [item("item-1", "dribbling-two-foot-zigzag")]);
    const before = sessionRows(player.id);
    await expectProblem(await swap({ itemId: "item-9", direction: "easier" }, { cookie: player.cookie }), 404);
    expect(sessionRows(player.id)).toEqual(before);
  });
});

describe("POST /api/player/today/swap: a swap", () => {
  test("easier replaces the item with its linked regression, records the relation, keeps the rest, and returns the updated session", async () => {
    const player = await onboardedPlayer();
    const opening = await sessionWith(player, [item("item-1", "ball-mastery-sole-taps", "warmup"), item("item-2", "dribbling-two-foot-zigzag"), item("item-3", "weak-foot-sole-drag", "fill")]);
    const otherRows = storedItems(player.id).filter((i) => i.itemId !== "item-2");
    const zigzagVersion = versionIdOf("dribbling-two-foot-zigzag");

    const res = await swap({ itemId: "item-2", direction: "easier" }, { cookie: player.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const updated = TodaySession.parse(await res.json());

    // The response is the whole updated session of the same day.
    expect(updated.id).toBe(opening.id);
    expect(updated.date).toBe(opening.date);
    expect(updated.items.map((i) => i.itemId)).toEqual(["item-1", "item-2", "item-3"]);
    const swapped = updated.items[1]!;
    expect(slugOfVersion(swapped.drillVersionId)).toBe("dribbling-freeze-and-go");
    expect(swapped.regressionOf).toBe(zigzagVersion);
    expect(swapped.progressionOf).toBeUndefined();
    expect(swapped.done).toBe(false);
    expect(swapped.minutes).toBe(minutesOf("dribbling-freeze-and-go"));
    expect(swapped.reason).toBe("focus");
    expect(swapped.content.title?.en).toBe("Freeze and go");
    // Minutes follow the new drill: the total is the sum of the items.
    expect(updated.totalMinutes).toBe(updated.items.reduce((sum, i) => sum + i.minutes, 0) + (updated.skillTest === undefined ? 0 : 2));
    // The other items are exactly as they were.
    expect(updated.items[0]).toEqual(opening.items[0]!);
    expect(updated.items[2]).toEqual(opening.items[2]!);

    // It is stored: the drill VERSION and the relation, and the next read of the day is the same session.
    const stored = storedItems(player.id);
    expect(stored[1]).toMatchObject({ itemId: "item-2", drillVersionId: versionIdOf("dribbling-freeze-and-go"), regressionOf: zigzagVersion });
    expect(stored.filter((i) => i.itemId !== "item-2")).toEqual(otherRows);
    expect(await todayOk(player)).toEqual(updated);
  });

  test("harder replaces the item with its linked progression and records it as progressionOf", async () => {
    const player = await onboardedPlayer();
    await sessionWith(player, [item("item-1", "dribbling-snail-circle")]);
    const updated = await swapOk(player, { itemId: "item-1", direction: "harder" });
    const swapped = updated.items[0]!;
    expect(slugOfVersion(swapped.drillVersionId)).toBe("dribbling-there-and-back");
    expect(swapped.progressionOf).toBe(versionIdOf("dribbling-snail-circle"));
    expect(swapped.regressionOf).toBeUndefined();
    expect(storedItems(player.id)[0]).toMatchObject({ progressionOf: versionIdOf("dribbling-snail-circle") });
    expect(storedItems(player.id)[0]!.regressionOf).toBeUndefined();
  });

  test("a second swap of the same item replaces the recorded relation, it does not add a second one", async () => {
    const player = await onboardedPlayer();
    await sessionWith(player, [item("item-1", "dribbling-two-foot-zigzag")]);
    await swapOk(player, { itemId: "item-1", direction: "easier" }); // freeze-and-go, regressionOf zigzag
    const freezeVersion = versionIdOf("dribbling-freeze-and-go");
    const again = await swapOk(player, { itemId: "item-1", direction: "harder" });
    const item1 = again.items[0]!;
    expect(item1.progressionOf).toBe(freezeVersion);
    expect(item1.regressionOf).toBeUndefined();
    expect(storedItems(player.id)[0]!.regressionOf).toBeUndefined();
  });

  test("with no linked regression the player can do, the nearest lower level of the same skill is taken", async () => {
    // A 'ball' player has no wall: passing-partner-pass-and-stop's only regression (passing-wall-inside-foot) needs one.
    const player = await onboardedPlayer({ equipment: "ball" });
    await sessionWith(player, [item("item-1", "passing-partner-pass-and-stop")]);
    const pool = playerPool(player);
    expect(pool.some((v) => v.slug === "passing-wall-inside-foot")).toBe(false);

    const updated = await swapOk(player, { itemId: "item-1", direction: "easier" });
    const swapped = updated.items[0]!;
    expect(swapped.regressionOf).toBe(versionIdOf("passing-partner-pass-and-stop"));
    const picked = pool.find((v) => v.versionId === swapped.drillVersionId);
    expect(picked).toBeDefined();
    expect(picked!.track).toBe("passing-first-touch");
    expect(picked!.level).toBe("basic");
    expect(picked!.slug).toBe("passing-roll-receive-redirect"); // 5 min against the drill's 6; pass-walk-stop is 4
  });

  test("the replacement always comes from the player's candidate set: equipment, age, partner and level rules hold", async () => {
    const nothing = await onboardedPlayer({ equipment: "nothing" });
    await sessionWith(nothing, [item("item-1", "juggling-knee-touch-march")]);
    const updated = await swapOk(nothing, { itemId: "item-1", direction: "easier" });
    const swapped = playerPool(nothing).find((v) => v.versionId === updated.items[0]!.drillVersionId);
    expect(swapped).toBeDefined();
    expect(swapped!.equipment).toBe("nothing");
    expect(["juggling-drum-roll-feet", "juggling-stork-stand"]).toContain(swapped!.slug);
  });

  test("a linked drill the player may not do (too young, partner needed) is not offered: no alternative", async () => {
    // Age 8: dribbling-change-direction-box (from age 8) has one progression, tight-cone-weave (from age 9);
    // every level-3 dribbling drill starts at age 9 or later.
    const young = await onboardedPlayer({ age: 8 });
    await sessionWith(young, [item("item-1", "dribbling-change-direction-box")]);
    const pool = playerPool(young);
    expect(pool.length).toBeGreaterThan(5);
    expect(pool.some((v) => v.slug === "dribbling-tight-cone-weave")).toBe(false);
    const before = sessionRows(young.id);
    const body = await expectProblem(await swap({ itemId: "item-1", direction: "harder" }, { cookie: young.cookie }), 409);
    expect(`${body.title} ${body.detail ?? ""}`).toMatch(/no alternative/i);
    expect(sessionRows(young.id)).toEqual(before);

    // A partner drill is refused to a player without a partner: look-up-dribble's only progression is one.
    const solo = await onboardedPlayer();
    await sessionWith(solo, [item("item-1", "dribbling-look-up-dribble")]);
    expect(playerPool(solo).some((v) => v.slug === "dribbling-partner-finger-signal")).toBe(false);
    await expectProblem(await swap({ itemId: "item-1", direction: "harder" }, { cookie: solo.cookie }), 409);
  });

  test("a drill already in the session is not brought in a second time", async () => {
    const player = await onboardedPlayer();
    await sessionWith(player, [item("item-1", "dribbling-two-foot-zigzag"), item("item-2", "dribbling-freeze-and-go")]);
    const updated = await swapOk(player, { itemId: "item-1", direction: "easier" });
    const slugs = updated.items.map((i) => slugOfVersion(i.drillVersionId));
    expect(new Set(slugs).size).toBe(2);
    expect(slugs[1]).toBe("dribbling-freeze-and-go");
    expect(slugs[0]).not.toBe("dribbling-freeze-and-go");
    expect(slugs[0]).not.toBe("dribbling-two-foot-zigzag");
    const drills = storedItems(player.id).map((i) => drillIdOfVersion(i.drillVersionId));
    expect(new Set(drills).size).toBe(2);
  });

  test("?locale and X-Timezone are honoured like GET /api/player/today: the day's own session, in the requested locale", async () => {
    const player = await onboardedPlayer();
    // Two zones more than a day apart: each has its own calendar day, so its own session.
    const east = "Pacific/Kiritimati";
    const west = "Etc/GMT+12";
    const eastSession = await sessionWith(player, [item("item-1", "dribbling-two-foot-zigzag")], east);
    const westSession = await sessionWith(player, [item("item-1", "dribbling-two-foot-zigzag")], west);
    expect(eastSession.date).not.toBe(westSession.date);

    const updated = await swapOk(player, { itemId: "item-1", direction: "easier" }, { timeZone: west, query: "?locale=en" });
    expect(updated.id).toBe(westSession.id);
    expect(updated.items[0]!.content.goal.en).toBeDefined();
    expect(slugOfVersion(updated.items[0]!.drillVersionId)).toBe("dribbling-freeze-and-go");
    expect(storedItems(player.id, eastSession.id)[0]!.drillVersionId).toBe(versionIdOf("dribbling-two-foot-zigzag"));
    expect(storedItems(player.id, westSession.id)[0]!.drillVersionId).toBe(versionIdOf("dribbling-freeze-and-go"));

    // The contract's locale rule applies: an unknown locale is refused, nothing is swapped.
    await expectProblem(await swap({ itemId: "item-1", direction: "harder" }, { cookie: player.cookie, timeZone: east, query: "?locale=de" }), 400);
    expect(storedItems(player.id, eastSession.id)[0]!.drillVersionId).toBe(versionIdOf("dribbling-two-foot-zigzag"));
  });
});

describe("POST /api/player/today/swap: refusals", () => {
  test("a finished item is a 409 problem, never swapped, and the session is untouched", async () => {
    const player = await onboardedPlayer();
    const opening = await sessionWith(player, [item("item-1", "dribbling-two-foot-zigzag"), item("item-2", "dribbling-snail-circle")]);
    markDone(player, opening, "item-1", 1);
    const before = sessionRows(player.id);
    expect(storedItems(player.id)[0]!.done).toBe(true);

    for (const direction of ["easier", "harder"] as const) {
      const body = await expectProblem(await swap({ itemId: "item-1", direction }, { cookie: player.cookie }), 409);
      expect(`${body.title} ${body.detail ?? ""}`).toMatch(/finished|done/i);
    }
    expect(sessionRows(player.id)).toEqual(before);
    // An unfinished item next to it can still be swapped, and the finished one stays as it was.
    const updated = await swapOk(player, { itemId: "item-2", direction: "harder" });
    expect(updated.items[0]).toEqual((await todayOk(player)).items[0]!);
    expect(updated.items[0]!.done).toBe(true);
    expect(updated.items[0]!.drillVersionId).toBe(versionIdOf("dribbling-two-foot-zigzag"));
    expect(updated.items[1]!.drillVersionId).not.toBe(versionIdOf("dribbling-snail-circle"));
  });

  test("no candidate in that direction is a 409 'no alternative' problem and the session is untouched", async () => {
    // A player with nothing to play with: ball-mastery-ghost-ball is their easiest drill of the skill, and every
    // link and every higher drill of ball-mastery needs a ball.
    const player = await onboardedPlayer({ equipment: "nothing" });
    await sessionWith(player, [item("item-1", "ball-mastery-ghost-ball", "warmup"), item("item-2", "dribbling-quick-feet-look-around")]);
    expect(playerPool(player).some((v) => v.track === "ball-mastery" && v.equipment !== "nothing")).toBe(false);
    const before = sessionRows(player.id);
    for (const direction of ["easier", "harder"] as const) {
      const body = await expectProblem(await swap({ itemId: "item-1", direction }, { cookie: player.cookie }), 409);
      expect(`${body.title} ${body.detail ?? ""}`).toMatch(/no alternative/i);
    }
    expect(sessionRows(player.id)).toEqual(before);
  });
});

describe("POST /api/player/today/swap: own session only", () => {
  test("a swap changes only the caller's session; another player's session is not reachable", async () => {
    const alice = await onboardedPlayer();
    const bob = await onboardedPlayer();
    await sessionWith(alice, [item("item-1", "dribbling-two-foot-zigzag")]);
    await sessionWith(bob, [item("item-1", "dribbling-two-foot-zigzag")]);
    const aliceBefore = sessionRows(alice.id);

    const updated = await swapOk(bob, { itemId: "item-1", direction: "easier" });
    expect(updated.id).toBe(sessionRows(bob.id)[0]!.id);
    expect(updated.id).not.toBe(aliceBefore[0]!.id);
    expect(sessionRows(alice.id)).toEqual(aliceBefore);
    expect(storedItems(bob.id)[0]!.drillVersionId).toBe(versionIdOf("dribbling-freeze-and-go"));
  });
});
