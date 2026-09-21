import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import { updateSettings } from "../../admin/settings";
import { createApp, type AppDeps } from "../../app";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import { Contribution, ENDPOINTS, MyContributionsResponse } from "../../shared/contributions";

// Every test runs the real createApp on a fresh in-memory database (real migrations, the REAL seed)
// with the routes under test, the commons read routes and the REAL Better Auth handler mounted.
// Sessions are real: an actor signs up (or signs in anonymously) through /api/auth/* and the request
// carries the Set-Cookie it got back. MEDIA_DIR is a temp directory that afterEach removes.
//
// Decisions the criteria leave open (each pinned below):
//   - a filled honeypot `website` is REJECTED with 422 on "/website" (not a fake 201); nothing is stored;
//   - a missing/unparseable `payload` part, a non-multipart body or a broken multipart body is 400;
//     a payload the contract refuses is 422 with JSON Pointers into the payload;
//   - too many files / a second `video` part / an unknown part name is 422 on that part's name;
//   - PUT with no file part keeps the stored attachments; with any file part it REPLACES them all.

const ROUTES_DIR_FILES = [
  "auth.routes.ts",
  "commons.routes.ts",
  "commons-export.routes.ts",
  "contributions.routes.ts",
] as const;
const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PASSWORD = "correct-horse-battery";
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS", "MEDIA_DIR"] as const;
const MIB = 1024 * 1024;
const COLLECTION = ENDPOINTS.createContribution.path; // /api/contributions
const MINE = ENDPOINTS.listMine.path;
const DRILL_SLUG = "ball-mastery-sole-rolls";
const MARKER = "Zebra-wall-passes-7f3a91"; // a name no seed drill contains

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
  dir = mkdtempSync(join(tmpdir(), "contributions-routes-"));
  mediaDir = join(dir, "media");
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

// --- real sessions ------------------------------------------------------------------------------

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

async function signInPlayer(): Promise<Actor> {
  const res = await postJson("/api/auth/sign-in/anonymous", {});
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

async function signUpContributor(email = "alice@example.com"): Promise<Actor> {
  const res = await postJson("/api/auth/sign-up/email", { name: "Coach", email, password: PASSWORD });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

// --- fixtures: real bytes -----------------------------------------------------------------------

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

/** A tiny mp4: an `ftyp` box (size 24, brand `isom`, minor version, compatible brands isom + mp42) then padding. */
const mp4Bytes = (padding = 64): Uint8Array<ArrayBuffer> =>
  new Uint8Array([
    0, 0, 0, 24, ...ascii("ftyp"), ...ascii("isom"), 0, 0, 2, 0, ...ascii("isom"), ...ascii("mp42"),
    ...new Array<number>(padding).fill(0),
  ]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngBytes = (padding = 32): Uint8Array<ArrayBuffer> => new Uint8Array([...PNG_SIGNATURE, ...new Array<number>(padding).fill(7)]);
const pdfBytes = (padding = 32): Uint8Array<ArrayBuffer> => new Uint8Array([...ascii("%PDF-1.4\n"), ...new Array<number>(padding).fill(0x20)]);

/** A PDF of exactly `size` bytes. */
const pdfOfSize = (size: number): Uint8Array<ArrayBuffer> => {
  const head = ascii("%PDF-1.4\n");
  const out = new Uint8Array(size);
  out.set(head);
  out.fill(0x20, head.length);
  return out;
};

const file = (bytes: Uint8Array<ArrayBuffer> | string, name: string, type: string): File => new File([bytes], name, { type });
const mp4File = (name = "clip.mp4") => file(mp4Bytes(), name, "video/mp4");
const pngFile = (name = "diagram.png") => file(pngBytes(), name, "image/png");
const pdfFile = (name = "plan.pdf") => file(pdfBytes(), name, "application/pdf");

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

type Parts = { video?: File; files?: File[]; extra?: [string, File | string][] };

/** The multipart body: the `payload` JSON part, an optional `video` and `files` parts. */
function form(payload: unknown, parts: Parts = {}): FormData {
  const fd = new FormData();
  if (payload !== undefined) fd.set("payload", typeof payload === "string" ? payload : JSON.stringify(payload));
  if (parts.video) fd.append("video", parts.video);
  for (const f of parts.files ?? []) fd.append("files", f);
  for (const [name, value] of parts.extra ?? []) fd.append(name, value);
  return fd;
}

// --- requests -----------------------------------------------------------------------------------

const authHeaders = (actor?: Actor): Record<string, string> => (actor ? { cookie: actor.cookie } : {});

const create = (actor: Actor | undefined, body: FormData | string | undefined) =>
  app.request(COLLECTION, { method: "POST", headers: authHeaders(actor), ...(body === undefined ? {} : { body }) });

const put = (actor: Actor | undefined, id: string, body: FormData | undefined) =>
  app.request(`${COLLECTION}/${id}`, { method: "PUT", headers: authHeaders(actor), ...(body === undefined ? {} : { body }) });

const withdrawReq = (actor: Actor | undefined, id: string) =>
  app.request(`${COLLECTION}/${id}`, { method: "DELETE", headers: authHeaders(actor) });

const mine = (actor: Actor | undefined) => app.request(MINE, { headers: authHeaders(actor) });

/** Creates a contribution the honest way and returns the parsed view. */
async function createOk(actor: Actor, payload: unknown = validPayload(), parts: Parts = {}): Promise<Contribution> {
  const res = await create(actor, form(payload, parts));
  expect(res.status).toBe(201);
  return Contribution.parse(await res.json());
}

// --- observations -------------------------------------------------------------------------------

const mediaFiles = (): string[] => (existsSync(mediaDir) ? readdirSync(mediaDir).sort() : []);
const count = (table: string): number => (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
const storedPaths = (): string[] =>
  (db.query("SELECT stored_path FROM contribution_attachments ORDER BY stored_path").all() as { stored_path: string }[]).map(
    (r) => r.stored_path,
  );
const stateOf = (id: string): string => (db.query("SELECT state FROM contributions WHERE id = ?").get(id) as { state: string }).state;
const setState = (id: string, state: string) => db.run("UPDATE contributions SET state = ? WHERE id = ?", [state, id]);

const problemOf = async (res: Response) => {
  const body = (await res.json()) as {
    type: string;
    title: string;
    status: number;
    detail?: string;
    errors?: { pointer: string; detail: string }[];
  };
  return { contentType: res.headers.get("content-type"), body };
};

const expectProblem = async (res: Response, status: number, title?: string) => {
  expect(res.status).toBe(status);
  const { contentType, body } = await problemOf(res);
  expect(contentType).toContain("application/problem+json");
  expect(body.status).toBe(status);
  if (title !== undefined) expect(body.title).toBe(title);
  return body;
};

const expectNothingStored = () => {
  expect(count("contributions")).toBe(0);
  expect(count("contribution_attachments")).toBe(0);
  expect(mediaFiles()).toEqual([]);
};

test("the routes serve the contract's paths and methods", () => {
  expect(ENDPOINTS.createContribution.method).toBe("POST");
  expect(ENDPOINTS.updateContribution.method).toBe("PUT");
  expect(ENDPOINTS.withdrawContribution.method).toBe("DELETE");
  expect(ENDPOINTS.listMine.method).toBe("GET");
  expect(COLLECTION).toBe("/api/contributions");
  expect(MINE).toBe("/api/contributions/mine");
});

// --- authorisation: 401 without a session, 403 for an anonymous player; nothing is stored -----------

describe("authorisation", () => {
  test("without a session every endpoint is a 401 problem and nothing is stored", async () => {
    const owner = await signUpContributor();
    const existing = await createOk(owner);
    const before = { rows: count("contributions"), files: mediaFiles() };

    for (const res of [
      await create(undefined, form(validPayload(), { video: mp4File() })),
      await put(undefined, existing.id, form(validPayload(), { video: mp4File() })),
      await withdrawReq(undefined, existing.id),
      await mine(undefined),
    ]) {
      await expectProblem(res, 401, "Unauthorized");
    }
    expect(count("contributions")).toBe(before.rows);
    expect(mediaFiles()).toEqual(before.files);
    expect(stateOf(existing.id)).toBe("pending");
  });

  test("an anonymous player gets 403 on every endpoint (a contributor needs a registered account) and nothing is stored", async () => {
    const player = await signInPlayer();
    const owner = await signUpContributor();
    const existing = await createOk(owner);
    const rowsBefore = count("contributions");

    for (const res of [
      await create(player, form(validPayload(), { video: mp4File() })),
      await put(player, existing.id, form(validPayload())),
      await withdrawReq(player, existing.id),
      await mine(player),
    ]) {
      await expectProblem(res, 403, "Forbidden");
    }
    expect(count("contributions")).toBe(rowsBefore);
    expect(mediaFiles()).toEqual([]);
    expect(stateOf(existing.id)).toBe("pending");
  });
});

// --- POST: create ---------------------------------------------------------------------------------------

describe("POST /api/contributions", () => {
  test("a real mp4 + png + pdf in one request: 201, the Contribution view, files on disk, rows in one contribution", async () => {
    const alice = await signUpContributor();
    const res = await create(alice, form(validPayload(), { video: mp4File("my clip.mp4"), files: [pngFile(), pdfFile()] }));
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    const view = Contribution.parse(await res.json());

    expect(view.state).toBe("pending");
    expect(view.payload.name).toBe(MARKER);
    expect(view.attachments.map((a) => a.kind)).toEqual(["video", "image", "document"]);
    expect(view.attachments.map((a) => a.mimeType)).toEqual(["video/mp4", "image/png", "application/pdf"]);
    expect(view.attachments.map((a) => a.filename)).toEqual(["my clip.mp4", "diagram.png", "plan.pdf"]);
    expect(view.attachments[0]!.size).toBe(mp4Bytes().byteLength);
    for (const a of view.attachments) expect(a.url.length).toBeGreaterThan(0);

    // The rows and the files agree, and the client's name is metadata only.
    const rows = db.query("SELECT stored_path, mime, bytes, original_name, kind FROM contribution_attachments").all() as {
      stored_path: string;
      mime: string;
      bytes: number;
      original_name: string;
      kind: string;
    }[];
    expect(rows).toHaveLength(3);
    expect(mediaFiles()).toEqual(rows.map((r) => r.stored_path).sort());
    for (const r of rows) expect(r.stored_path).not.toContain("clip");
    expect(count("contributions")).toBe(1);
    const owner = db.query("SELECT submitter_user_id AS u, state, origin FROM contributions").get() as { u: string; state: string; origin: string };
    expect(owner).toEqual({ u: alice.id, state: "pending", origin: "form" });
  });

  test("a contribution without any file is a 201 with no attachments", async () => {
    const alice = await signUpContributor();
    const view = await createOk(alice);
    expect(view.attachments).toEqual([]);
    expect(mediaFiles()).toEqual([]);
  });

  test("an improvement of an existing drill is accepted", async () => {
    const alice = await signUpContributor();
    const view = await createOk(alice, validPayload({ kind: "improvement", targetDrillSlug: DRILL_SLUG, improvementKind: "safety" }));
    expect(view.payload.kind).toBe("improvement");
    expect(view.payload.targetDrillSlug).toBe(DRILL_SLUG);
  });

  test("the client's file name never reaches a path: a traversal name is stored as metadata and the file lives in MEDIA_DIR", async () => {
    const alice = await signUpContributor();
    const view = await createOk(alice, validPayload(), { files: [file(pngBytes(), "../../evil.png", "image/png")] });
    expect(view.attachments[0]!.filename).toBe("evil.png");
    expect(mediaFiles()).toHaveLength(1);
    expect(existsSync(join(dir, "evil.png"))).toBe(false);
  });

  test("a browser's empty file input (no name, no bytes) is not an attachment", async () => {
    const alice = await signUpContributor();
    const view = await createOk(alice, validPayload(), { files: [file(new Uint8Array(0), "", "application/octet-stream")] });
    expect(view.attachments).toEqual([]);
    expect(mediaFiles()).toEqual([]);
  });

  describe("validation: 422 with JSON Pointers into the payload, nothing stored, every uploaded byte purged", () => {
    test("a missing attestation is a 422 on /rightsAttested and no file is left on disk", async () => {
      const alice = await signUpContributor();
      const { rightsAttested: _omit, ...withoutAttestation } = validPayload();
      const res = await create(alice, form(withoutAttestation, { video: mp4File(), files: [pngFile()] }));
      const body = await expectProblem(res, 422, "Unprocessable Entity");
      expect(body.errors?.map((e) => e.pointer)).toContain("/rightsAttested");
      expectNothingStored();
    });

    test("an attestation that is not literally true is a 422 on that field", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload({ noCommercialContent: false }), { video: mp4File() }));
      const body = await expectProblem(res, 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/noCommercialContent");
      expectNothingStored();
    });

    test("every invalid field gets its own pointer", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload({ name: "", ageMin: -1 }), { files: [pngFile()] }));
      const body = await expectProblem(res, 422);
      const pointers = body.errors?.map((e) => e.pointer) ?? [];
      expect(pointers).toContain("/name");
      expect(pointers).toContain("/ageMin");
      expectNothingStored();
    });

    test("an improvement without targetDrillSlug is a 422 on /targetDrillSlug", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload({ kind: "improvement" }), { video: mp4File() }));
      const body = await expectProblem(res, 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/targetDrillSlug");
      expectNothingStored();
    });

    test("an improvement of a drill that does not exist is a 422 on /targetDrillSlug and the stored files are purged", async () => {
      const alice = await signUpContributor();
      const res = await create(
        alice,
        form(validPayload({ kind: "improvement", targetDrillSlug: "no-such-drill" }), { video: mp4File(), files: [pngFile()] }),
      );
      const body = await expectProblem(res, 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/targetDrillSlug");
      expectNothingStored();
    });

    test("a filled honeypot `website` is REJECTED with 422 on /website (not a fake success) and nothing is stored", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload({ website: "https://spam.example" }), { video: mp4File() }));
      const body = await expectProblem(res, 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/website");
      expectNothingStored();
    });

    test("an empty honeypot is what a human sends: accepted", async () => {
      const alice = await signUpContributor();
      const view = await createOk(alice, validPayload({ website: "" }));
      expect(view.state).toBe("pending");
    });

    test("a payload with an unknown key is a 422 (the contract is strict)", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload({ isAdmin: true }), { files: [pngFile()] }));
      await expectProblem(res, 422);
      expectNothingStored();
    });

    test("more than 3 `files` is a 422 on /files and nothing is stored", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload(), { files: [pngFile("1.png"), pngFile("2.png"), pngFile("3.png"), pngFile("4.png")] }));
      const body = await expectProblem(res, 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/files");
      expectNothingStored();
    });

    test("exactly 3 `files` plus a video (the maximum) is accepted", async () => {
      const alice = await signUpContributor();
      const view = await createOk(alice, validPayload(), { video: mp4File(), files: [pngFile("1.png"), pngFile("2.png"), pdfFile("3.pdf")] });
      expect(view.attachments).toHaveLength(4);
      expect(mediaFiles()).toHaveLength(4);
    });

    test("a second `video` part is a 422 on /video and nothing is stored", async () => {
      const alice = await signUpContributor();
      const fd = form(validPayload(), { video: mp4File("a.mp4") });
      fd.append("video", mp4File("b.mp4"));
      const body = await expectProblem(await create(alice, fd), 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/video");
      expectNothingStored();
    });

    test("a part with an unknown name is a 422 on that name and nothing is stored", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload(), { files: [pngFile()], extra: [["attachment", pngFile()]] }));
      const body = await expectProblem(res, 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/attachment");
      expectNothingStored();
    });

    test("a text `video` part is a 422 on /video (a file is not a string)", async () => {
      const alice = await signUpContributor();
      const fd = form(validPayload());
      fd.set("video", "not a file");
      const body = await expectProblem(await create(alice, fd), 422);
      expect(body.errors?.map((e) => e.pointer)).toContain("/video");
      expectNothingStored();
    });
  });

  describe("malformed requests are 400 problems and store nothing", () => {
    test("a missing `payload` part", async () => {
      const alice = await signUpContributor();
      await expectProblem(await create(alice, form(undefined, { video: mp4File() })), 400, "Bad Request");
      expectNothingStored();
    });

    test("a `payload` part that is not JSON", async () => {
      const alice = await signUpContributor();
      await expectProblem(await create(alice, form("{not json", { video: mp4File() })), 400, "Bad Request");
      expectNothingStored();
    });

    test("a `payload` part that is not a JSON object", async () => {
      const alice = await signUpContributor();
      await expectProblem(await create(alice, form("[1, 2]", { video: mp4File() })), 400, "Bad Request");
      expectNothingStored();
    });

    test("a body that is not multipart", async () => {
      const alice = await signUpContributor();
      const res = await app.request(COLLECTION, {
        method: "POST",
        headers: { ...authHeaders(alice), "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      await expectProblem(res, 400, "Bad Request");
      expectNothingStored();
    });
  });

  describe("the files are checked by what they are and how big they are: nothing is left on disk", () => {
    test("a `.mp4` that contains text is a 415", async () => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload(), { video: file("this is not a video, just some text", "clip.mp4", "video/mp4") }));
      await expectProblem(res, 415, "Unsupported Media Type");
      expectNothingStored();
    });

    test("a later file of the wrong type purges the earlier files that were already stored", async () => {
      const alice = await signUpContributor();
      const res = await create(
        alice,
        form(validPayload(), { video: mp4File(), files: [pngFile(), file("plain text", "notes.pdf", "application/pdf")] }),
      );
      await expectProblem(res, 415);
      expectNothingStored();
    });

    // Bun's multipart parser derives a part's File.type from the file NAME's extension and ignores the part's own
    // Content-Type header, so the type a route sees is the name's. A real png sent under an `.exe` or `.bin`
    // name is therefore a disallowed declared type.
    test.each([["x.exe"], ["x.bin"]])("real png bytes under the name %s (a type that is not on the allow-list) are a 415", async (name) => {
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload(), { files: [file(pngBytes(), name, "image/png")] }));
      await expectProblem(res, 415);
      expectNothingStored();
    });

    test("the `video` part must be a video: a real PDF sent as video is a 415", async () => {
      const alice = await signUpContributor();
      await expectProblem(await create(alice, form(validPayload(), { video: pdfFile("fake.mp4") })), 415);
      expectNothingStored();
    });

    test("the `video` part must be a video: a real png sent as video is a 415 and nothing is stored", async () => {
      const alice = await signUpContributor();
      await expectProblem(await create(alice, form(validPayload(), { video: pngFile("photo.png") })), 415);
      expectNothingStored();
    });

    test("a file over settings.uploadMaxMb is a 413 and no file is left, including the ones stored before it", async () => {
      updateSettings(db, { uploadMaxMb: 1 });
      const alice = await signUpContributor();
      const res = await create(
        alice,
        form(validPayload(), { video: mp4File(), files: [pngFile(), file(pdfOfSize(MIB + 1), "big.pdf", "application/pdf")] }),
      );
      await expectProblem(res, 413, "Payload Too Large");
      expectNothingStored();
    });

    test("the cap is inclusive: a file of exactly uploadMaxMb is accepted", async () => {
      updateSettings(db, { uploadMaxMb: 1 });
      const alice = await signUpContributor();
      const view = await createOk(alice, validPayload(), { files: [file(pdfOfSize(MIB), "exact.pdf", "application/pdf")] });
      expect(view.attachments[0]!.size).toBe(MIB);
      expect(mediaFiles()).toHaveLength(1);
    });

    test("a request far over the total limit is a 413 whatever the cap is set to, and nothing is stored", async () => {
      updateSettings(db, { uploadMaxMb: 1 });
      const alice = await signUpContributor();
      const res = await create(alice, form(validPayload(), { files: [file(pdfOfSize(8 * MIB), "huge.pdf", "application/pdf")] }));
      await expectProblem(res, 413);
      expectNothingStored();
    });

    test("a body with no Content-Length is cut off once it passes the total limit: 413 and the rest is never pulled", async () => {
      updateSettings(db, { uploadMaxMb: 1 }); // total limit = (1 video + 3 files) x 1 MiB + 1 MiB of framing = 5 MiB
      const alice = await signUpContributor();
      const chunk = new Uint8Array(MIB).fill(0x78);
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 40) controller.close();
          else controller.enqueue(chunk);
        },
      });
      const res = await app.request(COLLECTION, {
        method: "POST",
        headers: { ...authHeaders(alice), "content-type": "multipart/form-data; boundary=----test-boundary" },
        body,
        duplex: "half",
      } as RequestInit);
      await expectProblem(res, 413);
      expect(pulled).toBeLessThan(15); // it stopped reading near 5 MiB, it did not drain 40 MiB
      expectNothingStored();
    });

    test("a Content-Length over the total limit is a 413 before the body is read", async () => {
      updateSettings(db, { uploadMaxMb: 1 });
      const alice = await signUpContributor();
      const boundary = "----test-boundary";
      const res = await app.request(COLLECTION, {
        method: "POST",
        headers: { ...authHeaders(alice), "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(500 * MIB) },
        body: `--${boundary}--\r\n`,
      });
      await expectProblem(res, 413);
      expectNothingStored();
    });
  });
});

// --- bounded work: the number of parts, the size of the payload and the size of the answer -----------------
//
// A registered contributor can send any body under the total limit, e.g. millions of empty parts with
// distinct unknown names, each of which used to become one parsed entry and one `errors[]` item. The
// pinned limits (the criteria say "a small fixed number"): at most MAX_PARTS = 16 parts in a request
// (the 5 the contract allows - payload, video, 3 files - plus room for a browser's empty file inputs),
// a `payload` part of at most 256 KiB, and at most MAX_ISSUES = 20 items in `errors[]`.

const MAX_PARTS = 16;
const MAX_ISSUES = 20;
const BOUNDARY = "----bounded-test";

/** A hand-built multipart body of empty parts with the given names, plus the `payload` part when `withPayload`. */
function rawMultipart(names: string[], opts: { withPayload?: boolean; boundaryParam?: string } = {}) {
  const { withPayload = true, boundaryParam = `boundary=${BOUNDARY}` } = opts;
  let body = "";
  if (withPayload) body += `--${BOUNDARY}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(validPayload())}\r\n`;
  for (const name of names) {
    // `files` is what a browser's empty file input sends (an empty filename); any other name is a text part.
    const disposition = name === "files" ? `name="files"; filename=""\r\nContent-Type: application/octet-stream` : `name="${name}"`;
    body += `--${BOUNDARY}\r\nContent-Disposition: form-data; ${disposition}\r\n\r\n\r\n`;
  }
  body += `--${BOUNDARY}--\r\n`;
  return { headers: { "content-type": `multipart/form-data; ${boundaryParam}` }, body };
}

const postRaw = (actor: Actor, raw: { headers: Record<string, string>; body: string }) =>
  app.request(COLLECTION, { method: "POST", headers: { ...authHeaders(actor), ...raw.headers }, body: raw.body });

/** `count` names of an empty file input: parts that are legitimate and are not attachments. */
const emptyFileInputs = (count: number): string[] => Array.from({ length: count }, () => "files");

describe("bounded work per request", () => {
  test("thousands of empty parts with distinct unknown names are refused with a small 4xx and nothing is stored", async () => {
    const alice = await signUpContributor();
    const names = Array.from({ length: 5000 }, (_, i) => `a${i}`);
    const res = await postRaw(alice, rawMultipart(names));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const text = await res.text();
    expect(text.length).toBeLessThan(2048); // the answer does not grow with the request
    expectNothingStored();
  });

  test("more than 16 parts is a 400 problem before anything is stored, even when the extra parts are harmless", async () => {
    const alice = await signUpContributor();
    // payload + 16 empty file inputs = 17 parts
    await expectProblem(await postRaw(alice, rawMultipart(emptyFileInputs(MAX_PARTS))), 400, "Bad Request");
    expectNothingStored();
  });

  test("a real upload with files and 17 parts is refused and none of its files is stored", async () => {
    const alice = await signUpContributor();
    const fd = form(validPayload(), { video: mp4File(), files: [pngFile(), pdfFile()] });
    for (let i = fd.getAll("payload").length + 3; i < MAX_PARTS + 1; i += 1) fd.append("files", new File([], "", { type: "application/octet-stream" }));
    await expectProblem(await create(alice, fd), 400, "Bad Request");
    expectNothingStored();
  });

  test("exactly 16 parts (the maximum) is accepted: payload, a video, 3 files and 11 empty file inputs", async () => {
    const alice = await signUpContributor();
    const fd = form(validPayload(), { video: mp4File(), files: [pngFile("1.png"), pngFile("2.png"), pdfFile("3.pdf")] });
    for (let i = 5; i < MAX_PARTS; i += 1) fd.append("files", new File([], "", { type: "application/octet-stream" }));
    const res = await create(alice, fd);
    expect(res.status).toBe(201);
    expect(Contribution.parse(await res.json()).attachments).toHaveLength(4);
    expect(mediaFiles()).toHaveLength(4);
  });

  test("the part limit does not depend on how the boundary is written: 16 parts with a quoted boundary pass, 17 fail", async () => {
    const alice = await signUpContributor();
    const quoted = { boundaryParam: `boundary="${BOUNDARY}"` };
    const ok = await postRaw(alice, rawMultipart(emptyFileInputs(MAX_PARTS - 1), quoted));
    expect(ok.status).toBe(201);
    await expectProblem(await postRaw(alice, rawMultipart(emptyFileInputs(MAX_PARTS), quoted)), 400, "Bad Request");
    expect(count("contributions")).toBe(1);
  });

  test("a multipart Content-Type without a boundary is a 400", async () => {
    const alice = await signUpContributor();
    const res = await postRaw(alice, rawMultipart([], { boundaryParam: "charset=utf-8" }));
    await expectProblem(res, 400, "Bad Request");
    expectNothingStored();
  });

  test("the errors[] of a 422 is bounded: a payload with 300 unknown keys reports at most 20 items, the first ones included", async () => {
    const alice = await signUpContributor();
    const unknown = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`extra${i}`, i]));
    const res = await create(alice, form(validPayload(unknown)));
    const body = await expectProblem(res, 422);
    expect(body.errors?.length).toBeGreaterThan(0);
    expect(body.errors!.length).toBeLessThanOrEqual(MAX_ISSUES);
    expect(body.errors!.map((e) => e.pointer)).toContain("/extra0");
    expectNothingStored();
  });

  test("a bound on errors[] never hides a real problem: an invalid field plus 300 unknown keys still reports the field", async () => {
    const alice = await signUpContributor();
    const unknown = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`extra${i}`, i]));
    const body = await expectProblem(await create(alice, form(validPayload({ ...unknown, name: "" }))), 422);
    expect(body.errors!.length).toBeLessThanOrEqual(MAX_ISSUES);
    expect(body.errors!.map((e) => e.pointer)).toContain("/name");
  });

  test("a `payload` part over 256 KiB is a 413 and nothing is stored; one just under it is accepted", async () => {
    const alice = await signUpContributor();
    const big = await create(alice, form(validPayload({ instructions: "x".repeat(300 * 1024) }), { files: [pngFile()] }));
    await expectProblem(big, 413, "Payload Too Large");
    expectNothingStored();

    const fine = await create(alice, form(validPayload({ instructions: "x".repeat(200 * 1024) })));
    expect(fine.status).toBe(201);
  });

  test("PUT is bounded the same way: 17 parts is a 400 and the stored contribution and its files are untouched", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { files: [pngFile()] });
    const filesBefore = mediaFiles();
    const raw = rawMultipart(emptyFileInputs(MAX_PARTS));
    const res = await app.request(`${COLLECTION}/${created.id}`, { method: "PUT", headers: { ...authHeaders(alice), ...raw.headers }, body: raw.body });
    await expectProblem(res, 400, "Bad Request");
    expect(mediaFiles()).toEqual(filesBefore);
    expect(stateOf(created.id)).toBe("pending");
  });
});

// --- GET /mine ----------------------------------------------------------------------------------------

describe("GET /api/contributions/mine", () => {
  test("a contributor with nothing submitted gets an empty array", async () => {
    const alice = await signUpContributor();
    const res = await mine(alice);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns the caller's contributions in every state, newest first, as the contract's array", async () => {
    const alice = await signUpContributor();
    const first = await createOk(alice, validPayload({ name: "first" }), { files: [pngFile()] });
    await Bun.sleep(5);
    const second = await createOk(alice, validPayload({ name: "second" }));
    const third = await createOk(alice, validPayload({ name: "third" }));
    setState(second.id, "rejected");
    await withdrawReq(alice, third.id);

    const res = await mine(alice);
    expect(res.status).toBe(200);
    const list = MyContributionsResponse.parse(await res.json());
    expect(list.map((c) => c.id).sort()).toEqual([first.id, second.id, third.id].sort());
    expect(list[list.length - 1]!.id).toBe(first.id);
    expect(list.find((c) => c.id === second.id)!.state).toBe("rejected");
    expect(list.find((c) => c.id === third.id)!.state).toBe("withdrawn");
    expect(list.find((c) => c.id === first.id)!.attachments).toHaveLength(1);
  });

  test("never contains another user's contribution", async () => {
    const alice = await signUpContributor("alice@example.com");
    const bob = await signUpContributor("bob@example.com");
    const alices = await createOk(alice, validPayload({ name: "alice-only-name" }), { files: [pngFile()] });
    const bobs = await createOk(bob, validPayload({ name: "bob-only-name" }));

    const forBob = await (await mine(bob)).text();
    expect(forBob).toContain(bobs.id);
    expect(forBob).not.toContain(alices.id);
    expect(forBob).not.toContain("alice-only-name");
    const forAlice = await (await mine(alice)).text();
    expect(forAlice).not.toContain(bobs.id);
    expect(forAlice).not.toContain("bob-only-name");
  });
});

// --- owner isolation: someone else's id is a 404, never a 403 --------------------------------------------

describe("owner isolation", () => {
  test("PUT and DELETE on another user's contribution are 404 problems and change nothing", async () => {
    const alice = await signUpContributor("alice@example.com");
    const bob = await signUpContributor("bob@example.com");
    const alices = await createOk(alice, validPayload(), { video: mp4File() });
    const filesBefore = mediaFiles();
    const rowsBefore = db.query("SELECT * FROM contributions").all();

    const putRes = await put(bob, alices.id, form(validPayload({ name: "hijacked" }), { files: [pngFile()] }));
    await expectProblem(putRes, 404, "Not Found");
    await expectProblem(await withdrawReq(bob, alices.id), 404, "Not Found");

    expect(db.query("SELECT * FROM contributions").all()).toEqual(rowsBefore);
    expect(mediaFiles()).toEqual(filesBefore);
    expect(storedPaths()).toHaveLength(1);
  });

  test("an id that does not exist is the same 404, so a stranger cannot tell them apart", async () => {
    const bob = await signUpContributor("bob@example.com");
    const alice = await signUpContributor("alice@example.com");
    const alices = await createOk(alice);
    const strangerOnReal = await expectProblem(await withdrawReq(bob, alices.id), 404);
    const strangerOnFake = await expectProblem(await withdrawReq(bob, "no-such-id"), 404);
    expect({ ...strangerOnReal, detail: undefined }).toEqual({ ...strangerOnFake, detail: undefined });
    await expectProblem(await put(bob, "no-such-id", form(validPayload())), 404);
  });

  test("a stranger's PUT with an invalid payload is a 404, not a 422: ownership is decided before the body is judged, and no byte is stored", async () => {
    const alice = await signUpContributor("alice@example.com");
    const bob = await signUpContributor("bob@example.com");
    const alices = await createOk(alice);
    const filesBefore = mediaFiles();
    await expectProblem(await put(bob, alices.id, form(validPayload({ rightsAttested: false }), { video: mp4File() })), 404, "Not Found");
    await expectProblem(await put(bob, "no-such-id", form("{not json", { video: mp4File() })), 404, "Not Found");
    expect(mediaFiles()).toEqual(filesBefore);
  });

  test("a stranger cannot reach a contribution in a state that would answer 409 to its owner (404 first)", async () => {
    const alice = await signUpContributor("alice@example.com");
    const bob = await signUpContributor("bob@example.com");
    const alices = await createOk(alice);
    setState(alices.id, "approved");
    await expectProblem(await put(bob, alices.id, form(validPayload())), 404);
    await expectProblem(await withdrawReq(bob, alices.id), 404);
  });
});

// --- PUT: edit and resubmit ----------------------------------------------------------------------------------

describe("PUT /api/contributions/:id", () => {
  test("the owner resubmits after changes were requested: 200, the updated view, state back to pending", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice);
    setState(created.id, "changes_requested");

    const res = await put(alice, created.id, form(validPayload({ name: "Better name", durationMin: 15 })));
    expect(res.status).toBe(200);
    const view = Contribution.parse(await res.json());
    expect(view.id).toBe(created.id);
    expect(view.state).toBe("pending");
    expect(view.payload.name).toBe("Better name");
    expect(view.payload.durationMin).toBe(15);
    expect(stateOf(created.id)).toBe("pending");
    expect(count("contributions")).toBe(1);
  });

  test("a pending contribution can be edited in place", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice);
    const res = await put(alice, created.id, form(validPayload({ name: "Edited while pending" })));
    expect(res.status).toBe(200);
    expect(Contribution.parse(await res.json()).payload.name).toBe("Edited while pending");
  });

  test("with no file part the stored attachments and their files are kept", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { video: mp4File(), files: [pngFile()] });
    const filesBefore = mediaFiles();

    const res = await put(alice, created.id, form(validPayload({ name: "Only text changed" })));
    expect(res.status).toBe(200);
    const view = Contribution.parse(await res.json());
    expect(view.attachments.map((a) => a.id)).toEqual(created.attachments.map((a) => a.id));
    expect(mediaFiles()).toEqual(filesBefore);
  });

  test("with file parts the attachments are REPLACED and the replaced files are deleted from disk", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { video: mp4File(), files: [pngFile()] });
    const oldFiles = mediaFiles();
    expect(oldFiles).toHaveLength(2);

    const res = await put(alice, created.id, form(validPayload(), { files: [pdfFile("new.pdf")] }));
    expect(res.status).toBe(200);
    const view = Contribution.parse(await res.json());
    expect(view.attachments.map((a) => a.filename)).toEqual(["new.pdf"]);
    const remaining = mediaFiles();
    expect(remaining).toHaveLength(1);
    expect(remaining).toEqual(storedPaths());
    for (const old of oldFiles) expect(remaining).not.toContain(old);
  });

  test("an invalid payload is a 422 with pointers: the contribution and its files are untouched and the new bytes purged", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { files: [pngFile()] });
    const filesBefore = mediaFiles();
    const rowBefore = db.query("SELECT * FROM contributions WHERE id = ?").get(created.id);

    const res = await put(alice, created.id, form(validPayload({ rightsAttested: false }), { video: mp4File() }));
    const body = await expectProblem(res, 422);
    expect(body.errors?.map((e) => e.pointer)).toContain("/rightsAttested");
    expect(mediaFiles()).toEqual(filesBefore);
    expect(db.query("SELECT * FROM contributions WHERE id = ?").get(created.id)).toEqual(rowBefore);
  });

  test("an oversize replacement file is a 413: the old files stay and no new file is left", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { files: [pngFile()] });
    const filesBefore = mediaFiles();
    updateSettings(db, { uploadMaxMb: 1 });

    const res = await put(alice, created.id, form(validPayload(), { files: [pngFile(), file(pdfOfSize(MIB + 1), "big.pdf", "application/pdf")] }));
    await expectProblem(res, 413);
    expect(mediaFiles()).toEqual(filesBefore);
    expect(storedPaths()).toEqual(filesBefore);
  });

  test.each(["approved", "rejected", "withdrawn"])("a contribution that is %s cannot be edited: 409, nothing changes, the new bytes are purged", async (state) => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { files: [pngFile()] });
    setState(created.id, state);
    const filesBefore = mediaFiles();

    const res = await put(alice, created.id, form(validPayload({ name: "too late" }), { video: mp4File() }));
    await expectProblem(res, 409, "Conflict");
    expect(stateOf(created.id)).toBe(state);
    expect((db.query("SELECT payload FROM contributions WHERE id = ?").get(created.id) as { payload: string }).payload).toContain(MARKER);
    expect(mediaFiles()).toEqual(filesBefore);
  });

  test("an improvement resubmitted with an unknown drill is a 422 on /targetDrillSlug", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice);
    const res = await put(alice, created.id, form(validPayload({ kind: "improvement", targetDrillSlug: "no-such-drill" })));
    const body = await expectProblem(res, 422);
    expect(body.errors?.map((e) => e.pointer)).toContain("/targetDrillSlug");
  });
});

// --- DELETE: withdraw -----------------------------------------------------------------------------------------

describe("DELETE /api/contributions/:id", () => {
  test("withdraws: 200, the withdrawn view, the attachment rows AND the files are deleted", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { video: mp4File(), files: [pngFile(), pdfFile()] });
    expect(mediaFiles()).toHaveLength(3);

    const res = await withdrawReq(alice, created.id);
    expect(res.status).toBe(200);
    const view = Contribution.parse(await res.json());
    expect(view.id).toBe(created.id);
    expect(view.state).toBe("withdrawn");
    expect(view.attachments).toEqual([]);
    expect(stateOf(created.id)).toBe("withdrawn");
    expect(count("contribution_attachments")).toBe(0);
    expect(mediaFiles()).toEqual([]);
  });

  test("a contribution that was already withdrawn is a 409", async () => {
    const alice = await signUpContributor();
    const created = await createOk(alice);
    expect((await withdrawReq(alice, created.id)).status).toBe(200);
    await expectProblem(await withdrawReq(alice, created.id), 409, "Conflict");
  });

  test.each(["approved", "rejected"])("a contribution that is %s cannot be withdrawn: 409 and its files stay", async (state) => {
    const alice = await signUpContributor();
    const created = await createOk(alice, validPayload(), { files: [pngFile()] });
    setState(created.id, state);
    const filesBefore = mediaFiles();

    await expectProblem(await withdrawReq(alice, created.id), 409, "Conflict");
    expect(stateOf(created.id)).toBe(state);
    expect(mediaFiles()).toEqual(filesBefore);
    expect(count("contribution_attachments")).toBe(1);
  });

  test("a withdrawal leaves other contributions' files alone", async () => {
    const alice = await signUpContributor();
    const a = await createOk(alice, validPayload(), { files: [pngFile()] });
    const b = await createOk(alice, validPayload({ name: "second" }), { files: [pdfFile()] });
    await withdrawReq(alice, a.id);
    expect(mediaFiles()).toEqual(storedPaths());
    expect(mediaFiles()).toHaveLength(1);
    expect(stateOf(b.id)).toBe("pending");
  });
});

// --- a pending contribution never shows in the commons ------------------------------------------------------------

describe("the commons never shows a contribution that is not accepted", () => {
  test("after a new contribution and an improvement of a real drill, the drill list and the export are unchanged and hold no trace", async () => {
    const list = "/api/commons/drills?limit=100";
    const exportPath = "/api/commons/export.json";
    const listBefore = await (await app.request(list)).text();
    const exportBefore = await (await app.request(exportPath)).text();
    expect(listBefore).not.toContain(MARKER);

    const alice = await signUpContributor();
    await createOk(alice, validPayload(), { video: mp4File(), files: [pngFile()] });
    await createOk(alice, validPayload({ name: `${MARKER}-improved`, kind: "improvement", targetDrillSlug: DRILL_SLUG, improvementKind: "safety" }));

    for (const [path, before] of [[list, listBefore], [exportPath, exportBefore]] as const) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(MARKER);
      expect(text).toBe(before);
    }
    const drill = await (await app.request(`/api/commons/drills/${DRILL_SLUG}`)).text();
    expect(drill).not.toContain(MARKER);
  });
});
