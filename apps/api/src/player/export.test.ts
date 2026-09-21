import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { PROBLEM_CONTENT_TYPE } from "../shared/primitives";
import { buildPlayerExport } from "./export";

// fc-mol-bjm.4: GET /api/player/export, the player's data as a JSON attachment.
//
// Two layers, both on real migrated in-memory databases (nothing is mocked):
//   * buildPlayerExport(db, playerId): the document. Tables are DISCOVERED from the schema (every table with a
//     player_id column), so a table that a later slice adds is exported without a code change: the tests add one
//     with plain DDL. Another player's rows never appear; secrets (hashes, tokens) never appear.
//   * the route, through the real createApp with the real Better Auth handler and real anonymous sign-ins: the
//     guard (401 without a session; anonymous players allowed), the attachment headers, that the player is the
//     session's and nothing in the request can name another one.
//
// Assertions are positive properties and specific forbidden things (an unrelated table, hash or token in the
// output); they never pin the exact set of tables, which other slices extend.

type Cell = string | number | Uint8Array | null;
type Row = Record<string, unknown>;

const T0 = "2026-01-05T10:00:00.000Z";
const T1 = "2026-01-06T10:00:00.000Z";
const NOW = new Date("2026-02-03T04:05:06.789Z");
const ME = "player-me";
const OTHER = "player-other";
const MY_HASH = "a".repeat(63) + "1";
const OTHER_HASH = "b".repeat(63) + "2";

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// --- rows ------------------------------------------------------------------------------------------

function insertRow(db: Database, table: string, row: Record<string, Cell>): void {
  const columns = Object.keys(row);
  db.query(`INSERT INTO "${table}" (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

function addPlayer(db: Database, playerId: string, marker: string): void {
  insertRow(db, "player_profiles", {
    player_id: playerId,
    age: 12,
    level: "basic",
    goal: "dribbling",
    equipment: marker,
    space: "yard",
    partner: 1,
    days_per_week: 3,
    minutes_per_session: 20,
    locale: "ru",
    created_at: T0,
    updated_at: T0,
  });
  insertRow(db, "test_results", { player_id: playerId, test_slug: `${marker}-test-a`, value: 12.5, recorded_at: T0, client_uuid: uuid(marker.length * 100 + 1) });
  insertRow(db, "test_results", { player_id: playerId, test_slug: `${marker}-test-b`, value: 7, recorded_at: T1, client_uuid: uuid(marker.length * 100 + 2) });
  insertRow(db, "roadmaps", { player_id: playerId, json: JSON.stringify({ note: `${marker}-roadmap` }), graph_version: "1.0.0", created_at: T0 });
  insertRow(db, "sessions", { id: `${marker}-session`, player_id: playerId, date: "2026-01-05", planner: "rules", graph_version: "1.0.0", items: JSON.stringify([{ itemId: `${marker}-item` }]) });
  insertRow(db, "session_events", { player_id: playerId, session_id: `${marker}-session`, client_uuid: uuid(marker.length * 100 + 3), type: "drill_done", item_id: `${marker}-item`, at: T0 });
  insertRow(db, "consents", { player_id: playerId, kind: "videoAnalysis", granted: 1, guardian_confirmed: 1, changed_at: T0 });
  insertRow(db, "consents", { player_id: playerId, kind: "videoAnalysis", granted: 0, changed_at: T1 });
}

const addRecoveryCode = (db: Database, playerId: string, hash: string): void =>
  insertRow(db, "recovery_codes", { player_id: playerId, code_hash: hash, created_at: T0, last_used_at: T1 });

function migrated(): Database {
  const db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  return db;
}

const tablesOf = (doc: Record<string, unknown>): Record<string, Row[]> => doc.tables as Record<string, Row[]>;
const sectionsOf = (doc: Record<string, unknown>): Record<string, string> => (doc.readme as { sections: Record<string, string> }).sections;
const text = (doc: unknown): string => JSON.stringify(doc);

// --- the document ----------------------------------------------------------------------------------

describe("buildPlayerExport", () => {
  let db: Database;
  beforeEach(() => {
    db = migrated();
    addPlayer(db, ME, "mine");
    addPlayer(db, OTHER, "theirs");
    addRecoveryCode(db, ME, MY_HASH);
    addRecoveryCode(db, OTHER, OTHER_HASH);
  });
  afterEach(() => db.close());

  test("carries the player id and the export time it was given", () => {
    const doc = buildPlayerExport(db, ME, NOW);
    expect(doc.playerId).toBe(ME);
    expect(doc.exportedAt).toBe("2026-02-03T04:05:06.789Z");
  });

  test("includes the player's rows of every player-owned table of the migrations", () => {
    const tables = tablesOf(buildPlayerExport(db, ME, NOW));
    expect(tables.player_profiles?.map((r) => r.equipment)).toEqual(["mine"]);
    expect(tables.test_results?.map((r) => r.test_slug)).toEqual(["mine-test-a", "mine-test-b"]);
    expect(tables.roadmaps?.map((r) => r.json)).toEqual([JSON.stringify({ note: "mine-roadmap" })]);
    expect(tables.sessions?.map((r) => r.id)).toEqual(["mine-session"]);
    expect(tables.session_events?.map((r) => r.item_id)).toEqual(["mine-item"]);
    expect(tables.consents?.map((r) => [r.granted, r.changed_at])).toEqual([[1, T0], [0, T1]]);
    expect(tables.recovery_codes?.map((r) => r.player_id)).toEqual([ME]);
  });

  test("a table added later with a player_id column appears, with the player's rows only", () => {
    db.run("CREATE TABLE later_slice (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, note TEXT NOT NULL)");
    insertRow(db, "later_slice", { player_id: ME, note: "later-mine-1" });
    insertRow(db, "later_slice", { player_id: OTHER, note: "later-theirs" });
    insertRow(db, "later_slice", { player_id: ME, note: "later-mine-2" });
    const doc = buildPlayerExport(db, ME, NOW);
    expect(tablesOf(doc).later_slice?.map((r) => r.note)).toEqual(["later-mine-1", "later-mine-2"]);
    expect(text(doc)).not.toContain("later-theirs");
  });

  test("a table added later without a player_id column is not exported", () => {
    db.run("CREATE TABLE unrelated_facts (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)");
    insertRow(db, "unrelated_facts", { id: 1, fact: "unrelated-fact-marker" });
    const doc = buildPlayerExport(db, ME, NOW);
    expect(tablesOf(doc).unrelated_facts).toBeUndefined();
    expect(text(doc)).not.toContain("unrelated-fact-marker");
  });

  test("another player's rows never appear, in any table", () => {
    const doc = buildPlayerExport(db, ME, NOW);
    for (const rows of Object.values(tablesOf(doc))) {
      for (const row of rows) if ("player_id" in row) expect(row.player_id).toBe(ME);
    }
    const out = text(doc);
    expect(out).not.toContain("theirs");
    expect(out).not.toContain(OTHER);
  });

  test("a table with a player_id column but no rows of the player is present and empty", () => {
    db.run("CREATE TABLE later_empty (player_id TEXT NOT NULL, note TEXT)");
    insertRow(db, "later_empty", { player_id: OTHER, note: "x" });
    expect(tablesOf(buildPlayerExport(db, ME, NOW)).later_empty).toEqual([]);
  });

  test("a player who never onboarded gets a valid document with empty sections", () => {
    const doc = buildPlayerExport(db, "player-new", NOW);
    expect(doc.playerId).toBe("player-new");
    expect(tablesOf(doc).player_profiles).toEqual([]);
    expect(tablesOf(doc).test_results).toEqual([]);
    expect(text(doc)).not.toContain("mine-");
    expect(text(doc)).not.toContain("theirs-");
  });

  test("the recovery code hash is never exported; the rest of the row is", () => {
    const doc = buildPlayerExport(db, ME, NOW);
    const [row] = tablesOf(doc).recovery_codes ?? [];
    expect(row).toEqual({ player_id: ME, created_at: T0, last_used_at: T1 });
    const out = text(doc);
    expect(out).not.toContain(MY_HASH);
    expect(out).not.toContain(OTHER_HASH);
    expect(out).not.toContain("code_hash");
  });

  test("secret-looking columns of a table added later (hash, token, secret, password) are dropped, the others kept", () => {
    db.run("CREATE TABLE later_keys (player_id TEXT NOT NULL, label TEXT, api_token TEXT, pass_hash TEXT, client_secret TEXT, password TEXT)");
    insertRow(db, "later_keys", { player_id: ME, label: "kept", api_token: "tok-1", pass_hash: "hash-1", client_secret: "sec-1", password: "pw-1" });
    const doc = buildPlayerExport(db, ME, NOW);
    expect(tablesOf(doc).later_keys).toEqual([{ player_id: ME, label: "kept" }]);
    for (const secret of ["tok-1", "hash-1", "sec-1", "pw-1"]) expect(text(doc)).not.toContain(secret);
  });

  test("a table name that needs quoting is exported safely", () => {
    db.run(`CREATE TABLE "odd ""name""" (player_id TEXT NOT NULL, note TEXT)`);
    insertRow(db, `odd "name"`.replaceAll('"', '""'), { player_id: ME, note: "odd-mine" });
    insertRow(db, `odd "name"`.replaceAll('"', '""'), { player_id: OTHER, note: "odd-theirs" });
    const doc = buildPlayerExport(db, ME, NOW);
    expect(tablesOf(doc)[`odd "name"`]?.map((r) => r.note)).toEqual(["odd-mine"]);
  });

  test("a BLOB column is exported as base64 text, so the document is plain JSON", () => {
    db.run("CREATE TABLE later_blob (player_id TEXT NOT NULL, data BLOB)");
    insertRow(db, "later_blob", { player_id: ME, data: new Uint8Array([1, 2, 3]) });
    const parsed = JSON.parse(text(buildPlayerExport(db, ME, NOW))) as { tables: Record<string, Row[]> };
    expect(parsed.tables.later_blob).toEqual([{ player_id: ME, data: "AQID" }]);
  });

  test("a WITHOUT ROWID table is exported too", () => {
    db.run("CREATE TABLE later_norowid (player_id TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (player_id, k)) WITHOUT ROWID");
    insertRow(db, "later_norowid", { player_id: ME, k: "b" });
    insertRow(db, "later_norowid", { player_id: ME, k: "a" });
    insertRow(db, "later_norowid", { player_id: OTHER, k: "c" });
    expect(tablesOf(buildPlayerExport(db, ME, NOW)).later_norowid?.map((r) => r.k)).toEqual(["a", "b"]);
  });

  test("contributions the player submitted are included (submitter_user_id), without other users' and without file paths", () => {
    const contribution = (id: string, submitter: string): Record<string, Cell> => ({
      id,
      kind: "new",
      payload: JSON.stringify({ title: `${id}-title` }),
      submitter_user_id: submitter,
      content_hash: "c".repeat(64),
      created_at: T0,
      updated_at: T0,
    });
    insertRow(db, "contributions", contribution("c-mine", ME));
    insertRow(db, "contributions", contribution("c-theirs", OTHER));
    const attachment = (id: string, contributionId: string): Record<string, Cell> => ({
      id,
      contribution_id: contributionId,
      kind: "image",
      stored_path: `uploads/${id}.png`,
      mime: "image/png",
      bytes: 10,
      original_name: `${id}.png`,
      created_at: T0,
    });
    insertRow(db, "contribution_attachments", attachment("a-mine", "c-mine"));
    insertRow(db, "contribution_attachments", attachment("a-theirs", "c-theirs"));

    const doc = buildPlayerExport(db, ME, NOW);
    expect(tablesOf(doc).contributions?.map((r) => r.id)).toEqual(["c-mine"]);
    expect(tablesOf(doc).contribution_attachments?.map((r) => r.id)).toEqual(["a-mine"]);
    const out = text(doc);
    expect(out).not.toContain("theirs");
    expect(out).not.toContain("uploads/");
    expect(out).not.toContain("stored_path");
  });

  describe("README", () => {
    test("is a short text plus one explanation for every exported section, tables added later included", () => {
      db.run("CREATE TABLE later_slice (player_id TEXT NOT NULL, note TEXT)");
      const doc = buildPlayerExport(db, ME, NOW);
      const readme = doc.readme as { about: string };
      expect(typeof readme.about).toBe("string");
      expect(readme.about.length).toBeGreaterThan(20);
      const sections = sectionsOf(doc);
      const names = Object.keys(tablesOf(doc));
      expect(names).toContain("later_slice");
      for (const name of names) {
        expect(typeof sections[name]).toBe("string");
        expect(sections[name]?.trim().length).toBeGreaterThan(10);
      }
    });

    test("says that the recovery code hash is left out", () => {
      expect(sectionsOf(buildPlayerExport(db, ME, NOW)).recovery_codes).toMatch(/hash/i);
    });

    test("describes the known sections in their own words, not with the generic text of a table added later", () => {
      db.run("CREATE TABLE later_slice (player_id TEXT NOT NULL, note TEXT)");
      const sections = sectionsOf(buildPlayerExport(db, ME, NOW));
      expect(sections.player_profiles).not.toBe(sections.later_slice);
      expect(sections.test_results).not.toBe(sections.later_slice);
      expect(sections.later_slice).toContain("later_slice");
    });
  });
});

// --- the route -------------------------------------------------------------------------------------

const SOURCE_DIR = resolve(import.meta.dir, "../http/routes");
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const PATH = "/api/player/export";

describe("GET /api/player/export", () => {
  let dir: string;
  let db: Database;
  let app: Hono;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), "player-export-routes-"));
    db = migrated();
    const routesDir = join(dir, "routes");
    mkdirSync(routesDir, { recursive: true });
    for (const file of ["player-export.routes.ts", "auth.routes.ts"]) {
      writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(SOURCE_DIR, file))};\n`);
    }
    const deps: AppDeps = { db, version: "test" };
    app = await createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const cookieOf = (res: Response): string =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  async function signIn(): Promise<{ cookie: string; id: string; token: string }> {
    const res = await app.request("/api/auth/sign-in/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json", origin: DEV_ORIGIN },
      body: "{}",
    });
    const body = (await res.json()) as { token: string; user: { id: string } };
    return { cookie: cookieOf(res), id: body.user.id, token: body.token };
  }

  test("no session is a 401 problem, never cached, and nothing is exported", async () => {
    const res = await app.request(PATH);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  test("an anonymous player gets their data as a JSON attachment, never cached", async () => {
    const me = await signIn();
    addPlayer(db, me.id, "mine");
    const res = await app.request(PATH, { headers: { cookie: me.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="[^"]+\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.playerId).toBe(me.id);
    const tables = tablesOf(body);
    expect(tables.player_profiles?.map((r) => r.equipment)).toEqual(["mine"]);
    expect(tables.test_results?.length).toBe(2);
    expect(tables.session_events?.length).toBe(1);
    expect(sectionsOf(body).player_profiles).toBeTruthy();
  });

  test("the player is the session's: another player's rows, a playerId in the query and the session token are never in the body", async () => {
    const me = await signIn();
    const other = await signIn();
    addPlayer(db, me.id, "mine");
    addPlayer(db, other.id, "theirs");
    addRecoveryCode(db, me.id, MY_HASH);
    addRecoveryCode(db, other.id, OTHER_HASH);

    const res = await app.request(`${PATH}?playerId=${encodeURIComponent(other.id)}&player_id=${encodeURIComponent(other.id)}`, {
      headers: { cookie: me.cookie, "x-player-id": other.id },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect((JSON.parse(raw) as { playerId: string }).playerId).toBe(me.id);
    expect(raw).toContain("mine");
    for (const forbidden of ["theirs", other.id, other.token, me.token, MY_HASH, OTHER_HASH]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  test("a signed-in player who never onboarded still gets a valid document", async () => {
    const me = await signIn();
    const res = await app.request(PATH, { headers: { cookie: me.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.playerId).toBe(me.id);
    expect(tablesOf(body).player_profiles).toEqual([]);
  });
});
