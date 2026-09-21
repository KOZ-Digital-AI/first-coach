// GET /api/media/:attachmentId (fc-mol-70i.6): serves one contribution attachment from the private
// upload store (MEDIA_DIR), with Range support.
//
// WHO MAY READ (one rule, decided per attachment)
//   - PUBLIC media: the attachment's contribution is 'approved' and its resulting drill is published
//     (unpublished_at IS NULL). Anyone may read it, with or without a session.
//   - everything else (pending, changes_requested, rejected, approved-but-unpublished, approved with no
//     drill): ONLY the submitter and an admin, and only a signed-in, NON-anonymous, not banned account.
//   - a foreign contributor, an anonymous player, an unauthenticated caller, a banned account, a missing
//     or malformed id, a row whose file is gone, an unusable stored name or a stored mime that is not an
//     allowed upload type all get THE SAME 404 (one response builder, nothing from the request echoed),
//     so a caller learns nothing about which ids exist. Never 401/403 here.
//   The route is not behind requireContributor/requireAdmin on purpose (those answer 401/403 and public
//   media needs no session); it reads the session with Better Auth's getSession and applies the same
//   rules as the guards in auth/middleware.ts: `isAnonymous !== false` is anonymous, a ban applies until
//   its expiry, the admin role is an exact match in the comma-separated role string. Roles and identity
//   come from the server session only; nothing in the request (header, query) is read for them. A failed
//   session lookup propagates to the app's error handler (500); it never falls through to serving.
//
// WHAT IS SENT
//   - The file is found from the STORED name only (the row's stored_path), through resolveStoredFile:
//     never from anything the client sent, not even the client's file name (metadata only).
//   - Content-Type is the stored mime from the row (the type the magic bytes were checked against at
//     upload), never sniffed and never taken from the request; a stored mime outside UPLOAD_MIME_TYPES is
//     never served. X-Content-Type-Options: nosniff on every response.
//   - Cache-Control: `private, no-store` for private media (on 200, 206, 416 and 404); public media is
//     `public, no-cache` (shared caches may store it but must revalidate, so an unpublish takes effect).
//   - Content-Disposition: `inline` for images and video, `attachment` for a PDF (it must not render in
//     the app's origin). The name is the client's file name made safe: control, bidi and path characters
//     replaced, an ASCII-only `filename` fallback and an RFC 5987 `filename*`; it cannot break out of the
//     header or the quotes.
//   - No listing: only /api/media/:attachmentId exists; /api/media and /api/media/ are the app's 404.
//
// RANGE (reading of RFC 9110): a single `bytes=a-b`, `bytes=a-` or `bytes=-n` is answered 206 with
// Content-Range and the end clamped to the file; an unsatisfiable one (start at or past the end, `-0`, a
// range on an empty file) is 416 with `Content-Range: bytes */size`; a malformed, reversed or multiple
// range, or any request with If-Range (no validator is offered, so it cannot match), is ignored and the
// whole file is sent as 200. The size is the file's, read when serving.
import type { Hono } from "hono";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth, getSession, ROLE_ADMIN } from "../../auth/better-auth";
import { type AttachmentForServing, getAttachmentForServing } from "../../contributions/repo";
import { resolveMediaDir, resolveStoredFile } from "../../contributions/uploads";
import { UPLOAD_MIME_TYPES } from "../../shared/contributions";
import { problem } from "../problem";

const ATTACHMENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PRIVATE_CACHE = "private, no-store";
const PUBLIC_CACHE = "public, no-cache";

const isAllowedMime = (mime: string): boolean => (UPLOAD_MIME_TYPES as readonly string[]).includes(mime);

// --- the one 404 -----------------------------------------------------------------------------------------

/** Every refusal, whatever the reason. Fixed text, no id, no reason. */
function notFound(): Response {
  const res = problem(404, "Not Found", "Media not found.");
  res.headers.set("cache-control", PRIVATE_CACHE);
  res.headers.set("x-content-type-options", "nosniff");
  return res;
}

// --- access ------------------------------------------------------------------------------------------------------

type SessionUser = { id: string; role?: string | null; isAnonymous?: boolean | null; banned?: boolean | null; banExpires?: Date | string | number | null };

/** As auth/middleware.ts: a ban applies until its expiry; no expiry, or an unreadable one, means it still applies. */
function isBanned(user: SessionUser): boolean {
  if (!user.banned) return false;
  if (user.banExpires === null || user.banExpires === undefined) return true;
  const until = new Date(user.banExpires).getTime();
  return Number.isNaN(until) || until > Date.now();
}

/** Owner-or-admin, for a signed-in non-anonymous account that is not banned. */
function mayReadPrivate(user: SessionUser | undefined, file: AttachmentForServing): boolean {
  if (user === undefined || user.isAnonymous !== false || isBanned(user)) return false;
  const isAdmin = (user.role ?? "").split(",").includes(ROLE_ADMIN);
  return isAdmin || user.id === file.submitterUserId;
}

// --- range -----------------------------------------------------------------------------------------------------------

type ByteRange = { start: number; end: number };

/** undefined: no usable Range header (send it all); "unsatisfiable": 416; otherwise the inclusive byte range. */
function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (match === null) return undefined; // malformed, another unit, several ranges: ignored
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    const n = Number(last); // the last n bytes
    return n === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return undefined; // reversed: invalid, ignored
  if (start >= size) return "unsatisfiable";
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

// --- Content-Disposition ----------------------------------------------------------------------------------------

// C0 and C1 controls, zero-width and bidi formatting characters, BOM, and both path separators.
const UNSAFE_NAME_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff/\\\\]", "g");

function contentDisposition(mime: string, originalName: string): string {
  const type = mime === "application/pdf" ? "attachment" : "inline";
  const name = String(originalName).replace(UNSAFE_NAME_CHARS, "_").trim() || "download";
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, "_");
  let encoded: string;
  try {
    // RFC 5987 attr-char: encodeURIComponent leaves ! ' ( ) * alone, which are not attr-char.
    encoded = encodeURIComponent(name).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    encoded = encodeURIComponent(fallback); // a lone surrogate cannot be encoded
  }
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// --- the route ---------------------------------------------------------------------------------------------------------

export async function register(app: Hono, deps: AppDeps): Promise<void> {
  // The session lookup reads Better Auth's tables. Idempotent and shared with auth.routes.ts.
  const auth = getAuth(deps);
  await ensureAuthSchema(auth, deps.db);

  app.get("/api/media/:attachmentId", async (c) => {
    const id = c.req.param("attachmentId");
    if (!ATTACHMENT_ID.test(id)) return notFound();
    const row = getAttachmentForServing(deps.db, id);
    if (row === null || !isAllowedMime(row.mime)) return notFound();

    if (!row.isPublic) {
      const session = await getSession(auth, c.req.raw.headers);
      if (!mayReadPrivate(session?.user, row)) return notFound();
    }

    const path = resolveStoredFile(resolveMediaDir(process.env), row.storedPath);
    if (path === undefined) return notFound();

    const file = Bun.file(path);
    const size = file.size;
    const headers = new Headers({
      "content-type": row.mime,
      "content-disposition": contentDisposition(row.mime, row.originalName),
      "cache-control": row.isPublic ? PUBLIC_CACHE : PRIVATE_CACHE,
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
    });

    const range = c.req.header("if-range") === undefined ? parseRange(c.req.header("range"), size) : undefined;
    if (range === "unsatisfiable") {
      const res = problem(416, "Range Not Satisfiable", "The requested range cannot be satisfied.");
      for (const [name, value] of headers) if (name !== "content-type" && name !== "content-disposition") res.headers.set(name, value);
      res.headers.set("content-range", `bytes */${size}`);
      return res;
    }
    if (range === undefined) {
      headers.set("content-length", String(size));
      return new Response(file, { status: 200, headers });
    }
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
  });
}
