import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { decide } from "../../contributions/moderation";
import { createContribution } from "../../contributions/repo";
import { storeUpload } from "../../contributions/uploads";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import { ENDPOINTS } from "../../shared/admin";
import type { ContributionPayloadRequest } from "../../shared/contributions";
import { DrillDetail } from "../../shared/commons";
import { TRUST_STATUSES } from "../../shared/primitives";
import type { TrustStatus } from "../../shared/primitives";

// POST /api/admin/drills/:slug/status and POST /api/admin/drills/:slug/unpublish (fc-mol-0v3.5).
//
// Every test runs the real createApp on a fresh in-memory database (real migrations, real seed) with the
// REAL Better Auth handler and the real public commons and media routes mounted next to the routes under
// test. Sessions are real: an actor signs up (or signs in anonymously) through /api/auth/* and the request
// carries the Set-Cookie it got back; the admin is promoted by a direct UPDATE of the user row, as the auth
// middleware tests do. No fake sessions. Temp dirs (uploads, routes) are removed in afterEach.
//
// Readings pinned here (each also stated in admin-drills.routes.ts):
//  * 401 without a session, 403 for a signed-in non-admin (anonymous, contributor, banned, a role that only
//    resembles admin), decided BEFORE the body, the slug or the store are looked at.
//  * The reviewer of a reviews row is the SESSION's admin (name, user id). The body is a strict object, so
//    a body that tries to name a reviewer or an admin is a 422 and nothing is written.
//  * A body the contract refuses (blank note, missing reason, unknown toStatus, unknown key) is a 422 with
//    `errors[]` JSON Pointers; a status the drill already has and ACADEMY_VERIFIED without an orgLabel
//    are 422 too; a body that is not a JSON object is a 400. Nothing is written on any of them.
//  * An unknown or already unpublished slug is a 404; unpublishing answers the detail as it was published,
//    with the new reviews row, and the drill is a 404 in the commons routes afterwards.
//  * "Purges the drill's media from public serving": after an unpublish the attachments of the drill's
//    contribution are no longer public in GET /api/media/:id (anonymous callers get the 404). The files are
//    kept (versions are immutable evidence for a rights complaint): the admin can still read them.

const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const SOURCE_DIR = resolve(import.meta.dir);
const ROUTES_DIR_FILES = ["admin-drills.routes.ts", "auth.routes.ts", "commons.routes.ts", "media.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS", "MEDIA_DIR"] as const;
const SLUG = "ball-mastery-sole-rolls"; // a seed drill, status COMMUNITY
const OTHER_SLUG = "ball-mastery-sole-taps";
const ADMIN_NAME = "Boss Admin";

let dir: string;
let mediaDir: string;
let db: Database;
let app: Hono;
const savedEnv: Record<string, string | undefined> = {};

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
  dir = mkdtempSync(join(tmpdir(), "admin-drills-routes-"));
  mediaDir = join(dir, "media");
  mkdirSync(mediaDir);
  process.env.MEDIA_DIR = mediaDir;
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
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

type Actor = { cookie: string; id: string; name: string };

async function signInPlayer(): Promise<Actor> {
  const res = await signPost("/api/auth/sign-in/anonymous", {});
  const body = (await res.json()) as { user: { id: string; name?: string } };
  return { cookie: cookieOf(res), id: body.user.id, name: body.user.name ?? "" };
}

async function signUpContributor(email = "contrib@example.com", name = "Coach"): Promise<Actor> {
  const res = await signPost("/api/auth/sign-up/email", { name, email, password: PASSWORD });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id, name };
}

async function signUpWithRole(role: string, email = `${role.replace(/\W/g, "_")}@example.com`): Promise<Actor> {
  const actor = await signUpContributor(email);
  db.run("UPDATE user SET role = ? WHERE id = ?", [role, actor.id]);
  return actor;
}

async function signUpAdmin(): Promise<Actor> {
  const actor = await signUpContributor("boss@example.com", ADMIN_NAME);
  db.run("UPDATE user SET role = 'admin' WHERE id = ?", [actor.id]);
  return actor;
}

// --- requests -----------------------------------------------------------------------------------

const STATUS_PATH = (slug: string): string => ENDPOINTS.setDrillStatus.path.replace(":slug", slug);
const UNPUBLISH_PATH = (slug: string): string => ENDPOINTS.unpublishDrill.path.replace(":slug", slug);

/** `body` is JSON-encoded unless it is already a string (to send malformed JSON verbatim). */
const send = (path: string, cookie: string | undefined, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const postStatus = (cookie: string | undefined, body?: unknown, slug = SLUG, headers?: Record<string, string>) =>
  send(STATUS_PATH(slug), cookie, body, headers);
const postUnpublish = (cookie: string | undefined, body?: unknown, slug = SLUG, headers?: Record<string, string>) =>
  send(UNPUBLISH_PATH(slug), cookie, body, headers);

const getDrill = (slug = SLUG) => app.request(`/api/commons/drills/${slug}?locale=ru`);
const getMedia = (id: string, cookie?: string) => app.request(`/api/media/${id}`, { headers: cookie ? { cookie } : {} });

const VALID_STATUS = { toStatus: "REVIEWED", note: "Checked the progressions with the club coaches" } as const;
const VALID_UNPUBLISH = { reason: "Rights complaint from the video owner" } as const;

const ENDPOINT_CASES = [
  { label: "status", send: postStatus, valid: VALID_STATUS },
  { label: "unpublish", send: postUnpublish, valid: VALID_UNPUBLISH },
] as const;

// --- the database, as it is observed ------------------------------------------------------------

const reviewCount = (): number => (db.query("SELECT count(*) AS c FROM reviews").get() as { c: number }).c;

/** Everything a drill action may change: drills (unpublish marker, pointer), version statuses, all reviews. */
const snapshot = () => ({
  drills: db.query("SELECT id, slug, current_version_id, unpublished_at FROM drills ORDER BY id").all(),
  versions: db.query("SELECT id, status FROM drill_versions ORDER BY id").all(),
  reviews: db.query("SELECT * FROM reviews ORDER BY id").all(),
});

type ReviewRow = {
  drill_version_id: string;
  reviewer: string;
  reviewer_user_id: string | null;
  org_label: string;
  from_status: string;
  to_status: string;
  note: string;
};
const lastReview = (): ReviewRow => db.query("SELECT * FROM reviews ORDER BY id DESC LIMIT 1").get() as ReviewRow;

const statusOf = (slug = SLUG): string =>
  (
    db
      .query("SELECT v.status FROM drills d JOIN drill_versions v ON v.id = d.current_version_id WHERE d.slug = ?")
      .get(slug) as { status: string }
  ).status;

const problemOf = async (res: Response) => {
  const text = await res.clone().text();
  return {
    contentType: res.headers.get("content-type"),
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
  return body;
};

const pointersOf = async (res: Response): Promise<string[]> => ((await problemOf(res)).body.errors ?? []).map((e) => e.pointer);

/** A 422 whose errors[] carries this JSON Pointer, and after which nothing was written. */
async function expectRefused(res: Response, pointer: string, before: ReturnType<typeof snapshot>) {
  await expectProblem(res.clone(), 422, "Unprocessable Entity");
  expect(await pointersOf(res)).toContain(pointer);
  expect(snapshot()).toEqual(before);
}

// --- a published drill with media ---------------------------------------------------------------

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const MP4 = (() => {
  const out = new Uint8Array(300);
  for (let i = 0; i < out.length; i += 1) out[i] = i % 251;
  out.set([0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii("isom")], 0);
  return out as Uint8Array<ArrayBuffer>;
})();

const newPayload = (): ContributionPayloadRequest => ({
  kind: "new",
  locale: "ru",
  name: "Wall passes",
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
});

/** A coach's new drill, approved by the real moderation service, with one uploaded video attached. */
async function publishDrillWithMedia(admin: Actor): Promise<{ slug: string; attachmentId: string; owner: Actor }> {
  const owner = await signUpContributor("alice@example.com", "Alice");
  const stored = await storeUpload(
    { body: new Blob([MP4]), declaredMime: "video/mp4", originalName: "wall.mp4" },
    { mediaDir, maxBytes: 1024 * 1024 },
  );
  const made = createContribution(db, {
    userId: owner.id,
    payload: newPayload(),
    attachments: [{ kind: stored.kind, storedPath: stored.storedPath, mime: stored.mime, bytes: stored.bytes, originalName: stored.originalName }],
  });
  const decided = decide(db, { id: admin.id, name: admin.name }, made.id, { action: "approve" });
  return { slug: decided.drill!.slug, attachmentId: made.attachments[0]!.id, owner };
}

// --- the contract -------------------------------------------------------------------------------

test("the routes serve the contract's paths with POST", () => {
  expect(ENDPOINTS.setDrillStatus.method).toBe("POST");
  expect(ENDPOINTS.unpublishDrill.method).toBe("POST");
  expect(STATUS_PATH(SLUG)).toBe(`/api/admin/drills/${SLUG}/status`);
  expect(UNPUBLISH_PATH(SLUG)).toBe(`/api/admin/drills/${SLUG}/unpublish`);
});

// --- authorisation: fail closed, and before the body, the slug or the store ----------------------

describe("no session: 401", () => {
  for (const endpoint of ENDPOINT_CASES) {
    test(`${endpoint.label}: without a cookie is a 401 problem+json and nothing is written`, async () => {
      const before = snapshot();
      await expectProblem(await endpoint.send(undefined, endpoint.valid), 401, "Unauthorized");
      expect(snapshot()).toEqual(before);
    });

    test(`${endpoint.label}: a malformed, invalid or unknown-slug request without a session is still a 401`, async () => {
      const before = snapshot();
      for (const body of ["{not json", "[]", {}, { note: "" }]) {
        await expectProblem(await endpoint.send(undefined, body), 401, "Unauthorized");
      }
      await expectProblem(await endpoint.send(undefined, endpoint.valid, "no-such-drill"), 401, "Unauthorized");
      expect(snapshot()).toEqual(before);
    });

    test(`${endpoint.label}: a forged session cookie is a 401`, async () => {
      const before = snapshot();
      const forged = "better-auth.session_token=Zm9yZ2VkLXRva2Vu.Zm9yZ2VkLXNpZ25hdHVyZQ";
      await expectProblem(await endpoint.send(forged, endpoint.valid), 401, "Unauthorized");
      expect(snapshot()).toEqual(before);
    });
  }
});

describe("signed in but not an administrator: 403", () => {
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
    ["a user whose role is upper-case (ADMIN)", () => signUpWithRole("ADMIN")],
    [
      "a banned admin",
      async () => {
        const admin = await signUpWithRole("admin");
        db.run("UPDATE user SET banned = 1 WHERE id = ?", [admin.id]);
        return admin;
      },
    ],
  ];

  for (const [label, makeActor] of actors) {
    for (const endpoint of ENDPOINT_CASES) {
      test(`${label}: ${endpoint.label} is a 403 problem+json and nothing is written`, async () => {
        const actor = await makeActor();
        const before = snapshot();
        await expectProblem(await endpoint.send(actor.cookie, endpoint.valid), 403, "Forbidden");
        expect(snapshot()).toEqual(before);
        expect(statusOf()).toBe("COMMUNITY");
        expect((await getDrill()).status).toBe(200);
      });

      test(`${label}: ${endpoint.label} with a malformed, invalid or unknown-slug request is a 403, never a 400, 404 or 422`, async () => {
        const actor = await makeActor();
        const before = snapshot();
        for (const body of ["{not json", "[]", "null", {}, { note: "" }]) {
          await expectProblem(await endpoint.send(actor.cookie, body), 403, "Forbidden");
        }
        await expectProblem(await endpoint.send(actor.cookie, endpoint.valid, "no-such-drill"), 403, "Forbidden");
        expect(snapshot()).toEqual(before);
      });
    }
  }

  test("a contributor cannot promote itself with request headers or body fields", async () => {
    const contributor = await signUpContributor();
    const before = snapshot();
    const headers = { "x-user-role": "admin", "x-role": "admin", "x-admin": "true", "x-admin-id": "someone" };

    await expectProblem(await postStatus(contributor.cookie, VALID_STATUS, SLUG, headers), 403, "Forbidden");
    await expectProblem(await postUnpublish(contributor.cookie, { ...VALID_UNPUBLISH, role: "admin" }, SLUG, headers), 403, "Forbidden");

    expect(snapshot()).toEqual(before);
  });
});

describe("administrators", () => {
  test("a role list that includes admin (contributor,admin) is let in, as the middleware decides", async () => {
    const actor = await signUpWithRole("contributor,admin");
    expect((await postStatus(actor.cookie, VALID_STATUS)).status).toBe(200);
  });
});

// --- POST /api/admin/drills/:slug/status --------------------------------------------------------------

describe("POST /api/admin/drills/:slug/status", () => {
  test("changes the status and answers 200 with the updated DrillDetail, new reviews row included", async () => {
    const admin = await signUpAdmin();
    expect(statusOf()).toBe("COMMUNITY");

    const res = await postStatus(admin.cookie, { toStatus: "REVIEWED", note: "  Checked with the club coaches  " });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    const detail = DrillDetail.parse(body);
    expect(ENDPOINTS.setDrillStatus.response.safeParse(body).success).toBe(true);
    expect(detail.slug).toBe(SLUG);
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews[0]).toMatchObject({
      reviewer: ADMIN_NAME,
      orgLabel: "",
      from: "COMMUNITY",
      to: "REVIEWED",
      note: "Checked with the club coaches",
    });
    expect(statusOf()).toBe("REVIEWED");
  });

  test("the change is visible in GET /api/commons/drills/:slug reviews, and in the library's status", async () => {
    const admin = await signUpAdmin();
    expect(((await (await getDrill()).json()) as { reviews: unknown[] }).reviews).toEqual([]);

    const res = await postStatus(admin.cookie, { toStatus: "EXPERT_VERIFIED", note: "Verified by a licensed coach" });
    expect(res.status).toBe(200);
    const returned = await res.json();

    const publicRes = await getDrill();
    expect(publicRes.status).toBe(200);
    const publicDetail = DrillDetail.parse(await publicRes.json());
    expect(publicDetail.reviews).toHaveLength(1);
    expect(publicDetail.reviews[0]).toMatchObject({ reviewer: ADMIN_NAME, from: "COMMUNITY", to: "EXPERT_VERIFIED", note: "Verified by a licensed coach" });
    expect(publicDetail.reviews).toEqual(returned.reviews);

    const list = (await (await app.request("/api/commons/drills?limit=100")).json()) as { items: { slug: string; status: string }[] };
    expect(list.items.find((item) => item.slug === SLUG)?.status).toBe("EXPERT_VERIFIED");
    expect(list.items.find((item) => item.slug === OTHER_SLUG)?.status).toBe("COMMUNITY"); // only this drill moved
  });

  test("each of the four statuses is reachable from another one, and the reviews row records from and to", async () => {
    const admin = await signUpAdmin();
    let from: TrustStatus = "COMMUNITY";
    for (const to of [...TRUST_STATUSES].filter((s) => s !== "COMMUNITY")) {
      const res = await postStatus(admin.cookie, { toStatus: to, note: `to ${to}`, ...(to === "ACADEMY_VERIFIED" ? { orgLabel: "Astana Academy" } : {}) });
      expect(res.status).toBe(200);
      expect(lastReview()).toMatchObject({ from_status: from, to_status: to, note: `to ${to}` });
      expect(statusOf()).toBe(to);
      from = to;
    }
    expect(reviewCount()).toBe(TRUST_STATUSES.length - 1);
  });

  test("ACADEMY_VERIFIED with an orgLabel is accepted and the label is on the reviews row", async () => {
    const admin = await signUpAdmin();

    const res = await postStatus(admin.cookie, { toStatus: "ACADEMY_VERIFIED", orgLabel: "Astana Football Academy", note: "Academy curriculum" });

    expect(res.status).toBe(200);
    const detail = DrillDetail.parse(await res.json());
    expect(detail.reviews[0]).toMatchObject({ orgLabel: "Astana Football Academy", to: "ACADEMY_VERIFIED" });
    expect(lastReview().org_label).toBe("Astana Football Academy");
  });

  test("ACADEMY_VERIFIED without an orgLabel (missing, empty or blank) is a 422 on /orgLabel and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    for (const extra of [{}, { orgLabel: "" }, { orgLabel: "   " }]) {
      const res = await postStatus(admin.cookie, { toStatus: "ACADEMY_VERIFIED", note: "Academy curriculum", ...extra });
      await expectRefused(res, "/orgLabel", before);
    }
    expect(statusOf()).toBe("COMMUNITY");
  });

  test("the note is required: missing, empty and blank are a 422 on /note and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    for (const body of [{ toStatus: "REVIEWED" }, { toStatus: "REVIEWED", note: "" }, { toStatus: "REVIEWED", note: "  \n " }]) {
      await expectRefused(await postStatus(admin.cookie, body), "/note", before);
    }
    await expectRefused(await postStatus(admin.cookie, { toStatus: "EXPERT_VERIFIED", note: " " }), "/note", before);
  });

  test("an unknown or missing toStatus is a 422 on /toStatus and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    await expectRefused(await postStatus(admin.cookie, { toStatus: "GOLD", note: "n" }), "/toStatus", before);
    await expectRefused(await postStatus(admin.cookie, { toStatus: "reviewed", note: "n" }), "/toStatus", before);
    await expectRefused(await postStatus(admin.cookie, { note: "n" }), "/toStatus", before);
  });

  test("moving a drill to the status it already has is a 422 and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    const res = await postStatus(admin.cookie, { toStatus: "COMMUNITY", note: "no change" });

    await expectRefused(res, "/toStatus", before);
  });

  test("the body is STRICT: an unknown key is a 422 at its own pointer and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    await expectRefused(await postStatus(admin.cookie, { ...VALID_STATUS, extra: 1 }), "/extra", before);
    await expectRefused(await postStatus(admin.cookie, { ...VALID_STATUS, orgLabel: "x", reason: "y" }), "/reason", before);
  });

  test("the reviewer comes from the session only: a body naming a reviewer or an admin is a 422", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    for (const field of ["reviewer", "reviewerUserId", "admin", "adminId", "userId", "role", "actor"]) {
      const res = await postStatus(admin.cookie, { ...VALID_STATUS, [field]: "someone-else" });
      await expectRefused(res, `/${field}`, before);
    }
  });

  test("the reviews row names the signed-in admin (name and user id); headers naming somebody else are ignored", async () => {
    const admin = await signUpAdmin();

    const res = await postStatus(admin.cookie, VALID_STATUS, SLUG, { "x-admin-id": "mallory", "x-admin-name": "Mallory", "x-user-id": "mallory" });

    expect(res.status).toBe(200);
    expect(lastReview()).toMatchObject({ reviewer: ADMIN_NAME, reviewer_user_id: admin.id });
    expect(DrillDetail.parse(await res.json()).reviews[0]?.reviewer).toBe(ADMIN_NAME);
  });

  test("a body that is not a JSON object is a 400 problem+json and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    for (const body of ["{not json", "[]", "null", '"text"', "5"]) {
      await expectProblem(await postStatus(admin.cookie, body), 400, "Bad Request");
    }
    await expectProblem(await postStatus(admin.cookie), 400, "Bad Request"); // no body at all
    expect(snapshot()).toEqual(before);
  });

  test("an unknown slug is a 404 problem+json and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    await expectProblem(await postStatus(admin.cookie, VALID_STATUS, "no-such-drill"), 404, "Not Found");
    expect(snapshot()).toEqual(before);
  });

  test("a malformed slug is a 400 on /slug and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    const res = await postStatus(admin.cookie, VALID_STATUS, "bad%20slug!");

    await expectProblem(res.clone(), 400, "Bad Request");
    expect(await pointersOf(res)).toContain("/slug");
    expect(snapshot()).toEqual(before);
  });

  test("a status change does not unpublish the drill: it stays readable in the commons", async () => {
    const admin = await signUpAdmin();

    expect((await postStatus(admin.cookie, VALID_STATUS)).status).toBe(200);

    expect((await getDrill()).status).toBe(200);
    expect(db.query("SELECT unpublished_at FROM drills WHERE slug = ?").get(SLUG)).toEqual({ unpublished_at: null });
  });

  test("an unpublished drill cannot change status: 404 and nothing is written", async () => {
    const admin = await signUpAdmin();
    expect((await postUnpublish(admin.cookie, VALID_UNPUBLISH)).status).toBe(200);
    const before = snapshot();

    await expectProblem(await postStatus(admin.cookie, VALID_STATUS), 404, "Not Found");

    expect(snapshot()).toEqual(before);
  });

  test("a status change on a drill with public media keeps that media public", async () => {
    const admin = await signUpAdmin();
    const { slug, attachmentId } = await publishDrillWithMedia(admin);

    expect((await postStatus(admin.cookie, VALID_STATUS, slug)).status).toBe(200);

    expect((await getMedia(attachmentId)).status).toBe(200);
  });
});

// --- POST /api/admin/drills/:slug/unpublish -----------------------------------------------------------

describe("POST /api/admin/drills/:slug/unpublish", () => {
  test("answers 200 with the DrillDetail as published plus the new reviews row (reason as the note)", async () => {
    const admin = await signUpAdmin();

    const res = await postUnpublish(admin.cookie, { reason: "  Rights complaint from the video owner  " });

    expect(res.status).toBe(200);
    const body = await res.json();
    const detail = DrillDetail.parse(body);
    expect(ENDPOINTS.unpublishDrill.response.safeParse(body).success).toBe(true);
    expect(detail.slug).toBe(SLUG);
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews[0]).toMatchObject({
      reviewer: ADMIN_NAME,
      from: "COMMUNITY",
      to: "COMMUNITY",
      note: "Rights complaint from the video owner",
    });
    expect(lastReview()).toMatchObject({ reviewer_user_id: admin.id, note: "Rights complaint from the video owner" });
  });

  test("the unpublished drill is a 404 in the commons routes, and gone from the library list", async () => {
    const admin = await signUpAdmin();
    expect((await getDrill()).status).toBe(200);

    expect((await postUnpublish(admin.cookie, VALID_UNPUBLISH)).status).toBe(200);

    await expectProblem(await getDrill(), 404, "Not Found");
    const list = (await (await app.request("/api/commons/drills?limit=100")).json()) as { items: { slug: string }[] };
    expect(list.items.map((item) => item.slug)).not.toContain(SLUG);
    expect(list.items.map((item) => item.slug)).toContain(OTHER_SLUG);
    expect((await getDrill(OTHER_SLUG)).status).toBe(200);
  });

  test("keeps every version row (a takedown hides the drill, it does not delete history)", async () => {
    const admin = await signUpAdmin();
    const versions = db.query("SELECT id FROM drill_versions WHERE drill_id = (SELECT id FROM drills WHERE slug = ?)").all(SLUG);

    expect((await postUnpublish(admin.cookie, VALID_UNPUBLISH)).status).toBe(200);

    expect(db.query("SELECT id FROM drill_versions WHERE drill_id = (SELECT id FROM drills WHERE slug = ?)").all(SLUG)).toEqual(versions);
    expect(versions.length).toBeGreaterThan(0);
  });

  test("a reason is required: missing, empty and blank are a 422 on /reason, and the drill stays published", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    for (const body of [{}, { reason: "" }, { reason: "   \n" }]) {
      await expectRefused(await postUnpublish(admin.cookie, body), "/reason", before);
    }
    expect((await getDrill()).status).toBe(200);
  });

  test("a reason that is not text is a 422 on /reason", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    for (const reason of [5, null, ["x"], { text: "x" }]) {
      await expectRefused(await postUnpublish(admin.cookie, { reason }), "/reason", before);
    }
  });

  test("the body is STRICT: an unknown key, or a reviewer, is a 422 at its own pointer and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    await expectRefused(await postUnpublish(admin.cookie, { ...VALID_UNPUBLISH, extra: 1 }), "/extra", before);
    for (const field of ["reviewer", "admin", "adminId", "role"]) {
      await expectRefused(await postUnpublish(admin.cookie, { ...VALID_UNPUBLISH, [field]: "someone-else" }), `/${field}`, before);
    }
    expect((await getDrill()).status).toBe(200);
  });

  test("the reviews row names the signed-in admin; headers naming somebody else are ignored", async () => {
    const admin = await signUpAdmin();

    const res = await postUnpublish(admin.cookie, VALID_UNPUBLISH, SLUG, { "x-admin-id": "mallory", "x-admin-name": "Mallory" });

    expect(res.status).toBe(200);
    expect(lastReview()).toMatchObject({ reviewer: ADMIN_NAME, reviewer_user_id: admin.id });
  });

  test("a body that is not a JSON object is a 400 problem+json and nothing is written", async () => {
    const admin = await signUpAdmin();
    const before = snapshot();

    for (const body of ["{not json", "[]", "null", '"text"']) {
      await expectProblem(await postUnpublish(admin.cookie, body), 400, "Bad Request");
    }
    await expectProblem(await postUnpublish(admin.cookie), 400, "Bad Request");
    expect(snapshot()).toEqual(before);
  });

  test("an unknown slug is a 404, and so is unpublishing the same drill twice (nothing more is written)", async () => {
    const admin = await signUpAdmin();
    await expectProblem(await postUnpublish(admin.cookie, VALID_UNPUBLISH, "no-such-drill"), 404, "Not Found");

    expect((await postUnpublish(admin.cookie, VALID_UNPUBLISH)).status).toBe(200);
    const after = snapshot();
    await expectProblem(await postUnpublish(admin.cookie, VALID_UNPUBLISH), 404, "Not Found");

    expect(snapshot()).toEqual(after);
  });

  test("a malformed slug is a 400 on /slug", async () => {
    const admin = await signUpAdmin();

    const res = await postUnpublish(admin.cookie, VALID_UNPUBLISH, "bad%20slug!");

    await expectProblem(res.clone(), 400, "Bad Request");
    expect(await pointersOf(res)).toContain("/slug");
  });
});

// --- takedown: the drill's media leaves public serving --------------------------------------------------

describe("unpublish purges the drill's media from public serving", () => {
  test("public before, a 404 for everyone but the admin after; the file itself is kept", async () => {
    const admin = await signUpAdmin();
    const { slug, attachmentId, owner } = await publishDrillWithMedia(admin);
    const stranger = await signUpContributor("stranger@example.com", "Stranger");
    const player = await signInPlayer();

    const before = await getMedia(attachmentId); // anonymous
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toContain("public");
    expect(new Uint8Array(await before.arrayBuffer())).toEqual(MP4);

    const res = await postUnpublish(admin.cookie, VALID_UNPUBLISH, slug);
    expect(res.status).toBe(200);

    const anonymous = await getMedia(attachmentId);
    await expectProblem(anonymous, 404, "Not Found");
    await expectProblem(await getMedia(attachmentId, stranger.cookie), 404, "Not Found");
    await expectProblem(await getMedia(attachmentId, player.cookie), 404, "Not Found");
    await expectProblem(await getDrill(slug), 404, "Not Found");

    const forAdmin = await getMedia(attachmentId, admin.cookie);
    expect(forAdmin.status).toBe(200);
    expect(forAdmin.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await forAdmin.arrayBuffer())).toEqual(MP4);
    expect(owner.id).not.toBe(admin.id);
  });

  test("a refused unpublish (blank reason) leaves the media public", async () => {
    const admin = await signUpAdmin();
    const { slug, attachmentId } = await publishDrillWithMedia(admin);

    expect((await postUnpublish(admin.cookie, { reason: " " }, slug)).status).toBe(422);

    expect((await getMedia(attachmentId)).status).toBe(200);
    expect((await getDrill(slug)).status).toBe(200);
  });

  test("a non-admin cannot take the media down", async () => {
    const admin = await signUpAdmin();
    const { slug, attachmentId, owner } = await publishDrillWithMedia(admin);

    expect((await postUnpublish(owner.cookie, VALID_UNPUBLISH, slug)).status).toBe(403);
    expect((await postUnpublish(undefined, VALID_UNPUBLISH, slug)).status).toBe(401);

    expect((await getMedia(attachmentId)).status).toBe(200);
  });
});
