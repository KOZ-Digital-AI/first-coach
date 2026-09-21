import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { migrate } from "../db/migrate";
import {
  requireAdmin,
  requireContributor,
  requirePlayer,
  type AuthVariables,
  type SessionLike,
  type SessionResolver,
} from "./middleware";

const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

let dir: string;
let db: Database;
let deps: AppDeps;
let app: Hono;
/** Names of the guarded routes whose handler actually ran. A denial must leave this empty. */
let reached: string[];
const savedEnv: Record<string, string | undefined> = {};

type Options = { resolveSession?: SessionResolver };

/**
 * Mounts one probe route per guard OUTSIDE /api (createApp answers unknown /api paths with a
 * 404 before later routes), on the real app, so the real error handler and the real Better
 * Auth handler are in play. The handlers echo `c.var` so tests can see what the guard set.
 */
function mountProbes(target: Hono, options?: Options): void {
  const probes = new Hono<{ Variables: AuthVariables }>();
  const guards = { player: requirePlayer, contributor: requireContributor, admin: requireAdmin };
  for (const [name, guard] of Object.entries(guards)) {
    probes.all(`/${name}`, guard(deps, options), (c) => {
      reached.push(name);
      return c.json({ playerId: c.var.playerId, user: c.var.user });
    });
  }
  target.route("/probe", probes);
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  reached = [];
  dir = mkdtempSync(join(tmpdir(), "auth-middleware-"));
  db = openDatabase(join(dir, "auth.db"));
  migrate(db, join(dir, "no-migrations"));
  deps = { db, version: "test" };
  app = await createApp(deps, undefined, { webDist: join(dir, "no-dist") });
  mountProbes(app);
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

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: DEV_ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

/** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Actor = { cookie: string; id: string; email: string };

async function signInPlayer(): Promise<Actor> {
  const res = await post("/api/auth/sign-in/anonymous", {});
  const body = (await res.json()) as { user: { id: string; email: string } };
  return { cookie: cookieOf(res), id: body.user.id, email: body.user.email };
}

async function signUpContributor(email = "contrib@example.com"): Promise<Actor> {
  const res = await post("/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id, email };
}

/** Bootstrap is out-of-band: promote by direct UPDATE, as the bootstrap will. */
async function signUpAdmin(): Promise<Actor> {
  const actor = await signUpContributor("boss@example.com");
  db.run("UPDATE user SET role = 'admin' WHERE id = ?", [actor.id]);
  return actor;
}

const call = (path: string, init: RequestInit = {}, appUnderTest: Hono = app) =>
  appUnderTest.request(path, init);
const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  call(path, { headers: { ...(cookie ? { cookie } : {}), ...headers } });

const readProblem = async (res: Response) => ({
  contentType: res.headers.get("content-type"),
  text: await res.clone().text(),
  body: (await res.json()) as Record<string, unknown>,
});

const ROUTES = ["/probe/player", "/probe/contributor", "/probe/admin"] as const;

describe("no session: 401 problem details on every guard", () => {
  for (const path of ROUTES) {
    test(`no cookie on ${path} is a 401 problem+json and the handler never runs`, async () => {
      const res = await get(path);

      expect(res.status).toBe(401);
      const { contentType, body } = await readProblem(res);
      expect(contentType).toContain("application/problem+json");
      expect(body).toEqual({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: expect.any(String),
      });
      expect(reached).toEqual([]);
    });
  }

  test("a client-forged cookie value (random token) is a 401", async () => {
    const forged = "better-auth.session_token=Zm9yZ2VkLXRva2Vu.Zm9yZ2VkLXNpZ25hdHVyZQ";
    for (const path of ROUTES) {
      const res = await get(path, forged);
      expect(res.status).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  test("a real session token WITHOUT its signature is a 401", async () => {
    const admin = await signUpAdmin();
    const row = db.query("SELECT token FROM session WHERE userId = ?").get(admin.id) as { token: string };

    for (const path of ROUTES) {
      const res = await get(path, `better-auth.session_token=${row.token}`);
      expect(res.status).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  test("the session cookie of a signed-out user is a 401", async () => {
    const player = await signInPlayer();
    const out = await post("/api/auth/sign-out", {}, player.cookie);
    expect(out.status).toBe(200);

    const res = await get("/probe/player", player.cookie);

    expect(res.status).toBe(401);
    expect(reached).toEqual([]);
  });
});

describe("requirePlayer", () => {
  test("an anonymous player passes and c.var.playerId is the session user id", async () => {
    const player = await signInPlayer();

    const res = await get("/probe/player", player.cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { playerId: string; user: Record<string, unknown> };
    expect(body.playerId).toBe(player.id);
    expect(body.user).toMatchObject({ id: player.id, isAnonymous: true });
    expect(reached).toEqual(["player"]);
  });

  test("a contributor and an admin pass too, each with their own id", async () => {
    const contributor = await signUpContributor();
    const admin = await signUpAdmin();

    const c = await get("/probe/player", contributor.cookie);
    const a = await get("/probe/player", admin.cookie);

    expect(c.status).toBe(200);
    expect(((await c.json()) as { playerId: string }).playerId).toBe(contributor.id);
    expect(a.status).toBe(200);
    expect(((await a.json()) as { playerId: string }).playerId).toBe(admin.id);
  });

  test("c.var.user carries id, role and isAnonymous from the server session", async () => {
    const contributor = await signUpContributor();

    const res = await get("/probe/player", contributor.cookie);

    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user).toMatchObject({ id: contributor.id, role: "contributor", isAnonymous: false });
  });
});

describe("requireContributor", () => {
  test("an anonymous player is a 403 problem+json (signed in, but not a contributor)", async () => {
    const player = await signInPlayer();

    const res = await get("/probe/contributor", player.cookie);

    expect(res.status).toBe(403);
    const { contentType, body } = await readProblem(res);
    expect(contentType).toContain("application/problem+json");
    expect(body).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: expect.any(String),
    });
    expect(reached).toEqual([]);
  });

  test("an anonymous player whose role is somehow admin is still a 403", async () => {
    const player = await signInPlayer();
    db.run("UPDATE user SET role = 'admin' WHERE id = ?", [player.id]);

    const res = await get("/probe/contributor", player.cookie);

    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("a contributor passes and c.var.playerId is their id", async () => {
    const contributor = await signUpContributor();

    const res = await get("/probe/contributor", contributor.cookie);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { playerId: string }).playerId).toBe(contributor.id);
    expect(reached).toEqual(["contributor"]);
  });

  test("an admin passes", async () => {
    const admin = await signUpAdmin();

    const res = await get("/probe/contributor", admin.cookie);

    expect(res.status).toBe(200);
    expect(reached).toEqual(["contributor"]);
  });
});

describe("requireAdmin", () => {
  test("a contributor is a 403 problem+json", async () => {
    const contributor = await signUpContributor();

    const res = await get("/probe/admin", contributor.cookie);

    expect(res.status).toBe(403);
    const { contentType, body } = await readProblem(res);
    expect(contentType).toContain("application/problem+json");
    expect(body).toEqual({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: expect.any(String),
    });
    expect(reached).toEqual([]);
  });

  test("an anonymous player is a 403", async () => {
    const player = await signInPlayer();

    const res = await get("/probe/admin", player.cookie);

    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("an anonymous player whose role is somehow admin is still a 403", async () => {
    const player = await signInPlayer();
    db.run("UPDATE user SET role = 'admin' WHERE id = ?", [player.id]);

    const res = await get("/probe/admin", player.cookie);

    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("an admin passes and c.var.playerId is their id", async () => {
    const admin = await signUpAdmin();

    const res = await get("/probe/admin", admin.cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { playerId: string; user: Record<string, unknown> };
    expect(body.playerId).toBe(admin.id);
    expect(body.user).toMatchObject({ role: "admin", isAnonymous: false });
    expect(reached).toEqual(["admin"]);
  });

  test("a multi-role user whose roles include admin passes; a look-alike role does not", async () => {
    const both = await signUpContributor("both@example.com");
    const lookalike = await signUpContributor("lookalike@example.com");
    db.run("UPDATE user SET role = 'contributor,admin' WHERE id = ?", [both.id]);
    db.run("UPDATE user SET role = 'administrator' WHERE id = ?", [lookalike.id]);

    const ok = await get("/probe/admin", both.cookie);
    const no = await get("/probe/admin", lookalike.cookie);

    expect(ok.status).toBe(200);
    expect(no.status).toBe(403);
  });

  test("role matching is exact like Better Auth's: padded roles do not satisfy admin, 'admin,' still does", async () => {
    const roles: [string, number][] = [
      [" admin", 403],
      ["admin ", 403],
      ["contributor, admin", 403],
      ["contributor,admin", 200],
      ["admin,", 200],
    ];
    const seen: [string, number][] = [];
    for (const [i, [role]] of roles.entries()) {
      const user = await signUpContributor(`role${i}@example.com`);
      db.run("UPDATE user SET role = ? WHERE id = ?", [role, user.id]);
      seen.push([role, (await get("/probe/admin", user.cookie)).status]);
    }

    expect(seen).toEqual(roles);
  });

  test("a promotion is picked up on the next request (role comes from the DB, not the cookie)", async () => {
    const user = await signUpContributor();
    const before = await get("/probe/admin", user.cookie);
    db.run("UPDATE user SET role = 'admin' WHERE id = ?", [user.id]);
    const after = await get("/probe/admin", user.cookie);
    db.run("UPDATE user SET role = 'contributor' WHERE id = ?", [user.id]);
    const demoted = await get("/probe/admin", user.cookie);

    expect([before.status, after.status, demoted.status]).toEqual([403, 200, 403]);
  });
});

describe("roles come from the server session only, never from request input", () => {
  const SPOOF_HEADERS = {
    "x-role": "admin",
    "x-user-role": "admin",
    "x-admin": "true",
    "x-user-id": "someone-else",
    "x-is-anonymous": "false",
  };

  test("spoofed role headers, a ?role=admin query and a JSON body role do not lift a contributor to admin", async () => {
    const contributor = await signUpContributor();

    const byHeader = await get("/probe/admin", contributor.cookie, SPOOF_HEADERS);
    const byQuery = await get("/probe/admin?role=admin&isAnonymous=false", contributor.cookie);
    const byBody = await call("/probe/admin", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: contributor.cookie },
      body: JSON.stringify({ role: "admin", user: { role: "admin" }, isAnonymous: false }),
    });

    expect(byHeader.status).toBe(403);
    expect(byQuery.status).toBe(403);
    expect(byBody.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("spoofed input does not lift an anonymous player to contributor", async () => {
    const player = await signInPlayer();

    const byHeader = await get("/probe/contributor", player.cookie, {
      ...SPOOF_HEADERS,
      "x-contributor": "true",
    });
    const byQuery = await get("/probe/contributor?role=contributor&isAnonymous=false", player.cookie);
    const byBody = await call("/probe/contributor", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: player.cookie },
      body: JSON.stringify({ role: "contributor", isAnonymous: false }),
    });

    expect(byHeader.status).toBe(403);
    expect(byQuery.status).toBe(403);
    expect(byBody.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("spoofed role input with no session is a 401, not a pass", async () => {
    for (const path of ROUTES) {
      const res = await get(`${path}?role=admin`, undefined, SPOOF_HEADERS);
      expect(res.status).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  test("a spoofed x-user-id does not change c.var.playerId", async () => {
    const player = await signInPlayer();

    const res = await get("/probe/player", player.cookie, { "x-user-id": "someone-else" });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { playerId: string }).playerId).toBe(player.id);
  });
});

describe("banned users", () => {
  test("a banned contributor and a banned admin are a 403 on every guard", async () => {
    const contributor = await signUpContributor();
    const admin = await signUpAdmin();
    db.run("UPDATE user SET banned = 1 WHERE id IN (?, ?)", [contributor.id, admin.id]);

    for (const actor of [contributor, admin]) {
      for (const path of ROUTES) {
        const res = await get(path, actor.cookie);
        expect(res.status).toBe(403);
      }
    }
    expect(reached).toEqual([]);
  });

  test("a banned anonymous player is a 403 on requirePlayer", async () => {
    const player = await signInPlayer();
    db.run("UPDATE user SET banned = 1 WHERE id = ?", [player.id]);

    const res = await get("/probe/player", player.cookie);

    expect(res.status).toBe(403);
    expect(reached).toEqual([]);
  });

  test("a ban with a future expiry is a 403; an expired ban no longer blocks", async () => {
    const user = await signUpContributor();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 1000).toISOString();

    db.run("UPDATE user SET banned = 1, banExpires = ? WHERE id = ?", [future, user.id]);
    const active = await get("/probe/contributor", user.cookie);
    db.run("UPDATE user SET banned = 1, banExpires = ? WHERE id = ?", [past, user.id]);
    const lifted = await get("/probe/contributor", user.cookie);

    expect(active.status).toBe(403);
    expect(lifted.status).toBe(200);
  });
});

describe("response bodies do not leak session or user internals", () => {
  test("401 and 403 bodies contain no ids, emails, tokens or roles of the caller", async () => {
    const player = await signInPlayer();
    const contributor = await signUpContributor();
    const token = (
      db.query("SELECT token FROM session WHERE userId = ?").get(contributor.id) as { token: string }
    ).token;
    const responses = [
      await get("/probe/contributor"),
      await get("/probe/contributor", player.cookie),
      await get("/probe/admin", contributor.cookie),
    ];

    for (const res of responses) {
      const { text, body } = await readProblem(res);
      expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
      for (const secret of [player.id, player.email, contributor.id, contributor.email, token, "session"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("a failing session lookup fails closed", () => {
  const brokenApp = async (resolveSession: SessionResolver): Promise<Hono> => {
    const broken = await createApp(deps, undefined, { webDist: join(dir, "no-dist") });
    mountProbes(broken, { resolveSession });
    return broken;
  };

  test("a resolver that throws is a 500 problem+json on every guard and next() is never reached", async () => {
    const boom = new Error("db exploded: secret-internal-detail");
    const broken = await brokenApp(async () => {
      throw boom;
    });
    const originalError = console.error;
    console.error = () => {}; // the app's error handler logs the failure; keep test output clean
    try {
      for (const path of ROUTES) {
        const res = await call(path, { headers: { cookie: "anything=1" } }, broken);

        expect(res.status).toBe(500);
        const { contentType, text } = await readProblem(res);
        expect(contentType).toContain("application/problem+json");
        expect(text).not.toContain("secret-internal-detail");
      }
    } finally {
      console.error = originalError;
    }
    expect(reached).toEqual([]);
  });

  test("a resolver that rejects with a non-Error is still a 500, never a pass", async () => {
    const broken = await brokenApp(() => Promise.reject("nope"));
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await call("/probe/admin", {}, broken);
      expect(res.status).toBe(500);
    } finally {
      console.error = originalError;
    }
    expect(reached).toEqual([]);
  });

  test("an injected resolver decides the session: null is a 401, a session is honoured", async () => {
    const none = await brokenApp(async () => null);
    const admin = await brokenApp(async () => ({
      user: { id: "u-admin", role: "admin", isAnonymous: false, banned: false },
    }));

    const denied = await call("/probe/player", {}, none);
    const allowed = await call("/probe/admin", {}, admin);

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { playerId: string }).playerId).toBe("u-admin");
  });

  test("a session whose isAnonymous flag is missing is treated as anonymous (fail closed)", async () => {
    const odd = await brokenApp(async () => ({ user: { id: "u-odd", role: "admin" } }));

    const contributor = await call("/probe/contributor", {}, odd);
    const admin = await call("/probe/admin", {}, odd);
    const player = await call("/probe/player", {}, odd);

    expect(contributor.status).toBe(403);
    expect(admin.status).toBe(403);
    expect(player.status).toBe(200);
  });
});

describe("fail-closed defaults for absent or unreadable session fields", () => {
  const appWith = async (user: SessionLike["user"]): Promise<Hono> => {
    const custom = await createApp(deps, undefined, { webDist: join(dir, "no-dist") });
    mountProbes(custom, { resolveSession: async () => ({ user }) });
    return custom;
  };

  for (const [label, user] of [
    ["null", { id: "u-null", isAnonymous: false, role: null }],
    ["undefined", { id: "u-undef", isAnonymous: false, role: undefined }],
  ] as const) {
    test(`a non-anonymous user with a ${label} role is a contributor, never an admin`, async () => {
      const custom = await appWith(user);

      const admin = await call("/probe/admin", {}, custom);
      const contributor = await call("/probe/contributor", {}, custom);

      expect(admin.status).toBe(403);
      expect(contributor.status).toBe(200);
      const body = (await contributor.json()) as { user: { role: string } };
      expect(body.user.role).toBe("contributor");
      expect(reached).toEqual(["contributor"]);
    });
  }

  test("a ban with an unreadable expiry (garbage string or invalid Date) still applies", async () => {
    const garbage = await appWith({ id: "u-g", isAnonymous: false, banned: true, banExpires: "garbage" });
    const invalid = await appWith({
      id: "u-i",
      isAnonymous: false,
      banned: true,
      banExpires: new Date("garbage"),
    });

    for (const custom of [garbage, invalid]) {
      for (const path of ROUTES) {
        expect((await call(path, {}, custom)).status).toBe(403);
      }
    }
    expect(reached).toEqual([]);
  });

  test("a ban whose expiry is in the past no longer applies (Date, ISO string and epoch ms)", async () => {
    const past = Date.now() - 60_000;
    for (const banExpires of [new Date(past), new Date(past).toISOString(), past]) {
      const custom = await appWith({ id: "u-p", isAnonymous: false, banned: true, banExpires });
      expect((await call("/probe/contributor", {}, custom)).status).toBe(200);
    }
  });
});
