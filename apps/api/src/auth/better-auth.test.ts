import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { migrate } from "../db/migrate";
import { createAuth, ensureAuthSchema, getAuth, getSession, resolveAuthConfig } from "./better-auth";

const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PROD_ORIGIN = "https://coach.example";
const SECRET = "s".repeat(40);
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

let dir: string;
let db: Database;
let deps: AppDeps;
let app: Hono;
const opened: Database[] = [];
const savedEnv: Record<string, string | undefined> = {};

const open = (path: string): Database => {
  const handle = openDatabase(path);
  opened.push(handle);
  return handle;
};

const bootApp = (handle: Database): Promise<Hono> =>
  createApp({ db: handle, version: "test" }, undefined, { webDist: join(dir, "no-dist") });

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "better-auth-"));
  db = open(join(dir, "auth.db"));
  migrate(db, join(dir, "no-migrations")); // the app's own runner has already run at boot
  deps = { db, version: "test" };
  app = await createApp(deps, undefined, { webDist: join(dir, "no-dist") });
});

afterEach(() => {
  for (const handle of opened.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const post = (
  path: string,
  body: unknown,
  cookie?: string,
  extra: Record<string, string> = {},
): Response | Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: DEV_ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });

/** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const signUp = (email: string, extra: Record<string, unknown> = {}) =>
  post("/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD, ...extra });

const userIdOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { user: { id: string } }).user.id;

const roleOf = (email: string): string | undefined =>
  (db.query("SELECT role FROM user WHERE email = ?").get(email) as { role: string } | null)?.role;

/** A standalone Auth on its own in-memory DB, for config that must differ from the env-driven app. */
async function standalone(production: boolean) {
  const handle = open(":memory:");
  const origin = production ? PROD_ORIGIN : DEV_ORIGIN;
  const auth = createAuth({ db: handle, secret: SECRET, baseURL: origin, production });
  await ensureAuthSchema(auth, handle);
  const call = (path: string, init: { ip?: string; body?: unknown } = {}) =>
    auth.handler(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          ...(init.ip ? { "x-forwarded-for": init.ip } : {}),
        },
        body: JSON.stringify(init.body ?? {}),
      }),
    );
  return { auth, handle, call };
}

describe("anonymous players", () => {
  test("sign-in yields a session cookie and a user flagged anonymous", async () => {
    const res = await post("/api/auth/sign-in/anonymous", {});

    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    const body = (await res.json()) as { user: { id: string; isAnonymous: boolean } };
    expect(body.user.isAnonymous).toBe(true);
    const row = db.query("SELECT isAnonymous FROM user WHERE id = ?").get(body.user.id) as {
      isAnonymous: number;
    };
    expect(row.isAnonymous).toBe(1);
  });

  test("a second cookieless anonymous sign-in is a different user", async () => {
    const first = await userIdOf(await post("/api/auth/sign-in/anonymous", {}));
    const second = await userIdOf(await post("/api/auth/sign-in/anonymous", {}));

    expect(second).not.toBe(first);
  });

  test("the session cookie resolves through getSession; no cookie resolves to null", async () => {
    const res = await post("/api/auth/sign-in/anonymous", {});

    const session = await getSession(getAuth(deps), new Headers({ cookie: cookieOf(res) }));

    expect(session?.user.isAnonymous).toBe(true);
    expect(await getSession(getAuth(deps), new Headers())).toBeNull();
  });

  test("a player session lasts 90 days so progress survives a long holiday", async () => {
    const res = await post("/api/auth/sign-in/anonymous", {});
    const userId = await userIdOf(res);

    const row = db.query("SELECT expiresAt FROM session WHERE userId = ?").get(userId) as {
      expiresAt: number | string;
    };

    const days = (new Date(row.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
  });
});

describe("contributors", () => {
  test("email sign-up yields role contributor and a session, with no verification step", async () => {
    const res = await signUp("c@example.com");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string; emailVerified: boolean } };
    expect(body.user.role).toBe("contributor");
    expect(roleOf("c@example.com")).toBe("contributor");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(true);
    const pending = db.query("SELECT count(*) AS n FROM verification").get() as { n: number };
    expect(pending.n).toBe(0);
  });

  test("no mail transport is configured and verification is not required", () => {
    const options = getAuth(deps).options as unknown as {
      emailVerification?: { sendVerificationEmail?: unknown };
      emailAndPassword?: { sendResetPassword?: unknown; requireEmailVerification?: boolean };
    };

    expect(options.emailVerification?.sendVerificationEmail).toBeUndefined();
    expect(options.emailAndPassword?.sendResetPassword).toBeUndefined();
    expect(options.emailAndPassword?.requireEmailVerification).toBe(false);
  });

  test("email + password sign-in works and a wrong password is refused", async () => {
    await signUp("in@example.com");

    const ok = await post("/api/auth/sign-in/email", { email: "in@example.com", password: PASSWORD });
    const bad = await post("/api/auth/sign-in/email", {
      email: "in@example.com",
      password: "wrong-password-xx",
    });

    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token="))).toBe(true);
    expect(bad.status).toBe(401);
    expect(bad.headers.getSetCookie()).toEqual([]);
  });

  test("sign-up cannot choose its own role", async () => {
    const res = await signUp("sneaky@example.com", { role: "admin" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("FIELD_NOT_ALLOWED");
    expect(roleOf("sneaky@example.com")).toBeUndefined(); // no user was created at all
  });

  test("a contributor cannot promote themselves through admin/set-role", async () => {
    const up = await signUp("self@example.com");
    const userId = await userIdOf(up.clone());

    const res = await post("/api/auth/admin/set-role", { userId, role: "admin" }, cookieOf(up));

    expect(res.status).toBe(403);
    expect(roleOf("self@example.com")).toBe("contributor");
  });

  test("a contributor cannot promote themselves through update-user", async () => {
    const up = await signUp("upd@example.com");

    await post("/api/auth/update-user", { name: "x", role: "admin" }, cookieOf(up));

    expect(roleOf("upd@example.com")).toBe("contributor");
  });

  test("an anonymous player cannot use admin endpoints", async () => {
    const anon = await post("/api/auth/sign-in/anonymous", {});
    const userId = await userIdOf(anon.clone());

    const res = await post("/api/auth/admin/set-role", { userId, role: "admin" }, cookieOf(anon));

    expect(res.status).toBe(403);
  });

  test("an admin can set a role, but only contributor or admin", async () => {
    await signUp("boss@example.com");
    db.run("UPDATE user SET role = 'admin' WHERE email = 'boss@example.com'"); // bootstrap is out-of-band
    const login = await post("/api/auth/sign-in/email", { email: "boss@example.com", password: PASSWORD });
    const target = await userIdOf(await signUp("t@example.com"));

    const bad = await post("/api/auth/admin/set-role", { userId: target, role: "superuser" }, cookieOf(login));
    const ok = await post("/api/auth/admin/set-role", { userId: target, role: "admin" }, cookieOf(login));

    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(ok.status).toBe(200);
    expect(roleOf("t@example.com")).toBe("admin");
  });
});

describe("admin endpoints are closed to everyone but an admin", () => {
  type Probe = { method: "GET" | "POST"; path: string; body: (victim: string, token: string) => unknown };
  const probes: Probe[] = [
    { method: "POST", path: "/api/auth/admin/set-role", body: (userId) => ({ userId, role: "admin" }) },
    { method: "GET", path: "/api/auth/admin/list-users", body: () => undefined },
    { method: "GET", path: "/api/auth/admin/get-user", body: () => undefined },
    {
      method: "POST",
      path: "/api/auth/admin/create-user",
      body: () => ({ email: "made@example.com", password: PASSWORD, name: "Made", role: "admin" }),
    },
    { method: "POST", path: "/api/auth/admin/update-user", body: (userId) => ({ userId, data: { name: "x" } }) },
    { method: "POST", path: "/api/auth/admin/ban-user", body: (userId) => ({ userId }) },
    { method: "POST", path: "/api/auth/admin/unban-user", body: (userId) => ({ userId }) },
    { method: "POST", path: "/api/auth/admin/impersonate-user", body: (userId) => ({ userId }) },
    { method: "POST", path: "/api/auth/admin/remove-user", body: (userId) => ({ userId }) },
    {
      method: "POST",
      path: "/api/auth/admin/set-user-password",
      body: (userId) => ({ userId, newPassword: "brand-new-password-1" }),
    },
    { method: "POST", path: "/api/auth/admin/list-user-sessions", body: (userId) => ({ userId }) },
    { method: "POST", path: "/api/auth/admin/revoke-user-session", body: (_u, sessionToken) => ({ sessionToken }) },
    { method: "POST", path: "/api/auth/admin/revoke-user-sessions", body: (userId) => ({ userId }) },
  ];

  test("every admin endpoint answers 401/403 to a contributor, an anonymous player and no cookie", async () => {
    const contributor = cookieOf(await signUp("contrib@example.com"));
    const player = cookieOf(await post("/api/auth/sign-in/anonymous", {}));
    const victimRes = await signUp("victim@example.com");
    const victim = await userIdOf(victimRes.clone());
    const token = cookieOf(victimRes).split("=")[1] ?? "x";
    const actors: [string, string | undefined][] = [
      ["contributor", contributor],
      ["anonymous", player],
      ["no cookie", undefined],
    ];

    const outcomes: string[] = [];
    for (const probe of probes) {
      for (const [actor, cookie] of actors) {
        const body = probe.body(victim, token);
        const res =
          probe.method === "GET"
            ? await app.request(
                probe.path + (probe.path.endsWith("get-user") ? `?id=${victim}` : ""),
                { headers: { origin: DEV_ORIGIN, ...(cookie ? { cookie } : {}) } },
              )
            : await post(probe.path, body, cookie);
        outcomes.push(`${probe.method} ${probe.path} as ${actor}: ${[401, 403].includes(res.status) ? "denied" : res.status}`);
      }
    }

    expect(outcomes).toHaveLength(probes.length * 3);
    expect(outcomes.filter((line) => !line.endsWith(": denied"))).toEqual([]);
    expect(roleOf("victim@example.com")).toBe("contributor");
    expect(roleOf("made@example.com")).toBeUndefined();
    const users = db.query("SELECT count(*) AS n FROM user").get() as { n: number };
    expect(users.n).toBe(3); // contributor, player, victim: nothing created or removed
  });
});

describe("GET is mounted under /api/auth", () => {
  test("GET /api/auth/get-session answers 200 with null and with the session's user", async () => {
    const anon = await app.request("/api/auth/get-session");
    expect(anon.status).toBe(200);
    expect(anon.headers.get("content-type")).toContain("application/json");
    expect(await anon.json()).toBeNull();

    const up = await signUp("getter@example.com");
    const withCookie = await app.request("/api/auth/get-session", { headers: { cookie: cookieOf(up) } });

    expect(withCookie.status).toBe(200);
    const body = (await withCookie.json()) as { user: { email: string } };
    expect(body.user.email).toBe("getter@example.com");
  });

  test("GET /api/auth/ok answers 200 { ok: true }", async () => {
    const res = await app.request("/api/auth/ok");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("cookies and origins", () => {
  test("outside production the session cookie is not Secure-prefixed and lacks Secure", async () => {
    const { handle, call } = await standalone(false);

    const res = await call("/api/auth/sign-in/anonymous");

    const cookie = res.headers.getSetCookie()[0] ?? "";
    expect(res.status).toBe(200);
    expect(cookie.startsWith("better-auth.session_token=")).toBe(true);
    expect(cookie).not.toContain("Secure");
    handle.close();
  });

  test("in production the session cookie is __Secure- prefixed, Secure and HttpOnly", async () => {
    const { handle, call } = await standalone(true);

    const res = await call("/api/auth/sign-in/anonymous");

    const cookie = res.headers.getSetCookie()[0] ?? "";
    expect(res.status).toBe(200);
    expect(cookie.startsWith("__Secure-better-auth.session_token=")).toBe(true);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    handle.close();
  });

  test("a cross-origin POST carrying the session cookie is rejected; a trusted dev origin is accepted", async () => {
    const up = await signUp("csrf@example.com");

    const evil = await post("/api/auth/sign-out", {}, cookieOf(up), { origin: "https://evil.example" });
    const vite = await post("/api/auth/sign-out", {}, cookieOf(up), { origin: "http://localhost:5173" });

    expect(evil.status).toBe(403);
    expect(vite.status).toBe(200);
  });

  test("an unknown /api/auth path answers 404 and is not the SPA", async () => {
    const res = await app.request("/api/auth/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  test("other unknown /api paths still 404 as problem+json", async () => {
    const res = await app.request("/api/other");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("rate limiting", () => {
  test("production throttles wrong-password sign-ins per IP but leaves anonymous sign-in roomier", async () => {
    const { handle, call } = await standalone(true);
    const wrong = { email: "no@one.io", password: "wrong-password-1" };

    const passwordStatuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      passwordStatuses.push((await call("/api/auth/sign-in/email", { ip: "9.9.9.9", body: wrong })).status);
    }
    const anonStatuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      anonStatuses.push((await call("/api/auth/sign-in/anonymous", { ip: "8.8.8.8" })).status);
    }

    expect(passwordStatuses).toEqual([...Array(10).fill(401), 429]); // 10 per 15 min per IP (fc-mol-x7d)
    expect(anonStatuses).toEqual([200, 200, 200, 200, 200, 200]);
    handle.close();
  });

  test("outside production the limiter is off", async () => {
    const { handle, call } = await standalone(false);
    const wrong = { email: "no@one.io", password: "wrong-password-1" };

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await call("/api/auth/sign-in/email", { ip: "9.9.9.9", body: wrong })).status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    handle.close();
  });

  test("anonymous sign-in has its own roomier rule of 30 per hour", async () => {
    const { auth, handle } = await standalone(true);

    const rules = (auth.options as { rateLimit?: { customRules?: Record<string, unknown> } }).rateLimit
      ?.customRules;

    expect(rules?.["/sign-in/anonymous"]).toEqual({ window: 3600, max: 30 });
    handle.close();
  });
});

describe("schema", () => {
  test("Better Auth's own tables exist after the routes are registered", () => {
    const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );

    for (const table of ["user", "session", "account", "verification"]) expect(names).toContain(table);
    expect(names).toContain("schema_migrations"); // the app's own tables are untouched
  });

  test("ensureAuthSchema is idempotent and concurrent callers share one run", async () => {
    const auth = getAuth(deps);

    const a = ensureAuthSchema(auth, db);
    const b = ensureAuthSchema(auth, db);
    await Promise.all([a, b]);

    expect(a).toBe(b);
    await ensureAuthSchema(auth, db);
  });

  test("getAuth returns one instance per database handle", () => {
    const other = open(":memory:");

    expect(getAuth(deps)).toBe(getAuth(deps));
    expect(getAuth({ db: other })).not.toBe(getAuth(deps));
  });

  test("a second boot over the same database file keeps existing users and still works", async () => {
    await signUp("again@example.com");
    db.close();

    const reopened = open(join(dir, "auth.db"));
    app = await bootApp(reopened);
    const login = await post("/api/auth/sign-in/email", { email: "again@example.com", password: PASSWORD });

    expect(login.status).toBe(200);
    const users = reopened.query("SELECT count(*) AS n FROM user").get() as { n: number };
    expect(users.n).toBe(1);
  });
});

describe("resolveAuthConfig", () => {
  const PROD_URL = "https://x.example";

  test("production without BETTER_AUTH_SECRET fails naming the variable", () => {
    expect(() => resolveAuthConfig(db, { NODE_ENV: "production", BETTER_AUTH_URL: PROD_URL })).toThrow(
      "BETTER_AUTH_SECRET",
    );
  });

  test("production with a too-short secret fails without printing the secret", () => {
    const short = "topsecret-short-value";
    let message = "";
    try {
      resolveAuthConfig(db, { NODE_ENV: "production", BETTER_AUTH_SECRET: short, BETTER_AUTH_URL: PROD_URL });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).not.toContain(short);
  });

  test("production without BETTER_AUTH_URL fails naming the variable", () => {
    expect(() => resolveAuthConfig(db, { NODE_ENV: "production", BETTER_AUTH_SECRET: SECRET })).toThrow(
      "BETTER_AUTH_URL",
    );
  });

  test("fails closed: no NODE_ENV and nothing else set is production and demands a secret", () => {
    expect(() => resolveAuthConfig(db, {})).toThrow("BETTER_AUTH_SECRET");
    expect(() => resolveAuthConfig(db, { BETTER_AUTH_URL: PROD_URL })).toThrow("BETTER_AUTH_SECRET");
  });

  test("fails closed: a secret and an http URL without NODE_ENV is production, never the dev fallback", async () => {
    const config = resolveAuthConfig(db, { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: "http://x" });

    expect(config.production).toBe(true);
    expect(config.secret).toBe(SECRET);
    expect(config.baseURL).toBe("http://x");
    expect(config.trustedOrigins).not.toContain("http://localhost:5173");
    const handle = open(":memory:");
    const auth = createAuth({ ...config, db: handle });
    await ensureAuthSchema(auth, handle);
    const res = await auth.handler(
      new Request("http://x/api/auth/sign-in/anonymous", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://x" },
        body: "{}",
      }),
    );
    const cookie = res.headers.getSetCookie()[0] ?? "";
    expect(cookie.startsWith("__Secure-better-auth.session_token=")).toBe(true);
    expect(cookie).toContain("Secure");
  });

  test.each(["Production", "PRODUCTION", "staging", "", "production ", "dev"])(
    "fails closed: NODE_ENV %p is production",
    (nodeEnv) => {
      expect(() => resolveAuthConfig(db, { NODE_ENV: nodeEnv })).toThrow("BETTER_AUTH_SECRET");
      const config = resolveAuthConfig(db, {
        NODE_ENV: nodeEnv,
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: "http://x",
      });
      expect(config.production).toBe(true);
    },
  );

  test.each(["development", "test"])(
    "NODE_ENV %p with nothing else set gets the dev fallbacks and is not production",
    (nodeEnv) => {
      const config = resolveAuthConfig(db, { NODE_ENV: nodeEnv });

      expect(config.production).toBe(false);
      expect(config.baseURL).toBe(DEV_ORIGIN);
      expect(config.secret.length).toBeGreaterThanOrEqual(32);
      expect(config.trustedOrigins).toContain("http://localhost:5173");
    },
  );

  test("an explicit secret and URL are honoured in development", () => {
    const config = resolveAuthConfig(db, {
      NODE_ENV: "development",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "http://localhost:9999",
    });

    expect(config.secret).toBe(SECRET);
    expect(config.baseURL).toBe("http://localhost:9999");
    expect(config.production).toBe(false);
  });

  test("production trusts only BETTER_AUTH_TRUSTED_ORIGINS, never the vite dev origin", () => {
    const config = resolveAuthConfig(db, {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: PROD_URL,
      BETTER_AUTH_TRUSTED_ORIGINS: " https://a.example , https://b.example ,",
    });

    expect(config.trustedOrigins).toEqual(["https://a.example", "https://b.example"]);
  });

  test.each(["*", "https://*.example.com", "https://a.example, *"])(
    "production rejects a wildcard in BETTER_AUTH_TRUSTED_ORIGINS (%p)",
    (origins) => {
      expect(() =>
        resolveAuthConfig(db, {
          NODE_ENV: "production",
          BETTER_AUTH_SECRET: SECRET,
          BETTER_AUTH_URL: PROD_URL,
          BETTER_AUTH_TRUSTED_ORIGINS: origins,
        }),
      ).toThrow("BETTER_AUTH_TRUSTED_ORIGINS");
    },
  );

  test("an empty BETTER_AUTH_TRUSTED_ORIGINS adds no origins", () => {
    const config = resolveAuthConfig(db, {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: PROD_URL,
      BETTER_AUTH_TRUSTED_ORIGINS: "  ",
    });

    expect(config.trustedOrigins).toEqual([]);
  });
});
