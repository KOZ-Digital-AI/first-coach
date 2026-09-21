// Contribution routes (fc-mol-70i.5): POST /api/contributions, GET /api/contributions/mine,
// PUT /api/contributions/:id (edit + resubmit) and DELETE /api/contributions/:id (withdraw).
//
// All four sit behind requireContributor: no session is a 401, an anonymous player a 403 (a
// contributor needs a registered account). The guard runs BEFORE the body is read, so an
// unauthorised request can neither reach the store nor write a byte to disk.
//
// Abuse guards (contributions/guards.ts, fc-mol-4ds.4), all before any file is stored:
//   POST   per-user daily limiter (429 + Retry-After), BEFORE the body is read; then, once the payload
//          is valid, an identical undecided contribution of the same user is a 409 pointing at it;
//   POST and PUT   a filled honeypot is a generic 422 on /website, judged before the rest of the payload.
//
// POST and PUT are ONE multipart request: a `payload` part (JSON, validated with the contract's
// ContributionPayloadRequest), an optional `video` part and up to 3 `files` parts. The order is
//   auth -> read the body under a hard size limit -> parse the parts -> validate -> store the files
//   -> write the contribution (one transaction in the repository)
// so nothing is written to MEDIA_DIR until the payload and the part layout are valid, and any failure
// AFTER a file was stored (a later file too big or of the wrong type, an unknown target drill, a
// state guard, a database error) deletes every file this request stored and rethrows.
//
// Errors are RFC 9457 problems (http/problem):
//   400 body is not multipart, is broken, or the `payload` part is missing / not a JSON object;
//   401 no session; 403 anonymous player;
//   404 a contribution that is not the caller's, or does not exist (never 403, never a different
//       answer: the repository throws the same error for both);
//   409 PUT/DELETE in a state that does not allow it; POST of content the caller already has undecided;
//   429 POST over the per-user daily limit (auth/rate-limit `contribution`);
//   413 the request, or one file, is over the limit (settings.uploadMaxMb, read on every request);
//   415 a file whose bytes are not an allowed type, or a `video` part that is not a video;
//   422 the payload or the part layout is invalid, with JSON Pointers ("/rightsAttested", "/files",
//       "/targetDrillSlug"); a filled honeypot `website` is a generic 422 on "/website" (rejected, not a
//       fake success), and NOTHING is stored;
//   anything else is rethrown to the app's onError (500 problem).
//
// CHOICES the contract leaves open (pinned by the tests)
//   - Work per request is bounded: at most MAX_PARTS (16) parts, counted from the multipart delimiters in the
//     already size-capped body before it is parsed (400 above it; an upper bound on the parts, so a body
//     cannot hide parts from it); a `payload` part of at most 256 KiB (413); at most MAX_ISSUES (20) items in
//     a 422's errors[]. Nothing has been stored when any of these refuses, so there is nothing to purge.
//   - The body is read through a byte counter with a total limit of (1 video + 3 files) x cap + 1 MiB
//     for the payload and the multipart framing: a Content-Length over it is refused before a byte is
//     read, and a body without (or lying about) Content-Length is cut off as soon as the counter passes
//     it. The per-file cap is enforced by storeUpload. The accepted body is held in memory (at most
//     that limit) and parsed with the platform's multipart parser.
//   - PUT with no file part keeps the stored attachments; with any file part it REPLACES them all (the
//     repository's updateForResubmit semantics); the replaced files are deleted after the commit. A
//     client cannot clear the attachments without replacing them.
//   - A browser's empty file input (a part with no file name and no bytes) is not an attachment.
//   - An unknown part name, a second `video`, more than 3 `files`, or a text value in a file part is a
//     422 on that part's name, reported together with the payload's own issues.
//   - Files that cannot be deleted after a commit (the row is already gone) are logged, never failed
//     on: the orphan sweep (contributions/uploads sweepOrphans) is the safety net.
import { Hono } from "hono";
import type { Context } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requireContributor } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import {
  ContributionNotFoundError,
  InvalidStateError,
  TargetDrillNotFoundError,
  attachmentPathsOf,
  createContribution,
  getForOwner,
  listMine,
  updateForResubmit,
  withdraw,
} from "../../contributions/repo";
import type { NewAttachment } from "../../contributions/repo";
import {
  UnsupportedMediaTypeError,
  UploadTooLargeError,
  deleteUpload,
  resolveMediaDir,
  storeUpload,
  uploadLimitBytes,
} from "../../contributions/uploads";
import {
  DuplicateContributionError,
  assertNotOwnDuplicate,
  contributionLimiter,
  duplicateProblem,
  rejectHoneypot,
} from "../../contributions/guards";
import { ContributionParams, ContributionPayloadRequest, ENDPOINTS } from "../../shared/contributions";
import type { ProblemError } from "../../shared/primitives";
import { fromZodError, problem } from "../problem";

/** `files` parts allowed next to the one `video` part. */
const MAX_FILES = 3;
/** Room in the request limit for the payload JSON and the multipart framing. */
const BODY_OVERHEAD_BYTES = 1024 * 1024;
/**
 * Parts in one request: the payload, the video and 3 files are 5; the rest is room for a browser's empty
 * file inputs. More is refused (400) BEFORE the body is parsed, so the work per request does not grow with it.
 */
const MAX_PARTS = 16;
/** The `payload` part is text fields; 256 KiB is far more than a drill needs (413 above it). */
const MAX_PAYLOAD_CHARS = 256 * 1024;
/** Items in a 422's `errors[]`: the first ones, so the answer does not grow with the request. */
const MAX_ISSUES = 20;

type Ctx = Context<{ Variables: AuthVariables }>;
type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = <T>(response: Response): Outcome<T> => ({ ok: false, response });

const escapePointer = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");

// --- logging (never bodies, headers or names) ---------------------------------------------------

function logCleanupFailure(path: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "could not delete an upload",
      path,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** Best-effort deletion of stored files: one failure never stops the others or masks the caller's error. */
function purge(mediaDir: string, storedPaths: readonly string[]): void {
  for (const storedPath of storedPaths) {
    try {
      deleteUpload(mediaDir, storedPath);
    } catch (error) {
      logCleanupFailure(storedPath, error);
    }
  }
}

// --- reading the body under a limit -------------------------------------------------------------------

/** The whole body, or undefined as soon as it passes `maxBytes` (the source is cancelled: no more is read). */
async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

// --- bounding the parts -----------------------------------------------------------------------------------

/** The boundary parameter of a multipart Content-Type (quoted or not), or undefined. */
function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s"]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

/**
 * How many times the delimiter `--<boundary>` occurs in the body, counting no further than `limit + 1`.
 * Every part needs its own opening delimiter (plus one closing delimiter), so this is an upper bound on
 * the parts the parser will produce; it costs one pass of indexOf, not one object per part.
 */
function countDelimiters(bytes: Uint8Array, boundary: string, limit: number): number {
  const needle = Buffer.from(`--${boundary}`);
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let found = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && found <= limit; at = haystack.indexOf(needle, at + needle.length)) {
    found += 1;
  }
  return found;
}

// --- parsing the submission ----------------------------------------------------------------------------

type Submission = {
  payload: ContributionPayloadRequest;
  video: File | undefined;
  files: File[];
};

const isRealFile = (value: FormDataEntryValue): value is File => typeof value !== "string";

/** One issue per unknown key, at that key's own path, so its pointer names the key (as admin-settings does). */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] }))
        : [issue],
    ),
  );
}

const tooLarge = (maxBytes: number): Response =>
  problem(413, "Payload Too Large", `The upload is over the limit of ${Math.floor(maxBytes / (1024 * 1024))} MB per file.`);

const badRequest = (detail: string): Response => problem(400, "Bad Request", detail);

/** Reads and validates the multipart body. Writes nothing anywhere. */
async function readSubmission(c: Ctx, deps: AppDeps): Promise<Outcome<Submission>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^multipart\/form-data\s*(;|$)/i.test(contentType)) {
    return fail(badRequest("The request must be multipart/form-data."));
  }

  const perFile = uploadLimitBytes(deps.db);
  const bodyLimit = perFile * (MAX_FILES + 1) + BODY_OVERHEAD_BYTES;
  const bytes = await readCapped(c.req.raw, bodyLimit);
  if (bytes === undefined) return fail(tooLarge(perFile));

  const boundary = boundaryOf(contentType);
  if (boundary === undefined) return fail(badRequest("The multipart Content-Type has no boundary."));
  // MAX_PARTS parts have MAX_PARTS opening delimiters and one closing one.
  if (countDelimiters(bytes, boundary, MAX_PARTS + 1) > MAX_PARTS + 1) {
    return fail(badRequest(`The request has too many parts: send at most ${MAX_PARTS}.`));
  }

  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return fail(badRequest("The multipart body could not be read."));
  }

  const issues: ProblemError[] = [];
  let payloadPart: FormDataEntryValue | undefined;
  let video: File | undefined;
  const files: File[] = [];

  for (const [name, value] of form.entries()) {
    if (name === "payload") {
      if (payloadPart !== undefined) return fail(badRequest("There must be exactly one `payload` part."));
      payloadPart = value;
    } else if (name === "video" || name === "files") {
      if (!isRealFile(value)) {
        issues.push({ pointer: `/${name}`, detail: `\`${name}\` must be a file.` });
      } else if (value.size === 0 && !value.name) {
        continue; // a browser's empty file input (Bun's parser hands it over with an undefined name)
      } else if (name === "video") {
        if (video !== undefined) issues.push({ pointer: "/video", detail: "Send at most one video." });
        else video = value;
      } else {
        files.push(value);
      }
    } else {
      issues.push({ pointer: `/${escapePointer(name)}`, detail: "Unknown part." });
    }
  }
  if (files.length > MAX_FILES) issues.push({ pointer: "/files", detail: `Send at most ${MAX_FILES} files.` });

  if (payloadPart === undefined) return fail(badRequest("The `payload` part is required."));
  // A file part is measured by its size before it is read (its bytes are UTF-8, so this is the stricter unit).
  const payloadSize = isRealFile(payloadPart) ? payloadPart.size : payloadPart.length;
  if (payloadSize > MAX_PAYLOAD_CHARS) {
    return fail(problem(413, "Payload Too Large", `The \`payload\` part is over ${MAX_PAYLOAD_CHARS / 1024} KiB.`));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(isRealFile(payloadPart) ? await payloadPart.text() : payloadPart);
  } catch {
    return fail(badRequest("The `payload` part must be JSON."));
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail(badRequest("The `payload` part must be a JSON object."));
  }

  // The honeypot is judged on the raw payload, before anything else about it is (guards.ts).
  const trapped = rejectHoneypot(raw as Record<string, unknown>);
  if (trapped !== undefined) return fail(trapped);

  const parsed = ContributionPayloadRequest.safeParse(raw);
  if (!parsed.success) issues.unshift(...fromZodError(expandUnknownKeys(parsed.error)));
  if (issues.length > 0 || !parsed.success) {
    return fail(problem(422, "Unprocessable Entity", "The contribution was not saved: some values are invalid.", issues.slice(0, MAX_ISSUES)));
  }
  return ok({ payload: parsed.data, video, files });
}

// --- storing the files ------------------------------------------------------------------------------------

/**
 * Stores the video (if any) and then the files, in that order, and hands the attachment rows to `write`.
 * Whatever goes wrong at any point after the first byte was written, every file stored so far is deleted
 * and the error is rethrown.
 */
async function withStoredUploads<T>(
  deps: AppDeps,
  submission: Submission,
  write: (attachments: NewAttachment[]) => T,
): Promise<T> {
  const mediaDir = resolveMediaDir();
  const maxBytes = uploadLimitBytes(deps.db);
  const attachments: NewAttachment[] = [];
  try {
    const parts: { part: File; mustBeVideo: boolean }[] = [
      ...(submission.video === undefined ? [] : [{ part: submission.video, mustBeVideo: true }]),
      ...submission.files.map((part) => ({ part, mustBeVideo: false })),
    ];
    for (const { part, mustBeVideo } of parts) {
      // storeUpload holds the declared type to the bytes' family, so a video-family declaration is enough.
      if (mustBeVideo && !part.type.trim().toLowerCase().startsWith("video/")) {
        throw new UnsupportedMediaTypeError("mismatch");
      }
      const stored = await storeUpload(
        { body: part, declaredMime: part.type, originalName: part.name },
        { mediaDir, maxBytes },
      );
      attachments.push({
        kind: stored.kind,
        storedPath: stored.storedPath,
        mime: stored.mime,
        bytes: stored.bytes,
        originalName: stored.originalName,
      });
    }
    return write(attachments);
  } catch (error) {
    purge(mediaDir, attachments.map((a) => a.storedPath));
    throw error;
  }
}

// --- error mapping ------------------------------------------------------------------------------------------------

/** The problem for an error the routes know about; undefined for everything else (rethrown to onError). */
function problemFor(error: unknown): Response | undefined {
  if (error instanceof UploadTooLargeError) return tooLarge(error.maxBytes);
  if (error instanceof UnsupportedMediaTypeError) {
    return problem(415, "Unsupported Media Type", "The file is not an allowed type: send mp4, webm, mov, jpeg, png or pdf.");
  }
  if (error instanceof TargetDrillNotFoundError) {
    return problem(422, "Unprocessable Entity", "The contribution was not saved: some values are invalid.", [
      { pointer: "/targetDrillSlug", detail: error.message },
    ]);
  }
  if (error instanceof DuplicateContributionError) return duplicateProblem(error.existingId);
  if (error instanceof ContributionNotFoundError) return problem(404, "Not Found", "No such contribution.");
  if (error instanceof InvalidStateError) {
    return problem(409, "Conflict", `The contribution is ${error.state} and cannot be ${error.operation === "withdraw" ? "withdrawn" : "resubmitted"}.`);
  }
  return undefined;
}

async function answer(run: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const known = problemFor(error);
    if (known === undefined) throw error;
    return known;
  }
}

// --- the routes ------------------------------------------------------------------------------------------------------

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const contributor = requireContributor(deps);
  const { db } = deps;
  const { createContribution: createSpec, listMine: mineSpec, updateContribution: updateSpec, withdrawContribution: withdrawSpec } = ENDPOINTS;

  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.post(createSpec.path, contributor, contributionLimiter(), (c) =>
    answer(async () => {
      const submission = await readSubmission(c, deps);
      if (!submission.ok) return submission.response;
      const userId = c.var.playerId;
      const { payload } = submission.value;
      // Cheap early exit before a byte is stored; repeated with the insert, in one synchronous step, so two
      // identical requests that are both in flight cannot both be written (the loser's files are purged).
      assertNotOwnDuplicate(db, userId, payload);
      const view = await withStoredUploads(deps, submission.value, (attachments) => {
        assertNotOwnDuplicate(db, userId, payload);
        return createContribution(db, { userId, payload, attachments });
      });
      return c.json(view, 201);
    }),
  );

  routes.get(mineSpec.path, contributor, (c) => c.json(listMine(db, c.var.playerId), 200));

  routes.put(updateSpec.path, contributor, (c) =>
    answer(async () => {
      const params = ContributionParams.safeParse(c.req.param());
      if (!params.success) return problem(400, "Bad Request", "Invalid request parameters.", fromZodError(params.error));
      const { id } = params.data;
      const userId = c.var.playerId;

      // Someone else's id (or none) is refused BEFORE the body is read or a byte is stored. The repository
      // repeats the check inside its transaction, which is the authoritative one.
      if (getForOwner(db, userId, id) === null) throw new ContributionNotFoundError();

      const submission = await readSubmission(c, deps);
      if (!submission.ok) return submission.response;
      const { payload, video, files } = submission.value;

      // No file part keeps the stored attachments; any file part replaces them all.
      const replacing = video !== undefined || files.length > 0;
      let replacedPaths: string[] = [];
      const view = await withStoredUploads(deps, submission.value, (attachments) => {
        // Read in the same synchronous step as the write: nothing can change the rows in between.
        replacedPaths = replacing ? attachmentPathsOf(db, id) : [];
        return updateForResubmit(db, userId, id, payload, replacing ? attachments : undefined);
      });
      purge(resolveMediaDir(), replacedPaths); // committed: the replaced files are garbage now
      return c.json(view, 200);
    }),
  );

  routes.delete(withdrawSpec.path, contributor, (c) =>
    answer(() => {
      const params = ContributionParams.safeParse(c.req.param());
      if (!params.success) return problem(400, "Bad Request", "Invalid request parameters.", fromZodError(params.error));
      const { id } = params.data;

      // Read the paths BEFORE the withdrawal deletes the rows; they are only used once it has committed
      // (someone else's id throws ContributionNotFoundError from withdraw, and nothing is deleted).
      const paths = attachmentPathsOf(db, id);
      const view = withdraw(db, c.var.playerId, id);
      purge(resolveMediaDir(), paths);
      return c.json(view, 200);
    }),
  );

  app.route("/", routes);
}
