import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { createApp, type AppDeps } from "../app";
import type { AuthVariables } from "../auth/middleware";
import { RATE_LIMITS, createRateLimitStore } from "../auth/rate-limit";
import { openDatabase } from "../db/database";
import { MIGRATIONS_DIR, migrate } from "../db/migrate";
import { Contribution, ContributionPayloadRequest, ENDPOINTS } from "../shared/contributions";
import { ProblemDetails } from "../shared/primitives";
import {
  DuplicateContributionError,
  assertNotOwnDuplicate,
  contributionLimiter,
  duplicateProblem,
  findOwnDuplicate,
  honeypotFilled,
  rejectHoneypot,
} from "./guards";
import { createContribution } from "./repo";

// The three abuse guards of POST /api/contributions (fc-mol-4ds.4), tested twice:
//   1. as units (the guard functions, on a real in-memory database and a real Hono limiter);
//   2. wired, through the REAL createApp with the real Better Auth handler and the real routes module,
//      because the criteria say "wired into POST /api/contributions before any file is stored".
//
// Readings the criteria leave open (each pinned below):
//   - the honeypot is the contract's `website` field; ANY value other than the empty string (a space, null,
//     a number) is "filled"; the rejection is a 422 on /website with a generic message, and it is decided
//     BEFORE the rest of the payload is judged, so it reveals nothing else;
//   - "undecided" is pending or changes_requested (the states the owner can still edit); a duplicate of an
//     approved, rejected or withdrawn contribution, or of another user's, is not a duplicate;
//   - the 409 names the existing contribution in `instance` (its URL) and in `contributionId`;
//   - the limiter is the `contribution` rule of auth/rate-limit (10 per day per user + IP) and runs FIRST, before
//     the body is read, so a limited caller costs no parsing and stores no byte; a request that the
//     later guards reject still used a unit of budget (probing costs the caller);
//   - only POST is guarded by the duplicate check and the limiter; the honeypot also holds on PUT.

const COLLECTION = ENDPOINTS.createContribution.path; // /api/contributions
const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER = "Zebra-wall-passes-7f3a91";

const validPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "new",
  locale: "ru",
  name: MARKER,
  sport: "football",
  skill: "alternating-touches",
  ageMin: 8,
  ageMax: 12,
  level: "beginner",
  goal: "control",
  instructions: "Pass the ball against the wall.",
  durationMin: 10,
  equipment: "ball_wall",
  mistakes: "",
  progression: "",
  regression: "",
  safety: "",
  source: "My own training notes",
  author: "Coach Aidos",
  rightsAttested: true,
  noCommercialContent: true,
  ...over,
});

const parsedPayload = (over: Record<string, unknown> = {}): ContributionPayloadRequest =>
  ContributionPayloadRequest.parse(validPayload(over));

const problemBody = async (res: Response) => ProblemDetails.parse(await res.json());

// =====================================================================================================
// 1. units
// =====================================================================================================

describe("honeypot guard", () => {
  test("a human's empty `website` and a missing one are not filled", () => {
    expect(honeypotFilled({ website: "" })).toBe(false);
    expect(honeypotFilled({})).toBe(false);
    expect(honeypotFilled(validPayload())).toBe(false);
    expect(rejectHoneypot(validPayload({ website: "" }))).toBeUndefined();
    expect(rejectHoneypot(validPayload())).toBeUndefined();
  });

  test.each([
    ["a url", "https://spam.example"],
    ["a single space", " "],
    ["the word 0", "0"],
    ["null", null],
    ["the number 0", 0],
    ["false", false],
    ["an object", {}],
    ["an array", []],
  ])("a `website` that is %s is filled", (_label, value) => {
    expect(honeypotFilled({ website: value })).toBe(true);
    expect(rejectHoneypot(validPayload({ website: value }))).toBeInstanceOf(Response);
  });

  test("the rejection is a generic 422 problem on /website: it names no trap, echoes no value, judges nothing else", async () => {
    const res = rejectHoneypot(validPayload({ website: "https://spam.example/buy-now", name: "", ageMin: -1 }))!;
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await problemBody(res);
    expect(body.status).toBe(422);
    expect(body.title).toBe("Unprocessable Entity");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.pointer).toBe("/website");
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/honeypot|\bbot\b|spam|robot|captcha|trap/i);
    expect(text).not.toContain("buy-now");
    expect(text).not.toContain("/name");
    expect(text).not.toContain("/ageMin");
  });

  test("the answer is the same whatever the filled value was", async () => {
    const a = await (rejectHoneypot({ website: "x" })!).text();
    const b = await (rejectHoneypot({ website: "something else entirely" })!).text();
    expect(a).toBe(b);
  });
});

describe("duplicate guard", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db, MIGRATIONS_DIR);
  });
  afterEach(() => db.close());

  const submit = (userId: string, over: Record<string, unknown> = {}, at = new Date()) =>
    createContribution(db, { userId, payload: parsedPayload(over), now: at });
  const setState = (id: string, state: string) => db.run("UPDATE contributions SET state = ? WHERE id = ?", [state, id]);

  test("the same user's pending contribution with the same content is found: its id comes back", () => {
    const existing = submit("alice");
    expect(findOwnDuplicate(db, "alice", parsedPayload())).toBe(existing.id);
  });

  test("changes_requested is still undecided", () => {
    const existing = submit("alice");
    setState(existing.id, "changes_requested");
    expect(findOwnDuplicate(db, "alice", parsedPayload())).toBe(existing.id);
  });

  test.each(["approved", "rejected", "withdrawn"])("a %s contribution is decided: the same content is not a duplicate of it", (state) => {
    const existing = submit("alice");
    setState(existing.id, state);
    expect(findOwnDuplicate(db, "alice", parsedPayload())).toBeNull();
  });

  test("another user's identical contribution is not a duplicate for this user (and its id is never returned)", () => {
    submit("bob");
    expect(findOwnDuplicate(db, "alice", parsedPayload())).toBeNull();
  });

  test("content that differs in any hashed field is not a duplicate", () => {
    submit("alice");
    expect(findOwnDuplicate(db, "alice", parsedPayload({ name: `${MARKER} 2` }))).toBeNull();
    expect(findOwnDuplicate(db, "alice", parsedPayload({ ageMax: 13 }))).toBeNull();
    expect(findOwnDuplicate(db, "alice", parsedPayload({ instructions: "Something else." }))).toBeNull();
  });

  test("it is an EXACT content match by the repository's hash: whitespace and key order do not hide a duplicate", () => {
    const existing = submit("alice");
    const reordered = ContributionPayloadRequest.parse(
      Object.fromEntries(Object.entries(validPayload({ name: `  ${MARKER}  `, website: "" })).reverse()),
    );
    expect(findOwnDuplicate(db, "alice", reordered)).toBe(existing.id);
  });

  test("with several undecided copies the OLDEST one is named, deterministically", () => {
    const first = submit("alice", {}, new Date("2026-01-01T10:00:00.000Z"));
    submit("alice", {}, new Date("2026-01-02T10:00:00.000Z"));
    expect(findOwnDuplicate(db, "alice", parsedPayload())).toBe(first.id);
  });

  test("assertNotOwnDuplicate throws a DuplicateContributionError carrying the existing id, and returns quietly otherwise", () => {
    expect(() => assertNotOwnDuplicate(db, "alice", parsedPayload())).not.toThrow();
    const existing = submit("alice");
    try {
      assertNotOwnDuplicate(db, "alice", parsedPayload());
      throw new Error("expected a DuplicateContributionError");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateContributionError);
      expect((error as DuplicateContributionError).existingId).toBe(existing.id);
    }
  });

  test("the 409 problem points at the existing contribution", async () => {
    const res = duplicateProblem("abc-123");
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await problemBody(res);
    expect(body.status).toBe(409);
    expect(body.title).toBe("Conflict");
    expect(body.instance).toBe(`${COLLECTION}/abc-123`);
    expect((body as Record<string, unknown>).contributionId).toBe("abc-123");
    expect(body.detail).toContain("abc-123");
  });
});

describe("per-user daily limiter", () => {
  const appWith = (options: Parameters<typeof contributionLimiter>[0]) => {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use("*", async (c, next) => {
      c.set("playerId", c.req.header("x-user") ?? "");
      await next();
    });
    let reached = 0;
    app.post("/x", contributionLimiter(options), (c) => {
      reached += 1;
      return c.json({ ok: true });
    });
    return { app, reached: () => reached };
  };
  const hit = (app: Hono<{ Variables: AuthVariables }>, user: string) =>
    app.request("/x", { method: "POST", headers: { "x-user": user } });

  test("the budget is the `contribution` rule: the 11th request of the day is a 429 problem with Retry-After, and never reaches the handler", async () => {
    expect(RATE_LIMITS.contribution.max).toBe(10);
    const { app, reached } = appWith({ store: createRateLimitStore(), now: () => 1_000_000 });
    for (let i = 0; i < RATE_LIMITS.contribution.max; i++) expect((await hit(app, "alice")).status).toBe(200);
    const res = await hit(app, "alice");
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(Number(res.headers.get("retry-after"))).toBe(24 * 60 * 60);
    expect((await problemBody(res)).status).toBe(429);
    expect(reached()).toBe(10);
  });

  test("the window is a day: still limited a second before it ends, free again when it has passed", async () => {
    let now = 5_000_000;
    const { app } = appWith({ store: createRateLimitStore(), now: () => now });
    for (let i = 0; i < 10; i++) await hit(app, "alice");
    now += DAY_MS - 1000;
    const late = await hit(app, "alice");
    expect(late.status).toBe(429);
    expect(Number(late.headers.get("retry-after"))).toBe(1);
    now += 1000;
    expect((await hit(app, "alice")).status).toBe(200);
  });

  test("users do not share a bucket", async () => {
    const { app } = appWith({ store: createRateLimitStore(), now: () => 1_000 });
    for (let i = 0; i < 10; i++) await hit(app, "alice");
    expect((await hit(app, "alice")).status).toBe(429);
    expect((await hit(app, "bob")).status).toBe(200);
  });
});

// =====================================================================================================
// 2. wired through the real app
// =====================================================================================================

const ROUTES_DIR_FILES = ["auth.routes.ts", "contributions.routes.ts"] as const;
const SOURCE_DIR = resolve(import.meta.dir, "../http/routes");
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS", "MEDIA_DIR"] as const;

describe("wired into POST /api/contributions", () => {
  let dir: string;
  let mediaDir: string;
  let db: Database;
  let app: Hono;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    dir = mkdtempSync(join(tmpdir(), "contribution-guards-"));
    mediaDir = join(dir, "media");
    process.env.MEDIA_DIR = mediaDir;
    db = openDatabase(":memory:");
    migrate(db, MIGRATIONS_DIR);
    const routesDir = join(dir, "routes");
    mkdirSync(routesDir, { recursive: true });
    for (const file of ROUTES_DIR_FILES) {
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

  // --- real sessions ---------------------------------------------------------------------------------
  const postJson = (path: string, body: unknown) =>
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
  async function signUp(email: string): Promise<Actor> {
    const res = await postJson("/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD });
    const body = (await res.json()) as { user: { id: string } };
    return { cookie: cookieOf(res), id: body.user.id };
  }
  async function signInPlayer(): Promise<Actor> {
    const res = await postJson("/api/auth/sign-in/anonymous", {});
    const body = (await res.json()) as { user: { id: string } };
    return { cookie: cookieOf(res), id: body.user.id };
  }

  // --- real bytes ------------------------------------------------------------------------------------
  const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
  const mp4File = (name = "clip.mp4"): File =>
    new File(
      [new Uint8Array([0, 0, 0, 24, ...ascii("ftyp"), ...ascii("isom"), 0, 0, 2, 0, ...ascii("isom"), ...ascii("mp42"), ...new Array<number>(64).fill(0)])],
      name,
      { type: "video/mp4" },
    );
  const pngFile = (name = "diagram.png"): File =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(32).fill(7)])], name, { type: "image/png" });

  function form(payload: unknown, parts: { video?: File; files?: File[] } = {}): FormData {
    const fd = new FormData();
    fd.set("payload", typeof payload === "string" ? payload : JSON.stringify(payload));
    if (parts.video) fd.append("video", parts.video);
    for (const f of parts.files ?? []) fd.append("files", f);
    return fd;
  }

  const create = (actor: Actor, body: FormData | string) =>
    app.request(COLLECTION, { method: "POST", headers: { cookie: actor.cookie }, body });
  const put = (actor: Actor, id: string, body: FormData) =>
    app.request(`${COLLECTION}/${id}`, { method: "PUT", headers: { cookie: actor.cookie }, body });
  async function createOk(actor: Actor, over: Record<string, unknown> = {}, parts: { video?: File; files?: File[] } = {}): Promise<Contribution> {
    const res = await create(actor, form(validPayload(over), parts));
    expect(res.status).toBe(201);
    return Contribution.parse(await res.json());
  }

  // --- observations ----------------------------------------------------------------------------------
  const mediaFiles = (): string[] => (existsSync(mediaDir) ? readdirSync(mediaDir).sort() : []);
  const count = (table: string): number => (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  const expectNothingStored = () => {
    expect(count("contributions")).toBe(0);
    expect(count("contribution_attachments")).toBe(0);
    expect(mediaFiles()).toEqual([]);
  };
  const setState = (id: string, state: string) => db.run("UPDATE contributions SET state = ? WHERE id = ?", [state, id]);

  // --- honeypot --------------------------------------------------------------------------------------
  describe("honeypot", () => {
    test("a filled `website` is a generic 422 on /website: nothing stored, the other invalid fields are not reported", async () => {
      const alice = await signUp("alice@example.com");
      const res = await create(alice, form(validPayload({ website: "https://spam.example", name: "" }), { video: mp4File(), files: [pngFile()] }));
      expect(res.status).toBe(422);
      const body = await problemBody(res);
      expect(body.errors.map((e) => e.pointer)).toEqual(["/website"]);
      expect(JSON.stringify(body)).not.toMatch(/honeypot|\bbot\b|spam|captcha/i);
      expectNothingStored();
    });

    test("a `website` that is not a string is rejected the same way", async () => {
      const alice = await signUp("alice@example.com");
      const res = await create(alice, form(validPayload({ website: null }), { video: mp4File() }));
      expect(res.status).toBe(422);
      expect((await problemBody(res)).errors.map((e) => e.pointer)).toEqual(["/website"]);
      expectNothingStored();
    });

    test("an empty `website` is what a human sends: accepted", async () => {
      const alice = await signUp("alice@example.com");
      expect((await createOk(alice, { website: "" })).state).toBe("pending");
    });

    test("PUT keeps rejecting a filled honeypot and leaves the stored contribution untouched", async () => {
      const alice = await signUp("alice@example.com");
      const created = await createOk(alice, {}, { files: [pngFile()] });
      const before = mediaFiles();
      const res = await put(alice, created.id, form(validPayload({ website: "x", name: "changed" }), { video: mp4File() }));
      expect(res.status).toBe(422);
      expect((await problemBody(res)).errors.map((e) => e.pointer)).toEqual(["/website"]);
      expect(mediaFiles()).toEqual(before);
      expect((db.query("SELECT payload FROM contributions WHERE id = ?").get(created.id) as { payload: string }).payload).toContain(MARKER);
    });
  });

  // --- duplicates ------------------------------------------------------------------------------------
  describe("duplicate of the user's own undecided contribution", () => {
    test("the second identical submission is a 409 that points at the first; nothing more is stored", async () => {
      const alice = await signUp("alice@example.com");
      const first = await createOk(alice, {}, { files: [pngFile()] });
      const filesBefore = mediaFiles();

      const res = await create(alice, form(validPayload(), { video: mp4File(), files: [pngFile("other.png")] }));
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      const body = await problemBody(res);
      expect(body.title).toBe("Conflict");
      expect(body.instance).toBe(`${COLLECTION}/${first.id}`);
      expect((body as Record<string, unknown>).contributionId).toBe(first.id);
      expect(count("contributions")).toBe(1);
      expect(count("contribution_attachments")).toBe(1);
      expect(mediaFiles()).toEqual(filesBefore);
    });

    test("the duplicate is refused BEFORE its files are looked at: a duplicate with an unusable file is a 409, not a 415", async () => {
      const alice = await signUp("alice@example.com");
      await createOk(alice);
      const notAVideo = new File([new Uint8Array(64).fill(65)], "clip.mp4", { type: "video/mp4" });
      const res = await create(alice, form(validPayload(), { video: notAVideo }));
      expect(res.status).toBe(409);
      expect(mediaFiles()).toEqual([]);
    });

    test("attachments do not make a submission different: the content is the payload", async () => {
      const alice = await signUp("alice@example.com");
      await createOk(alice);
      const res = await create(alice, form(validPayload(), { files: [pngFile()] }));
      expect(res.status).toBe(409);
      expect(mediaFiles()).toEqual([]);
    });

    test("different content is accepted", async () => {
      const alice = await signUp("alice@example.com");
      await createOk(alice);
      await createOk(alice, { name: `${MARKER} again` });
      expect(count("contributions")).toBe(2);
    });

    test("a duplicate of a contribution that was decided or withdrawn is accepted", async () => {
      const alice = await signUp("alice@example.com");
      const first = await createOk(alice);
      for (const state of ["rejected", "approved", "withdrawn"]) {
        setState(first.id, state);
        await createOk(alice);
        db.run("DELETE FROM contributions WHERE id != ?", [first.id]);
      }
      expect(count("contributions")).toBe(1);
    });

    test("another user's identical pending contribution is not a duplicate", async () => {
      const alice = await signUp("alice@example.com");
      const bob = await signUp("bob@example.com");
      await createOk(alice);
      const bobs = await createOk(bob);
      expect(bobs.state).toBe("pending");
      expect(count("contributions")).toBe(2);
    });

    test("an invalid payload is still a 422, not a 409: the duplicate check judges valid content only", async () => {
      const alice = await signUp("alice@example.com");
      await createOk(alice);
      const res = await create(alice, form(validPayload({ ageMin: -1 })));
      expect(res.status).toBe(422);
    });

    test("two identical requests at once, with files, yield one 201 and one 409, one row and one set of files", async () => {
      const alice = await signUp("alice@example.com");
      const [a, b] = await Promise.all([
        create(alice, form(validPayload(), { video: mp4File("a.mp4"), files: [pngFile("a.png")] })),
        create(alice, form(validPayload(), { video: mp4File("b.mp4"), files: [pngFile("b.png")] })),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(count("contributions")).toBe(1);
      expect(count("contribution_attachments")).toBe(2);
      expect(mediaFiles()).toHaveLength(2);
    });

    test("PUT is not a duplicate check: resubmitting a contribution with its own unchanged content is a 200", async () => {
      const alice = await signUp("alice@example.com");
      const first = await createOk(alice);
      const res = await put(alice, first.id, form(validPayload()));
      expect(res.status).toBe(200);
    });
  });

  // --- limiter ---------------------------------------------------------------------------------------
  describe("per-user daily limiter", () => {
    const fill = async (actor: Actor, n: number) => {
      for (let i = 0; i < n; i++) await createOk(actor, { name: `${MARKER} ${i}` });
    };

    test("the 11th contribution of the day is a 429 problem with Retry-After and no byte is stored for it", async () => {
      const alice = await signUp("alice@example.com");
      await fill(alice, RATE_LIMITS.contribution.max);
      const res = await create(alice, form(validPayload({ name: "the eleventh" }), { video: mp4File(), files: [pngFile()] }));
      expect(res.status).toBe(429);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(count("contributions")).toBe(10);
      expect(count("contribution_attachments")).toBe(0);
      expect(mediaFiles()).toEqual([]);
    });

    test("the limiter comes first: a limited caller gets 429 whatever else is wrong with the request, and the body is not judged", async () => {
      const alice = await signUp("alice@example.com");
      await fill(alice, 10);
      const variants: [string, FormData | string][] = [
        ["not multipart", "just text"],
        ["a filled honeypot", form(validPayload({ website: "x" }), { video: mp4File() })],
        ["a duplicate", form(validPayload({ name: `${MARKER} 0` }), { video: mp4File() })],
        ["an invalid payload", form(validPayload({ ageMin: -1 }), { files: [pngFile()] })],
      ];
      for (const [label, body] of variants) {
        const res = await create(alice, body);
        expect({ label, status: res.status }).toEqual({ label, status: 429 });
      }
      expect(mediaFiles()).toEqual([]);
      expect(count("contributions")).toBe(10);
    });

    test("a submission that the other guards reject still uses a unit of the budget", async () => {
      const alice = await signUp("alice@example.com");
      for (let i = 0; i < 10; i++) {
        expect((await create(alice, form(validPayload({ website: "x" })))).status).toBe(422);
      }
      expect((await create(alice, form(validPayload()))).status).toBe(429);
      expect(count("contributions")).toBe(0);
    });

    test("users do not share a bucket: bob is not limited by alice", async () => {
      const alice = await signUp("alice@example.com");
      const bob = await signUp("bob@example.com");
      await fill(alice, 10);
      expect((await create(alice, form(validPayload({ name: "over" })))).status).toBe(429);
      expect((await createOk(bob)).state).toBe("pending");
    });

    test("only POST is limited: alice can still list and edit her contributions", async () => {
      const alice = await signUp("alice@example.com");
      await fill(alice, 10);
      const list = await app.request(ENDPOINTS.listMine.path, { headers: { cookie: alice.cookie } });
      expect(list.status).toBe(200);
      const first = (await list.json()) as { id: string }[];
      const res = await put(alice, first[0]!.id, form(validPayload({ name: "edited" })));
      expect(res.status).toBe(200);
    });

    test("authorisation is decided before the limiter: no session is 401 and an anonymous player 403, neither uses budget", async () => {
      const player = await signInPlayer();
      const alice = await signUp("alice@example.com");
      const anonymous = await app.request(COLLECTION, { method: "POST", body: form(validPayload()) });
      expect(anonymous.status).toBe(401);
      for (let i = 0; i < 12; i++) expect((await create(player, form(validPayload()))).status).toBe(403);
      await fill(alice, 10);
      expect(count("contributions")).toBe(10);
    });
  });

  test("the guards keep the route's existing caps: a `payload` part over 256 KiB is still a 413 and nothing is stored", async () => {
    const alice = await signUp("alice@example.com");
    const res = await create(alice, form(validPayload({ instructions: "x".repeat(300 * 1024) }), { video: mp4File() }));
    expect(res.status).toBe(413);
    expectNothingStored();
  });
});
