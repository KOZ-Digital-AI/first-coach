import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono, type Context } from "hono";
import { createApp, type AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { createAuth, ensureAuthSchema, resolveAuthConfig } from "./better-auth";
import { requireContributor, requirePlayer, type AuthVariables } from "./middleware";
import { createRateLimitStore, RATE_LIMITS, rateLimit } from "./rate-limit";

const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PROD_ORIGIN = "https://coach.example";
const SECRET = "s".repeat(40);
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const savedEnv: Record<string, string | undefined> = {};
const opened: Database[] = [];
const open = (path = ":memory:"): Database => {
  const handle = openDatabase(path);
  opened.push(handle);
  return handle;
};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const handle of opened.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed by the test
    }
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("limits are constants in one place", () => {
  test("the numbers from the acceptance criteria", () => {
    expect(RATE_LIMITS.signIn).toEqual({ max: 10, window: 15 * 60 });
    expect(RATE_LIMITS.signUp).toEqual({ max: 10, window: 15 * 60 });
    expect(RATE_LIMITS.anonymousSignIn).toEqual({ max: 30, window: 60 * 60 });
    expect(RATE_LIMITS.contribution).toEqual({ max: 10, window: 24 * 60 * 60 });
    expect(RATE_LIMITS.videoAnalysis).toEqual({ max: 10, window: 24 * 60 * 60 });
    expect(RATE_LIMITS.aiPlan).toEqual({ max: 20, window: 24 * 60 * 60 });
    expect(RATE_LIMITS.recover).toEqual({ max: 5, window: 15 * 60 });
  });
});

// ---------------------------------------------------------------------------------------
// The Hono limiter, behind real Better Auth sessions (sign-up / anonymous cookies).
// ---------------------------------------------------------------------------------------

let db: Database;
let app: Hono;
let clock: number;
let reached: string[];
const now = () => clock;

const post = (path: string, body: unknown = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN },
    body: JSON.stringify(body),
  });

/** `name=value` pairs of every Set-Cookie header, joined for a Cookie request header. */
const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Actor = { cookie: string; id: string };

async function signInPlayer(): Promise<Actor> {
  const res = await post("/api/auth/sign-in/anonymous");
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

let emailCounter = 0;
async function signUpContributor(): Promise<Actor> {
  const email = `coach${++emailCounter}@example.com`;
  const res = await post("/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

/** POSTs a probe route as `actor`, from the client IP `ip` as an edge proxy would report it. */
const hit = (path: string, actor: Actor, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { cookie: actor.cookie, ...headers } });

const ipHeader = (ip: string) => ({ "x-forwarded-for": ip });

/** Calls `path` `times` times; returns the status of each call. */
async function hitMany(path: string, actor: Actor, times: number, headers: Record<string, string> = {}) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) statuses.push((await hit(path, actor, headers)).status);
  return statuses;
}

const ok = (n: number) => Array<number>(n).fill(200);

beforeEach(async () => {
  clock = 1_800_000_000_000;
  reached = [];
  emailCounter = 0;
  db = open();
  const deps: AppDeps = { db, version: "test" };
  app = await createApp(deps, undefined, { webDist: "/nonexistent-web-dist" });

  // Probe routes OUTSIDE /api (createApp 404s unknown /api paths before later routes).
  const probes = new Hono<{ Variables: AuthVariables }>();
  const handler = (name: string) => (c: Context) => {
    reached.push(name);
    return c.json({ ok: true });
  };
  const store = createRateLimitStore;
  probes.post("/contribution", requireContributor(deps), rateLimit("contribution", { now, store: store() }), handler("contribution"));
  probes.post("/video", requirePlayer(deps), rateLimit("videoAnalysis", { now, store: store() }), handler("video"));
  probes.post("/plan", requirePlayer(deps), rateLimit("aiPlan", { now, store: store() }), handler("plan"));
  probes.post("/recover", requirePlayer(deps), rateLimit("recover", { now, store: store() }), handler("recover"));
  // Wired WITHOUT a guard: misconfiguration must fail closed.
  probes.post("/unguarded", rateLimit("contribution", { now, store: store() }), handler("unguarded"));
  // Two routes sharing the default per-rule store (no `store` option).
  const shared = new Hono<{ Variables: AuthVariables }>();
  shared.post("/a", requireContributor(deps), rateLimit("contribution", { now }), handler("shared-a"));
  shared.post("/b", requireContributor(deps), rateLimit("contribution", { now }), handler("shared-b"));
  probes.route("/shared", shared);
  app.route("/probe", probes);
});

describe("contributions: 10 per day per user", () => {
  test("the 10th passes and the 11th gets a 429 problem with Retry-After; the handler never runs for it", async () => {
    const coach = await signUpContributor();

    const statuses = await hitMany("/probe/contribution", coach, 11);

    expect(statuses).toEqual([...ok(10), 429]);
    expect(reached).toHaveLength(10);
    const res = await hit("/probe/contribution", coach);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({ type: "about:blank", title: "Too Many Requests", status: 429 });
    expect(reached).toHaveLength(10);
  });

  test("Retry-After counts down the seconds until the window opens again", async () => {
    const coach = await signUpContributor();
    await hitMany("/probe/contribution", coach, 10); // window opens at the first hit

    const first = await hit("/probe/contribution", coach);
    expect(first.headers.get("retry-after")).toBe(String(24 * 60 * 60));

    clock += 90 * MINUTE + 400; // 90 min 0.4 s later: rounds UP to whole seconds
    const later = await hit("/probe/contribution", coach);
    expect(later.status).toBe(429);
    expect(later.headers.get("retry-after")).toBe(String(24 * 60 * 60 - 90 * 60));
  });

  test("the window resets after a day, and not one millisecond earlier", async () => {
    const coach = await signUpContributor();
    await hitMany("/probe/contribution", coach, 10);
    expect((await hit("/probe/contribution", coach)).status).toBe(429);

    clock += DAY - 1;
    expect((await hit("/probe/contribution", coach)).status).toBe(429);

    clock += 1;
    expect(await hitMany("/probe/contribution", coach, 11)).toEqual([...ok(10), 429]);
  });

  test("separate users do not share a bucket", async () => {
    const a = await signUpContributor();
    const b = await signUpContributor();
    await hitMany("/probe/contribution", a, 10);
    expect((await hit("/probe/contribution", a)).status).toBe(429);

    expect(await hitMany("/probe/contribution", b, 10)).toEqual(ok(10));
    expect((await hit("/probe/contribution", b)).status).toBe(429);
  });

  test("the bucket is per user AND IP: the same user from another client IP has its own", async () => {
    const coach = await signUpContributor();
    await hitMany("/probe/contribution", coach, 10, ipHeader("203.0.113.1"));
    expect((await hit("/probe/contribution", coach, ipHeader("203.0.113.1"))).status).toBe(429);

    expect((await hit("/probe/contribution", coach, ipHeader("203.0.113.2"))).status).toBe(200);
  });

  test("an anonymous player is refused by the guard (403) and never spends the limiter", async () => {
    const player = await signInPlayer();

    expect(await hitMany("/probe/contribution", player, 12)).toEqual(Array(12).fill(403));
    expect(reached).toEqual([]);
  });

  test("two routes on the same rule draw from one budget", async () => {
    const coach = await signUpContributor();

    const onA = await hitMany("/probe/shared/a", coach, 6);
    const onB = await hitMany("/probe/shared/b", coach, 5);

    expect([...onA, ...onB]).toEqual([...ok(10), 429]);
  });
});

describe("X-Forwarded-For is not blindly trusted", () => {
  test("rotating the client-controlled left side of a proxy chain does not buy a fresh bucket", async () => {
    const coach = await signUpContributor();

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      // A trusted edge appends the real address; a client can only prepend its own claims.
      statuses.push((await hit("/probe/contribution", coach, ipHeader(`198.51.100.${i}, 203.0.113.9`))).status);
    }

    expect(statuses).toEqual([...ok(10), 429]);
  });

  test("rotating unparseable header values does not buy a fresh bucket either", async () => {
    const coach = await signUpContributor();

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await hit("/probe/contribution", coach, ipHeader(`not-an-ip-${i}`))).status);
    }

    expect(statuses).toEqual([...ok(10), 429]);
  });

  test("a request with no forwarded address is still limited", async () => {
    const coach = await signUpContributor();

    expect(await hitMany("/probe/contribution", coach, 11)).toEqual([...ok(10), 429]);
  });
});

describe("the other write rules", () => {
  test("video analyses: 10 per day per player", async () => {
    const player = await signInPlayer();
    const other = await signInPlayer();

    expect(await hitMany("/probe/video", player, 11)).toEqual([...ok(10), 429]);
    expect((await hit("/probe/video", other)).status).toBe(200);
    clock += DAY;
    expect((await hit("/probe/video", player)).status).toBe(200);
  });

  test("AI plan: 20 per day per player", async () => {
    const player = await signInPlayer();

    expect(await hitMany("/probe/plan", player, 21)).toEqual([...ok(20), 429]);
    clock += DAY;
    expect((await hit("/probe/plan", player)).status).toBe(200);
  });

  test("recover: 5 per 15 minutes", async () => {
    const player = await signInPlayer();

    expect(await hitMany("/probe/recover", player, 6)).toEqual([...ok(5), 429]);
    const blocked = await hit("/probe/recover", player);
    expect(blocked.headers.get("retry-after")).toBe(String(15 * 60));
    clock += 15 * MINUTE - 1;
    expect((await hit("/probe/recover", player)).status).toBe(429);
    clock += 1;
    expect((await hit("/probe/recover", player)).status).toBe(200);
  });

  test("each rule keeps its own counter for the same player", async () => {
    const player = await signInPlayer();
    await hitMany("/probe/recover", player, 6);

    expect((await hit("/probe/video", player)).status).toBe(200);
    expect((await hit("/probe/plan", player)).status).toBe(200);
  });
});

describe("fail closed", () => {
  test("a limiter mounted without a session guard answers 401 and never runs the handler", async () => {
    const res = await app.request("/probe/unguarded", { method: "POST" });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(reached).toEqual([]);
  });

  test("a request with no session cookie is a 401 from the guard, not counted", async () => {
    const res = await app.request("/probe/contribution", { method: "POST" });

    expect(res.status).toBe(401);
    expect(reached).toEqual([]);
  });
});

describe("store bounds", () => {
  test("expired counters are swept and the oldest key is evicted when the store is full", async () => {
    const store = createRateLimitStore();
    const deps: AppDeps = { db, version: "test" };
    const small = new Hono<{ Variables: AuthVariables }>();
    small.post("/x", requirePlayer(deps), rateLimit("recover", { now, store, maxKeys: 2 }), (c) => c.json({}));
    app.route("/small", small);
    const [a, b, c] = [await signInPlayer(), await signInPlayer(), await signInPlayer()];

    await hit("/small/x", a);
    await hit("/small/x", b);
    expect(store.size).toBe(2);
    await hit("/small/x", c); // full: the oldest key (a) makes room
    expect(store.size).toBe(2);

    clock += 15 * MINUTE; // everything has expired
    await hit("/small/x", a);
    expect(store.size).toBe(1); // b and c were swept, only a's fresh counter remains
  });
});

// ---------------------------------------------------------------------------------------
// Better Auth's built-in limiter: production only, SQLite storage.
// ---------------------------------------------------------------------------------------

/** A production Auth on its own in-memory SQLite DB, driven by real HTTP requests. */
async function productionAuth() {
  const handle = open();
  const auth = createAuth(
    resolveAuthConfig(handle, {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: PROD_ORIGIN,
    }),
  );
  await ensureAuthSchema(auth, handle);
  const call = (path: string, body: unknown, ip?: string) =>
    auth.handler(
      new Request(`${PROD_ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PROD_ORIGIN,
          ...(ip ? { "x-forwarded-for": ip } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  return { auth, handle, call };
}

const statusesOf = async (n: number, run: (i: number) => Response | Promise<Response>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await run(i)).status);
  return out;
};

describe("Better Auth rateLimit (production)", () => {
  test("sign-in: 10 per 15 minutes per IP, then 429 with a retry hint; another IP is unaffected", async () => {
    const { call } = await productionAuth();
    const wrong = { email: "no@one.io", password: "wrong-password-1" };

    const statuses = await statusesOf(11, () => call("/api/auth/sign-in/email", wrong, "203.0.113.5"));

    expect(statuses).toEqual([...Array(10).fill(401), 429]);
    const blocked = await call("/api/auth/sign-in/email", wrong, "203.0.113.5");
    expect(Number(blocked.headers.get("x-retry-after"))).toBeGreaterThan(60); // minutes, not seconds
    expect((await call("/api/auth/sign-in/email", wrong, "203.0.113.6")).status).toBe(401);
  }, 30_000);

  test("sign-up: 10 per 15 minutes per IP", async () => {
    const { call } = await productionAuth();

    const statuses = await statusesOf(11, (i) =>
      call("/api/auth/sign-up/email", { name: "C", email: `c${i}@example.com`, password: PASSWORD }, "203.0.113.5"),
    );

    expect(statuses).toEqual([...ok(10), 429]);
  }, 30_000);

  test("anonymous sign-in: 30 per hour per IP", async () => {
    const { call } = await productionAuth();

    const statuses = await statusesOf(31, () => call("/api/auth/sign-in/anonymous", {}, "203.0.113.5"));

    expect(statuses).toEqual([...ok(30), 429]);
    expect((await call("/api/auth/sign-in/anonymous", {}, "203.0.113.6")).status).toBe(200);
  }, 30_000);

  test("the counters live in the app's SQLite database (rateLimit table), not in memory", async () => {
    const { handle, call } = await productionAuth();

    await call("/api/auth/sign-in/anonymous", {}, "203.0.113.5");

    const rows = handle.query("SELECT key, count FROM rateLimit").all() as { key: string; count: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.key.includes("203.0.113.5") && r.count === 1)).toBe(true);
  });

  test("rotating the left side of a forwarded chain does not evade the limit", async () => {
    const { call } = await productionAuth();

    const statuses = await statusesOf(11, (i) =>
      call("/api/auth/sign-up/email", { name: "C", email: `c${i}@example.com`, password: PASSWORD }, `198.51.100.${i}, 203.0.113.9`),
    );

    expect(statuses).toEqual([...ok(10), 429]);
  }, 30_000);
});
