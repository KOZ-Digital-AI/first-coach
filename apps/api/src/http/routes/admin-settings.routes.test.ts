import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { DEFAULT_SETTINGS, getSettings, SettingsSchema, updateSettings } from "../../admin/settings";
import type { Settings } from "../../admin/settings";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import { ENDPOINTS, Settings as ContractSettings } from "../../shared/admin";
import { TRUST_STATUSES } from "../../shared/primitives";

// Every test runs the real createApp on a fresh in-memory database migrated with the real
// migrations, with the REAL Better Auth handler mounted (auth.routes.ts) next to the route under
// test. Sessions are real: an actor signs up (or signs in anonymously) through /api/auth/*, and
// the request carries the Set-Cookie it got back. The admin is promoted by a direct UPDATE of the
// user row, exactly as the auth middleware tests do (bootstrap is out-of-band). No fake sessions.

const ROUTES_DIR_FILES = ["admin-settings.routes.ts", "auth.routes.ts"] as const;
const SOURCE_DIR = resolve(import.meta.dir);
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const DEV_SECRET = "dev-only-better-auth-secret-0123456789abcdef";
const PASSWORD = "correct-horse-battery";
const PATH = ENDPOINTS.getSettings.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

/** A real createApp that mounts only the route under test and the real Better Auth handler. */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTES_DIR_FILES) {
    writeFileSync(
      join(routesDir, file),
      `export { register } from ${JSON.stringify(join(SOURCE_DIR, file))};\n`,
    );
  }
  const deps: AppDeps = { db, version: "test" };
  return createApp(deps, routesDir, { webDist: join(dir, "no-dist") });
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "admin-settings-routes-"));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
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

// --- real sessions ----------------------------------------------------------------------------

const post = (path: string, body: unknown) =>
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

/** A non-anonymous account whose stored role string is exactly `role`. */
async function signUpWithRole(role: string, email = `${role.replace(/\W/g, "_")}@example.com`): Promise<Actor> {
  const actor = await signUpContributor(email);
  db.run("UPDATE user SET role = ? WHERE id = ?", [role, actor.id]);
  return actor;
}

const signUpAdmin = () => signUpWithRole("admin", "boss@example.com");

// --- requests ---------------------------------------------------------------------------------

const get = (cookie?: string) => app.request(PATH, { headers: cookie ? { cookie } : {} });

/** `body` is JSON-encoded unless it is already a string (to send malformed JSON verbatim). */
const put = (cookie: string | undefined, body?: unknown) =>
  app.request(PATH, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

/** Every settings row, whole, so "the store is untouched" compares values AND updated_at. */
const rows = () => db.query("SELECT key, value, updated_at FROM settings ORDER BY key").all();

const problemOf = async (res: Response) => {
  const text = await res.clone().text();
  return {
    contentType: res.headers.get("content-type"),
    text,
    body: JSON.parse(text) as {
      type: string;
      title: string;
      status: number;
      detail?: string;
      errors?: { pointer: string; detail: string }[];
    },
  };
};

const expectProblem = async (res: Response, status: number, title: string) => {
  expect(res.status).toBe(status);
  const { contentType, body } = await problemOf(res);
  expect(contentType).toContain("application/problem+json");
  expect(body).toMatchObject({ type: "about:blank", title, status });
};

/** Both the typed schema and the contract's loose schema accept this body. */
const expectValidSettings = (body: unknown) => {
  expect(SettingsSchema.safeParse(body).success).toBe(true);
  expect(ContractSettings.safeParse(body).success).toBe(true);
};

const VALID_PUT: Settings = {
  minStatusByAgeBand: { u10: "EXPERT_VERIFIED", u14: "REVIEWED", adult: "COMMUNITY" },
  uploadMaxMb: 120,
  aiPlannerEnabled: false,
  videoCoachEnabled: false,
  retestIntervalsDays: [10, 20, 40, 90],
};

test("the route serves the contract's path with the contract's methods", () => {
  expect(ENDPOINTS.getSettings.method).toBe("GET");
  expect(ENDPOINTS.putSettings.method).toBe("PUT");
  expect(ENDPOINTS.putSettings.path).toBe(PATH);
  expect(PATH).toBe("/api/admin/settings");
});

// --- authorisation: fail closed, and before the body is read ------------------------------------

describe("no session: 401 on both methods", () => {
  test("GET without a cookie is a 401 problem+json", async () => {
    await expectProblem(await get(), 401, "Unauthorized");
  });

  test("PUT without a cookie is a 401 problem+json and the store is untouched", async () => {
    await expectProblem(await put(undefined, VALID_PUT), 401, "Unauthorized");
    expect(rows()).toEqual([]);
  });

  test("a malformed or invalid body without a session is still a 401, never a 400 or 422", async () => {
    for (const body of ["{not json", "[]", { uploadMaxMb: 0 }]) {
      await expectProblem(await put(undefined, body), 401, "Unauthorized");
    }
    expect(rows()).toEqual([]);
  });

  test("a forged session cookie is a 401 on both methods", async () => {
    const forged = "better-auth.session_token=Zm9yZ2VkLXRva2Vu.Zm9yZ2VkLXNpZ25hdHVyZQ";
    await expectProblem(await get(forged), 401, "Unauthorized");
    await expectProblem(await put(forged, VALID_PUT), 401, "Unauthorized");
    expect(rows()).toEqual([]);
  });

  test("the cookie of a signed-out admin is a 401", async () => {
    const admin = await signUpAdmin();
    const out = await app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json", origin: DEV_ORIGIN, cookie: admin.cookie },
      body: "{}",
    });
    expect(out.status).toBe(200);

    await expectProblem(await get(admin.cookie), 401, "Unauthorized");
    await expectProblem(await put(admin.cookie, VALID_PUT), 401, "Unauthorized");
    expect(rows()).toEqual([]);
  });
});

describe("signed in but not an administrator: 403 on both methods", () => {
  const actors: [string, () => Promise<Actor>][] = [
    ["a contributor", () => signUpContributor()],
    ["an anonymous player", () => signInPlayer()],
    [
      "an anonymous player whose stored role is admin",
      async () => {
        const player = await signInPlayer();
        db.run("UPDATE user SET role = 'admin' WHERE id = ?", [player.id]);
        return player;
      },
    ],
    ["a user whose role merely CONTAINS admin (superadmin)", () => signUpWithRole("superadmin")],
    ["a user whose role merely starts with admin (admin2)", () => signUpWithRole("admin2")],
    ["a user whose role is admin with a space (' admin')", () => signUpWithRole(" admin")],
    ["a user whose role is upper-case (ADMIN)", () => signUpWithRole("ADMIN")],
  ];

  for (const [label, makeActor] of actors) {
    test(`${label}: GET is a 403 problem+json`, async () => {
      const actor = await makeActor();
      await expectProblem(await get(actor.cookie), 403, "Forbidden");
    });

    test(`${label}: PUT is a 403 problem+json and the store is untouched`, async () => {
      const actor = await makeActor();
      await expectProblem(await put(actor.cookie, VALID_PUT), 403, "Forbidden");
      expect(rows()).toEqual([]);
    });

    test(`${label}: a malformed, non-object or invalid body is a 403, never a 400 or 422`, async () => {
      const actor = await makeActor();
      for (const body of ["{not json", "[]", "null", { uploadMaxMb: 0 }, { nope: 1 }]) {
        await expectProblem(await put(actor.cookie, body), 403, "Forbidden");
      }
      expect(rows()).toEqual([]);
    });
  }

  test("a 403 leaves the values an admin set earlier exactly as they were", async () => {
    const admin = await signUpAdmin();
    expect((await put(admin.cookie, VALID_PUT)).status).toBe(200);
    const before = rows();
    const contributor = await signUpContributor();

    await expectProblem(await put(contributor.cookie, { uploadMaxMb: 5 }), 403, "Forbidden");

    expect(rows()).toEqual(before);
  });
});

describe("administrators", () => {
  test("an admin is let in on both methods", async () => {
    const admin = await signUpAdmin();
    expect((await get(admin.cookie)).status).toBe(200);
    expect((await put(admin.cookie, {})).status).toBe(200);
  });

  test("a role list that includes admin (contributor,admin) is let in, as the middleware decides", async () => {
    const actor = await signUpWithRole("contributor,admin");
    expect((await get(actor.cookie)).status).toBe(200);
  });
});

// --- GET --------------------------------------------------------------------------------------

describe("GET /api/admin/settings", () => {
  test("on a fresh database answers 200 with the full default settings", async () => {
    const admin = await signUpAdmin();

    const res = await get(admin.cookie);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual(DEFAULT_SETTINGS);
    expectValidSettings(body);
    expect(rows()).toEqual([]); // reading writes nothing
  });

  test("answers what the store holds, validated against the typed and the contract schema", async () => {
    const admin = await signUpAdmin();
    updateSettings(db, VALID_PUT);

    const res = await get(admin.cookie);

    const body = await res.json();
    expect(body).toEqual(VALID_PUT);
    expectValidSettings(body);
  });
});

// --- PUT: round trip --------------------------------------------------------------------------

describe("PUT /api/admin/settings: validate, persist, return the full object", () => {
  test("a full valid object round-trips: PUT answers 200 with it, GET and the store agree", async () => {
    const admin = await signUpAdmin();

    const res = await put(admin.cookie, VALID_PUT);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(VALID_PUT);
    expectValidSettings(body);
    expect(await (await get(admin.cookie)).json()).toEqual(VALID_PUT);
    expect(getSettings(db)).toEqual(VALID_PUT);
  });

  test("a partial patch answers the FULL updated object, not just the patch", async () => {
    const admin = await signUpAdmin();

    const res = await put(admin.cookie, { uploadMaxMb: 75 });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ...DEFAULT_SETTINGS, uploadMaxMb: 75 });
    expectValidSettings(body);
  });

  test("a partial patch keeps every field an earlier PUT set", async () => {
    const admin = await signUpAdmin();
    expect((await put(admin.cookie, VALID_PUT)).status).toBe(200);

    const res = await put(admin.cookie, { uploadMaxMb: 75, aiPlannerEnabled: true });

    expect(await res.json()).toEqual({ ...VALID_PUT, uploadMaxMb: 75, aiPlannerEnabled: true });
    expect(await (await get(admin.cookie)).json()).toEqual({ ...VALID_PUT, uploadMaxMb: 75, aiPlannerEnabled: true });
  });

  test("a patch of one age band merges into the stored bands (the store's rule)", async () => {
    const admin = await signUpAdmin();
    expect((await put(admin.cookie, VALID_PUT)).status).toBe(200);

    const res = await put(admin.cookie, { minStatusByAgeBand: { adult: "ACADEMY_VERIFIED" } });

    expect(((await res.json()) as typeof VALID_PUT).minStatusByAgeBand).toEqual({
      u10: "EXPERT_VERIFIED",
      u14: "REVIEWED",
      adult: "ACADEMY_VERIFIED",
    });
  });

  test("an empty patch is a 200 with the full current settings and writes nothing", async () => {
    const admin = await signUpAdmin();

    const res = await put(admin.cookie, {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_SETTINGS);
    expect(rows()).toEqual([]);
  });
});

// --- PUT: 422 with pointers -------------------------------------------------------------------

describe("PUT /api/admin/settings: invalid values are a 422 with a JSON pointer, nothing persisted", () => {
  const invalidUploadCaps: [string, string][] = [
    ["zero", JSON.stringify({ uploadMaxMb: 0 })],
    ["negative", JSON.stringify({ uploadMaxMb: -5 })],
    ["non-integer", JSON.stringify({ uploadMaxMb: 1.5 })],
    ["a string", JSON.stringify({ uploadMaxMb: "50" })],
    ["null", JSON.stringify({ uploadMaxMb: null })],
    ["a boolean", JSON.stringify({ uploadMaxMb: true })],
    ["an array", JSON.stringify({ uploadMaxMb: [50] })],
    ["not a finite number (1e999)", '{"uploadMaxMb": 1e999}'],
    ["beyond safe integers (2^53)", '{"uploadMaxMb": 9007199254740992}'],
  ];

  for (const [label, raw] of invalidUploadCaps) {
    test(`an upload cap that is ${label} is a 422 problem+json with pointer /uploadMaxMb`, async () => {
      const admin = await signUpAdmin();
      expect((await put(admin.cookie, { aiPlannerEnabled: false })).status).toBe(200);
      const before = rows();

      const res = await put(admin.cookie, raw);

      await expectProblem(res, 422, "Unprocessable Entity");
      const { body } = await problemOf(res);
      expect(body.errors).toEqual([{ pointer: "/uploadMaxMb", detail: expect.any(String) }]);
      expect(rows()).toEqual(before);
    });
  }

  const otherPointers: [string, unknown, string][] = [
    ["a trust status the enum does not have", { minStatusByAgeBand: { u10: "GOLD" } }, "/minStatusByAgeBand/u10"],
    ["a band value of the wrong type", { minStatusByAgeBand: { adult: 3 } }, "/minStatusByAgeBand/adult"],
    ["bands that are not an object", { minStatusByAgeBand: "COMMUNITY" }, "/minStatusByAgeBand"],
    ["a non-boolean AI planner flag", { aiPlannerEnabled: "yes" }, "/aiPlannerEnabled"],
    ["a non-boolean video coach flag", { videoCoachEnabled: 1 }, "/videoCoachEnabled"],
    ["empty retest intervals", { retestIntervalsDays: [] }, "/retestIntervalsDays"],
    ["a non-positive retest interval", { retestIntervalsDays: [7, 0] }, "/retestIntervalsDays/1"],
    ["a non-integer retest interval", { retestIntervalsDays: [7.5] }, "/retestIntervalsDays/0"],
    ["retest intervals that are not an array", { retestIntervalsDays: 7 }, "/retestIntervalsDays"],
    ["an unknown setting", { theme: "dark" }, "/theme"],
    ["an unknown age band", { minStatusByAgeBand: { u18: "COMMUNITY" } }, "/minStatusByAgeBand/u18"],
  ];

  for (const [label, body, pointer] of otherPointers) {
    test(`${label} is a 422 with pointer ${pointer}`, async () => {
      const admin = await signUpAdmin();
      const before = rows();

      const res = await put(admin.cookie, body);

      await expectProblem(res, 422, "Unprocessable Entity");
      const { body: problem } = await problemOf(res);
      expect(problem.errors).toEqual([{ pointer, detail: expect.any(String) }]);
      expect(rows()).toEqual(before);
    });
  }

  test("a patch with one valid and one invalid key persists neither, and lists every error", async () => {
    const admin = await signUpAdmin();
    expect((await put(admin.cookie, VALID_PUT)).status).toBe(200);
    const before = rows();

    const res = await put(admin.cookie, {
      aiPlannerEnabled: true, // valid, and different from what is stored
      uploadMaxMb: 0,
      minStatusByAgeBand: { u10: "GOLD" },
    });

    await expectProblem(res, 422, "Unprocessable Entity");
    const { body } = await problemOf(res);
    expect(body.errors?.map((e) => e.pointer).sort()).toEqual(["/minStatusByAgeBand/u10", "/uploadMaxMb"]);
    expect(rows()).toEqual(before);
    expect(getSettings(db)).toEqual(VALID_PUT);
  });

  test("a rejected PUT on a fresh database creates no rows", async () => {
    const admin = await signUpAdmin();

    await put(admin.cookie, { aiPlannerEnabled: false, uploadMaxMb: -1 });

    expect(rows()).toEqual([]);
  });
});

// --- PUT: 400 for a body that is not a JSON object ---------------------------------------------

describe("PUT /api/admin/settings: a body that is not a JSON object is a 400, nothing persisted", () => {
  const bodies: [string, string | undefined][] = [
    ["unparseable JSON", "{not json"],
    ["a truncated object", '{"uploadMaxMb": 5'],
    ["an empty body", undefined],
    ["an array", "[]"],
    ["an array of objects", '[{"uploadMaxMb": 5}]'],
    ["null", "null"],
    ["a string", '"uploadMaxMb"'],
    ["a number", "42"],
    ["a boolean", "true"],
  ];

  for (const [label, raw] of bodies) {
    test(`${label} is a 400 problem+json`, async () => {
      const admin = await signUpAdmin();
      const before = rows();

      const res = await put(admin.cookie, raw);

      await expectProblem(res, 400, "Bad Request");
      expect(rows()).toEqual(before);
    });
  }

  test("the 400 does not echo the parser's message or the body", async () => {
    const admin = await signUpAdmin();

    const { text } = await problemOf(await put(admin.cookie, "{secret-marker: not json"));

    expect(text).not.toContain("secret-marker");
    expect(text.toLowerCase()).not.toContain("unexpected");
    expect(text.toLowerCase()).not.toContain("json parse");
  });
});

// --- no secrets, no stack ---------------------------------------------------------------------

describe("error bodies leak nothing", () => {
  test("401, 403, 400 and 422 bodies carry no stack, secret, token, email or SQL", async () => {
    const admin = await signUpAdmin();
    const contributor = await signUpContributor();
    const token = (db.query("SELECT token FROM session WHERE userId = ?").get(admin.id) as { token: string }).token;
    const responses = [
      await get(),
      await get(contributor.cookie),
      await put(admin.cookie, "{nope"),
      await put(admin.cookie, { uploadMaxMb: 0 }),
      await put(admin.cookie, { minStatusByAgeBand: { u10: "GOLD" }, sneaky: 1 }),
    ];

    for (const res of responses) {
      const text = await res.text();
      expect(text).not.toMatch(/\bat\s.+\(.+:\d+:\d+\)/); // a stack frame
      expect(text).not.toContain(DEV_SECRET);
      expect(text).not.toContain(token);
      expect(text).not.toContain(admin.email);
      expect(text).not.toContain(contributor.email);
      expect(text.toLowerCase()).not.toContain("select ");
      expect(text).not.toContain("stack");
    }
  });

  test("a failing store is a generic 500 problem+json with no internals", async () => {
    const admin = await signUpAdmin();
    db.run("DROP TABLE settings");
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const res of [await get(admin.cookie), await put(admin.cookie, { uploadMaxMb: 5 })]) {
        await expectProblem(res, 500, "Internal Server Error");
        const { text } = await problemOf(res);
        expect(text).not.toContain("settings");
        expect(text).not.toContain("no such table");
        expect(text).not.toContain("stack");
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// --- the next candidate computation sees a change without a restart ------------------------------
//
// There is no planner yet. What it will call to filter candidates is `getSettings(db)`; these
// tests prove that a PUT is visible to that function immediately, and that the route keeps no
// copy of the settings of its own (which a "restart to pick up the change" would need).

describe("a change to minStatusByAgeBand is visible without a restart", () => {
  const bands = (u10: string, u14: string, adult: string) => ({ minStatusByAgeBand: { u10, u14, adult } });

  test("after a PUT, a fresh getSettings(db) returns the new minimum", async () => {
    const admin = await signUpAdmin();
    expect(getSettings(db).minStatusByAgeBand).toEqual(DEFAULT_SETTINGS.minStatusByAgeBand);

    const res = await put(admin.cookie, bands("ACADEMY_VERIFIED", "EXPERT_VERIFIED", "REVIEWED"));

    expect(res.status).toBe(200);
    expect(getSettings(db).minStatusByAgeBand).toEqual({
      u10: "ACADEMY_VERIFIED",
      u14: "EXPERT_VERIFIED",
      adult: "REVIEWED",
    });
  });

  test("two consecutive PUT/GET pairs on the same app instance each reflect their own change", async () => {
    const admin = await signUpAdmin();

    for (const [u10, u14, adult] of [
      ["REVIEWED", "REVIEWED", "EXPERT_VERIFIED"],
      ["ACADEMY_VERIFIED", "COMMUNITY", "REVIEWED"],
    ] as const) {
      const put1 = await put(admin.cookie, bands(u10, u14, adult));
      const got = (await (await get(admin.cookie)).json()) as typeof VALID_PUT;

      expect(((await put1.json()) as typeof VALID_PUT).minStatusByAgeBand).toEqual({ u10, u14, adult });
      expect(got.minStatusByAgeBand).toEqual({ u10, u14, adult });
      expect(getSettings(db).minStatusByAgeBand).toEqual({ u10, u14, adult });
    }
  });

  test("the route caches nothing: a change made behind its back is what the next GET shows", async () => {
    const admin = await signUpAdmin();
    expect(((await (await get(admin.cookie)).json()) as typeof VALID_PUT).minStatusByAgeBand.u10).toBe("COMMUNITY");

    updateSettings(db, bands("EXPERT_VERIFIED", "EXPERT_VERIFIED", "EXPERT_VERIFIED"));

    const after = (await (await get(admin.cookie)).json()) as typeof VALID_PUT;
    expect(after.minStatusByAgeBand).toEqual({
      u10: "EXPERT_VERIFIED",
      u14: "EXPERT_VERIFIED",
      adult: "EXPERT_VERIFIED",
    });
    // and a PUT merges into that stored state, not into an earlier snapshot
    const merged = (await (await put(admin.cookie, { minStatusByAgeBand: { u14: "REVIEWED" } })).json()) as typeof VALID_PUT;
    expect(merged.minStatusByAgeBand).toEqual({ u10: "EXPERT_VERIFIED", u14: "REVIEWED", adult: "EXPERT_VERIFIED" });
  });

  test("a rejected PUT leaves the minimum the planner would see unchanged", async () => {
    const admin = await signUpAdmin();
    expect((await put(admin.cookie, bands("REVIEWED", "REVIEWED", "REVIEWED"))).status).toBe(200);

    const res = await put(admin.cookie, { ...bands("ACADEMY_VERIFIED", "ACADEMY_VERIFIED", "ACADEMY_VERIFIED"), uploadMaxMb: 0 });

    expect(res.status).toBe(422);
    expect(getSettings(db).minStatusByAgeBand).toEqual({ u10: "REVIEWED", u14: "REVIEWED", adult: "REVIEWED" });
  });

  test("every trust status is accepted for every band", async () => {
    const admin = await signUpAdmin();
    for (const status of TRUST_STATUSES) {
      const res = await put(admin.cookie, bands(status, status, status));
      expect(res.status).toBe(200);
      expect(getSettings(db).minStatusByAgeBand).toEqual({ u10: status, u14: status, adult: status });
    }
  });
});
