import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";

// DELETE /api/player (fc-mol-bjm.5): the player erases their data. Two layers, both on real code:
//   1. deletePlayerData(db, playerId) (./delete.ts) on a migrated in-memory database with the real
//      migrations: deletes the profile (the foreign keys' ON DELETE CASCADE removes every player-owned row),
//      then VERIFIES by introspection that no table with a player_id column still holds the id, and throws
//      (rolling back) when one does. That guards a future migration whose table forgets the cascade.
//   2. The route through the real createApp with the REAL Better Auth handler: sessions are real
//      sign-ins through /api/auth/*, each request carries the cookie it got back (technique of
//      link-account.test.ts). Nothing about a session is faked.
//
// Readings the criteria leave open, pinned here (each is also stated in delete.ts):
//   * "Every table that holds the player id" = every table with a column named player_id, found in the schema
//     at run time (sqlite_master and sqlite_temp_master, so a TEMP table counts). Columns with another name
//     (contributions.submitter_user_id) are not player data: "Contributions made under a coach account ...
//     stay attributed".
//   * The verification runs inside the erasing transaction: a table that keeps a row makes the whole deletion
//     fail and NOTHING changes (profile, auth user and session stay, no cookie is cleared).
//   * A caller without a profile (a guest who never onboarded) still ends their session and user: 204.
//   * DELETE /api/player removes the caller's Better Auth user, sessions and accounts whatever the account kind
//     (guest or email account); after a guest was linked to an account (fc-mol-70i.12) the data lives under
//     the account id and the same call erases it.

const ROUTES_DIR = resolve(import.meta.dir, "../http/routes");
const ROUTE_FILES = ["player-delete.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const DELETE_PATH = "/api/player";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
/** The player-owned tables of migrations 002, 005 and 007; the schema scan below finds them itself. */
const KNOWN_TABLES = ["player_profiles", "test_results", "roadmaps", "sessions", "session_events", "consents", "recovery_codes"] as const;

// The module under test is imported lazily so a missing module fails its own tests, not the whole file.
const deleteModule = () => import("./delete");

let dir: string;
let db: Database;
let seq: number;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  seq = 0;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "player-delete-"));
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

// --- player data ----------------------------------------------------------------------------------

const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const hash = (n: string): string => createHash("sha256").update(n).digest("hex");
const AT = "2026-03-10T12:00:00.000Z";

/** A row in EVERY player-owned table of the migrations for `playerId` (two where a table takes history). */
function populate(playerId: string): void {
  db.query(
    `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
     VALUES (?, 12, 'basic', 'dribbling', 'ball', 'yard', 0, 3, 20, 'ru')`,
  ).run(playerId);
  for (const slug of ["juggling-max-touches", "slalom-time"]) {
    db.query("INSERT INTO test_results (player_id, test_slug, value, client_uuid) VALUES (?, ?, 10, ?)").run(playerId, slug, uuid());
  }
  for (const version of ["v1", "v2"]) {
    db.query("INSERT INTO roadmaps (player_id, json, graph_version) VALUES (?, '{}', ?)").run(playerId, version);
  }
  const sessionId = `session-${playerId}`;
  db.query("INSERT INTO sessions (id, player_id, date, planner, graph_version, items) VALUES (?, ?, '2026-03-10', 'rules', 'v1', '[]')").run(
    sessionId,
    playerId,
  );
  for (const type of ["drill_done", "session_finished"]) {
    db.query("INSERT INTO session_events (player_id, session_id, client_uuid, type, at) VALUES (?, ?, ?, ?, ?)").run(playerId, sessionId, uuid(), type, AT);
  }
  db.query("INSERT INTO consents (player_id, kind, granted) VALUES (?, 'videoAnalysis', 1)").run(playerId);
  db.query("INSERT INTO consents (player_id, kind, granted) VALUES (?, 'videoAnalysis', 0)").run(playerId);
  db.query("INSERT INTO recovery_codes (player_id, code_hash) VALUES (?, ?)").run(playerId, hash(playerId));
}

/** Every table of the schema with a player_id column, found by this test itself (not by the code under test). */
function playerIdTables(): string[] {
  return (
    db
      .query(
        `SELECT DISTINCT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) c
          WHERE m.type = 'table' AND c.name = 'player_id' ORDER BY m.name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Rows holding `playerId` per table, over every table with a player_id column. */
function rowsOf(playerId: string): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const table of playerIdTables()) {
    rows[table] = (db.query(`SELECT count(*) AS n FROM "${table}" WHERE player_id = ?`).get(playerId) as { n: number }).n;
  }
  return rows;
}

const totalOf = (rows: Record<string, number>): number => Object.values(rows).reduce((sum, n) => sum + n, 0);
const count = (sql: string, ...params: string[]): number => (db.query(sql).get(...params) as { n: number }).n;

// --- deletePlayerData ------------------------------------------------------------------------------

describe("deletePlayerData: every player-owned row goes with the profile", () => {
  test("the schema scan finds the player-owned tables of the migrations (the test looks at all of them)", () => {
    for (const table of KNOWN_TABLES) expect(playerIdTables()).toContain(table);
  });

  test("zero rows remain in any table with a player_id column, and the deletion says it happened", async () => {
    const { deletePlayerData } = await deleteModule();
    populate("p1");
    populate("p2");
    for (const table of KNOWN_TABLES) expect(rowsOf("p1")[table]).toBeGreaterThan(0); // the fixture fills every table

    expect(deletePlayerData(db, "p1")).toEqual({ deleted: true });

    const after = rowsOf("p1");
    for (const table of playerIdTables()) expect(after[table]).toBe(0);
    expect(totalOf(after)).toBe(0);
  });

  test("another player's rows are untouched, table by table", async () => {
    const { deletePlayerData } = await deleteModule();
    populate("p1");
    populate("p2");
    populate("p3");
    const before2 = rowsOf("p2");
    const before3 = rowsOf("p3");

    deletePlayerData(db, "p1");

    expect(rowsOf("p2")).toEqual(before2);
    expect(rowsOf("p3")).toEqual(before3);
    expect(totalOf(before2)).toBeGreaterThan(KNOWN_TABLES.length); // more than one row per table: the fixture is not trivial
  });

  test("a player without a profile owns nothing: nothing is deleted, nothing throws, others stay", async () => {
    const { deletePlayerData } = await deleteModule();
    populate("p2");
    const before = rowsOf("p2");

    expect(deletePlayerData(db, "never-onboarded")).toEqual({ deleted: false });

    expect(rowsOf("p2")).toEqual(before);
  });

  test("contributions submitted under the same id stay (submitter_user_id is not a player_id column)", async () => {
    const { deletePlayerData } = await deleteModule();
    populate("coach-1");
    db.query("INSERT INTO contributions (id, kind, payload, submitter_user_id, content_hash) VALUES ('c1', 'new', '{}', 'coach-1', ?)").run(hash("c1"));
    db.query(
      `INSERT INTO contribution_attachments (id, contribution_id, kind, stored_path, mime, bytes, original_name)
       VALUES ('a1', 'c1', 'video', 'uploads/a1.mp4', 'video/mp4', 10, 'drill.mp4')`,
    ).run();

    deletePlayerData(db, "coach-1");

    expect(count("SELECT count(*) AS n FROM contributions WHERE id = 'c1' AND submitter_user_id = 'coach-1'")).toBe(1);
    expect(count("SELECT count(*) AS n FROM contribution_attachments WHERE contribution_id = 'c1'")).toBe(1);
    expect(totalOf(rowsOf("coach-1"))).toBe(0);
  });

  test("a future table WITH the cascade passes the verification (positive: it is what a good migration looks like)", async () => {
    const { deletePlayerData } = await deleteModule();
    db.run(
      "CREATE TABLE zz_future_ok (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE ON UPDATE CASCADE)",
    );
    populate("p1");
    db.query("INSERT INTO zz_future_ok (player_id) VALUES ('p1')").run();

    deletePlayerData(db, "p1");

    expect(count("SELECT count(*) AS n FROM zz_future_ok")).toBe(0);
  });
});

describe("deletePlayerData: the verification fails loudly and changes nothing", () => {
  test("a deliberately non-cascading table that keeps the player's row makes it throw, naming the table", async () => {
    const { deletePlayerData, ErasureIncompleteError } = await deleteModule();
    db.run("CREATE TABLE zz_no_cascade (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL)");
    populate("p1");
    db.query("INSERT INTO zz_no_cascade (player_id) VALUES ('p1')").run();

    let thrown: unknown;
    try {
      deletePlayerData(db, "p1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ErasureIncompleteError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { tables: string[] }).tables).toEqual(["zz_no_cascade"]);
    expect((thrown as Error).message).toContain("zz_no_cascade");
  });

  test("the failed deletion is rolled back: the profile and every other table still hold the player", async () => {
    const { deletePlayerData } = await deleteModule();
    db.run("CREATE TABLE zz_no_cascade (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL)");
    populate("p1");
    populate("p2");
    db.query("INSERT INTO zz_no_cascade (player_id) VALUES ('p1')").run();
    const before1 = rowsOf("p1");
    const before2 = rowsOf("p2");

    expect(() => deletePlayerData(db, "p1")).toThrow();

    expect(rowsOf("p1")).toEqual(before1);
    expect(rowsOf("p2")).toEqual(before2);
    expect(before1.player_profiles).toBe(1);
    expect(before1.zz_no_cascade).toBe(1);
  });

  test("a non-cascading table holding only ANOTHER player's rows does not block the deletion", async () => {
    const { deletePlayerData } = await deleteModule();
    db.run("CREATE TABLE zz_no_cascade (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL)");
    populate("p1");
    db.query("INSERT INTO zz_no_cascade (player_id) VALUES ('p2')").run();

    expect(deletePlayerData(db, "p1")).toEqual({ deleted: true });

    expect(count("SELECT count(*) AS n FROM zz_no_cascade WHERE player_id = 'p2'")).toBe(1);
    expect(totalOf(rowsOf("p1"))).toBe(0);
  });

  test("a non-cascading TEMP table is found too", async () => {
    const { deletePlayerData, ErasureIncompleteError } = await deleteModule();
    db.run("CREATE TEMP TABLE zz_temp_no_cascade (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL)");
    populate("p1");
    db.query("INSERT INTO zz_temp_no_cascade (player_id) VALUES ('p1')").run();

    expect(() => deletePlayerData(db, "p1")).toThrow(ErasureIncompleteError);
    expect(count("SELECT count(*) AS n FROM player_profiles WHERE player_id = 'p1'")).toBe(1);
  });

  test("with foreign keys switched off the cascade does not run and the verification catches it", async () => {
    const { deletePlayerData, ErasureIncompleteError } = await deleteModule();
    populate("p1");
    db.run("PRAGMA foreign_keys = OFF");
    const before = rowsOf("p1");

    let thrown: unknown;
    try {
      deletePlayerData(db, "p1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ErasureIncompleteError);
    expect((thrown as { tables: string[] }).tables).toContain("test_results");
    expect(rowsOf("p1")).toEqual(before); // rolled back: the profile is still there too
  });
});

// --- the route -------------------------------------------------------------------------------------

/** A real createApp that mounts only the routes under test and the real Better Auth handler. */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTE_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(ROUTES_DIR, file))};\n`);
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

const post = (app: Hono, path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Actor = { cookie: string; id: string };

async function actorOf(res: Response): Promise<Actor> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

const signInAnonymous = async (app: Hono): Promise<Actor> => actorOf(await post(app, "/api/auth/sign-in/anonymous", {}));
const signUp = (app: Hono, email: string, cookie?: string) =>
  post(app, "/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD }, cookie);
const signIn = (app: Hono, email: string) => post(app, "/api/auth/sign-in/email", { email, password: PASSWORD });

const del = (app: Hono, cookie?: string) => app.request(DELETE_PATH, { method: "DELETE", headers: cookie ? { cookie } : {} });
const me = (app: Hono, cookie: string) => app.request("/api/player/me", { headers: { cookie } });

/** Better Auth's rows of a user: the user itself, its sessions and its accounts. */
const authRows = (userId: string) => ({
  users: count('SELECT count(*) AS n FROM "user" WHERE id = ?', userId),
  sessions: count('SELECT count(*) AS n FROM "session" WHERE "userId" = ?', userId),
  accounts: count('SELECT count(*) AS n FROM "account" WHERE "userId" = ?', userId),
});

describe("DELETE /api/player", () => {
  let app: Hono;

  beforeEach(async () => {
    app = await buildApp();
  });

  test("no session is a 401 and deletes nothing", async () => {
    const other = await signInAnonymous(app);
    populate(other.id);
    const before = rowsOf(other.id);

    const res = await del(app);

    expect(res.status).toBe(401);
    expect(rowsOf(other.id)).toEqual(before);
    expect(authRows(other.id)).toEqual({ users: 1, sessions: 1, accounts: 0 });
  });

  test("a guest: 204 without a body, no-store, the session cookie cleared, every player row and the auth user gone", async () => {
    const guest = await signInAnonymous(app);
    populate(guest.id);
    expect(authRows(guest.id)).toEqual({ users: 1, sessions: 1, accounts: 0 });

    const res = await del(app, guest.cookie);

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cleared = res.headers.getSetCookie().filter((c) => /session_token=;/.test(c));
    expect(cleared.length).toBeGreaterThan(0);
    for (const cookie of cleared) expect(cookie).toMatch(/Max-Age=0/i);
    expect(totalOf(rowsOf(guest.id))).toBe(0);
    for (const table of KNOWN_TABLES) expect(rowsOf(guest.id)[table]).toBe(0);
    expect(authRows(guest.id)).toEqual({ users: 0, sessions: 0, accounts: 0 });
  });

  test("the old cookie is dead afterwards: a guarded route and a second delete both answer 401", async () => {
    const guest = await signInAnonymous(app);
    populate(guest.id);
    expect((await me(app, guest.cookie)).status).not.toBe(401);

    expect((await del(app, guest.cookie)).status).toBe(204);

    expect((await me(app, guest.cookie)).status).toBe(401);
    expect((await del(app, guest.cookie)).status).toBe(401);
  });

  test("another player's data, auth user and session are untouched and still work", async () => {
    const guest = await signInAnonymous(app);
    const other = await signInAnonymous(app);
    populate(guest.id);
    populate(other.id);
    const before = rowsOf(other.id);

    expect((await del(app, guest.cookie)).status).toBe(204);

    expect(rowsOf(other.id)).toEqual(before);
    expect(authRows(other.id)).toEqual({ users: 1, sessions: 1, accounts: 0 });
    expect((await me(app, other.cookie)).status).not.toBe(401);
  });

  test("a guest who never onboarded (no profile) still ends the session and the user", async () => {
    const guest = await signInAnonymous(app);

    const res = await del(app, guest.cookie);

    expect(res.status).toBe(204);
    expect(authRows(guest.id)).toEqual({ users: 0, sessions: 0, accounts: 0 });
    expect((await me(app, guest.cookie)).status).toBe(401);
  });

  test("a coach account: player data, user, account and EVERY session go; contributions stay attributed", async () => {
    const coach = await actorOf(await signUp(app, "coach@example.com"));
    const second = cookieOf(await signIn(app, "coach@example.com")); // a second device
    populate(coach.id);
    db.query("INSERT INTO contributions (id, kind, payload, submitter_user_id, content_hash) VALUES ('c1', 'new', '{}', ?, ?)").run(coach.id, hash("c1"));
    db.query(
      `INSERT INTO contribution_attachments (id, contribution_id, kind, stored_path, mime, bytes, original_name)
       VALUES ('a1', 'c1', 'video', 'uploads/a1.mp4', 'video/mp4', 10, 'drill.mp4')`,
    ).run();
    expect(authRows(coach.id)).toEqual({ users: 1, sessions: 2, accounts: 1 });
    expect((await me(app, second)).status).not.toBe(401);

    const res = await del(app, coach.cookie);

    expect(res.status).toBe(204);
    expect(totalOf(rowsOf(coach.id))).toBe(0);
    expect(authRows(coach.id)).toEqual({ users: 0, sessions: 0, accounts: 0 });
    expect((await me(app, second)).status).toBe(401);
    expect(count("SELECT count(*) AS n FROM contributions WHERE id = 'c1' AND submitter_user_id = ?", coach.id)).toBe(1);
    expect(count("SELECT count(*) AS n FROM contribution_attachments WHERE contribution_id = 'c1'")).toBe(1);
  });

  test("a guest linked to an account (fc-mol-70i.12): the moved data is erased with the account", async () => {
    const guest = await signInAnonymous(app);
    populate(guest.id);
    const signedUp = await signUp(app, "linked@example.com", guest.cookie);
    const account = await actorOf(signedUp);
    expect(account.id).not.toBe(guest.id);
    expect(rowsOf(account.id).player_profiles).toBe(1); // the hook moved the guest's data under the account id
    expect(totalOf(rowsOf(guest.id))).toBe(0);

    expect((await del(app, account.cookie)).status).toBe(204);

    expect(totalOf(rowsOf(account.id))).toBe(0);
    expect(authRows(account.id)).toEqual({ users: 0, sessions: 0, accounts: 0 });
  });

  test("a table that forgot the cascade: 500, nothing deleted, the user is still signed in, no cookie cleared", async () => {
    const guest = await signInAnonymous(app);
    populate(guest.id);
    db.run("CREATE TABLE zz_no_cascade (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL)");
    db.query("INSERT INTO zz_no_cascade (player_id) VALUES (?)").run(guest.id);
    const before = rowsOf(guest.id);
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await del(app, guest.cookie);

      expect(res.status).toBe(500);
      expect(res.headers.getSetCookie().filter((c) => /session_token=;/.test(c))).toEqual([]);
    } finally {
      quiet.mockRestore();
    }
    expect(rowsOf(guest.id)).toEqual(before);
    expect(authRows(guest.id)).toEqual({ users: 1, sessions: 1, accounts: 0 });
    expect((await me(app, guest.cookie)).status).not.toBe(401);
  });
});
