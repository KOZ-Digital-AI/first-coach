// Upload store for contribution attachments (fc-mol-70i.2): files live under MEDIA_DIR, are named by
// the server, and are checked by what they ARE (magic bytes), never by what the client says they are.
//
// Layout: MEDIA_DIR is a FLAT directory of `<32 hex>.<ext>` files. The row in contribution_attachments
// (006) holds that name as stored_path; the client's file name is metadata only (original_name).
// MEDIA_DIR defaults to ./data/media relative to the working directory (env.ts reads MEDIA_DIR as an
// optional string; the Docker image sets it to /data/media, on the volume). Nothing here ever writes
// outside the directory it is handed.
//
// Readings of the criteria (also pinned by uploads.test.ts):
//  * The size cap `maxBytes` is inclusive and is enforced WHILE streaming: each chunk is counted before
//    it is written, the first chunk that would cross the cap aborts the upload, cancels the source and
//    deletes the partial file. Nothing but a 12-byte header window is ever held back in memory (and
//    that only until the type is known). The cap in settings, uploadMaxMb, is megabytes = MiB.
//  * MIME allow-list = UPLOAD_MIME_TYPES, verified by MAGIC BYTES at offset 0 of the stream. The
//    declared (header) type must ALSO be on the allow-list and in the same FAMILY (video / image /
//    document) as the detected type, else the upload is rejected (415). A sibling inside a family (a
//    declared video/mp4 whose bytes are QuickTime) is accepted and the DETECTED type is what is stored.
//    Known limit: WebM and Matroska share the EBML header; only the magic 1A45DFA3 is checked.
//  * The client's name never touches a path. It is sanitised (basename, control and bidi characters
//    removed, at most 200 characters, never blank) and returned as `originalName` for the row.
//  * Files are created exclusively (`wx`: O_CREAT | O_EXCL): an existing name, including a planted
//    symlink, is never overwritten or written through; a new random name is drawn instead.
//  * sweepOrphans leaves a file younger than ORPHAN_GRACE_MS (10 minutes, by mtime) alone, so an upload
//    that has written its file but not yet inserted its row is not deleted. It only ever touches
//    regular files directly in mediaDir: symlinks and subdirectories are skipped, never followed.
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getSettings } from "../admin/settings";
import { UPLOAD_MIME_TYPES } from "../shared/contributions";
import type { MediaKind } from "../shared/primitives";

// --- errors ---------------------------------------------------------------------------------------

/** The upload passed `maxBytes`. The route maps it to a 413 problem. */
export class UploadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`upload exceeds the limit of ${maxBytes} bytes`);
    this.name = "UploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export type UnsupportedReason = "empty" | "declared-not-allowed" | "unrecognised" | "mismatch";

/** The bytes (or the declared type) are not an allowed upload type. The route maps it to a 415 problem. */
export class UnsupportedMediaTypeError extends Error {
  readonly reason: UnsupportedReason;

  constructor(reason: UnsupportedReason) {
    super(`unsupported upload type (${reason})`);
    this.name = "UnsupportedMediaTypeError";
    this.reason = reason;
  }
}

/** A stored path that is not a plain path inside the media directory. */
export class UnsafePathError extends Error {
  constructor(message = "path is not inside the media directory") {
    super(message);
    this.name = "UnsafePathError";
  }
}

// --- the allow-list ---------------------------------------------------------------------------------

type AllowedMime = (typeof UPLOAD_MIME_TYPES)[number];

const TYPES: Record<AllowedMime, { kind: MediaKind; ext: string }> = {
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
  "video/quicktime": { kind: "video", ext: "mov" },
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/png": { kind: "image", ext: "png" },
  "application/pdf": { kind: "document", ext: "pdf" },
};

const isAllowedMime = (mime: string): mime is AllowedMime => Object.hasOwn(TYPES, mime);

/** Bytes needed to tell every allowed type apart: an ftyp box is size(4) 'ftyp'(4) brand(4). */
const HEADER_BYTES = 12;

/** Major brands of an ISO base media file that is an mp4 (a 'qt  ' brand is QuickTime; heic, avif, M4A are not video). */
const MP4_BRANDS = new Set([
  "isom", "mp41", "mp42", "mmp4", "avc1", "dash", "msnv", "ndas", "M4V ", "M4VH", "M4VP", "f4v ", "3gp4", "3gp5", "3gp6", "3gp7",
]);

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);

const asciiAt = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** What the bytes are, or undefined when they are not an allowed type. */
function detectMime(head: Uint8Array): AllowedMime | undefined {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm"; // EBML
  if (head.length >= HEADER_BYTES && asciiAt(head, 4, 4) === "ftyp") {
    const boxSize = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0);
    if (boxSize !== 1 && boxSize < HEADER_BYTES) return undefined; // 1 = 64-bit size follows
    const brand = asciiAt(head, 8, 4);
    if (brand === "qt  ") return "video/quicktime";
    if (MP4_BRANDS.has(brand) || /^iso[2-9]$/.test(brand)) return "video/mp4";
  }
  return undefined;
}

/** "Video/MP4; codecs=avc1" -> "video/mp4". */
const normaliseMime = (declared: string): string => String(declared).split(";")[0]!.trim().toLowerCase();

// --- the client's file name -------------------------------------------------------------------------------

const MAX_NAME_CHARS = 200;
// C0 and C1 controls, DEL, zero-width and bidi formatting characters, BOM.
const INVISIBLE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/**
 * The client's file name as safe METADATA: no control characters, only the part after the last `/` or
 * `\`, no dots-only names, at most 200 characters (cut on characters, not code units), never blank
 * ("upload" when nothing is left). It is never used to build a path.
 */
export function sanitizeOriginalName(raw: string): string {
  let name = String(raw).replace(INVISIBLE, "");
  name = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).trim();
  if (/^\.*$/.test(name)) return "upload";
  const chars = Array.from(name);
  if (chars.length > MAX_NAME_CHARS) name = chars.slice(0, MAX_NAME_CHARS).join("").trim();
  return name === "" ? "upload" : name;
}

// --- MEDIA_DIR and the limit -----------------------------------------------------------------------------------

export const DEFAULT_MEDIA_DIR = "./data/media";

/** MEDIA_DIR (blank counts as unset, as in env.ts), else ./data/media; resolved against the working directory. */
export function resolveMediaDir(env: Record<string, string | undefined> = process.env): string {
  const value = env.MEDIA_DIR;
  return resolve(value !== undefined && value.trim() !== "" ? value : DEFAULT_MEDIA_DIR);
}

/** settings.uploadMaxMb as bytes (megabytes = MiB). */
export function uploadLimitBytes(db: Database): number {
  return getSettings(db).uploadMaxMb * 1024 * 1024;
}

// --- storing -------------------------------------------------------------------------------------------------------------

export type StoreUploadInput = {
  body: ReadableStream<Uint8Array> | Blob;
  /** The Content-Type the client sent for this part. Checked against the bytes, never trusted. */
  declaredMime: string;
  /** The client's file name: sanitised and returned as metadata only. */
  originalName: string;
};

export type StoreUploadOptions = {
  mediaDir: string;
  maxBytes: number;
  /** Name generator (tests). Must return [A-Za-z0-9_-]{1,64}. Defaults to 32 random hex characters. */
  randomId?: () => string;
};

export type StoredUpload = {
  /** Relative to mediaDir: `<random>.<ext>`. This is what goes into contribution_attachments.stored_path. */
  storedPath: string;
  /** The DETECTED type. */
  mime: string;
  bytes: number;
  kind: MediaKind;
  /** Sanitised; goes into contribution_attachments.original_name. */
  originalName: string;
};

const NAME_ATTEMPTS = 5;

const defaultRandomId = (): string => randomBytes(16).toString("hex");

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    offset += bytesWritten;
  }
}

const concat = (parts: Uint8Array[], length: number): Uint8Array => {
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/**
 * Streams the upload into `mediaDir/<random>.<ext>`. Rejects with UploadTooLargeError (413) as soon as
 * the running total passes maxBytes, or UnsupportedMediaTypeError (415) when the magic bytes are not an
 * allowed type or disagree with the declared type; in every failure the partial file is deleted.
 */
export async function storeUpload(input: StoreUploadInput, opts: StoreUploadOptions): Promise<StoredUpload> {
  const { mediaDir, maxBytes } = opts;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive integer");
  }
  const declared = normaliseMime(input.declaredMime);
  if (!isAllowedMime(declared)) throw new UnsupportedMediaTypeError("declared-not-allowed");
  const originalName = sanitizeOriginalName(input.originalName);

  mkdirSync(mediaDir, { recursive: true });
  const root = realpathSync(mediaDir); // stored files are addressed through the real directory

  const reader = (input.body instanceof Blob ? input.body.stream() : input.body).getReader();
  const held: Uint8Array[] = [];
  let heldLength = 0;
  let total = 0;
  let handle: FileHandle | undefined;
  let path: string | undefined;
  let detected: AllowedMime | undefined;
  let storedPath: string | undefined;

  /** The type is decided from the held header window; only then is the file created. */
  const begin = async (): Promise<void> => {
    const head = concat(held, heldLength);
    if (head.byteLength === 0) throw new UnsupportedMediaTypeError("empty");
    detected = detectMime(head);
    if (detected === undefined) throw new UnsupportedMediaTypeError("unrecognised");
    if (TYPES[detected].kind !== TYPES[declared].kind) throw new UnsupportedMediaTypeError("mismatch");

    for (let attempt = 0; attempt < NAME_ATTEMPTS && handle === undefined; attempt += 1) {
      const id = (opts.randomId ?? defaultRandomId)();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("randomId returned an unusable name");
      const name = `${id}.${TYPES[detected].ext}`;
      try {
        handle = await open(join(root, name), "wx", 0o600); // exclusive: never overwrite, never follow a link
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      storedPath = name;
      path = join(root, name);
    }
    if (handle === undefined) throw new Error("could not create a unique file name");
    await writeAll(handle, head);
    held.length = 0;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new UploadTooLargeError(maxBytes); // before this chunk is kept or written
      if (handle !== undefined) {
        await writeAll(handle, value);
        continue;
      }
      held.push(value);
      heldLength += value.byteLength;
      if (heldLength >= HEADER_BYTES) await begin();
    }
    if (handle === undefined) await begin(); // shorter than the header window (or empty)
    await handle!.close();
    handle = undefined;
  } catch (error) {
    await reader.cancel().catch(() => {}); // stop the source; do not read on
    await handle?.close().catch(() => {});
    if (path !== undefined) rmSync(path, { force: true });
    throw error;
  }

  const type = TYPES[detected!];
  return { storedPath: storedPath!, mime: detected!, bytes: total, kind: type.kind, originalName };
}

// --- paths inside mediaDir ------------------------------------------------------------------------------------------------

/**
 * Where `storedPath` is, guaranteed to be inside mediaDir: relative, no `..`, no backslash, no NUL,
 * and its directory (symlinks resolved) still inside the real mediaDir. Undefined when mediaDir does
 * not exist. The last component itself is NOT resolved, so a symlink there stays a symlink.
 */
function locate(mediaDir: string, storedPath: string): string | undefined {
  if (
    typeof storedPath !== "string" ||
    storedPath === "" ||
    storedPath.includes("\0") ||
    storedPath.includes("\\") ||
    isAbsolute(storedPath) ||
    storedPath.split("/").includes("..")
  ) {
    throw new UnsafePathError();
  }
  let root: string;
  try {
    root = realpathSync(mediaDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const target = resolve(root, storedPath);
  if (!target.startsWith(root + sep)) throw new UnsafePathError();
  let parent: string;
  try {
    parent = realpathSync(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target; // nothing there to reach through
    throw error;
  }
  if (parent !== root && !parent.startsWith(root + sep)) throw new UnsafePathError();
  return join(parent, basename(target));
}

/**
 * Removes a stored file. Idempotent (already gone is fine). Throws UnsafePathError for a path outside
 * mediaDir (`..`, absolute, through a symlinked directory) and for a directory. A symlink entry is
 * removed itself; its target is never touched.
 */
export function deleteUpload(mediaDir: string, storedPath: string): void {
  const target = locate(mediaDir, storedPath);
  if (target === undefined) return;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory()) throw new UnsafePathError("stored path is a directory");
  try {
    unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// --- the orphan sweep -----------------------------------------------------------------------------------------------------------

/** A stray file younger than this is left alone: its upload may still be waiting to insert its row. */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

export type SweepOptions = {
  /** Clock in epoch milliseconds (tests). Defaults to Date.now. */
  now?: () => number;
  /** Overrides ORPHAN_GRACE_MS. */
  graceMs?: number;
};

export type SweepResult = { removedFiles: number; removedRows: number };

/** Is `storedPath` a regular file inside mediaDir? A symlink, a directory, a missing or unsafe path is not. */
function isStoredFile(mediaDir: string, storedPath: string): boolean {
  try {
    const target = locate(mediaDir, storedPath);
    return target !== undefined && lstatSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Reconciles mediaDir with contribution_attachments: deletes the regular files directly in mediaDir
 * that no row references (unless younger than the grace period), and deletes the rows whose file is
 * missing. Throws when mediaDir does not exist or is not a directory BEFORE touching any row, so a
 * missing volume can never wipe the table. Never deletes mediaDir, never follows a symlink.
 */
export function sweepOrphans(db: Database, mediaDir: string, opts: SweepOptions = {}): SweepResult {
  const root = realpathSync(mediaDir);
  if (!statSync(root).isDirectory()) throw new Error("media directory is not a directory");
  const nowMs = (opts.now ?? Date.now)();
  const graceMs = opts.graceMs ?? ORPHAN_GRACE_MS;

  const rows = db.query("SELECT id, stored_path FROM contribution_attachments").all() as { id: string; stored_path: string }[];
  const referenced = new Set(rows.map((row) => row.stored_path));

  let removedFiles = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || referenced.has(entry.name)) continue; // symlinks and directories are not files here
    const path = join(root, entry.name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || nowMs - stat.mtimeMs < graceMs) continue;
      unlinkSync(path);
      removedFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const missing = rows.filter((row) => !isStoredFile(root, row.stored_path));
  const remove = db.prepare("DELETE FROM contribution_attachments WHERE id = ?");
  db.transaction(() => {
    for (const row of missing) remove.run(row.id);
  })();

  return { removedFiles, removedRows: missing.length };
}
