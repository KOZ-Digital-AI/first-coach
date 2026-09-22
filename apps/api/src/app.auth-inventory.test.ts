import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "./app";
import { loadSeed } from "./commons/seed-loader";
import { MIGRATIONS_DIR, migrate } from "./db/migrate";

// The complete API auth inventory (auth-gate spec §4.2, P4 — auth-gate-api): mounts createApp the
// EXACT way app.ts does — the real `Bun.Glob("*.routes.ts")` walk over the real routes directory, no
// stub modules, nothing left out — and asserts, with no session:
//   1. every /api/player, /api/contributions and /api/admin route answers 401;
//   2. every OTHER discovered route is exactly a literal public allowlist (written out below), so
//      adding a public route is a deliberate, reviewed edit to THIS file, not a silent side effect;
//   3. /api/media/:id, the one named exception that is neither 401-gated nor on the public allowlist
//      (auth.routes.ts's wildcard mount is the other), still answers 404 — never 200 — for an id
//      nobody could own.
//
// The route inventory itself is read off the live `Hono` instance's own `app.routes` (method + path,
// exactly as `mountRoutes` registered them), never retyped by hand: a new route module that lands
// unguarded shows up as a fourth, undeclared path and fails test 2 on the day it lands, whether or not
// anyone remembered to update a hand-written list.
const SEED_DIR = resolve(import.meta.dir, "../../../config/commons");
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

/** Everything a signed-out visitor may reach today (auth-gate spec §4's public-surface table). */
const PUBLIC_ALLOWLIST = [
  "GET /health",
  "GET /api/commons/drills",
  "GET /api/commons/drills/:slug",
  "GET /api/commons/skill-graph/:sport",
  "GET /api/commons/export.json",
  "GET /api/commons/schema.json",
  "GET /api/commons/stats",
  "GET /api/onboarding/:sport",
  "GET /api/contribute/meta",
  "GET /api/video/rubrics/:skillSlug",
] as const;

/**
 * Named exceptions (spec §4): neither on the public allowlist nor 401-gated by a Hono guard here.
 * `/api/auth/*` is Better Auth's own wildcard mount, proven separately by auth.routes.test.ts.
 * `/api/media/:attachmentId` decides per-attachment inside media.routes.ts, tested below.
 */
const NAMED_EXCEPTIONS = new Set(["GET /api/auth/*", "POST /api/auth/*", "GET /api/media/:attachmentId"]);

const GATED_PREFIX = /^\S+ \/api\/(player|contributions|admin)(\/|$)/;

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "auth-inventory-"));
  db = new Database(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  const deps: AppDeps = { db, version: "test" };
  // No routesDir argument: this is the SAME default (`http/routes`, the real one) that createApp
  // itself uses when app.ts calls it with none — the whole point of this file.
  app = await createApp(deps, undefined, { webDist: join(dir, "no-dist") });
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

// --- the live route table, read off the app itself, never hand-copied ------------------------------

/** `{ method, path }` filled with a placeholder for every `:param` segment, e.g. `/api/commons/drills/:slug`
 * -> `/api/commons/drills/x`. Good enough to reach the handler; no test here reads the response body. */
function fill(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "x");
}

/** Every concrete `METHOD path` the app answers, deduped, with the framework's own `/*` and `/api/*`
 * catch-alls (the 404 and the SPA fallback, never real routes) left out. */
function routeTable(instance: Hono): Set<string> {
  const keys = new Set<string>();
  for (const route of instance.routes) {
    if (route.method === "ALL") continue; // the notFound/SPA catch-alls, not a real endpoint
    keys.add(`${route.method} ${route.path}`);
  }
  return keys;
}

function partition(keys: Set<string>): { gated: string[]; other: string[] } {
  const gated: string[] = [];
  const other: string[] = [];
  for (const key of keys) {
    if (GATED_PREFIX.test(key)) gated.push(key);
    else if (!NAMED_EXCEPTIONS.has(key)) other.push(key);
  }
  return { gated, other };
}

async function requestNoSession(key: string): Promise<Response> {
  const [method, path] = key.split(" ", 2) as [string, string];
  return app.request(fill(path), { method });
}

describe("the whole API, mounted exactly as app.ts mounts it", () => {
  test("every /api/player route answers 401 with no session", async () => {
    const { gated } = partition(routeTable(app));
    const playerRoutes = gated.filter((key) => key.includes(" /api/player"));
    expect(playerRoutes.length).toBeGreaterThan(0); // the inventory itself must not be empty

    for (const key of playerRoutes) {
      const res = await requestNoSession(key);
      expect(res.status).toBe(401);
    }
  });

  test("every /api/contributions route answers 401 with no session", async () => {
    const { gated } = partition(routeTable(app));
    const contributionRoutes = gated.filter((key) => key.includes(" /api/contributions"));
    expect(contributionRoutes.length).toBeGreaterThan(0);

    for (const key of contributionRoutes) {
      const res = await requestNoSession(key);
      expect(res.status).toBe(401);
    }
  });

  test("every /api/admin route answers 401 with no session", async () => {
    const { gated } = partition(routeTable(app));
    const adminRoutes = gated.filter((key) => key.includes(" /api/admin"));
    expect(adminRoutes.length).toBeGreaterThan(0);

    for (const key of adminRoutes) {
      const res = await requestNoSession(key);
      expect(res.status).toBe(401);
    }
  });

  test("the routes that answer without a session are exactly the public allowlist (a new unguarded route fails here)", async () => {
    const { other } = partition(routeTable(app));

    expect(other.sort()).toEqual([...PUBLIC_ALLOWLIST].sort());

    for (const key of other) {
      const res = await requestNoSession(key);
      expect(res.status).not.toBe(401);
    }
  });

  test("/api/media/:id is a named exception and still answers 404 — never 200 — for a stranger's private attachment", async () => {
    const res = await app.request("/api/media/no-such-attachment-id");
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(200);
  });
});
