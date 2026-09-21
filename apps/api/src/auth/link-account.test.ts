import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import { loadSeed } from "../commons/seed-loader";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { ingestEvents } from "../player/events";
import type { PlayerProfile } from "../shared/domain";
import { ENDPOINTS as JOURNEY } from "../shared/journey";
import type { BaselineResult } from "../shared/onboarding";
import { ENDPOINTS as ONBOARDING } from "../shared/onboarding";
import type { SessionEvent } from "../shared/session";

// The anonymous() plugin's onLinkAccount (fc-mol-70i.12): a guest who signs up or signs in to a real
// (email) account keeps their progress. Every test runs the real createApp on a fresh in-memory database
// migrated with the real migrations and loaded with the REAL football seed, with the REAL Better Auth
// handler mounted next to GET /api/player/me and GET /api/player/journey. Guests and accounts are real
// cookies from /api/auth/* (anonymous sign-in, email sign-up, email sign-in); the guest's cookie rides on
// the sign-up / sign-in request exactly as the browser sends it. Nothing about a session is faked.
//
// Readings the criteria leave open, pinned here (each is also stated in link-account.ts):
//   * "Covered" (the schema-scan test) = every table with a player_id column other than player_profiles has a
//     foreign key player_id -> player_profiles(player_id) ON UPDATE CASCADE, so re-keying the profile
//     re-keys the table (005_sessions.sql header). Anything else is a table the re-key would forget.
//   * If the real account already has a player_profiles row nothing is merged and nothing is overwritten:
//     the account's rows are byte for byte what they were, and the guest's rows stay where they are.
//   * A failing hook must throw (Better Auth then answers 500, issues no cookie and does NOT delete the
//     anonymous user), and must leave both users' rows as they were; a retry then succeeds.

const SOURCE_DIR = resolve(import.meta.dir, "../http/routes");
const SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");
const ROUTE_FILES = ["player-start.routes.ts", "player-journey.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const ME = "/api/player/me";
const JOURNEY_PATH = JOURNEY.getJourney.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const NOW = new Date("2026-03-10T12:00:00.000Z");
const TODAY = "2026-03-10";
/** The player-owned tables the seeded data below must fill (the schema scan is a separate test). */
const KNOWN_TABLES = ["player_profiles", "test_results", "roadmaps", "sessions", "session_events"] as const;

// The module under test is imported lazily so a missing module fails its own tests, not the whole file.
const linkModule = () => import("./link-account");

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
  setSystemTime(NOW);
  seq = 0;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "link-account-"));
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

const post = (path: string, body: unknown, cookie?: string) =>
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

const signInAnonymous = async (): Promise<Actor> => actorOf(await post("/api/auth/sign-in/anonymous", {}));
const signUp = (email: string, cookie?: string) =>
  post("/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD }, cookie);
const signIn = (email: string, cookie?: string, password = PASSWORD) =>
  post("/api/auth/sign-in/email", { email, password }, cookie);

// --- player data ----------------------------------------------------------------------------------

const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const profileOf = (over: Partial<PlayerProfile> = {}): PlayerProfile => ({
  age: 12,
  level: "basic",
  goal: "dribbling",
  equipment: "ball",
  space: "yard",
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: "ru",
  ...over,
});

const baseline = (): BaselineResult[] => [
  { testSlug: "juggling-max-touches", value: 30, attempts: 3, clientUuid: uuid() },
  { testSlug: "wall-passing-60s", value: 20, clientUuid: uuid() },
  { testSlug: "ball-mastery-30s", value: 95, clientUuid: uuid() },
  { testSlug: "slalom-time", value: 9, errors: 1, clientUuid: uuid() },
  { testSlug: "weak-foot-passes", value: 4, clientUuid: uuid() },
];

/** POST /api/player/start for the actor: a profile, five baseline results and a roadmap. */
async function onboard(actor: Actor, profile: PlayerProfile = profileOf()): Promise<void> {
  const res = await app.request(ONBOARDING.start.path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: actor.cookie },
    body: JSON.stringify({ profile, baseline: baseline() }),
  });
  expect(res.status).toBe(200);
}

/** A session with two drill items, both done, and finished: rows in sessions and session_events. */
function trainOnce(playerId: string, sessionId: string): void {
  const versions = db
    .query(
      `SELECT d.current_version_id AS id FROM drills d
         JOIN drill_skills ds ON ds.drill_id = d.id AND ds.is_primary = 1
         JOIN skills s ON s.id = ds.skill_id WHERE s.slug = 'ball-mastery' ORDER BY d.slug LIMIT 2`,
    )
    .all() as Array<{ id: string }>;
  expect(versions).toHaveLength(2);
  const graphVersion = (db.query("SELECT graph_version FROM sports WHERE slug = 'football'").get() as { graph_version: string }).graph_version;
  const items = versions.map((v, i) => ({
    itemId: `i${i + 1}`,
    drillVersionId: v.id,
    minutes: 5,
    done: false,
    content: { goal: { en: "g" } },
  }));
  db.run("INSERT INTO sessions (id, player_id, date, planner, graph_version, items) VALUES (?, ?, ?, 'rules', ?, ?)", [
    sessionId,
    playerId,
    TODAY,
    graphVersion,
    JSON.stringify(items),
  ]);
  const at = NOW.toISOString();
  const events: SessionEvent[] = [
    { clientUuid: uuid(), sessionId, type: "drill_done", at, itemId: "i1" },
    { clientUuid: uuid(), sessionId, type: "drill_done", at, itemId: "i2" },
    { clientUuid: uuid(), sessionId, type: "session_finished", at },
  ];
  ingestEvents(db, playerId, events);
}

/** An anonymous player with a profile, results, a roadmap and one finished session. */
async function guestWithProgress(profile: PlayerProfile = profileOf(), sessionId = "guest-session"): Promise<Actor> {
  const guest = await signInAnonymous();
  await onboard(guest, profile);
  trainOnce(guest.id, sessionId);
  return guest;
}

/** Every row of the player-owned tables that carries this player id, in a stable order, as plain data. */
function dump(playerId: string): Record<string, unknown[]> {
  return Object.fromEntries(
    KNOWN_TABLES.map((table) => [table, db.query(`SELECT * FROM ${table} WHERE player_id = ? ORDER BY 1`).all(playerId)]),
  );
}

/** A dump with the player id blanked out, to compare one player's data with what it was under another id. */
const blank = (rows: Record<string, unknown[]>): Record<string, unknown[]> =>
  Object.fromEntries(Object.entries(rows).map(([table, list]) => [table, list.map((row) => ({ ...(row as object), player_id: "-" }))]));

const dumpWithoutOwner = (playerId: string): Record<string, unknown[]> => blank(dump(playerId));

const countsOf = (playerId: string): Record<string, number> =>
  Object.fromEntries(
    KNOWN_TABLES.map((table) => [
      table,
      (db.query(`SELECT count(*) AS n FROM ${table} WHERE player_id = ?`).get(playerId) as { n: number }).n,
    ]),
  );

const userExists = (id: string): boolean => (db.query('SELECT count(*) AS n FROM "user" WHERE id = ?').get(id) as { n: number }).n === 1;

// --- what the client reads --------------------------------------------------------------------------

const get = (path: string, cookie: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { cookie, ...headers } });

/** GET /api/player/me and GET /api/player/journey as the cookie's player sees them; both must be 200. */
async function seen(cookie: string): Promise<{ me: unknown; journey: unknown }> {
  const me = await get(ME, cookie);
  const journey = await get(JOURNEY_PATH, cookie);
  expect(me.status).toBe(200);
  expect(journey.status).toBe(200);
  return { me: await me.json(), journey: await journey.json() };
}

// --- the schema scan ---------------------------------------------------------------------------------

/** Every table of the database that has a column named player_id, scanned from the schema itself. */
function tablesWithPlayerId(handle: Database): string[] {
  return (
    handle
      .query(
        `SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) c
          WHERE m.type = 'table' AND c.name = 'player_id' ORDER BY m.name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** The tables with a player_id that re-keying player_profiles would NOT carry along. */
function uncoveredTables(handle: Database): string[] {
  return tablesWithPlayerId(handle).filter((table) => {
    if (table === "player_profiles") return false;
    const keys = handle.query(`SELECT * FROM pragma_foreign_key_list('${table}')`).all() as Array<{
      table: string;
      from: string;
      to: string;
      on_update: string;
    }>;
    return !keys.some(
      (key) => key.table === "player_profiles" && key.from === "player_id" && key.to === "player_id" && key.on_update === "CASCADE",
    );
  });
}

// =====================================================================================================
// (1) a guest who onboards, then signs up
// =====================================================================================================

describe("a guest signs up", () => {
  test("GET /api/player/me and /api/player/journey return the same profile and roadmap under the new account", async () => {
    const guest = await guestWithProgress();
    const bystander = await guestWithProgress(profileOf({ age: 15, locale: "kk" }), "bystander-session");
    for (const table of KNOWN_TABLES) expect(countsOf(guest.id)[table]).toBeGreaterThan(0); // every table has data to lose
    const before = await seen(guest.cookie);
    const guestRows = dumpWithoutOwner(guest.id);
    const bystanderRows = dump(bystander.id);

    const res = await signUp("new@example.com", guest.cookie);
    const account = await actorOf(res);

    expect(account.id).not.toBe(guest.id);
    expect(await seen(account.cookie)).toEqual(before);
    expect(dumpWithoutOwner(account.id)).toEqual(guestRows); // every row, each column, only the owner differs
    expect(dump(guest.id)).toEqual({ player_profiles: [], test_results: [], roadmaps: [], sessions: [], session_events: [] });
    expect(dump(bystander.id)).toEqual(bystanderRows); // nobody else is touched
  });

  test("the anonymous user is deleted after the re-key and its cookie no longer reads anything", async () => {
    const guest = await guestWithProgress();

    await actorOf(await signUp("gone@example.com", guest.cookie));

    expect(userExists(guest.id)).toBe(false);
    expect((await get(ME, guest.cookie)).status).toBe(401);
  });

  test("the session events keep their content: an append-only log survives the re-key", async () => {
    const guest = await guestWithProgress();
    const log = db.query("SELECT client_uuid, session_id, type, item_id, at, received_at FROM session_events ORDER BY id").all();
    expect(log).toHaveLength(3);

    const account = await actorOf(await signUp("log@example.com", guest.cookie));

    const after = db
      .query("SELECT client_uuid, session_id, type, item_id, at, received_at FROM session_events WHERE player_id = ? ORDER BY id")
      .all(account.id);
    expect(after).toEqual(log);
  });

  test("a guest who never onboarded signs up without error and the account has no player rows", async () => {
    const guest = await signInAnonymous();

    const account = await actorOf(await signUp("empty@example.com", guest.cookie));

    expect(countsOf(account.id)).toEqual({ player_profiles: 0, test_results: 0, roadmaps: 0, sessions: 0, session_events: 0 });
    expect((await get(ME, account.cookie)).status).toBe(404);
  });

  test("a sign-up with no guest cookie is an ordinary sign-up that touches no player data", async () => {
    const bystander = await guestWithProgress();
    const rows = dump(bystander.id);

    const account = await actorOf(await signUp("plain@example.com"));

    expect(countsOf(account.id).player_profiles).toBe(0);
    expect(dump(bystander.id)).toEqual(rows);
  });
});

// =====================================================================================================
// (2) a guest signs in to an existing account
// =====================================================================================================

describe("a guest signs in to an existing account", () => {
  test("an account that already has a profile keeps its own data and the guest's rows are left untouched", async () => {
    const account = await actorOf(await signUp("owner@example.com"));
    await onboard(account, profileOf({ age: 9, locale: "kk", minutesPerSession: 10 }));
    trainOnce(account.id, "account-session");
    const accountBefore = await seen(account.cookie);
    const accountRows = dump(account.id);
    const guest = await guestWithProgress(profileOf({ age: 13, locale: "en" }), "guest-session");
    const guestRows = dump(guest.id);

    const res = await signIn("owner@example.com", guest.cookie);
    const again = await actorOf(res);

    expect(again.id).toBe(account.id);
    expect(await seen(again.cookie)).toEqual(accountBefore);
    expect(dump(account.id)).toEqual(accountRows); // nothing merged, nothing overwritten
    expect(dump(guest.id)).toEqual(guestRows); // the guest's rows stay exactly where they were
    expect(userExists(guest.id)).toBe(false); // the plugin still cleans the anonymous user up
  });

  test("an existing account with no profile adopts the guest's progress", async () => {
    const account = await actorOf(await signUp("blank@example.com"));
    const guest = await guestWithProgress();
    const before = await seen(guest.cookie);
    const guestRows = dumpWithoutOwner(guest.id);

    const again = await actorOf(await signIn("blank@example.com", guest.cookie));

    expect(again.id).toBe(account.id);
    expect(await seen(again.cookie)).toEqual(before);
    expect(dumpWithoutOwner(account.id)).toEqual(guestRows);
    expect(countsOf(guest.id).player_profiles).toBe(0);
  });

  test("a wrong password links nothing and deletes nothing", async () => {
    await actorOf(await signUp("locked@example.com"));
    const guest = await guestWithProgress();
    const guestRows = dump(guest.id);

    const res = await signIn("locked@example.com", guest.cookie, "not-the-password");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(dump(guest.id)).toEqual(guestRows);
    expect(userExists(guest.id)).toBe(true);
    expect((await get(ME, guest.cookie)).status).toBe(200);
  });
});

// =====================================================================================================
// (3) rerun and idempotence
// =====================================================================================================

describe("rerun and idempotence", () => {
  test("linking the same pair again moves nothing and reports nothing to link", async () => {
    const { linkPlayerData } = await linkModule();
    const guest = await guestWithProgress();
    const account = await actorOf(await signUp("twice@example.com", guest.cookie));
    const rows = dump(account.id);

    const outcome = linkPlayerData(db, guest.id, account.id);

    expect(outcome.status).toBe("nothing-to-link");
    expect(dump(account.id)).toEqual(rows);
  });

  test("a fresh empty guest signing in to a linked account changes nothing", async () => {
    const guest = await guestWithProgress();
    const account = await actorOf(await signUp("linked@example.com", guest.cookie));
    const after = await seen(account.cookie);
    const rows = dump(account.id);
    const visitor = await signInAnonymous();

    const again = await actorOf(await signIn("linked@example.com", visitor.cookie));

    expect(await seen(again.cookie)).toEqual(after);
    expect(dump(account.id)).toEqual(rows);
  });

  test("a failed link loses nothing for either user, issues no session, and a retry then succeeds", async () => {
    const guest = await guestWithProgress();
    const before = await seen(guest.cookie);
    const guestRows = dump(guest.id);
    // The re-key updates roadmaps through ON UPDATE CASCADE; make that update fail.
    db.run("CREATE TRIGGER link_boom BEFORE UPDATE ON roadmaps BEGIN SELECT RAISE(ABORT, 'boom'); END");

    const failed = await signUp("retry@example.com", guest.cookie);

    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(failed.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(false);
    expect(dump(guest.id)).toEqual(guestRows); // rolled back as a whole: no half re-key
    expect(userExists(guest.id)).toBe(true); // the anonymous user is kept, so the data stays reachable
    expect(await seen(guest.cookie)).toEqual(before);
    const account = db.query('SELECT id FROM "user" WHERE email = ?').get("retry@example.com") as { id: string } | null;
    expect(account).not.toBeNull(); // the account itself exists: Better Auth created it before the hook ran
    expect(countsOf(account!.id).player_profiles).toBe(0);

    db.run("DROP TRIGGER link_boom");
    const retried = await actorOf(await signIn("retry@example.com", guest.cookie));

    expect(retried.id).toBe(account!.id);
    expect(await seen(retried.cookie)).toEqual(before);
    expect(dumpWithoutOwner(retried.id)).toEqual(blank(guestRows));
  });
});

// =====================================================================================================
// the handler and the re-key itself (real database, no Better Auth round trip)
// =====================================================================================================

describe("linkPlayerData", () => {
  const seedPlayer = (id: string, age = 12): void => {
    db.run(
      `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
       VALUES (?, ?, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, 'ru')`,
      [id, age],
    );
    db.run("INSERT INTO test_results (player_id, test_slug, value, recorded_at, client_uuid) VALUES (?, 'slalom-time', 9, ?, ?)", [
      id,
      NOW.toISOString(),
      uuid(),
    ]);
  };

  test("re-keys the guest's rows and reports how many rows moved per table, counts only", async () => {
    const { linkPlayerData } = await linkModule();
    seedPlayer("guest-1");

    const outcome = linkPlayerData(db, "guest-1", "account-1");

    expect(outcome).toEqual({ status: "linked", rows: expect.objectContaining({ player_profiles: 1, test_results: 1 }) });
    expect(countsOf("account-1")).toMatchObject({ player_profiles: 1, test_results: 1 });
    expect(countsOf("guest-1")).toMatchObject({ player_profiles: 0, test_results: 0 });
  });

  test("an account that already has a profile is reported as kept and nothing changes", async () => {
    const { linkPlayerData } = await linkModule();
    seedPlayer("guest-2", 13);
    seedPlayer("account-2", 9);
    const guestRows = dump("guest-2");
    const accountRows = dump("account-2");

    const outcome = linkPlayerData(db, "guest-2", "account-2");

    expect(outcome.status).toBe("account-kept");
    expect(dump("guest-2")).toEqual(guestRows);
    expect(dump("account-2")).toEqual(accountRows);
  });

  test("a guest with no profile has nothing to link", async () => {
    const { linkPlayerData } = await linkModule();
    seedPlayer("account-3");

    expect(linkPlayerData(db, "guest-3", "account-3").status).toBe("nothing-to-link");
    expect(countsOf("account-3").player_profiles).toBe(1);
  });

  test("linking a player to itself is a no-op", async () => {
    const { linkPlayerData } = await linkModule();
    seedPlayer("same-1");
    const rows = dump("same-1");

    expect(linkPlayerData(db, "same-1", "same-1").status).toBe("not-applicable");
    expect(dump("same-1")).toEqual(rows);
  });

  test("a table with a player_id that the re-key would forget makes the link fail and roll back", async () => {
    const { linkPlayerData } = await linkModule();
    db.run("CREATE TABLE player_notes (player_id TEXT NOT NULL, note TEXT NOT NULL) STRICT"); // no FK: a table nobody thought of
    seedPlayer("guest-4");
    db.run("INSERT INTO player_notes (player_id, note) VALUES ('guest-4', 'n')");
    const rows = dump("guest-4");

    expect(() => linkPlayerData(db, "guest-4", "account-4")).toThrow();

    expect(dump("guest-4")).toEqual(rows); // the profile is back under the guest
    expect(countsOf("account-4").player_profiles).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM player_notes WHERE player_id = 'guest-4'").get() as { n: number }).n).toBe(1);
  });

  test("a cascade that does not run (foreign keys off) fails closed instead of orphaning the children", async () => {
    const { linkPlayerData } = await linkModule();
    seedPlayer("guest-5");
    db.run("PRAGMA foreign_keys = OFF");
    try {
      expect(() => linkPlayerData(db, "guest-5", "account-5")).toThrow();
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }

    expect(countsOf("guest-5")).toMatchObject({ player_profiles: 1, test_results: 1 });
    expect(countsOf("account-5").player_profiles).toBe(0);
  });
});

describe("createLinkAccountHandler", () => {
  const input = (anonymousId: string, newId: string, over: { newAnonymous?: boolean } = {}) =>
    ({
      anonymousUser: { user: { id: anonymousId, isAnonymous: true, email: "temp-guest@anonymous.placeholder.invalid" }, session: { id: "s1" } },
      newUser: {
        user: { id: newId, isAnonymous: over.newAnonymous ?? false, email: "person@example.com", name: "Aidana" },
        session: { id: "s2" },
      },
      ctx: {},
    }) as never;

  const seedProfile = (id: string): void => {
    db.run(
      `INSERT INTO player_profiles (player_id, age, level, goal, equipment, space, partner, days_per_week, minutes_per_session, locale)
       VALUES (?, 12, 'basic', 'dribbling', 'cones', 'yard', 1, 3, 20, 'ru')`,
      [id],
    );
  };

  test("re-keys the anonymous user's profile to the new user and logs the outcome without any id, email or name", async () => {
    const { createLinkAccountHandler } = await linkModule();
    const logs: unknown[] = [];
    const handler = createLinkAccountHandler(db, (entry: unknown) => logs.push(entry));
    seedProfile("anon-id-123456");

    await handler(input("anon-id-123456", "real-id-654321"));

    expect(countsOf("real-id-654321").player_profiles).toBe(1);
    expect(countsOf("anon-id-123456").player_profiles).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "linked" });
    const text = JSON.stringify(logs);
    for (const secret of ["anon-id-123456", "real-id-654321", "person@example.com", "Aidana", "temp-guest"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("reports an account that already had a profile", async () => {
    const { createLinkAccountHandler } = await linkModule();
    const logs: Array<{ status: string }> = [];
    const handler = createLinkAccountHandler(db, (entry: { status: string }) => logs.push(entry));
    seedProfile("anon-x");
    seedProfile("real-x");

    await handler(input("anon-x", "real-x"));

    expect(logs.map((l) => l.status)).toEqual(["account-kept"]);
    expect(countsOf("anon-x").player_profiles).toBe(1);
  });

  test("does nothing when the new user is itself anonymous or is the same user", async () => {
    const { createLinkAccountHandler } = await linkModule();
    const handler = createLinkAccountHandler(db, () => {});
    seedProfile("anon-y");

    await handler(input("anon-y", "other-anon", { newAnonymous: true }));
    await handler(input("anon-y", "anon-y"));

    expect(countsOf("anon-y").player_profiles).toBe(1);
    expect(countsOf("other-anon").player_profiles).toBe(0);
  });

  test("lets a failure propagate (so Better Auth does not delete the anonymous user)", async () => {
    const { createLinkAccountHandler } = await linkModule();
    const handler = createLinkAccountHandler(db, () => {});
    db.run("CREATE TRIGGER handler_boom BEFORE UPDATE ON player_profiles BEGIN SELECT RAISE(ABORT, 'boom'); END");
    seedProfile("anon-z");

    await expect(Promise.resolve(handler(input("anon-z", "real-z")))).rejects.toThrow();

    expect(countsOf("anon-z").player_profiles).toBe(1);
  });
});

// =====================================================================================================
// (4) the schema scan
// =====================================================================================================

describe("schema scan", () => {
  test("every table with a player_id column is re-keyed by player_profiles through ON UPDATE CASCADE", () => {
    const scanned = tablesWithPlayerId(db);

    // Positive: the scan sees the tables the migrations create today.
    for (const table of KNOWN_TABLES) expect(scanned).toContain(table);
    // The property that matters: no table with a player_id is left out of the re-key.
    expect(uncoveredTables(db)).toEqual([]);
  });

  test("the scan reports a table that would be forgotten (a player_id with no cascading key)", () => {
    db.run("CREATE TABLE player_badges (player_id TEXT NOT NULL, badge TEXT NOT NULL) STRICT");
    db.run("CREATE TABLE player_notes (player_id TEXT NOT NULL REFERENCES player_profiles (player_id) ON DELETE CASCADE, note TEXT) STRICT");
    db.run("CREATE TABLE player_ok (player_id TEXT NOT NULL REFERENCES player_profiles (player_id) ON UPDATE CASCADE, note TEXT) STRICT");

    expect(uncoveredTables(db)).toEqual(["player_badges", "player_notes"]);
  });
});
