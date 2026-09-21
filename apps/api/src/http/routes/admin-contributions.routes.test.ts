import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { createContribution } from "../../contributions/repo";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import { DecisionResponse, ENDPOINTS, ModerationQueueResponse } from "../../shared/admin";
import type { ModerationQueueItem } from "../../shared/admin";
import type { ContributionPayloadRequest } from "../../shared/contributions";
import { PROBLEM_CONTENT_TYPE } from "../../shared/primitives";

// Every test runs the real createApp on a fresh in-memory database migrated with the real migrations
// and loaded with the REAL seed, with the REAL Better Auth handler mounted (auth.routes.ts) next to the
// route under test. Sessions are real: an actor signs up (or signs in anonymously) through /api/auth/*
// and the request carries the Set-Cookie it got back; the admin is promoted by a direct UPDATE of the
// user row (bootstrap is out-of-band), as the auth middleware and settings route tests do. Contributions
// are created through the merged repo (createContribution). No fake sessions, no mocked services.

const ROUTES_DIR_FILES = ["admin-contributions.routes.ts", "auth.routes.ts"] as const;
const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const LIST_PATH = ENDPOINTS.listContributions.path;
const decisionPath = (id: string) => ENDPOINTS.decideContribution.path.replace(":id", id);
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS"] as const;

const T_SEED = new Date("2026-01-01T00:00:00.000Z");
const T_CREATED = new Date("2026-03-01T10:00:00.000Z");
const DRILL_SLUG = "ball-mastery-sole-rolls";

let dir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

/** A real createApp that mounts only the route under test and the real Better Auth handler. */
async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTES_DIR_FILES) {
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
  dir = mkdtempSync(join(tmpdir(), "admin-contributions-routes-"));
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR, { now: () => T_SEED });
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

type Actor = { cookie: string; id: string; email: string; name: string };

async function signInPlayer(): Promise<Actor> {
  const res = await post("/api/auth/sign-in/anonymous", {});
  const body = (await res.json()) as { user: { id: string; email: string; name: string } };
  return { cookie: cookieOf(res), id: body.user.id, email: body.user.email, name: body.user.name };
}

async function signUpContributor(email = "contrib@example.com", name = "Coach Contributor"): Promise<Actor> {
  const res = await post("/api/auth/sign-up/email", { name, email, password: PASSWORD });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id, email, name };
}

/** A non-anonymous account whose stored role string is exactly `role`. */
async function signUpWithRole(role: string, email: string, name: string): Promise<Actor> {
  const actor = await signUpContributor(email, name);
  db.run("UPDATE user SET role = ? WHERE id = ?", [role, actor.id]);
  return actor;
}

const signUpAdmin = () => signUpWithRole("admin", "boss@example.com", "Admin Aidar");

// --- requests ---------------------------------------------------------------------------------

const list = (cookie?: string, query = "") => app.request(`${LIST_PATH}${query}`, { headers: cookie ? { cookie } : {} });

/** `body` is JSON-encoded unless it is already a string (to send malformed JSON verbatim). */
const decide = (cookie: string | undefined, id: string, body?: unknown) =>
  app.request(decisionPath(id), {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const problemOf = async (res: Response) =>
  (await res.clone().json()) as {
    type: string;
    title: string;
    status: number;
    detail?: string;
    errors?: { pointer: string; detail: string }[];
  };

const pointersOf = async (res: Response): Promise<string[]> => ((await problemOf(res)).errors ?? []).map((e) => e.pointer);

/** A 4xx answer that is an RFC 9457 problem whose body status is the HTTP status. */
async function expectProblem(res: Response, status: number): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  expect((await problemOf(res)).status).toBe(status);
}

// --- fixtures ---------------------------------------------------------------------------------

const newPayload = (over: Partial<ContributionPayloadRequest> = {}): ContributionPayloadRequest => ({
  kind: "new",
  locale: "ru",
  name: "Wall passes",
  sport: "football",
  skill: "alternating-touches",
  ageMin: 8,
  ageMax: 12,
  level: "beginner",
  goal: "control",
  instructions: "Pass the ball against the wall.\nTake it with the inside of the foot.",
  durationMin: 10,
  equipment: "ball_wall",
  mistakes: "Passing too hard\nLooking only at the ball",
  progression: "Use only the weaker foot",
  regression: "Stand closer to the wall",
  safety: "Keep away from windows",
  source: "My own training notes",
  sourceUrl: "https://example.com/wall",
  author: "Coach Aidos",
  rightsAttested: true,
  noCommercialContent: true,
  ...over,
});

const improvementPayload = (over: Partial<ContributionPayloadRequest> = {}): ContributionPayloadRequest =>
  newPayload({
    kind: "improvement",
    targetDrillSlug: DRILL_SLUG,
    improvementKind: "safety",
    name: "Перекаты подошвой",
    instructions: "Катай мяч подошвой вперёд.\nПотом назад.",
    mistakes: "Слишком сильно давить на мяч",
    progression: "",
    regression: "",
    safety: "Носи удобную обувь",
    author: "Coach Bota",
    source: "Bota's notes",
    sourceUrl: "https://example.com/bota",
    ...over,
  });

const submit = (userId: string, payload: ContributionPayloadRequest = newPayload(), now: Date = T_CREATED): string =>
  createContribution(db, { userId, payload, now }).id;

const count = (table: string): number => (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
const stateOf = (id: string): string => (db.query("SELECT state FROM contributions WHERE id = ?").get(id) as { state: string }).state;
const payloadColumnOf = (id: string): string => (db.query("SELECT payload FROM contributions WHERE id = ?").get(id) as { payload: string }).payload;

type Snapshot = { drills: number; versions: number; reviews: number; state: string; payload: string };
/** Everything a decision could write, so "nothing was written" compares the whole. */
const snapshot = (id: string): Snapshot => ({
  drills: count("drills"),
  versions: count("drill_versions"),
  reviews: count("reviews"),
  state: stateOf(id),
  payload: payloadColumnOf(id),
});

const queue = async (cookie: string, query = ""): Promise<ModerationQueueItem[]> => {
  const res = await list(cookie, query);
  expect(res.status).toBe(200);
  return ModerationQueueResponse.parse(await res.json());
};

// --- access: requireAdmin runs before anything else ---------------------------------------------

describe("access control", () => {
  test("no session is 401 on both routes and nothing is written", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const id = submit(alice.id);
    const before = snapshot(id);

    await expectProblem(await list(undefined), 401);
    await expectProblem(await decide(undefined, id, { action: "approve" }), 401);
    expect(snapshot(id)).toEqual(before);
  });

  test("an anonymous player session is 403 on every route", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const id = submit(alice.id);
    const before = snapshot(id);
    const player = await signInPlayer();

    await expectProblem(await list(player.cookie), 403);
    await expectProblem(await list(player.cookie, "?state=pending"), 403);
    await expectProblem(await decide(player.cookie, id, { action: "approve" }), 403);
    expect(snapshot(id)).toEqual(before);
  });

  test("a contributor session (the submitter included) is 403 on every route and nothing is written", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const bob = await signUpContributor("bob@example.com", "Bob");
    const id = submit(alice.id);
    const before = snapshot(id);

    for (const actor of [alice, bob]) {
      const listed = await list(actor.cookie);
      await expectProblem(listed, 403);
      expect(await listed.clone().text()).not.toContain("Wall passes");
      await expectProblem(await decide(actor.cookie, id, { action: "approve" }), 403);
      await expectProblem(await decide(actor.cookie, id, { action: "reject", note: "no" }), 403);
    }
    expect(snapshot(id)).toEqual(before);
  });

  test("the guard runs before the body is read: a contributor sending garbage still gets 403, not 422 or 400", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const id = submit(alice.id);

    await expectProblem(await decide(alice.cookie, id, { action: "explode", edits: { author: "x" } }), 403);
    await expectProblem(await decide(alice.cookie, id, "{not json"), 403);
  });

  test("a banned admin is 403, and a role that merely contains 'admin' is not an admin", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const id = submit(alice.id);
    const before = snapshot(id);

    const banned = await signUpWithRole("admin", "banned@example.com", "Banned Admin");
    db.run("UPDATE user SET banned = 1 WHERE id = ?", [banned.id]);
    const superadmin = await signUpWithRole("superadmin", "super@example.com", "Super Admin");

    for (const actor of [banned, superadmin]) {
      await expectProblem(await list(actor.cookie), 403);
      await expectProblem(await decide(actor.cookie, id, { action: "approve" }), 403);
    }
    expect(snapshot(id)).toEqual(before);
  });

  test("an admin passes both routes", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const id = submit(alice.id);
    const admin = await signUpAdmin();

    expect((await list(admin.cookie)).status).toBe(200);
    expect((await decide(admin.cookie, id, { action: "reject", note: "Not now" })).status).toBe(200);
  });
});

// --- GET /api/admin/contributions -----------------------------------------------------------------

describe("GET /api/admin/contributions", () => {
  test("lists every contribution with its FULL payload and the submitter's id and name", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice Coach");
    const payload = newPayload();
    const id = submit(alice.id, payload);
    const admin = await signUpAdmin();

    const items = await queue(admin.cookie);
    const item = items.find((entry) => entry.contribution.id === id)!;
    expect(item).toBeDefined();
    expect(item.contribution.state).toBe("pending");
    // The whole payload, so a review needs no second call.
    expect(item.contribution.payload).toMatchObject({
      kind: "new",
      name: "Wall passes",
      instructions: payload.instructions,
      mistakes: payload.mistakes,
      safety: payload.safety,
      author: "Coach Aidos",
      durationMin: 10,
    });
    expect(item.submitter).toEqual({ id: alice.id, name: "Alice Coach" });
    expect("diff" in item).toBe(false);
    expect("duplicateOf" in item).toBe(false);
  });

  test("?state filters to that state; without it every state comes back", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const pending = submit(alice.id, newPayload({ name: "Pending one" }));
    const toReject = submit(alice.id, newPayload({ name: "To reject" }));
    const toChange = submit(alice.id, newPayload({ name: "To change" }));
    const toApprove = submit(alice.id, newPayload({ name: "To approve" }));
    expect((await decide(admin.cookie, toReject, { action: "reject", note: "No" })).status).toBe(200);
    expect((await decide(admin.cookie, toChange, { action: "request_changes", note: "Fix" })).status).toBe(200);
    expect((await decide(admin.cookie, toApprove, { action: "approve" })).status).toBe(200);

    const idsOf = (items: ModerationQueueItem[]) => items.map((item) => item.contribution.id).sort();
    expect(idsOf(await queue(admin.cookie, "?state=pending"))).toEqual([pending]);
    expect(idsOf(await queue(admin.cookie, "?state=rejected"))).toEqual([toReject]);
    expect(idsOf(await queue(admin.cookie, "?state=changes_requested"))).toEqual([toChange]);
    expect(idsOf(await queue(admin.cookie, "?state=approved"))).toEqual([toApprove]);
    expect(idsOf(await queue(admin.cookie))).toEqual([pending, toReject, toChange, toApprove].sort());
  });

  test("an unknown state, a repeated state and an unknown query key are 422 with a pointer", async () => {
    const admin = await signUpAdmin();

    const bogus = await list(admin.cookie, "?state=bogus");
    await expectProblem(bogus, 422);
    expect(await pointersOf(bogus)).toContain("/state");

    await expectProblem(await list(admin.cookie, "?state=pending&state=rejected"), 422);

    const extra = await list(admin.cookie, "?colour=red");
    await expectProblem(extra, 422);
    expect(await pointersOf(extra)).toContain("/colour");
  });

  test("an improvement carries the diff against the current version: changed fields only, in its own locale", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const id = submit(alice.id, improvementPayload());
    const admin = await signUpAdmin();

    const item = (await queue(admin.cookie, "?state=pending")).find((entry) => entry.contribution.id === id)!;
    const diff = item.diff!;
    expect(diff).toBeDefined();
    const fields = diff.map((entry) => entry.field);
    // Changed: the instructions text and the attribution of the improver.
    expect(fields).toContain("instructions.ru");
    expect(fields).toContain("author");
    // Unchanged: the title is the seed's own Russian title, so it is omitted.
    expect(fields).not.toContain("name.ru");
    const instructions = diff.find((entry) => entry.field === "instructions.ru")!;
    expect(instructions.before).toContain("Поставь подошву правой ноги");
    expect(instructions.after).toBe("Катай мяч подошвой вперёд.\nПотом назад.");
    // Only the payload's locale is compared.
    expect(fields.some((field) => field.endsWith(".kk") || field.endsWith(".en"))).toBe(false);
    expect(diff.find((entry) => entry.field === "author")).toMatchObject({ before: "FIRST COACH Genesis", after: "Coach Bota" });
  });

  test("duplicateOf names the other contribution when the content hash matches, and only then", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const bob = await signUpContributor("bob@example.com", "Bob");
    const first = submit(alice.id, newPayload(), new Date("2026-03-01T10:00:00.000Z"));
    // Same content, different submitter and moment: a content-hash match.
    const second = submit(bob.id, newPayload(), new Date("2026-03-02T10:00:00.000Z"));
    const unrelated = submit(alice.id, newPayload({ name: "Something else entirely" }));
    const admin = await signUpAdmin();

    const items = await queue(admin.cookie);
    const byId = (id: string) => items.find((entry) => entry.contribution.id === id)!;
    expect(byId(second).duplicateOf).toBe(first);
    expect(byId(first).duplicateOf).toBe(second);
    expect("duplicateOf" in byId(unrelated)).toBe(false);
  });

  test("an approved improvement has no diff: its change is already the current version", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id, improvementPayload());
    expect((await decide(admin.cookie, id, { action: "approve" })).status).toBe(200);

    const item = (await queue(admin.cookie, "?state=approved")).find((entry) => entry.contribution.id === id)!;
    expect("diff" in item).toBe(false);
    expect(item.contribution.resultingDrillSlug).toBe(DRILL_SLUG);
  });
});

// --- POST /api/admin/contributions/:id/decision -------------------------------------------------------

describe("POST decision: approve", () => {
  test("approving a new contribution returns the created DrillDetail in the SAME response", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);
    const drillsBefore = count("drills");

    const res = await decide(admin.cookie, id, { action: "approve" });
    expect(res.status).toBe(200);
    const body = DecisionResponse.parse(await res.json());
    expect(body.contribution.id).toBe(id);
    expect(body.contribution.state).toBe("approved");
    expect(count("drills")).toBe(drillsBefore + 1);

    const drill = body.drill!;
    expect(drill).toBeDefined();
    expect(body.contribution.resultingDrillSlug).toBe(drill.slug);
    expect(drill.content.title?.ru).toBe("Wall passes");
    expect(drill.history.map((entry) => entry.semver)).toEqual(["1.0.0"]);
    const current = db.query("SELECT v.id AS id, v.semver AS semver FROM drills d JOIN drill_versions v ON v.id = d.current_version_id WHERE d.slug = ?").get(drill.slug) as { id: string; semver: string };
    expect(drill.versionId).toBe(current.id);
    expect(current.semver).toBe("1.0.0");
  });

  test("an omitted status is COMMUNITY; a given status is used; the review row is the SESSION admin's", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const community = submit(alice.id, newPayload({ name: "Community drill" }));
    const reviewed = submit(alice.id, newPayload({ name: "Reviewed drill" }));

    const a = DecisionResponse.parse(await (await decide(admin.cookie, community, { action: "approve" })).json());
    const b = DecisionResponse.parse(await (await decide(admin.cookie, reviewed, { action: "approve", status: "REVIEWED", note: "Checked on the pitch" })).json());

    const statusOf = (versionId: string) => (db.query("SELECT status FROM drill_versions WHERE id = ?").get(versionId) as { status: string }).status;
    expect(statusOf(a.drill!.versionId)).toBe("COMMUNITY");
    expect(statusOf(b.drill!.versionId)).toBe("REVIEWED");

    const review = db.query("SELECT reviewer, reviewer_user_id AS userId, to_status AS toStatus, note FROM reviews WHERE drill_version_id = ?").get(b.drill!.versionId) as {
      reviewer: string;
      userId: string;
      toStatus: string;
      note: string;
    };
    expect(review).toEqual({ reviewer: "Admin Aidar", userId: admin.id, toStatus: "REVIEWED", note: "Checked on the pitch" });
  });

  test("approving an improvement creates the next minor version and keeps the old one readable", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id, improvementPayload());

    const res = await decide(admin.cookie, id, { action: "approve" });
    expect(res.status).toBe(200);
    const body = DecisionResponse.parse(await res.json());
    expect(body.drill!.slug).toBe(DRILL_SLUG);
    expect(body.drill!.history.map((entry) => entry.semver)).toEqual(["1.1.0", "1.0.0"]);
    expect(body.drill!.versionId).toBe(`${DRILL_SLUG}-v1.1.0`);
    expect((db.query("SELECT semver FROM drill_versions WHERE id = ?").get(`${DRILL_SLUG}-v1.0.0`) as { semver: string }).semver).toBe("1.0.0");
  });

  test("the contributor stays the author when the admin edits the content; the edits are applied", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);

    const res = await decide(admin.cookie, id, { action: "approve", edits: { name: "Edited wall passes", durationMin: 12 } });
    expect(res.status).toBe(200);
    const body = DecisionResponse.parse(await res.json());
    expect(body.drill!.content.title?.ru).toBe("Edited wall passes");
    expect(body.contribution.payload.name).toBe("Edited wall passes");
    const version = db.query("SELECT author_name AS name, author_user_id AS userId, minutes FROM drill_versions WHERE id = ?").get(body.drill!.versionId) as {
      name: string;
      userId: string;
      minutes: number;
    };
    expect(version).toEqual({ name: "Coach Aidos", userId: alice.id, minutes: 12 });
  });
});

describe("POST decision: request_changes and reject", () => {
  test("reject stores the note and moves the contribution to rejected", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);
    const drills = count("drills");

    const res = await decide(admin.cookie, id, { action: "reject", note: "Not suitable for this age" });
    expect(res.status).toBe(200);
    const body = DecisionResponse.parse(await res.json());
    expect(body.contribution.state).toBe("rejected");
    expect(body.contribution.reviewerNote).toBe("Not suitable for this age");
    expect("drill" in body).toBe(false);
    expect(count("drills")).toBe(drills);
  });

  test("request_changes stores the note and moves the contribution to changes_requested", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);

    const res = await decide(admin.cookie, id, { action: "request_changes", note: "Add a safety line" });
    expect(res.status).toBe(200);
    const body = DecisionResponse.parse(await res.json());
    expect(body.contribution.state).toBe("changes_requested");
    expect(body.contribution.reviewerNote).toBe("Add a safety line");
  });
});

describe("POST decision: a missing required note is 422 with pointer /note", () => {
  test.each([
    ["reject", { action: "reject" }],
    ["reject with a blank note", { action: "reject", note: "   " }],
    ["request_changes", { action: "request_changes" }],
    ["approve as EXPERT_VERIFIED", { action: "approve", status: "EXPERT_VERIFIED" }],
    ["approve as ACADEMY_VERIFIED", { action: "approve", status: "ACADEMY_VERIFIED", orgLabel: "Academy" }],
  ])("%s", async (_name, body) => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);
    const before = snapshot(id);

    const res = await decide(admin.cookie, id, body);
    await expectProblem(res, 422);
    expect(await pointersOf(res)).toContain("/note");
    expect(snapshot(id)).toEqual(before);
  });

  test("ACADEMY_VERIFIED without an orgLabel is refused with pointer /orgLabel and nothing is written", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);
    const before = snapshot(id);

    const res = await decide(admin.cookie, id, { action: "approve", status: "ACADEMY_VERIFIED", note: "Checked" });
    await expectProblem(res, 422);
    expect(await pointersOf(res)).toContain("/orgLabel");
    expect(snapshot(id)).toEqual(before);
  });
});

describe("POST decision: an illegal transition is a 409 problem", () => {
  test("deciding an already decided contribution is 409 and writes nothing", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const approved = submit(alice.id, newPayload({ name: "Approved first" }));
    const rejected = submit(alice.id, newPayload({ name: "Rejected first" }));
    expect((await decide(admin.cookie, approved, { action: "approve" })).status).toBe(200);
    expect((await decide(admin.cookie, rejected, { action: "reject", note: "No" })).status).toBe(200);
    const beforeApproved = snapshot(approved);
    const beforeRejected = snapshot(rejected);

    await expectProblem(await decide(admin.cookie, approved, { action: "approve" }), 409);
    await expectProblem(await decide(admin.cookie, approved, { action: "reject", note: "Changed my mind" }), 409);
    await expectProblem(await decide(admin.cookie, rejected, { action: "approve" }), 409);
    expect(snapshot(approved)).toEqual(beforeApproved);
    expect(snapshot(rejected)).toEqual(beforeRejected);
  });

  test("a contribution waiting for the contributor (changes_requested) cannot be approved by the admin", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);
    expect((await decide(admin.cookie, id, { action: "request_changes", note: "Fix" })).status).toBe(200);
    const before = snapshot(id);

    await expectProblem(await decide(admin.cookie, id, { action: "approve" }), 409);
    expect(snapshot(id)).toEqual(before);
  });

  test("an unknown contribution is 404", async () => {
    const admin = await signUpAdmin();
    await expectProblem(await decide(admin.cookie, "no-such-contribution", { action: "approve" }), 404);
  });
});

// --- the strict body: nothing unknown reaches the service --------------------------------------------

describe("POST decision: the body is strict", () => {
  test.each(["authorName", "author", "kind", "locale", "targetDrillSlug", "improvementKind", "rightsAttested", "noCommercialContent", "website"])(
    "edits.%s is refused with 422 and never reaches the stored payload",
    async (key) => {
      const alice = await signUpContributor("alice@example.com", "Alice");
      const admin = await signUpAdmin();
      const id = submit(alice.id);
      const before = snapshot(id);

      const res = await decide(admin.cookie, id, { action: "approve", edits: { [key]: "hijack" } });
      await expectProblem(res, 422);
      expect(await pointersOf(res)).toContain(`/edits/${key}`);
      expect(snapshot(id)).toEqual(before);
      expect(payloadColumnOf(id)).not.toContain("hijack");
    },
  );

  test("edits are refused for a reject too: the schema is checked before any action", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);
    const before = snapshot(id);

    const res = await decide(admin.cookie, id, { action: "reject", note: "No", edits: { authorName: "Mallory" } });
    await expectProblem(res, 422);
    expect(await pointersOf(res)).toContain("/edits/authorName");
    expect(snapshot(id)).toEqual(before);
  });

  test.each(["authorName", "reviewer", "adminId", "admin", "reviewerUserId"])(
    "a top-level %s is refused with 422: the admin identity comes from the session only",
    async (key) => {
      const alice = await signUpContributor("alice@example.com", "Alice");
      const admin = await signUpAdmin();
      const id = submit(alice.id);
      const before = snapshot(id);

      const res = await decide(admin.cookie, id, { action: "approve", [key]: "someone-else" });
      await expectProblem(res, 422);
      expect(await pointersOf(res)).toContain(`/${key}`);
      expect(snapshot(id)).toEqual(before);
    },
  );

  test("an invalid action, an invalid status and a mistyped edit are 422 with pointers", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);
    const before = snapshot(id);

    const action = await decide(admin.cookie, id, { action: "explode" });
    await expectProblem(action, 422);
    expect(await pointersOf(action)).toContain("/action");

    const status = await decide(admin.cookie, id, { action: "approve", status: "PLATINUM" });
    await expectProblem(status, 422);
    expect(await pointersOf(status)).toContain("/status");

    const edit = await decide(admin.cookie, id, { action: "approve", edits: { ageMin: "seven" } });
    await expectProblem(edit, 422);
    expect(await pointersOf(edit)).toContain("/edits/ageMin");
    expect(snapshot(id)).toEqual(before);
  });

  test("a body that is not a JSON object is 400", async () => {
    const alice = await signUpContributor("alice@example.com", "Alice");
    const admin = await signUpAdmin();
    const id = submit(alice.id);

    await expectProblem(await decide(admin.cookie, id, "{not json"), 400);
    await expectProblem(await decide(admin.cookie, id, "[]"), 400);
    await expectProblem(await decide(admin.cookie, id, "null"), 400);
    await expectProblem(await decide(admin.cookie, id), 400);
    expect(stateOf(id)).toBe("pending");
  });
});
