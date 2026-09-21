import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { PROBLEM_CONTENT_TYPE } from "../shared/primitives";
import { Consents, DEFAULT_CONSENTS } from "../shared/privacy";
import type { UpdateConsentsRequest } from "../shared/privacy";
import { GuardianConfirmationRequiredError, PlayerNotOnboardedError, getConsents, requireConsent, setConsents } from "./consents";

// The store tests run on a fresh in-memory database migrated with the REAL migrations (007_privacy included).
// The route and middleware tests run the real createApp on such a database with the REAL Better Auth handler
// and real anonymous sign-ins (no fake sessions), mounting only player-consents.routes.ts, the auth routes and
// one generated route module that puts requireConsent behind requirePlayer (a stand-in for the video coach
// endpoint, which does not exist yet). Profiles are inserted with SQL so that the age is the test's choice.

const ROUTES_DIR = resolve(import.meta.dir, "../http/routes");
const SRC_DIR = resolve(import.meta.dir, "..");
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const CONSENTS = "/api/player/consents";
const VIDEO_GATED = "/api/test/video-gated";
const MODEL_GATED = "/api/test/model-gated";

let dir: string;
let db: Database;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "consents-"));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
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

// --- db helpers -----------------------------------------------------------------------------------

/** A profile row of the given age (the only column the consent rules read); the rest is valid filler. */
function createProfile(playerId: string, age: number): void {
  db.query(
    `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
     VALUES (?, ?, 'basic', 'dribbling', 'ball', 'yard', 0, 3, 20, 'ru')`,
  ).run(playerId, age);
}

type ConsentRow = { id: number; player_id: string; kind: string; granted: number; guardian_confirmed: number; changed_at: string };
const consentRows = (playerId: string): ConsentRow[] =>
  db.query("SELECT id, player_id, kind, granted, guardian_confirmed, changed_at FROM consents WHERE player_id = ? ORDER BY id").all(playerId) as ConsentRow[];

const at = (iso: string) => () => new Date(iso);

// =====================================================================================================
// the store: getConsents / setConsents
// =====================================================================================================

describe("getConsents", () => {
  test("a player who never chose has everything off, and no timestamps", () => {
    createProfile("p1", 15);
    expect(getConsents(db, "p1")).toEqual(DEFAULT_CONSENTS);
  });

  test("an unknown player id (no profile, no rows) also reads as everything off", () => {
    expect(getConsents(db, "nobody")).toEqual(DEFAULT_CONSENTS);
  });

  test("the answer is the contract's Consents", () => {
    createProfile("p1", 15);
    setConsents(db, "p1", { videoAnalysis: true, modelImprovement: true });
    expect(Consents.safeParse(getConsents(db, "p1")).success).toBe(true);
  });
});

describe("setConsents: grant and revoke", () => {
  test("granting returns the updated Consents with the server time of the change", () => {
    createProfile("p1", 15);
    const after = setConsents(db, "p1", { videoAnalysis: true }, { now: at("2026-03-01T10:00:00.000Z") });
    expect(after.videoAnalysis).toMatchObject({ granted: true, at: "2026-03-01T10:00:00.000Z" });
    expect(after.modelImprovement).toEqual({ granted: false });
    expect(getConsents(db, "p1")).toEqual(after);
  });

  test("revoking works: the grant is followed by a revoke and the consent reads false again", () => {
    createProfile("p1", 15);
    setConsents(db, "p1", { videoAnalysis: true, modelImprovement: true }, { now: at("2026-03-01T10:00:00.000Z") });
    const after = setConsents(db, "p1", { videoAnalysis: false }, { now: at("2026-03-02T10:00:00.000Z") });
    expect(after.videoAnalysis.granted).toBe(false);
    expect(after.videoAnalysis.at).toBe("2026-03-02T10:00:00.000Z");
    expect(after.modelImprovement.granted).toBe(true); // untouched
    expect(getConsents(db, "p1").videoAnalysis.granted).toBe(false);
  });

  test("history is kept as rows: every change appends one row and no stored row is rewritten", () => {
    createProfile("p1", 15);
    setConsents(db, "p1", { videoAnalysis: true }, { now: at("2026-03-01T10:00:00.000Z") });
    const first = consentRows("p1");
    setConsents(db, "p1", { videoAnalysis: false }, { now: at("2026-03-02T10:00:00.000Z") });
    setConsents(db, "p1", { videoAnalysis: true }, { now: at("2026-03-03T10:00:00.000Z") });
    const rows = consentRows("p1");
    expect(rows.map((r) => r.granted)).toEqual([1, 0, 1]);
    expect(rows.every((r) => r.kind === "videoAnalysis")).toBe(true);
    expect(rows[0]).toEqual(first[0]);
  });

  test("the current consent is the LAST WRITTEN row, not the latest timestamp: a clock stepping back cannot resurrect a grant", () => {
    createProfile("p1", 15);
    setConsents(db, "p1", { videoAnalysis: true }, { now: at("2026-03-05T10:00:00.000Z") });
    setConsents(db, "p1", { videoAnalysis: false }, { now: at("2026-03-01T10:00:00.000Z") }); // the host clock went back
    expect(getConsents(db, "p1").videoAnalysis.granted).toBe(false);
  });

  test("a request writes one row per PRESENT key: an omitted key is left as it is", () => {
    createProfile("p1", 15);
    setConsents(db, "p1", { modelImprovement: true });
    expect(consentRows("p1").map((r) => r.kind)).toEqual(["modelImprovement"]);
    expect(getConsents(db, "p1").videoAnalysis).toEqual({ granted: false });
  });

  test("guardianConfirmed on its own writes nothing", () => {
    createProfile("p1", 10);
    setConsents(db, "p1", { guardianConfirmed: true });
    expect(consentRows("p1")).toEqual([]);
    expect(getConsents(db, "p1")).toEqual(DEFAULT_CONSENTS);
  });

  test("a PUT that changes nothing (empty request) writes nothing and returns the current consents", () => {
    createProfile("p1", 15);
    setConsents(db, "p1", { videoAnalysis: true });
    const before = getConsents(db, "p1");
    expect(setConsents(db, "p1", {})).toEqual(before);
    expect(consentRows("p1")).toHaveLength(1);
  });

  test("consents are per player: one player's change never shows for another", () => {
    createProfile("p1", 15);
    createProfile("p2", 15);
    setConsents(db, "p1", { videoAnalysis: true, modelImprovement: true });
    expect(getConsents(db, "p2")).toEqual(DEFAULT_CONSENTS);
    setConsents(db, "p2", { videoAnalysis: false });
    expect(getConsents(db, "p1").videoAnalysis.granted).toBe(true);
    expect(consentRows("p1")).toHaveLength(2);
  });

  test("a player who has not onboarded (no profile, so no age) cannot set consents, and nothing is written", () => {
    expect(() => setConsents(db, "nobody", { modelImprovement: true })).toThrow(PlayerNotOnboardedError);
    expect(consentRows("nobody")).toEqual([]);
  });
});

describe("setConsents: the under-13 guardian rule", () => {
  test("age 11 granting videoAnalysis without guardianConfirmed is refused and nothing is stored", () => {
    createProfile("kid", 11);
    expect(() => setConsents(db, "kid", { videoAnalysis: true })).toThrow(GuardianConfirmationRequiredError);
    expect(consentRows("kid")).toEqual([]);
    expect(getConsents(db, "kid")).toEqual(DEFAULT_CONSENTS);
  });

  test("guardianConfirmed: false is no confirmation", () => {
    createProfile("kid", 11);
    expect(() => setConsents(db, "kid", { videoAnalysis: true, guardianConfirmed: false })).toThrow(GuardianConfirmationRequiredError);
    expect(consentRows("kid")).toEqual([]);
  });

  test("age 11 with guardianConfirmed true may grant, and the confirmation is recorded and returned", () => {
    createProfile("kid", 11);
    const after = setConsents(db, "kid", { videoAnalysis: true, guardianConfirmed: true });
    expect(after.videoAnalysis).toMatchObject({ granted: true, guardianConfirmed: true });
    expect(consentRows("kid")[0]).toMatchObject({ kind: "videoAnalysis", granted: 1, guardian_confirmed: 1 });
  });

  test("the boundary is 13: age 12 needs the guardian, age 13 does not", () => {
    createProfile("twelve", 12);
    createProfile("thirteen", 13);
    expect(() => setConsents(db, "twelve", { videoAnalysis: true })).toThrow(GuardianConfirmationRequiredError);
    expect(setConsents(db, "thirteen", { videoAnalysis: true }).videoAnalysis.granted).toBe(true);
  });

  test("the rule uses the player's CURRENT age: a profile that turned 13 no longer needs the guardian", () => {
    createProfile("kid", 12);
    expect(() => setConsents(db, "kid", { videoAnalysis: true })).toThrow(GuardianConfirmationRequiredError);
    db.query("UPDATE player_profiles SET age = 13 WHERE player_id = 'kid'").run();
    expect(setConsents(db, "kid", { videoAnalysis: true }).videoAnalysis.granted).toBe(true);
  });

  test("revocation is always allowed under 13, with no guardian", () => {
    createProfile("kid", 11);
    setConsents(db, "kid", { videoAnalysis: true, guardianConfirmed: true });
    const after = setConsents(db, "kid", { videoAnalysis: false });
    expect(after.videoAnalysis.granted).toBe(false);
    expect(consentRows("kid")).toHaveLength(2);
  });

  test("modelImprovement is not gated by the guardian, and its row never carries a guardian confirmation", () => {
    createProfile("kid", 11);
    const after = setConsents(db, "kid", { modelImprovement: true, guardianConfirmed: true });
    expect(after.modelImprovement.granted).toBe(true);
    expect(consentRows("kid")).toHaveLength(1);
    expect(consentRows("kid")[0]).toMatchObject({ kind: "modelImprovement", guardian_confirmed: 0 });
  });

  test("a refused request is all-or-nothing: the other keys of the same request are not written either", () => {
    createProfile("kid", 11);
    expect(() => setConsents(db, "kid", { videoAnalysis: true, modelImprovement: true })).toThrow(GuardianConfirmationRequiredError);
    expect(consentRows("kid")).toEqual([]);
  });
});

// =====================================================================================================
// requireConsent
// =====================================================================================================

describe("requireConsent (unit)", () => {
  test("mounted without a session guard (no player on the context) it fails closed with 401 and never calls the handler", async () => {
    let reached = false;
    const app = new Hono();
    app.get("/x", requireConsent({ db }, "videoAnalysis") as never, (c) => {
      reached = true;
      return c.json({});
    });
    const res = await app.request("/x");
    expect(res.status).toBe(401);
    expect(reached).toBe(false);
  });

  test("with the player on the context it lets a granted consent through and answers 403 'consent required' otherwise", async () => {
    createProfile("p1", 15);
    const app = new Hono<{ Variables: { playerId: string } }>();
    app.use("*", async (c, next) => {
      c.set("playerId", c.req.header("x-test-player") ?? "");
      await next();
    });
    app.get("/x", requireConsent({ db }, "videoAnalysis"), (c) => c.json({ ok: true }));

    const denied = await app.request("/x", { headers: { "x-test-player": "p1" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
    expect(await denied.json()).toMatchObject({ title: "consent required", status: 403 });

    setConsents(db, "p1", { videoAnalysis: true });
    expect((await app.request("/x", { headers: { "x-test-player": "p1" } })).status).toBe(200);
    // another player's grant does not open the door for this one
    expect((await app.request("/x", { headers: { "x-test-player": "p2" } })).status).toBe(403);
  });
});

// =====================================================================================================
// the routes, through the app
// =====================================================================================================

const GATE_MODULE = (): string => `
import { ensureAuthSchema, getAuth } from ${JSON.stringify(join(SRC_DIR, "auth/better-auth"))};
import { requirePlayer } from ${JSON.stringify(join(SRC_DIR, "auth/middleware"))};
import { requireConsent } from ${JSON.stringify(join(SRC_DIR, "player/consents"))};
export async function register(app, deps) {
  await ensureAuthSchema(getAuth(deps), deps.db);
  app.get(${JSON.stringify(VIDEO_GATED)}, requirePlayer(deps), requireConsent(deps, "videoAnalysis"), (c) => c.json({ ok: true }));
  app.get(${JSON.stringify(MODEL_GATED)}, requirePlayer(deps), requireConsent(deps, "modelImprovement"), (c) => c.json({ ok: true }));
}
`;

/** A real createApp that mounts only the routes under test, the real Better Auth handler and the gate stand-in. */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ["player-consents.routes.ts", "auth.routes.ts"]) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(ROUTES_DIR, file))};\n`);
  }
  writeFileSync(join(routesDir, "consent-gate.routes.ts"), GATE_MODULE());
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

/** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Player = { cookie: string; id: string };

describe("GET/PUT /api/player/consents", () => {
  let app: Hono;

  beforeEach(async () => {
    app = await buildApp();
  });

  async function signInPlayer(age?: number): Promise<Player> {
    const res = await app.request("/api/auth/sign-in/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json", origin: DEV_ORIGIN },
      body: "{}",
    });
    const body = (await res.json()) as { user: { id: string } };
    if (age !== undefined) createProfile(body.user.id, age);
    return { cookie: cookieOf(res), id: body.user.id };
  }

  const get = (player?: Player) => app.request(CONSENTS, { headers: player ? { cookie: player.cookie } : {} });
  const put = (body: unknown, player?: Player) =>
    app.request(CONSENTS, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(player ? { cookie: player.cookie } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const putOk = async (player: Player, body: UpdateConsentsRequest): Promise<Consents> => {
    const res = await put(body, player);
    expect(res.status).toBe(200);
    return Consents.parse(await res.json());
  };
  const getOk = async (player: Player): Promise<Consents> => {
    const res = await get(player);
    expect(res.status).toBe(200);
    return Consents.parse(await res.json());
  };

  type Problem = { type: string; title: string; status: number; detail?: string; errors?: { pointer: string; detail: string }[] };
  const expectProblem = async (res: Response, status: number): Promise<Problem> => {
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Problem;
    expect(body.status).toBe(status);
    return body;
  };

  test("no session is a 401 problem on both methods, whatever the body holds", async () => {
    await expectProblem(await get(), 401);
    await expectProblem(await put({ videoAnalysis: true }), 401);
    await expectProblem(await put("not json"), 401);
  });

  test("GET answers everything off for a player who never chose, and it is never cached", async () => {
    const player = await signInPlayer(15);
    const res = await get(player);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Consents.parse(await res.json())).toEqual(DEFAULT_CONSENTS);
  });

  test("GET also answers the defaults for a player who has not onboarded", async () => {
    const player = await signInPlayer();
    expect(await getOk(player)).toEqual(DEFAULT_CONSENTS);
  });

  test("PUT grants and answers the updated Consents (one call), which GET then repeats", async () => {
    const player = await signInPlayer(15);
    const res = await put({ videoAnalysis: true, modelImprovement: true }, player);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const after = Consents.parse(await res.json());
    expect(after.videoAnalysis.granted).toBe(true);
    expect(after.videoAnalysis.at).toBeDefined();
    expect(after.modelImprovement.granted).toBe(true);
    expect(await getOk(player)).toEqual(after);
  });

  test("PUT revokes: a granted consent reads false afterwards, and the grant stays in the history", async () => {
    const player = await signInPlayer(15);
    await putOk(player, { videoAnalysis: true });
    const after = await putOk(player, { videoAnalysis: false });
    expect(after.videoAnalysis.granted).toBe(false);
    expect((await getOk(player)).videoAnalysis.granted).toBe(false);
    expect(consentRows(player.id).map((r) => r.granted)).toEqual([1, 0]);
  });

  test("age 11 without guardianConfirmed is a 422 problem pointing at /guardianConfirmed, and nothing is stored", async () => {
    const kid = await signInPlayer(11);
    const body = await expectProblem(await put({ videoAnalysis: true }, kid), 422);
    expect(body.errors?.map((e) => e.pointer)).toEqual(["/guardianConfirmed"]);
    expect(consentRows(kid.id)).toEqual([]);
    expect(await getOk(kid)).toEqual(DEFAULT_CONSENTS);
  });

  test("age 11 with guardianConfirmed true grants, and the confirmation is returned", async () => {
    const kid = await signInPlayer(11);
    const after = await putOk(kid, { videoAnalysis: true, guardianConfirmed: true });
    expect(after.videoAnalysis).toMatchObject({ granted: true, guardianConfirmed: true });
  });

  test("age 11 may revoke without a guardian, and may grant modelImprovement (only videoAnalysis is gated)", async () => {
    const kid = await signInPlayer(11);
    await putOk(kid, { videoAnalysis: true, guardianConfirmed: true });
    expect((await putOk(kid, { videoAnalysis: false })).videoAnalysis.granted).toBe(false);
    expect((await putOk(kid, { modelImprovement: true })).modelImprovement.granted).toBe(true);
  });

  test("a body that is not a JSON object is a 400", async () => {
    const player = await signInPlayer(15);
    await expectProblem(await put("not json", player), 400);
    await expectProblem(await put("[true]", player), 400);
    await expectProblem(await put("null", player), 400);
  });

  test("an invalid value is a 422 with a pointer to the field, and nothing is stored", async () => {
    const player = await signInPlayer(15);
    const body = await expectProblem(await put({ videoAnalysis: "yes" }, player), 422);
    expect(body.errors?.map((e) => e.pointer)).toEqual(["/videoAnalysis"]);
    expect(consentRows(player.id)).toEqual([]);
  });

  test("a request cannot name another player: an unknown key such as playerId is a 422 at its own pointer", async () => {
    const player = await signInPlayer(15);
    const victim = await signInPlayer(15);
    const body = await expectProblem(await put({ playerId: victim.id, videoAnalysis: true }, player), 422);
    expect(body.errors?.map((e) => e.pointer)).toEqual(["/playerId"]);
    expect(consentRows(victim.id)).toEqual([]);
    expect(consentRows(player.id)).toEqual([]);
  });

  test("PUT for a player who has not onboarded is a 404 problem and writes nothing", async () => {
    const player = await signInPlayer();
    await expectProblem(await put({ videoAnalysis: true }, player), 404);
    expect(consentRows(player.id)).toEqual([]);
  });

  test("consents are the session's own: two players never see each other's", async () => {
    const a = await signInPlayer(15);
    const b = await signInPlayer(15);
    await putOk(a, { videoAnalysis: true });
    expect(await getOk(b)).toEqual(DEFAULT_CONSENTS);
    expect((await getOk(a)).videoAnalysis.granted).toBe(true);
  });

  // --- requireConsent behind the real guard ------------------------------------------------------

  test("requireConsent: 401 without a session, 403 'consent required' without the consent, 200 once granted, 403 again after revoking", async () => {
    const player = await signInPlayer(15);
    const call = (path: string, who?: Player) => app.request(path, { headers: who ? { cookie: who.cookie } : {} });

    await expectProblem(await call(VIDEO_GATED), 401);

    const denied = await expectProblem(await call(VIDEO_GATED, player), 403);
    expect(denied.title).toBe("consent required");

    await putOk(player, { videoAnalysis: true });
    const allowed = await call(VIDEO_GATED, player);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });

    await putOk(player, { videoAnalysis: false });
    expect((await expectProblem(await call(VIDEO_GATED, player), 403)).title).toBe("consent required");
  });

  test("requireConsent gates the named kind only: a videoAnalysis grant does not open a modelImprovement gate", async () => {
    const player = await signInPlayer(15);
    await putOk(player, { videoAnalysis: true });
    const call = (path: string) => app.request(path, { headers: { cookie: player.cookie } });
    expect((await call(VIDEO_GATED)).status).toBe(200);
    expect((await call(MODEL_GATED)).status).toBe(403);
    await putOk(player, { modelImprovement: true });
    expect((await call(MODEL_GATED)).status).toBe(200);
  });

  test("an under-13 player who was refused the grant stays behind the gate", async () => {
    const kid = await signInPlayer(11);
    expect((await put({ videoAnalysis: true }, kid)).status).toBe(422);
    const res = await app.request(VIDEO_GATED, { headers: { cookie: kid.cookie } });
    expect(res.status).toBe(403);
  });
});
