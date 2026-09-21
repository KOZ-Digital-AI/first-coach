import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import { RATE_LIMITS } from "../auth/rate-limit";
import { loadSeed } from "../commons/seed-loader";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { Timestamp } from "../shared/domain";
import type { PlayerProfile } from "../shared/domain";
import { ENDPOINTS as ONBOARDING, StartResponse } from "../shared/onboarding";
import type { BaselineResult, StartRequest } from "../shared/onboarding";
import { ENDPOINTS, RECOVERY_CODE_PATTERN, RecoverResponse, RecoveryCodeResponse } from "../shared/privacy";
import { PROBLEM_CONTENT_TYPE } from "../shared/primitives";
import { createRecoveryCode, generateRecoveryCode, hashRecoveryCode, recoverPlayer, verifyRecoveryCode } from "./recovery";

// Two layers, both on a fresh in-memory database migrated with the REAL migrations (007_privacy included):
//   * the module (recovery.ts): code generation, the hash, the constant-time check, creating and restoring;
//   * the routes (player-recovery.routes.ts) through the real createApp with the REAL Better Auth handler and
//     the real start route: players are real anonymous sign-ins that onboard through POST /api/player/start.
// The rate limiter keeps its counters per process, keyed by client IP, so every test that is not about the limit
// sends its own X-Forwarded-For address and never shares a budget with another test.

const ROUTES_DIR_SRC = resolve(import.meta.dir, "../http/routes");
const SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");
const ROUTE_FILES = ["player-recovery.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const CREATE = ENDPOINTS.createRecoveryCode.path;
const RECOVER = ENDPOINTS.recover.path;
const ME = "/api/player/me";
const PASSWORD = "correct-horse-battery";
const UNAMBIGUOUS_FORBIDDEN = /[01OIL]/;
const T0 = "2026-01-01T00:00:00.000Z";

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

/** A real createApp that mounts only the routes under test and the real Better Auth handler. */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTE_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(ROUTES_DIR_SRC, file))};\n`);
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "recovery-"));
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

// --- helpers -------------------------------------------------------------------------------------

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
const compact = (code: string): string => code.replaceAll("-", "");

let nextIp = 1;
/** A client address no other test uses (the limiter's counters live for the whole process). */
const freshIp = (): string => `203.0.113.${nextIp++}`;

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

async function signUpAccount(email = "coach@example.com"): Promise<Player> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN },
    body: JSON.stringify({ name: "Coach", email, password: PASSWORD }),
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

let nextBaseline = 1;
let nextRow = 1_000_000;

/**
 * A signed-in player who has onboarded (profile, results and roadmap through the real start route) and who also
 * has a training session with an event and a stored consent, so that every table with a player_id has a row.
 */
async function trainedPlayer(over: Partial<PlayerProfile> = {}): Promise<Player & { start: StartResponse }> {
  const player = await signInPlayer();
  const body: StartRequest = { profile: { ...PROFILE, ...over }, baseline: baseline(nextBaseline) };
  nextBaseline += 10;
  const res = await app.request(ONBOARDING.start.path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: player.cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const sessionId = `session-${nextRow}`;
  db.run("INSERT INTO sessions (id, player_id, date, planner, graph_version, items) VALUES (?, ?, '2026-01-01', 'rules', 'v1', '[]')", [
    sessionId,
    player.id,
  ]);
  db.run("INSERT INTO session_events (player_id, session_id, client_uuid, type, at) VALUES (?, ?, ?, 'drill_done', ?)", [
    player.id,
    sessionId,
    uuid(nextRow++),
    T0,
  ]);
  db.run("INSERT INTO consents (player_id, kind, granted) VALUES (?, 'modelImprovement', 1)", [player.id]);
  db.run("INSERT INTO ai_calls (player_id, kind, model, candidate_ids, chosen_ids, latency_ms) VALUES (?, 'plan', 'test-model', '[\"dv-1\"]', '[\"dv-1\"]', 1)", [player.id]);
  db.run("INSERT INTO video_analyses (id, player_id, skill_slug, rubric_version, confidence, scores, focus_next, recommended, features_summary, client_uuid) VALUES (?, ?, 'first-touch', 1, 'low', '[{\"key\":\"balance\"}]', 'again', '[]', '{}', ?)", [`va-${nextRow}`, player.id, uuid(nextRow++)]);
  return { ...player, start: StartResponse.parse(await res.json()) };
}

type Call = { cookie?: string; ip?: string; body?: unknown };

/** `body` is JSON-encoded unless it is already a string (to send malformed JSON verbatim). */
function post(path: string, call: Call = {}): Promise<Response> | Response {
  const raw = call.body === undefined ? undefined : typeof call.body === "string" ? call.body : JSON.stringify(call.body);
  return app.request(path, {
    method: "POST",
    headers: {
      ...(raw === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": call.ip ?? freshIp(),
      ...(call.cookie === undefined ? {} : { cookie: call.cookie }),
    },
    ...(raw === undefined ? {} : { body: raw }),
  });
}

/** Creates the player's recovery code through the route and returns the code shown once. */
async function issueCode(player: Player): Promise<string> {
  const res = await post(CREATE, { cookie: player.cookie });
  expect(res.status).toBe(200);
  return RecoveryCodeResponse.parse(await res.json()).code;
}

const recover = (player: Player, body: unknown, ip?: string) => post(RECOVER, { cookie: player.cookie, body, ...(ip ? { ip } : {}) });

/** Every table that has a player_id column, found the way the module must find them (not a hard-coded list). */
function playerTables(): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = 'player_id' ORDER BY m.name",
    )
    .all()
    .map((row) => row.name);
}

/** Row counts of one player in every table that has a player_id. */
function countsOf(playerId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of playerTables()) {
    out[table] = db.query<{ n: number }, [string]>(`SELECT count(*) AS n FROM "${table}" WHERE player_id = ?`).get(playerId)!.n;
  }
  return out;
}

/** Row counts of the whole table for every table that has a player_id. */
function totals(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of playerTables()) out[table] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()!.n;
  return out;
}

const ZERO = (counts: Record<string, number>): Record<string, number> => Object.fromEntries(Object.keys(counts).map((key) => [key, 0]));

/** Inserts a bare profile for the module-level tests (no route, no auth). */
function insertProfile(playerId: string): void {
  db.run(
    "INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale) VALUES (?, 12, 'basic', 'dribbling', 'ball', 'yard', 0, 3, 20, 'ru')",
    [playerId],
  );
}

// --- the module: generating, hashing, checking ---------------------------------------------------

describe("generateRecoveryCode", () => {
  test("is 4 groups of 4 in the contract's canonical form: 16 characters, hyphen separated", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode();
      expect(code).toMatch(RECOVERY_CODE_PATTERN);
      expect(code).toHaveLength(19);
      expect(compact(code)).toHaveLength(16);
    }
  });

  test("uses an unambiguous alphabet: never 0, 1, O, I or L", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const char of compact(generateRecoveryCode())) seen.add(char);
    for (const char of seen) expect(char).not.toMatch(UNAMBIGUOUS_FORBIDDEN);
    // a real alphabet, not a handful of characters: 400 codes of 16 draws each reach most of it
    expect(seen.size).toBeGreaterThanOrEqual(25);
  });

  test("is high entropy: 500 codes are all different", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) codes.add(generateRecoveryCode());
    expect(codes.size).toBe(500);
  });
});

describe("hashRecoveryCode", () => {
  test("is the lower-case hex sha-256 of the canonical code", () => {
    expect(hashRecoveryCode("ABCD-EFGH-JKMN-PQRS")).toBe(sha256Hex("ABCD-EFGH-JKMN-PQRS"));
    expect(hashRecoveryCode("ABCD-EFGH-JKMN-PQRS")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hashes what the player typed like what was shown: case, spaces and hyphens do not matter", () => {
    const shown = hashRecoveryCode("ABCD-EFGH-JKMN-PQRS");
    expect(hashRecoveryCode("abcd efgh jkmn pqrs")).toBe(shown);
    expect(hashRecoveryCode("  abcdefghjkmnpqrs ")).toBe(shown);
    expect(hashRecoveryCode("ABCD-EFGH-JKMN-PQRT")).not.toBe(shown);
  });
});

describe("verifyRecoveryCode", () => {
  test("finds the player whose stored hash matches, and nobody for another code", () => {
    insertProfile("p1");
    const { code } = createRecoveryCode(db, "p1")!;
    expect(verifyRecoveryCode(db, code)).toBe("p1");
    expect(verifyRecoveryCode(db, code.toLowerCase().replaceAll("-", " "))).toBe("p1");
    expect(verifyRecoveryCode(db, generateRecoveryCode())).toBeNull();
  });

  test("compares the two digests with the constant-time comparator, for a known code AND an unknown one", () => {
    insertProfile("p1");
    const { code } = createRecoveryCode(db, "p1")!;
    const calls: [Uint8Array, Uint8Array][] = [];
    const compare = (a: Uint8Array, b: Uint8Array): boolean => {
      calls.push([a, b]);
      return Buffer.from(a).equals(Buffer.from(b));
    };

    expect(verifyRecoveryCode(db, code, compare)).toBe("p1");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toHaveLength(32); // two raw sha-256 digests, never the code text
    expect(calls[0]![1]).toHaveLength(32);

    expect(verifyRecoveryCode(db, generateRecoveryCode(), compare)).toBeNull();
    expect(calls).toHaveLength(2); // an unknown code costs the same comparison: no early exit tells it apart
    expect(calls[1]![0]).toHaveLength(32);
    expect(calls[1]![1]).toHaveLength(32);
  });

  test("the comparator's answer decides: a stored hash that the comparator refuses is not a match", () => {
    insertProfile("p1");
    const { code } = createRecoveryCode(db, "p1")!;
    expect(verifyRecoveryCode(db, code, () => false)).toBeNull();
  });
});

// --- the module: creating a code -----------------------------------------------------------------

describe("createRecoveryCode", () => {
  test("stores only the hash and returns the code and its creation time once", () => {
    insertProfile("p1");
    const created = createRecoveryCode(db, "p1", { now: () => new Date(T0) })!;

    expect(created.code).toMatch(RECOVERY_CODE_PATTERN);
    expect(created.createdAt).toBe(T0);
    const rows = db.query<{ player_id: string; code_hash: string; created_at: string; last_used_at: string | null }, []>("SELECT * FROM recovery_codes").all();
    expect(rows).toEqual([{ player_id: "p1", code_hash: sha256Hex(created.code), created_at: T0, last_used_at: null }]);
  });

  test("replaces the earlier code: one row, the old code stops working, last_used_at starts over", () => {
    insertProfile("p1");
    const first = createRecoveryCode(db, "p1")!;
    db.run("UPDATE recovery_codes SET last_used_at = ? WHERE player_id = 'p1'", [T0]);
    const second = createRecoveryCode(db, "p1", { now: () => new Date("2026-02-02T00:00:00.000Z") })!;

    expect(second.code).not.toBe(first.code);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM recovery_codes").get()!.n).toBe(1);
    expect(verifyRecoveryCode(db, first.code)).toBeNull();
    expect(verifyRecoveryCode(db, second.code)).toBe("p1");
    const row = db.query<{ created_at: string; last_used_at: string | null }, []>("SELECT created_at, last_used_at FROM recovery_codes").get()!;
    expect(row).toEqual({ created_at: "2026-02-02T00:00:00.000Z", last_used_at: null });
  });

  test("a player without a profile gets no code", () => {
    expect(createRecoveryCode(db, "nobody")).toBeNull();
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM recovery_codes").get()!.n).toBe(0);
  });

  test("a generated code whose hash another player already holds is replaced by another draw, and the other code survives", () => {
    insertProfile("p1");
    insertProfile("p2");
    const taken = createRecoveryCode(db, "p1")!;
    const fresh = generateRecoveryCode();
    const draws = [taken.code, fresh];

    const created = createRecoveryCode(db, "p2", { generate: () => draws.shift()! })!;

    expect(created.code).toBe(fresh);
    expect(verifyRecoveryCode(db, taken.code)).toBe("p1");
    expect(verifyRecoveryCode(db, fresh)).toBe("p2");
  });
});

// --- the module: restoring -----------------------------------------------------------------------

describe("recoverPlayer", () => {
  test("recovering with the code of the player's own current id changes nothing and succeeds", () => {
    insertProfile("p1");
    const { code } = createRecoveryCode(db, "p1")!;
    db.run("INSERT INTO consents (player_id, kind, granted) VALUES ('p1', 'videoAnalysis', 1)");

    const outcome = recoverPlayer(db, code, "p1", { replace: true });

    expect(outcome.status).toBe("recovered");
    expect(countsOf("p1").player_profiles).toBe(1);
    expect(countsOf("p1").consents).toBe(1);
  });

  test("a wrong code is 'invalid' and moves nothing", () => {
    insertProfile("p1");
    createRecoveryCode(db, "p1");
    expect(recoverPlayer(db, generateRecoveryCode(), "p2", { replace: true }).status).toBe("invalid");
    expect(countsOf("p1").player_profiles).toBe(1);
  });
});

// --- POST /api/player/recovery-code --------------------------------------------------------------

describe("POST /api/player/recovery-code", () => {
  test("no session is 401", async () => {
    const res = await post(CREATE);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
  });

  test("a signed-in player who has not onboarded is 404: there is nothing to recover", async () => {
    const player = await signInPlayer();
    const res = await post(CREATE, { cookie: player.cookie });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM recovery_codes").get()!.n).toBe(0);
  });

  test("answers a 16-character code from an unambiguous alphabet, grouped 4x4, with its creation time, never cached", async () => {
    const player = await trainedPlayer();
    const res = await post(CREATE, { cookie: player.cookie });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = RecoveryCodeResponse.parse(await res.json());
    expect(body.code).toMatch(RECOVERY_CODE_PATTERN);
    expect(compact(body.code)).toHaveLength(16);
    expect(compact(body.code)).not.toMatch(UNAMBIGUOUS_FORBIDDEN);
    expect(Timestamp.safeParse(body.createdAt).success).toBe(true);
    const row = db.query<{ created_at: string }, [string]>("SELECT created_at FROM recovery_codes WHERE player_id = ?").get(player.id)!;
    expect(row.created_at).toBe(body.createdAt);
  });

  test("the code is not stored in clear text anywhere: only its sha-256 is in the database", async () => {
    const player = await trainedPlayer();
    const code = await issueCode(player);

    const row = db.query<{ code_hash: string }, [string]>("SELECT code_hash FROM recovery_codes WHERE player_id = ?").get(player.id)!;
    expect(row.code_hash).toBe(sha256Hex(code));
    expect(row.code_hash).not.toBe(code);

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((table) => table.name);
    expect(tables).toContain("recovery_codes");
    for (const table of tables) {
      const dump = JSON.stringify(db.query(`SELECT * FROM "${table}"`).all()).toUpperCase();
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(compact(code));
    }
  });

  test("shows a new code every time and each replaces the earlier one: the old code stops recovering", async () => {
    const player = await trainedPlayer();
    const first = await issueCode(player);
    const second = await issueCode(player);
    expect(second).not.toBe(first);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM recovery_codes").get()!.n).toBe(1);

    const stale = await recover(await signInPlayer(), { code: first });
    expect(stale.status).toBe(422);
    const fresh = await recover(await signInPlayer(), { code: second });
    expect(fresh.status).toBe(200);
  });
});

// --- POST /api/player/recover: restoring ---------------------------------------------------------

describe("POST /api/player/recover", () => {
  test("no session is 401 and a contributor account (not an anonymous player) is 403; nothing moves", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const before = countsOf(old.id);

    const anonymous = await post(RECOVER, { body: { code } });
    expect(anonymous.status).toBe(401);
    const account = await signUpAccount();
    const contributor = await recover(account, { code });
    expect(contributor.status).toBe(403);
    expect(contributor.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);

    expect(countsOf(old.id)).toEqual(before);
  });

  test("restore moves every row of every table with a player_id to the current session, in one step", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const before = countsOf(old.id);
    const totalsBefore = totals();
    // not vacuous: the player has rows in every table that carries a player_id
    expect(playerTables()).toEqual(expect.arrayContaining(["consents", "player_profiles", "recovery_codes", "roadmaps", "session_events", "sessions", "test_results"]));
    for (const table of playerTables()) expect(before[table]).toBeGreaterThan(0);

    const current = await signInPlayer();
    const res = await recover(current, { code });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = RecoverResponse.parse(await res.json());
    expect(body.profile).toEqual(old.start.profile);
    expect(body.roadmap).toEqual(old.start.roadmap);
    expect(countsOf(old.id)).toEqual(ZERO(before));
    expect(countsOf(current.id)).toEqual(before);
    expect(totals()).toEqual(totalsBefore);

    // the current session now IS the player: the /train guard's question answers with the restored data
    const me = await app.request(ME, { headers: { cookie: current.cookie } });
    expect(me.status).toBe(200);
    expect(StartResponse.parse(await me.json()).profile).toEqual(old.start.profile);
  });

  test("also finds a table with a player_id that nothing declared (discovered by introspection), and moves it with the rest", async () => {
    db.run("CREATE TABLE zz_notes (player_id TEXT NOT NULL, note TEXT NOT NULL) STRICT");
    const old = await trainedPlayer();
    db.run("INSERT INTO zz_notes (player_id, note) VALUES (?, 'kept')", [old.id]);
    const code = await issueCode(old);

    const current = await signInPlayer();
    const res = await recover(current, { code });

    expect(res.status).toBe(200);
    expect(db.query("SELECT player_id, note FROM zz_notes").all()).toEqual([{ player_id: current.id, note: "kept" }]);
  });

  test("a failure half-way rolls everything back: the player keeps all rows under the old id", async () => {
    db.run("CREATE TABLE zz_notes (player_id TEXT NOT NULL, note TEXT NOT NULL) STRICT");
    db.run("CREATE TRIGGER zz_notes_frozen BEFORE UPDATE ON zz_notes BEGIN SELECT RAISE(ABORT, 'frozen'); END");
    const old = await trainedPlayer();
    db.run("INSERT INTO zz_notes (player_id, note) VALUES (?, 'x')", [old.id]);
    const code = await issueCode(old);
    const before = countsOf(old.id);
    const errors = spyOn(console, "error").mockImplementation(() => {});

    const current = await signInPlayer();
    const res = await recover(current, { code });
    errors.mockRestore();

    expect(res.status).toBe(500);
    expect(countsOf(old.id)).toEqual(before);
    expect(countsOf(current.id)).toEqual(ZERO(before));
  });

  test("the code keeps working after a restore: it follows the player, and last_used_at records the use", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const first = await signInPlayer();
    expect((await recover(first, { code })).status).toBe(200);

    const row = db.query<{ player_id: string; last_used_at: string | null }, []>("SELECT player_id, last_used_at FROM recovery_codes").get()!;
    expect(row.player_id).toBe(first.id);
    expect(Timestamp.safeParse(row.last_used_at).success).toBe(true);

    const second = await signInPlayer();
    expect((await recover(second, { code })).status).toBe(200);
    expect(countsOf(second.id).player_profiles).toBe(1);
    expect(countsOf(first.id).player_profiles).toBe(0);
  });

  test("accepts the code as the player types it: lower case, spaces, no hyphens", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const typed = code.toLowerCase().replaceAll("-", " ");
    const res = await recover(await signInPlayer(), { code: typed });
    expect(res.status).toBe(200);
  });

  test("a wrong code is one generic 422: a code that never existed, a malformed one and a replaced one are indistinguishable", async () => {
    const old = await trainedPlayer();
    const replaced = await issueCode(old);
    const liveCode = await issueCode(old);
    const before = countsOf(old.id);

    const answers: { status: number; type: string | null; body: unknown }[] = [];
    for (const code of [generateRecoveryCode(), "nope", replaced]) {
      const res = await recover(await signInPlayer(), { code });
      answers.push({ status: res.status, type: res.headers.get("content-type"), body: await res.json() });
    }

    for (const answer of answers) {
      expect(answer.status).toBe(422);
      expect(answer.type).toBe(PROBLEM_CONTENT_TYPE);
      expect(answer.body).not.toHaveProperty("errors"); // no pointer, no hint about the shape or existence
      expect(JSON.stringify(answer.body)).not.toContain(liveCode);
    }
    expect(answers[1]!.body).toEqual(answers[0]!.body);
    expect(answers[2]!.body).toEqual(answers[0]!.body);
    expect(countsOf(old.id)).toEqual(before);
  });

  test("refuses with 409 when the current session already has training data, and moves and deletes nothing", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const current = await trainedPlayer();
    const oldBefore = countsOf(old.id);
    const currentBefore = countsOf(current.id);

    const res = await recover(current, { code });

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(countsOf(old.id)).toEqual(oldBefore);
    expect(countsOf(current.id)).toEqual(currentBefore);
  });

  test("with replace:true the current session's own data is dropped and the recovered player takes its place", async () => {
    const old = await trainedPlayer({ age: 14 });
    const code = await issueCode(old);
    const current = await trainedPlayer({ age: 9 });
    const oldBefore = countsOf(old.id);
    const currentBefore = countsOf(current.id);
    const totalsBefore = totals();

    const res = await recover(current, { code, replace: true });

    expect(res.status).toBe(200);
    const body = RecoverResponse.parse(await res.json());
    expect(body.profile.age).toBe(14);
    expect(countsOf(old.id)).toEqual(ZERO(oldBefore));
    expect(countsOf(current.id)).toEqual(oldBefore);
    // the current session's earlier rows are gone, not merged: each table lost exactly the rows the current player had
    const after = totals();
    for (const table of playerTables()) expect(after[table]).toBe(totalsBefore[table]! - currentBefore[table]!);
  });

  test("replace:true with the player's own code from the player's own session keeps the data", async () => {
    const player = await trainedPlayer();
    const code = await issueCode(player);
    const before = countsOf(player.id);

    const res = await recover(player, { code, replace: true });

    expect(res.status).toBe(200);
    expect(countsOf(player.id)).toEqual(before);
  });

  test("the body is validated: not an object is 400, an unknown key and a non-boolean replace are 422 with pointers", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const current = await signInPlayer();

    expect((await recover(current, "not json")).status).toBe(400);
    expect((await recover(current, [code])).status).toBe(400);

    const unknown = await recover(current, { code, playerId: old.id });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { errors: { pointer: string }[] }).errors.map((e) => e.pointer)).toContain("/playerId");

    const notBoolean = await recover(current, { code, replace: "yes" });
    expect(notBoolean.status).toBe(422);
    expect(((await notBoolean.json()) as { errors: { pointer: string }[] }).errors.map((e) => e.pointer)).toContain("/replace");

    expect(countsOf(current.id).player_profiles).toBe(0);
  });
});

// --- POST /api/player/recover: the attempt limit ---------------------------------------------------

describe("POST /api/player/recover attempt limit", () => {
  test("is 5 attempts per 15 minutes, from the shared rate-limit table", () => {
    expect(RATE_LIMITS.recover).toEqual({ max: 5, window: 900 });
  });

  test("the fifth attempt is still served and the sixth is 429 with Retry-After, even with the right code", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const current = await signInPlayer();
    const ip = freshIp();

    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await recover(current, { code: generateRecoveryCode() }, ip)).status).toBe(422);
    }
    const before = countsOf(old.id);
    // the fifth attempt uses the right code and is served ...
    expect((await recover(current, { code }, ip)).status).toBe(200);
    expect(countsOf(old.id)).not.toEqual(before);

    // ... the sixth is refused
    const sixth = await recover(current, { code }, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    const retryAfter = Number(sixth.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  test("a spent budget refuses the right code: nothing moves on a 429", async () => {
    const old = await trainedPlayer();
    const code = await issueCode(old);
    const before = countsOf(old.id);
    const current = await signInPlayer();
    const ip = freshIp();

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await recover(current, { code: generateRecoveryCode() }, ip)).status).toBe(422);
    }
    const res = await recover(current, { code }, ip);

    expect(res.status).toBe(429);
    expect(countsOf(old.id)).toEqual(before);
    expect(countsOf(current.id).player_profiles).toBe(0);
  });

  test("the budget belongs to the client address, not to the session: a fresh session on the same address is still limited", async () => {
    const ip = freshIp();
    const first = await signInPlayer();
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await recover(first, { code: generateRecoveryCode() }, ip)).status).toBe(422);
    }

    const second = await signInPlayer();
    expect((await recover(second, { code: generateRecoveryCode() }, ip)).status).toBe(429);
  });

  test("another client address has its own budget", async () => {
    const ip = freshIp();
    const player = await signInPlayer();
    for (let attempt = 1; attempt <= 5; attempt++) await recover(player, { code: generateRecoveryCode() }, ip);
    expect((await recover(player, { code: generateRecoveryCode() }, ip)).status).toBe(429);

    expect((await recover(player, { code: generateRecoveryCode() }, freshIp())).status).toBe(422);
  });

  test("an attempt that fails validation still uses budget (probing costs the caller)", async () => {
    const ip = freshIp();
    const player = await signInPlayer();
    for (let attempt = 1; attempt <= 5; attempt++) expect((await recover(player, { code: 12345 }, ip)).status).toBe(422);
    expect((await recover(player, { code: generateRecoveryCode() }, ip)).status).toBe(429);
  });
});
