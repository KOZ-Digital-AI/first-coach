import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";

// The Better Auth wildcard mount (auth-gate spec §4, P4 — auth-gate-api): auth.routes.ts documents
// that /api/auth/* exposes both the public sign-in/sign-up surface AND the admin plugin's
// user-management sub-routes, guarded by Better Auth's own adminMiddleware + `adminRoles: ["admin"]`
// (better-auth.ts), never by a Hono middleware here. This file is the proof: it boots the REAL
// createApp with ONLY auth.routes.ts mounted (the surface under test needs nothing else) on a fresh
// in-memory database, and hits the admin sub-routes with no cookie, an anonymous session and a
// contributor session — each must be refused — and with an admin session, which must succeed, so a
// broken route (refusing everyone) cannot pass as a working gate.
//
// Readings pinned here:
//   * "refused" = 401 (no session at all, Better Auth's adminMiddleware) or 403 (a signed-in
//     non-admin, Better Auth's own permission check) — never 200, whichever it is.
//   * An anonymous player carries the role "contributor" (better-auth.ts's defaultRole applies to
//     everyone), so it is refused for the exact same reason a contributor account is: the role has no
//     admin permissions. The two are tested and asserted separately anyway, so a future change that
//     starts telling them apart is still covered.
//   * The four admin sub-routes probed are the ones the spec names: list-users (read), set-role,
//     ban-user, impersonate-user (the three that can act on another account). Real Better Auth request
//     bodies are sent even for the refusal cases (a fake but well-shaped userId) so a refusal is never
//     accidentally a schema 400 in disguise.

const SOURCE_DIR = resolve(import.meta.dir);
const ROUTE_FILES = ["auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

const LIST_USERS = "/api/auth/admin/list-users";
const SET_ROLE = "/api/auth/admin/set-role";
const BAN_USER = "/api/auth/admin/ban-user";
const IMPERSONATE_USER = "/api/auth/admin/impersonate-user";

let dir: string;
let db: Database;
let app: Hono;
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
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "auth-routes-"));
  db = new Database(":memory:"); // ensureAuthSchema (in register()) creates Better Auth's own tables
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

// --- real sessions, real requests (no mocks) ------------------------------------------------------

const signPost = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN },
    body: JSON.stringify(body),
  });

const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Actor = { cookie: string; id: string };

async function signInPlayer(): Promise<Actor> {
  const res = await signPost("/api/auth/sign-in/anonymous", {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

async function signUpContributor(email: string, name = "Coach"): Promise<Actor> {
  const res = await signPost("/api/auth/sign-up/email", { name, email, password: PASSWORD });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

async function signUpAdmin(email = "boss@example.com"): Promise<Actor> {
  const actor = await signUpContributor(email, "Boss Admin");
  db.run("UPDATE user SET role = 'admin' WHERE id = ?", [actor.id]);
  return actor;
}

// --- the admin sub-routes --------------------------------------------------------------------------

const withCookie = (cookie: string | undefined): Record<string, string> => (cookie ? { cookie } : {});

const getUsers = (cookie?: string) => app.request(LIST_USERS, { headers: withCookie(cookie) });

const postAdmin = (path: string, cookie: string | undefined, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...withCookie(cookie) },
    body: JSON.stringify(body),
  });

const setRole = (cookie: string | undefined, userId = "does-not-exist") =>
  postAdmin(SET_ROLE, cookie, { userId, role: "admin" });
const banUser = (cookie: string | undefined, userId = "does-not-exist") => postAdmin(BAN_USER, cookie, { userId });
const impersonateUser = (cookie: string | undefined, userId = "does-not-exist") =>
  postAdmin(IMPERSONATE_USER, cookie, { userId });

async function allFour(cookie: string | undefined): Promise<number[]> {
  const [list, role, ban, impersonate] = await Promise.all([
    getUsers(cookie),
    setRole(cookie),
    banUser(cookie),
    impersonateUser(cookie),
  ]);
  return [list.status, role.status, ban.status, impersonate.status];
}

describe("Better Auth admin sub-routes, no Hono guard but never open", () => {
  test("no session: every admin sub-route is refused (401/403), never 200", async () => {
    const statuses = await allFour(undefined);
    for (const status of statuses) {
      expect(status).toBe(401); // Better Auth's adminMiddleware: no session at all
      expect(status).not.toBe(200);
    }
  });

  test("an anonymous player cannot list, ban, impersonate or promote users", async () => {
    const player = await signInPlayer();
    const statuses = await allFour(player.cookie);
    for (const status of statuses) {
      expect([401, 403]).toContain(status);
      expect(status).not.toBe(200);
    }
  });

  test("a contributor account cannot list, ban, impersonate or promote users", async () => {
    const contributor = await signUpContributor("contrib@example.com");
    const statuses = await allFour(contributor.cookie);
    for (const status of statuses) {
      expect([401, 403]).toContain(status);
      expect(status).not.toBe(200);
    }
  });

  test("an admin account can list users — the refusals above are a real gate, not a broken route", async () => {
    const admin = await signUpAdmin();
    const res = await getUsers(admin.cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[]; total: number };
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1); // at least the admin itself
  });

  test("sign-in, sign-up, anonymous sign-in and get-session stay reachable with no session", async () => {
    const signUp = await signPost("/api/auth/sign-up/email", {
      name: "Coach",
      email: "reachable@example.com",
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);

    const signIn = await signPost("/api/auth/sign-in/email", { email: "reachable@example.com", password: PASSWORD });
    expect(signIn.status).toBe(200);

    const anon = await signPost("/api/auth/sign-in/anonymous", {});
    expect(anon.status).toBe(200);

    const session = await app.request("/api/auth/get-session");
    expect(session.status).toBe(200);
  });
});
