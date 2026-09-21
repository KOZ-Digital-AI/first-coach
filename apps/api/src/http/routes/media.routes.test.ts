import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { createContribution } from "../../contributions/repo";
import { storeUpload } from "../../contributions/uploads";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import type { ContributionPayloadRequest } from "../../shared/contributions";
import { PROBLEM_CONTENT_TYPE } from "../../shared/primitives";

// GET /api/media/:attachmentId (fc-mol-70i.6): private media serving.
//
// Every test runs the real createApp on a fresh in-memory database (real migrations, real seed) with the
// REAL Better Auth handler mounted next to the route, a temp MEDIA_DIR holding files written by the real
// storeUpload, and real sign-up cookies. No fake sessions. Temp dirs are removed in afterEach.
//
// Readings pinned here (each also stated in media.routes.ts):
//  * PUBLIC = the attachment's contribution is 'approved' and its resulting drill is published
//    (unpublished_at IS NULL). Public media needs no session. Everything else is owner-or-admin.
//  * A stranger, an anonymous player, a banned account, an unauthenticated caller, a malformed id, a
//    missing id and a row whose file is gone all get THE SAME 404 (status, headers, body).
//  * Range: one range is honoured (206); an unsatisfiable one is 416 with `Content-Range: bytes */size`;
//    a malformed range, several ranges and a request with If-Range (there is no validator to match) are
//    ignored and answered 200 with the whole file.
//  * Content-Disposition: `inline` for images and video, `attachment` for a PDF.

const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const SOURCE_DIR = resolve(import.meta.dir);
const ROUTES_DIR_FILES = ["media.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111";
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS", "MEDIA_DIR"] as const;
const DRILL_SLUG = "ball-mastery-sole-rolls";

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
  dir = mkdtempSync(join(tmpdir(), "media-routes-"));
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
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// --- real sessions ------------------------------------------------------------------------

const post = (path: string, body: unknown) =>
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
  const res = await post("/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

async function signUpAdmin(): Promise<Actor> {
  const actor = await signUp("boss@example.com");
  db.run("UPDATE user SET role = 'admin' WHERE id = ?", [actor.id]);
  return actor;
}

async function signInAnonymous(): Promise<Actor> {
  const res = await post("/api/auth/sign-in/anonymous", {});
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

// --- files and rows -------------------------------------------------------------------------------

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** `head` then a byte pattern (i mod 251) up to `size`, so every range is checkable. */
function content(head: number[], size = 300): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = i % 251;
  out.set(head, 0);
  return out;
}

const MP4 = content([0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii("isom")]);
const PNG = content([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 120);
const PDF = content(ascii("%PDF-1.4\n"), 150);
const WEBM = content([0x1a, 0x45, 0xdf, 0xa3], 90);

const payload = (): ContributionPayloadRequest => ({
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

type Seeded = { attachmentId: string; contributionId: string; storedPath: string; bytes: Uint8Array<ArrayBuffer> };

/** Stores `bytes` with the real upload store and attaches them to a new contribution of `owner`. */
async function seed(owner: string, opts: { bytes?: Uint8Array<ArrayBuffer>; mime?: string; originalName?: string } = {}): Promise<Seeded> {
  const bytes = opts.bytes ?? MP4;
  const mime = opts.mime ?? "video/mp4";
  const stored = await storeUpload(
    { body: new Blob([bytes]), declaredMime: mime, originalName: opts.originalName ?? "wall.mp4" },
    { mediaDir, maxBytes: 1024 * 1024 },
  );
  const made = createContribution(db, {
    userId: owner,
    payload: payload(),
    attachments: [{ kind: stored.kind, storedPath: stored.storedPath, mime: stored.mime, bytes: stored.bytes, originalName: stored.originalName }],
  });
  return { attachmentId: made.attachments[0]!.id, contributionId: made.id, storedPath: stored.storedPath, bytes };
}

const drillId = (): string => (db.query("SELECT id FROM drills WHERE slug = ?").get(DRILL_SLUG) as { id: string }).id;
const approve = (contributionId: string): void => {
  db.run("UPDATE contributions SET state = 'approved', resulting_drill_id = ? WHERE id = ?", [drillId(), contributionId]);
};
const unpublishDrill = (): void => {
  db.run("UPDATE drills SET unpublished_at = '2026-04-01T00:00:00.000Z' WHERE id = ?", [drillId()]);
};

// --- requests --------------------------------------------------------------------------------------

const get = (id: string, opts: { cookie?: string; headers?: Record<string, string>; method?: string } = {}) =>
  app.request(`/api/media/${id}`, {
    ...(opts.method === undefined ? {} : { method: opts.method }),
    headers: { ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }), ...opts.headers },
  });

const bodyBytes = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());

/** Everything observable about a response, to compare two 404s. */
async function fingerprint(res: Response) {
  return { status: res.status, headers: [...res.headers.entries()].sort(), body: await res.text() };
}

async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  const text = await res.clone().text();
  expect(JSON.parse(text)).toMatchObject({ status: 404 });
  return fingerprint(res);
}

// --- access --------------------------------------------------------------------------------------

describe("who can read unapproved media", () => {
  test("the owner gets 200 with the exact bytes", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    const res = await get(s.attachmentId, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(await bodyBytes(res)).toEqual(s.bytes);
    expect(res.headers.get("content-length")).toBe(String(s.bytes.length));
  });

  test("an admin gets 200", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUpAdmin();
    const s = await seed(owner.id);
    const res = await get(s.attachmentId, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await bodyBytes(res)).toEqual(s.bytes);
  });

  test("a foreign contributor gets 404 and never the bytes", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const s = await seed(owner.id);
    const res = await get(s.attachmentId, { cookie: stranger.cookie });
    await expectNotFound(res);
  });

  test("no cookie is 404, not 401", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    await expectNotFound(await get(s.attachmentId));
  });

  test("stranger, no cookie, anonymous player, missing id, malformed id and a vanished file are one and the same 404", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const player = await signInAnonymous();
    const s = await seed(owner.id);
    const gone = await seed(owner.id);
    rmSync(join(mediaDir, gone.storedPath));

    const results = [
      await expectNotFound(await get(s.attachmentId, { cookie: stranger.cookie })),
      await expectNotFound(await get(s.attachmentId)),
      await expectNotFound(await get(s.attachmentId, { cookie: player.cookie })),
      await expectNotFound(await get("no-such-attachment", { cookie: owner.cookie })),
      await expectNotFound(await get("no-such-attachment")),
      await expectNotFound(await get("..%2F..%2Fetc%2Fpasswd", { cookie: owner.cookie })),
      await expectNotFound(await get("%00", { cookie: owner.cookie })),
      await expectNotFound(await get("a".repeat(500), { cookie: owner.cookie })),
      await expectNotFound(await get(gone.attachmentId, { cookie: owner.cookie })),
    ];
    for (const r of results) expect(r).toEqual(results[0]!);
    expect(results[0]!.body).not.toContain(s.attachmentId);
  });

  test("an anonymous player is refused even when its id is the submitter id, and even with the admin role", async () => {
    const player = await signInAnonymous();
    const s = await seed(player.id);
    await expectNotFound(await get(s.attachmentId, { cookie: player.cookie }));
    db.run("UPDATE user SET role = 'admin' WHERE id = ?", [player.id]);
    await expectNotFound(await get(s.attachmentId, { cookie: player.cookie }));
  });

  test("a banned owner and a banned admin are refused", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUpAdmin();
    const s = await seed(owner.id);
    db.run("UPDATE user SET banned = 1 WHERE id IN (?, ?)", [owner.id, admin.id]);
    await expectNotFound(await get(s.attachmentId, { cookie: owner.cookie }));
    await expectNotFound(await get(s.attachmentId, { cookie: admin.cookie }));
  });

  test("roles come from the server session only: role hints in the request grant nothing", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const s = await seed(owner.id);
    const res = await app.request(`/api/media/${s.attachmentId}?role=admin&userId=${owner.id}`, {
      headers: { cookie: stranger.cookie, "x-role": "admin", "x-user-id": owner.id },
    });
    await expectNotFound(res);
  });

  test("a tampered session cookie is refused", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    const tampered = owner.cookie.replace(/(=[^;.]*)/, "$1x");
    await expectNotFound(await get(s.attachmentId, { cookie: tampered }));
  });

  test("a withdrawn contribution's attachment is gone: 404 for its owner", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    db.run("DELETE FROM contribution_attachments WHERE id = ?", [s.attachmentId]);
    await expectNotFound(await get(s.attachmentId, { cookie: owner.cookie }));
  });

  test("a rejected contribution stays readable by its owner and hidden from others", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const s = await seed(owner.id);
    db.run("UPDATE contributions SET state = 'rejected' WHERE id = ?", [s.contributionId]);
    expect((await get(s.attachmentId, { cookie: owner.cookie })).status).toBe(200);
    await expectNotFound(await get(s.attachmentId, { cookie: stranger.cookie }));
    await expectNotFound(await get(s.attachmentId));
  });
});

describe("approved media of a published drill is public", () => {
  test("anyone, with or without a session, gets 200", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const player = await signInAnonymous();
    const s = await seed(owner.id);
    approve(s.contributionId);
    for (const cookie of [undefined, stranger.cookie, player.cookie, owner.cookie]) {
      const res = await get(s.attachmentId, cookie === undefined ? {} : { cookie });
      expect(res.status).toBe(200);
      expect(await bodyBytes(res)).toEqual(s.bytes);
    }
  });

  test("public media may be cached publicly, private media never is", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    approve(s.contributionId);
    const res = await get(s.attachmentId);
    expect(res.headers.get("cache-control")).toContain("public");
    expect(res.headers.get("cache-control")).not.toContain("private");
  });

  test("once the drill is unpublished the media is private again", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const s = await seed(owner.id);
    approve(s.contributionId);
    unpublishDrill();
    await expectNotFound(await get(s.attachmentId));
    await expectNotFound(await get(s.attachmentId, { cookie: stranger.cookie }));
    expect((await get(s.attachmentId, { cookie: owner.cookie })).status).toBe(200);
  });

  test("approved without a resulting drill is not public", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    db.run("UPDATE contributions SET state = 'approved' WHERE id = ?", [s.contributionId]);
    await expectNotFound(await get(s.attachmentId));
  });

  test("another contribution's attachments do not become public with it", async () => {
    const owner = await signUp("owner@example.com");
    const approved = await seed(owner.id);
    const pending = await seed(owner.id);
    approve(approved.contributionId);
    expect((await get(approved.attachmentId)).status).toBe(200);
    await expectNotFound(await get(pending.attachmentId));
  });
});

// --- headers -----------------------------------------------------------------------------------------

describe("response headers", () => {
  test("private media is Cache-Control: private, no-store on 200 and on 206", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    const full = await get(s.attachmentId, { cookie: owner.cookie });
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    const part = await get(s.attachmentId, { cookie: owner.cookie, headers: { range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("cache-control")).toBe("private, no-store");
  });

  test("a 404 is never cacheable either", async () => {
    const res = await get("no-such-attachment");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("Content-Type is the STORED mime, never sniffed and never the client's Accept", async () => {
    const owner = await signUp("owner@example.com");
    const cases: [Uint8Array<ArrayBuffer>, string][] = [
      [MP4, "video/mp4"],
      [PNG, "image/png"],
      [PDF, "application/pdf"],
      [WEBM, "video/webm"],
    ];
    for (const [bytes, mime] of cases) {
      const s = await seed(owner.id, { bytes, mime });
      const res = await get(s.attachmentId, { cookie: owner.cookie, headers: { accept: "text/html" } });
      expect(res.headers.get("content-type")).toBe(mime);
    }
  });

  test("Content-Type follows the stored row, not the bytes or the file extension", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id, { bytes: PNG, mime: "image/png" });
    db.run("UPDATE contribution_attachments SET mime = 'image/jpeg' WHERE id = ?", [s.attachmentId]);
    const res = await get(s.attachmentId, { cookie: owner.cookie });
    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  test("a stored mime that is not an allowed upload type is never served (no html, no svg)", async () => {
    const owner = await signUp("owner@example.com");
    for (const mime of ["text/html", "image/svg+xml", "application/javascript"]) {
      const s = await seed(owner.id, { bytes: PNG, mime: "image/png" });
      db.run("UPDATE contribution_attachments SET mime = ? WHERE id = ?", [mime, s.attachmentId]);
      await expectNotFound(await get(s.attachmentId, { cookie: owner.cookie }));
    }
  });

  test("X-Content-Type-Options: nosniff on private, public, partial and range-error responses", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    const priv = await get(s.attachmentId, { cookie: owner.cookie });
    const part = await get(s.attachmentId, { cookie: owner.cookie, headers: { range: "bytes=1-2" } });
    const bad = await get(s.attachmentId, { cookie: owner.cookie, headers: { range: "bytes=9999-" } });
    approve(s.contributionId);
    const pub = await get(s.attachmentId);
    for (const res of [priv, part, bad, pub]) expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("Content-Disposition: inline for video and images, attachment for a PDF", async () => {
    const owner = await signUp("owner@example.com");
    const video = await seed(owner.id, { originalName: "wall.mp4" });
    const image = await seed(owner.id, { bytes: PNG, mime: "image/png", originalName: "cones.png" });
    const pdf = await seed(owner.id, { bytes: PDF, mime: "application/pdf", originalName: "plan.pdf" });
    expect((await get(video.attachmentId, { cookie: owner.cookie })).headers.get("content-disposition")).toMatch(/^inline;/);
    expect((await get(image.attachmentId, { cookie: owner.cookie })).headers.get("content-disposition")).toMatch(/^inline;/);
    expect((await get(pdf.attachmentId, { cookie: owner.cookie })).headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  test("Content-Disposition is safe for a hostile client file name (no header injection, no quote or path break-out)", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    const hostile = 'a"; filename="evil.html\r\nX-Evil: 1\r\n\r\n<script>../\\..\\x.mp4';
    db.run("UPDATE contribution_attachments SET original_name = ? WHERE id = ?", [hostile, s.attachmentId]);
    const res = await get(s.attachmentId, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-evil")).toBeNull();
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toMatch(/^(inline|attachment); filename="[A-Za-z0-9._ -]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]*$/);
    const decoded = decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!);
    expect(decoded).not.toMatch(/[\u0000-\u001f\u007f/\\]/);
  });

  test("a non-ASCII file name survives in filename*", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    db.run("UPDATE contribution_attachments SET original_name = ? WHERE id = ?", ["Тренировка (1).mp4", s.attachmentId]);
    const disposition = (await get(s.attachmentId, { cookie: owner.cookie })).headers.get("content-disposition")!;
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe("Тренировка (1).mp4");
    expect(disposition).toMatch(/^[\x20-\x7e]*$/);
  });

  test("HEAD answers the headers of GET with no body, and hides private media the same way", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const s = await seed(owner.id);
    const head = await get(s.attachmentId, { cookie: owner.cookie, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await get(s.attachmentId, { cookie: stranger.cookie, method: "HEAD" })).status).toBe(404);
  });
});

// --- range -----------------------------------------------------------------------------------------------

describe("range requests", () => {
  const SIZE = MP4.length;

  let n = 0; // a test may call ranged() several times: one new owner (one email) each
  async function ranged(range: string, over: Record<string, string> = {}) {
    n += 1;
    const owner = await signUp(`owner${n}@example.com`);
    const s = await seed(owner.id);
    return { s, res: await get(s.attachmentId, { cookie: owner.cookie, headers: { range, ...over } }) };
  }

  test("a full response advertises Accept-Ranges: bytes", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    expect((await get(s.attachmentId, { cookie: owner.cookie })).headers.get("accept-ranges")).toBe("bytes");
  });

  test("bytes=a-b is 206 with exactly those bytes", async () => {
    const { s, res } = await ranged("bytes=10-19");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${SIZE}`);
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await bodyBytes(res)).toEqual(s.bytes.slice(10, 20));
  });

  test("bytes=a- runs to the end", async () => {
    const { s, res } = await ranged("bytes=250-");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 250-${SIZE - 1}/${SIZE}`);
    expect(await bodyBytes(res)).toEqual(s.bytes.slice(250));
  });

  test("bytes=-n is the last n bytes", async () => {
    const { s, res } = await ranged("bytes=-5");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${SIZE - 5}-${SIZE - 1}/${SIZE}`);
    expect(await bodyBytes(res)).toEqual(s.bytes.slice(SIZE - 5));
  });

  test("a suffix longer than the file is the whole file as 206", async () => {
    const { s, res } = await ranged("bytes=-99999");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect(await bodyBytes(res)).toEqual(s.bytes);
  });

  test("an end past the file is clamped to the last byte", async () => {
    const { s, res } = await ranged("bytes=290-99999");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 290-${SIZE - 1}/${SIZE}`);
    expect(await bodyBytes(res)).toEqual(s.bytes.slice(290));
  });

  test("the last byte alone and the first byte alone", async () => {
    const last = await ranged(`bytes=${SIZE - 1}-${SIZE - 1}`);
    expect(last.res.status).toBe(206);
    expect(await bodyBytes(last.res)).toEqual(last.s.bytes.slice(SIZE - 1));
    const first = await ranged("bytes=0-0");
    expect(first.res.status).toBe(206);
    expect(await bodyBytes(first.res)).toEqual(first.s.bytes.slice(0, 1));
  });

  test("a start at or past the end is 416 with Content-Range: bytes */size", async () => {
    for (const range of [`bytes=${SIZE}-`, `bytes=${SIZE}-${SIZE + 5}`, "bytes=99999-", "bytes=-0"]) {
      const { res } = await ranged(range);
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${SIZE}`);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
    }
  });

  test("a malformed, reversed, non-byte or multiple range is ignored: 200 with the whole file", async () => {
    for (const range of ["bytes=abc", "bytes=5-2", "items=0-5", "bytes=", "bytes=0-1,5-6", "0-5", "bytes=-", "bytes=1-2-3", "bytes= 1-2"]) {
      const { s, res } = await ranged(range);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-range")).toBeNull();
      expect(await bodyBytes(res)).toEqual(s.bytes);
    }
  });

  test("If-Range cannot match (no validator is offered): the range is ignored, 200", async () => {
    const { s, res } = await ranged("bytes=0-9", { "if-range": '"anything"' });
    expect(res.status).toBe(200);
    expect(await bodyBytes(res)).toEqual(s.bytes);
  });

  test("a range never widens access: a stranger's ranged request is the same 404, an out-of-range one too", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    const s = await seed(owner.id);
    const plain = await expectNotFound(await get(s.attachmentId, { cookie: stranger.cookie }));
    for (const range of ["bytes=0-9", "bytes=99999-"]) {
      expect(await expectNotFound(await get(s.attachmentId, { cookie: stranger.cookie, headers: { range } }))).toEqual(plain);
    }
  });

  test("public media honours ranges without a session", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    approve(s.contributionId);
    const res = await get(s.attachmentId, { headers: { range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(await bodyBytes(res)).toEqual(s.bytes.slice(0, 4));
  });
});

// --- paths -----------------------------------------------------------------------------------------------------

describe("the file path comes from the stored name only", () => {
  test("a stored path that climbs out of the media dir is never read", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    writeFileSync(join(dir, "secret.mp4"), "TOP SECRET");
    db.run("UPDATE contribution_attachments SET stored_path = '../secret.mp4' WHERE id = ?", [s.attachmentId]);
    const res = await get(s.attachmentId, { cookie: owner.cookie });
    expect(await res.text()).not.toContain("TOP SECRET");
    expect(res.status).toBe(404);
  });

  test("an absolute stored path and a nested one are never read", async () => {
    const owner = await signUp("owner@example.com");
    const secret = join(dir, "secret2.mp4");
    writeFileSync(secret, "TOP SECRET");
    mkdirSync(join(mediaDir, "sub"));
    writeFileSync(join(mediaDir, "sub", "deep.mp4"), "DEEP");
    for (const stored of [secret, "sub/deep.mp4"]) {
      const s = await seed(owner.id);
      db.run("UPDATE contribution_attachments SET stored_path = ? WHERE id = ?", [stored, s.attachmentId]);
      const res = await get(s.attachmentId, { cookie: owner.cookie });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/TOP SECRET|DEEP/);
    }
  });

  test("a symlink in the media dir is never followed", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    writeFileSync(join(dir, "secret3.mp4"), "TOP SECRET");
    symlinkSync(join(dir, "secret3.mp4"), join(mediaDir, "link.mp4"));
    db.run("UPDATE contribution_attachments SET stored_path = 'link.mp4' WHERE id = ?", [s.attachmentId]);
    const res = await get(s.attachmentId, { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  test("the client's file name never picks the file", async () => {
    const owner = await signUp("owner@example.com");
    writeFileSync(join(mediaDir, "victim.mp4"), "VICTIM");
    const s = await seed(owner.id, { originalName: "victim.mp4" });
    db.run("UPDATE contribution_attachments SET original_name = '../victim.mp4' WHERE id = ?", [s.attachmentId]);
    const res = await get(s.attachmentId, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(await bodyBytes(res)).toEqual(s.bytes);
  });
});

describe("routing", () => {
  test("there is no directory listing: /api/media, /api/media/ and deeper paths are 404 problems", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    for (const path of ["/api/media", "/api/media/", `/api/media/${s.attachmentId}/`, `/api/media/${s.attachmentId}/x`, "/api/media/%2e%2e/"]) {
      const res = await app.request(path, { headers: { cookie: owner.cookie } });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
    }
  });

  test("only GET and HEAD read media: POST, PUT and DELETE are not routes", async () => {
    const owner = await signUp("owner@example.com");
    const s = await seed(owner.id);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await app.request(`/api/media/${s.attachmentId}`, { method, headers: { cookie: owner.cookie } });
      expect(res.status).toBe(404);
    }
  });
});
