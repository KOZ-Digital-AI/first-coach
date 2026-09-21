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
import { CommonsStats, ENDPOINTS } from "../../shared/stats";

// Every test runs the real createApp on a fresh in-memory database migrated with the real
// migrations. The seeded tests load the REAL seed (config/commons), so the numbers asserted
// below are what the landing stat strip really shows, not fixtures.

const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILE = resolve(import.meta.dir, "commons-stats.routes.ts");
const PATH = ENDPOINTS.getStats.path;

/** What the real seed yields: 60 drills in 5 tracks, no contributions yet, one sport (football). */
const SEEDED = { drills: 60, tracks: 5, contributions: 0, sports: 1 };
const EMPTY = { drills: 0, tracks: 0, contributions: 0, sports: 0 };

let dir: string;
let db: Database;
let app: Hono;

/**
 * A real createApp that mounts ONLY the stats route module (through a one-line re-export in a
 * temp routes dir), so the app's real 404 handling, `/api/*` guard and static mount are in play
 * without depending on any sibling route module.
 */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  writeFileSync(
    join(routesDir, "commons-stats.routes.ts"),
    `export { register } from ${JSON.stringify(ROUTE_FILE)};\n`,
  );
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

const get = (): Promise<Response> => app.request(PATH);

/** Every table's rows, so "the DB is unchanged" compares the whole database, not a count. */
function snapshot(): Record<string, unknown[]> {
  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "commons-stats-routes-"));
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
});

describe("GET /api/commons/stats on the real seed", () => {
  beforeEach(async () => {
    loadSeed(db, SEED_DIR);
    app = await buildApp();
  });

  test("answers 200 with exactly the seed's drills, tracks, contributions and sports", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SEEDED);
  });

  test("the body parses with the shared CommonsStats schema", async () => {
    const parsed = CommonsStats.safeParse(await (await get()).json());

    expect(parsed.success).toBe(true);
  });

  test("the body has exactly the four keys and nothing else", async () => {
    const body = (await (await get()).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["contributions", "drills", "sports", "tracks"]);
  });

  test("responds with an application/json content type", async () => {
    const res = await get();

    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("is public: answers without any cookie or authorization header", async () => {
    const res = await app.request(PATH, { headers: {} });

    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  test("reading the stats does not change the database", async () => {
    const before = snapshot();

    await get();
    await get();

    expect(snapshot()).toEqual(before);
  });

  test("an unpublished drill drops out of drills and nothing else changes", async () => {
    const victim = db.query<{ id: string }, []>(`SELECT id FROM drills ORDER BY slug LIMIT 1`).get();
    db.query(`UPDATE drills SET unpublished_at = '2026-09-21T00:00:00.000Z' WHERE id = ?`).run(victim?.id ?? "");

    const body = await (await get()).json();

    expect(body).toEqual({ ...SEEDED, drills: SEEDED.drills - 1 });
    expect(db.query<{ n: number }, []>(`SELECT count(*) AS n FROM drills`).get()?.n).toBe(60);
    expect(db.query<{ n: number }, []>(`SELECT count(*) AS n FROM drill_versions`).get()?.n).toBe(60);
  });

  test("a contributed version of a published drill counts as a contribution", async () => {
    const original = db
      .query<{ id: string; drill_id: string }, []>(
        `SELECT v.id, v.drill_id FROM drill_versions v JOIN drills d ON d.id = v.drill_id ORDER BY d.slug LIMIT 1`,
      )
      .get();
    db.query(
      `INSERT INTO drill_versions (id, drill_id, semver, parent_version_id, status, content, equipment, space,
         partner, age_min, age_max, level, minutes, license, author_name, source, origin)
       SELECT 'contrib-1', drill_id, '9.9.9', id, 'COMMUNITY', content, equipment, space,
         partner, age_min, age_max, level, minutes, license, author_name, source, 'contribution'
       FROM drill_versions WHERE id = ?`,
    ).run(original?.id ?? "");

    const body = await (await get()).json();

    expect(body).toEqual({ ...SEEDED, contributions: 1 });
  });
});

describe("GET /api/commons/stats before any seeding", () => {
  test("an empty migrated database answers 200 with all zeros", async () => {
    app = await buildApp();

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY);
  });
});

describe("other methods on /api/commons/stats", () => {
  beforeEach(async () => {
    loadSeed(db, SEED_DIR);
    app = await buildApp();
  });

  test("POST is not served: the app's default not-found answer, never a 200", async () => {
    const res = await app.request(PATH, { method: "POST" });

    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
});
