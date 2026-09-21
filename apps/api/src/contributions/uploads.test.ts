import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AppDeps } from "../app";
import { DEFAULT_BOOT_DIR, runBootHooks } from "../boot";
import { onBoot } from "../boot/30-uploads.boot";
import { openDatabase } from "../db/database";
import { migrate } from "../db/migrate";
import { UPLOAD_MIME_TYPES } from "../shared/contributions";
import {
  DEFAULT_MEDIA_DIR,
  ORPHAN_GRACE_MS,
  UnsafePathError,
  UnsupportedMediaTypeError,
  UploadTooLargeError,
  deleteUpload,
  resolveMediaDir,
  sanitizeOriginalName,
  storeUpload,
  sweepOrphans,
  uploadLimitBytes,
} from "./uploads";

// Readings the tests pin (each is also stated in uploads.ts):
//  * size cap: `maxBytes` is inclusive (a file of exactly maxBytes is stored, maxBytes + 1 is not);
//    the settings cap uploadMaxMb is megabytes = MiB (1024 * 1024 bytes).
//  * "declared type must agree with the detected type family": the declared type must be one of the
//    allow-listed types AND belong to the same family (video / image / document) as the detected
//    type. A sibling in the same family (declared video/mp4, bytes say video/quicktime) is accepted and
//    the DETECTED type is what is stored. Anything else (octet-stream, another family) is rejected.
//  * the sweep leaves a file younger than ORPHAN_GRACE_MS (10 minutes) alone.

// --- fixtures -------------------------------------------------------------------------------

const KIB = 1024;

/** `head` then zero padding up to `size` bytes. */
function fileBytes(head: ArrayLike<number>, size = 64): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head, 0);
  return out;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const ftyp = (brand: string): number[] => [0, 0, 0, 0x18, ...ascii("ftyp"), ...ascii(brand)];

const MP4 = fileBytes(ftyp("isom"));
const MOV = fileBytes(ftyp("qt  "));
const WEBM = fileBytes([0x1a, 0x45, 0xdf, 0xa3]);
const JPEG = fileBytes([0xff, 0xd8, 0xff, 0xe0]);
const PNG = fileBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = fileBytes(ascii("%PDF-1.7\n"));

const ALLOWED = [
  { mime: "video/mp4", bytes: MP4, ext: "mp4", kind: "video" },
  { mime: "video/quicktime", bytes: MOV, ext: "mov", kind: "video" },
  { mime: "video/webm", bytes: WEBM, ext: "webm", kind: "video" },
  { mime: "image/jpeg", bytes: JPEG, ext: "jpg", kind: "image" },
  { mime: "image/png", bytes: PNG, ext: "png", kind: "image" },
  { mime: "application/pdf", bytes: PDF, ext: "pdf", kind: "document" },
] as const;

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

type Counting = { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean };

/**
 * A pull-driven source of `total` bytes in `chunk`-sized pieces that starts with `head`. It only
 * produces a chunk when the consumer asks, so `pulled()` is how much the consumer really took.
 */
function countingSource(head: Uint8Array, total: number, chunk = KIB): Counting {
  let sent = 0;
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= total) return controller.close();
        const size = Math.min(chunk, total - sent);
        const piece = new Uint8Array(size);
        if (sent === 0) piece.set(head.subarray(0, Math.min(head.length, size)), 0);
        sent += size;
        pulled += size;
        controller.enqueue(piece);
      },
      cancel() {
        cancelled = true;
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

let root: string;
let mediaDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uploads-"));
  mediaDir = join(root, "media");
  mkdirSync(mediaDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const store = (
  body: ReadableStream<Uint8Array> | Blob,
  declaredMime: string,
  originalName = "clip.bin",
  maxBytes = 10 * KIB * KIB,
  extra: { randomId?: () => string } = {},
) => storeUpload({ body, declaredMime, originalName }, { mediaDir, maxBytes, ...extra });

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
};

const listing = (dir = mediaDir): string[] => readdirSync(dir).sort();

// --- storeUpload: accepted types ----------------------------------------------------------------

describe("storeUpload accepts every allow-listed type with the right magic bytes", () => {
  test("the fixtures cover exactly the contract's allow-list", () => {
    expect([...ALLOWED.map((a) => a.mime)].sort()).toEqual([...UPLOAD_MIME_TYPES].sort());
  });

  for (const { mime, bytes, ext, kind } of ALLOWED) {
    test(`${mime}`, async () => {
      const stored = await store(streamOf(bytes), mime);

      expect(stored.mime).toBe(mime);
      expect(stored.kind).toBe(kind);
      expect(stored.bytes).toBe(bytes.length);
      expect(stored.storedPath).toMatch(new RegExp(`^[0-9a-f]{32}\\.${ext}$`));
      expect(new Uint8Array(readFileSync(join(mediaDir, stored.storedPath)))).toEqual(bytes);
      expect(listing()).toEqual([stored.storedPath]);
    });
  }

  test("a Blob and a File are accepted as well as a stream", async () => {
    const fromBlob = await store(new Blob([PNG]), "image/png");
    const fromFile = await store(new File([PDF], "plan.pdf", { type: "application/pdf" }), "application/pdf");
    expect(fromBlob.mime).toBe("image/png");
    expect(fromFile.mime).toBe("application/pdf");
    expect(listing()).toHaveLength(2);
  });

  test("the declared type is read case-insensitively and without parameters", async () => {
    const stored = await store(streamOf(MP4), "Video/MP4; codecs=avc1.42E01E");
    expect(stored.mime).toBe("video/mp4");
  });

  test("a chunked stream is reassembled in order (magic bytes split across chunks)", async () => {
    const stored = await store(streamOf(PNG.subarray(0, 3), PNG.subarray(3, 5), PNG.subarray(5)), "image/png");
    expect(new Uint8Array(readFileSync(join(mediaDir, stored.storedPath)))).toEqual(PNG);
    expect(stored.bytes).toBe(PNG.length);
  });

  test("a sibling in the same family is accepted and the DETECTED type is stored", async () => {
    const stored = await store(streamOf(MOV), "video/mp4");
    expect(stored.mime).toBe("video/quicktime");
    expect(stored.storedPath.endsWith(".mov")).toBe(true);
  });

  test("ISO base media brands other than quicktime are mp4 (mp42, avc1)", async () => {
    for (const brand of ["mp42", "avc1"]) {
      const stored = await store(streamOf(fileBytes(ftyp(brand))), "video/mp4");
      expect(stored.mime).toBe("video/mp4");
    }
  });
});

// --- storeUpload: rejected types --------------------------------------------------------------------

describe("storeUpload rejects on the MAGIC BYTES, not the name or the header", () => {
  test("a text file sent as .mp4 / video/mp4 is an UnsupportedMediaTypeError and leaves nothing behind", async () => {
    const text = new TextEncoder().encode("this is definitely not a video, just some plain text\n");
    const error = await rejection(store(streamOf(text), "video/mp4", "holiday.mp4"));
    expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
    expect(listing()).toEqual([]);
  });

  test("an empty upload is refused", async () => {
    const error = await rejection(store(streamOf(), "video/mp4"));
    expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
    expect(listing()).toEqual([]);
  });

  test("an ftyp box with a brand that is not mp4 or quicktime (heic) is refused", async () => {
    const error = await rejection(store(streamOf(fileBytes(ftyp("heic"))), "video/mp4"));
    expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test("real bytes of a type that is not on the allow-list are refused even under an allowed header (gif as image/png)", async () => {
    const gif = fileBytes(ascii("GIF89a"));
    const error = await rejection(store(streamOf(gif), "image/png"));
    expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test("header and detected type disagree: rejected, in every direction that crosses a family", async () => {
    const cases: [Uint8Array, string][] = [
      [MP4, "image/png"],
      [PNG, "video/mp4"],
      [JPEG, "application/pdf"],
      [PDF, "image/jpeg"],
      [WEBM, "image/png"],
    ];
    for (const [bytes, declared] of cases) {
      const error = await rejection(store(streamOf(bytes), declared));
      expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
    }
    expect(listing()).toEqual([]);
  });

  test("a declared type that is not allow-listed is refused even when the bytes are valid", async () => {
    for (const declared of ["application/octet-stream", "text/plain", "", "video/x-msvideo"]) {
      const error = await rejection(store(streamOf(MP4), declared));
      expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
    }
    expect(listing()).toEqual([]);
  });
});

// --- storeUpload: the size cap while streaming ------------------------------------------------------

describe("storeUpload enforces the size cap WHILE streaming", () => {
  test("an oversize stream is aborted shortly after the cap: not buffered, partial file removed", async () => {
    const cap = 10 * KIB;
    const source = countingSource(MP4, 10 * KIB * KIB, KIB); // 10 MiB offered against a 10 KiB cap

    const error = await rejection(store(source.stream, "video/mp4", "big.mp4", cap));

    expect(error).toBeInstanceOf(UploadTooLargeError);
    expect((error as UploadTooLargeError).maxBytes).toBe(cap);
    expect(listing()).toEqual([]);
    // The consumer stopped pulling right after the cap (a couple of chunks of read-ahead at most).
    expect(source.pulled()).toBeGreaterThan(cap);
    expect(source.pulled()).toBeLessThanOrEqual(cap + 4 * KIB);
    expect(source.cancelled()).toBe(true);
  });

  test("the limit is inclusive: maxBytes is stored, maxBytes + 1 is not", async () => {
    const cap = 4 * KIB;
    const exact = await store(countingSource(PNG, cap).stream, "image/png", "a.png", cap);
    expect(exact.bytes).toBe(cap);

    const error = await rejection(store(countingSource(PNG, cap + 1).stream, "image/png", "b.png", cap));
    expect(error).toBeInstanceOf(UploadTooLargeError);
    expect(listing()).toEqual([exact.storedPath]);
  });

  test("a cap smaller than the very first chunk is still a size error and writes nothing", async () => {
    const error = await rejection(store(streamOf(PNG), "image/png", "a.png", 8));
    expect(error).toBeInstanceOf(UploadTooLargeError);
    expect(listing()).toEqual([]);
  });

  test("an oversize Blob is refused as well", async () => {
    const error = await rejection(store(new Blob([fileBytes(PNG, 3 * KIB)]), "image/png", "a.png", 2 * KIB));
    expect(error).toBeInstanceOf(UploadTooLargeError);
    expect(listing()).toEqual([]);
  });

  test("an unreadable cap is refused instead of meaning 'unlimited'", async () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(store(streamOf(PNG), "image/png", "a.png", cap)).rejects.toThrow();
    }
    expect(listing()).toEqual([]);
  });

  test("a stream that fails half way leaves no partial file and surfaces the failure", async () => {
    let step = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(fileBytes(PNG, KIB));
        else if (step === 2) controller.enqueue(new Uint8Array(KIB));
        else controller.error(new Error("connection reset"));
      },
    });

    await expect(store(broken, "image/png")).rejects.toThrow("connection reset");
    expect(listing()).toEqual([]);
  });
});

// --- storeUpload: names, paths, collisions ---------------------------------------------------------------------------

describe("storeUpload never lets the client's name near the path", () => {
  const HOSTILE = [
    "../../etc/passwd",
    "a/b",
    "..\\x",
    "..\\..\\windows\\system32\\config",
    "/etc/passwd",
    "C:\\Users\\x\\a.mp4",
    "evil\0.mp4",
    "..",
    ".",
    "",
    "   ",
    `${"x".repeat(5000)}.mp4`,
    "видео-тест 🎾.mp4",
    "line\nbreak\r.mp4",
  ];

  for (const name of HOSTILE) {
    test(`name ${JSON.stringify(name.length > 30 ? `${name.slice(0, 30)}...(${name.length})` : name)}`, async () => {
      const stored = await store(streamOf(PNG), "image/png", name);

      // The stored path is a random flat name inside mediaDir; nothing else was created anywhere.
      expect(stored.storedPath).toMatch(/^[0-9a-f]{32}\.png$/);
      expect(resolve(mediaDir, stored.storedPath).startsWith(mediaDir + sep)).toBe(true);
      expect(listing()).toEqual([stored.storedPath]);
      expect(listing(root)).toEqual(["media"]);

      // The name survives only as sanitised metadata.
      expect(stored.originalName).not.toMatch(/[\\/\0\n\r]/);
      expect(stored.originalName.trim()).not.toBe("");
      expect(stored.originalName).not.toBe("..");
      expect([...stored.originalName].length).toBeLessThanOrEqual(200);
    });
  }

  test("sanitizeOriginalName keeps the basename only", () => {
    expect(sanitizeOriginalName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOriginalName("a/b")).toBe("b");
    expect(sanitizeOriginalName("..\\x")).toBe("x");
    expect(sanitizeOriginalName("C:\\Users\\x\\clip.mp4")).toBe("clip.mp4");
    expect(sanitizeOriginalName("a\0b.mp4")).toBe("ab.mp4");
    expect(sanitizeOriginalName("tab\there\u0085.mp4")).toBe("tabhere.mp4");
    expect(sanitizeOriginalName("видео-тест 🎾.mp4")).toBe("видео-тест 🎾.mp4");
    expect(sanitizeOriginalName("  drill 1.mp4  ")).toBe("drill 1.mp4");
  });

  test("sanitizeOriginalName never returns something blank, dotty or huge", () => {
    for (const name of ["", "   ", ".", "..", "/", "a/", "\0\0", "\u202e"]) {
      const clean = sanitizeOriginalName(name);
      expect(clean.trim()).not.toBe("");
      expect(clean).not.toMatch(/^\.+$/);
    }
    expect([...sanitizeOriginalName("y".repeat(10_000))].length).toBeLessThanOrEqual(200);
    // Cut on characters, not in the middle of a surrogate pair.
    const cut = sanitizeOriginalName("🎾".repeat(500));
    expect(cut).toBe("🎾".repeat(200));
  });

  test("two uploads of the same file and name never collide", async () => {
    const stored = await Promise.all(Array.from({ length: 40 }, () => store(streamOf(PNG), "image/png", "same.png")));
    expect(new Set(stored.map((s) => s.storedPath)).size).toBe(40);
    expect(listing()).toHaveLength(40);
  });

  test("a missing mediaDir is created; a path that is a plain file is refused", async () => {
    const nested = join(root, "a", "b", "media");
    const stored = await storeUpload(
      { body: streamOf(PNG), declaredMime: "image/png", originalName: "a.png" },
      { mediaDir: nested, maxBytes: KIB * KIB },
    );
    expect(listing(nested)).toEqual([stored.storedPath]);

    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    await expect(
      storeUpload({ body: streamOf(PNG), declaredMime: "image/png", originalName: "a.png" }, { mediaDir: file, maxBytes: KIB }),
    ).rejects.toThrow();
  });
});

describe("storeUpload creates the file exclusively (never overwrites, never writes through a link)", () => {
  const sequence = (...ids: string[]) => {
    let i = 0;
    return () => ids[Math.min(i++, ids.length - 1)] as string;
  };

  test("an existing file with the drawn name is left untouched and another name is drawn", async () => {
    writeFileSync(join(mediaDir, "aaaa.png"), "precious");

    const stored = await store(streamOf(PNG), "image/png", "a.png", KIB * KIB, { randomId: sequence("aaaa", "bbbb") });

    expect(stored.storedPath).toBe("bbbb.png");
    expect(readFileSync(join(mediaDir, "aaaa.png"), "utf8")).toBe("precious");
  });

  test("a planted symlink at the drawn name is not written through", async () => {
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(mediaDir, "aaaa.png"));
    symlinkSync(join(root, "dangling-target"), join(mediaDir, "cccc.png"));

    const stored = await store(streamOf(PNG), "image/png", "a.png", KIB * KIB, {
      randomId: sequence("aaaa", "cccc", "bbbb"),
    });

    expect(stored.storedPath).toBe("bbbb.png");
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(existsSync(join(root, "dangling-target"))).toBe(false);
  });

  test("when every draw collides the upload fails and the existing file survives", async () => {
    writeFileSync(join(mediaDir, "aaaa.png"), "precious");
    await expect(store(streamOf(PNG), "image/png", "a.png", KIB * KIB, { randomId: () => "aaaa" })).rejects.toThrow();
    expect(readFileSync(join(mediaDir, "aaaa.png"), "utf8")).toBe("precious");
    expect(listing()).toEqual(["aaaa.png"]);
  });
});

// --- deleteUpload ---------------------------------------------------------------------------------------------------------

describe("deleteUpload", () => {
  test("removes the file, and is idempotent", async () => {
    const stored = await store(streamOf(PNG), "image/png");
    deleteUpload(mediaDir, stored.storedPath);
    expect(listing()).toEqual([]);
    expect(() => deleteUpload(mediaDir, stored.storedPath)).not.toThrow();
    expect(() => deleteUpload(mediaDir, "never-existed.png")).not.toThrow();
  });

  test("refuses a path that leaves mediaDir: '..', absolute, NUL, empty", () => {
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "keep");
    for (const bad of ["../victim.txt", "a/../../victim.txt", "..", victim, "/etc/passwd", "x\0y.png", "", "..\\victim.txt"]) {
      expect(() => deleteUpload(mediaDir, bad)).toThrow(UnsafePathError);
    }
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  test("refuses to go through a symlinked directory that points outside mediaDir", () => {
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "victim.txt"), "keep");
    symlinkSync(outsideDir, join(mediaDir, "link"));

    expect(() => deleteUpload(mediaDir, "link/victim.txt")).toThrow(UnsafePathError);
    expect(readFileSync(join(outsideDir, "victim.txt"), "utf8")).toBe("keep");
  });

  test("a symlink entry inside mediaDir is removed itself, its target is not touched", () => {
    const victim = join(root, "victim.txt");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(mediaDir, "link.png"));

    deleteUpload(mediaDir, "link.png");

    expect(listing()).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe("keep");
  });

  test("does not delete a directory", () => {
    mkdirSync(join(mediaDir, "sub"));
    expect(() => deleteUpload(mediaDir, "sub")).toThrow();
    expect(existsSync(join(mediaDir, "sub"))).toBe(true);
  });
});

// --- sweepOrphans ---------------------------------------------------------------------------------------------------------

describe("sweepOrphans", () => {
  const NOW = Date.parse("2026-03-01T12:00:00.000Z");
  const now = () => NOW;
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    db.run(
      `INSERT INTO contributions (id, kind, payload, submitter_user_id, content_hash)
       VALUES ('c1', 'new', '{}', 'user-1', '${"a".repeat(64)}')`,
    );
  });

  afterEach(() => {
    db.close();
  });

  const attach = (id: string, storedPath: string): void => {
    db.run(
      `INSERT INTO contribution_attachments (id, contribution_id, kind, stored_path, mime, bytes, original_name)
       VALUES (?, 'c1', 'image', ?, 'image/png', 8, 'a.png')`,
      [id, storedPath],
    );
  };
  const rowPaths = (): string[] =>
    (db.query("SELECT stored_path FROM contribution_attachments ORDER BY stored_path").all() as { stored_path: string }[]).map(
      (r) => r.stored_path,
    );

  /** A file whose mtime is `ageMs` before NOW. */
  const put = (dir: string, name: string, ageMs: number, content = "data"): string => {
    const path = join(dir, name);
    writeFileSync(path, content);
    const when = new Date(NOW - ageMs);
    utimesSync(path, when, when);
    return path;
  };
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  test("removes a stray file that no row references, and returns the counts", () => {
    put(mediaDir, "stray.png", HOUR);

    const result = sweepOrphans(db, mediaDir, { now });

    expect(result).toEqual({ removedFiles: 1, removedRows: 0 });
    expect(listing()).toEqual([]);
  });

  test("removes a row whose file is missing and keeps a row whose file exists (and that file)", () => {
    put(mediaDir, "kept.png", HOUR);
    attach("a-kept", "kept.png");
    attach("a-lost", "lost.png");

    const result = sweepOrphans(db, mediaDir, { now });

    expect(result).toEqual({ removedFiles: 0, removedRows: 1 });
    expect(rowPaths()).toEqual(["kept.png"]);
    expect(listing()).toEqual(["kept.png"]);
  });

  test("does both in one run", () => {
    put(mediaDir, "kept.png", HOUR);
    put(mediaDir, "stray-1.mp4", HOUR);
    put(mediaDir, "stray-2.pdf", 2 * HOUR);
    attach("a-kept", "kept.png");
    attach("a-lost", "lost.png");

    expect(sweepOrphans(db, mediaDir, { now })).toEqual({ removedFiles: 2, removedRows: 1 });
    expect(listing()).toEqual(["kept.png"]);
    expect(rowPaths()).toEqual(["kept.png"]);
  });

  test("a stray file younger than the grace period is kept (an upload may be in flight), older is removed", () => {
    expect(ORPHAN_GRACE_MS).toBe(10 * MINUTE);
    put(mediaDir, "young.png", 9 * MINUTE);
    put(mediaDir, "old.png", 11 * MINUTE);

    expect(sweepOrphans(db, mediaDir, { now })).toEqual({ removedFiles: 1, removedRows: 0 });
    expect(listing()).toEqual(["young.png"]);

    // Later, once the grace period has passed, the same file is swept.
    expect(sweepOrphans(db, mediaDir, { now: () => NOW + 2 * MINUTE })).toEqual({ removedFiles: 1, removedRows: 0 });
    expect(listing()).toEqual([]);
  });

  test("the grace period is injectable", () => {
    put(mediaDir, "a.png", 5 * MINUTE);
    expect(sweepOrphans(db, mediaDir, { now, graceMs: 10 * MINUTE }).removedFiles).toBe(0);
    expect(sweepOrphans(db, mediaDir, { now, graceMs: 2 * MINUTE }).removedFiles).toBe(1);
  });

  test("a file stored by storeUpload is swept only after its row is gone (cascade from the contribution)", async () => {
    const stored = await store(streamOf(PNG), "image/png");
    attach("a1", stored.storedPath);
    const path = join(mediaDir, stored.storedPath);
    utimesSync(path, new Date(NOW - HOUR), new Date(NOW - HOUR));

    expect(sweepOrphans(db, mediaDir, { now })).toEqual({ removedFiles: 0, removedRows: 0 });
    expect(existsSync(path)).toBe(true);

    db.run("DELETE FROM contributions WHERE id = 'c1'"); // the rows go by cascade, the file does not
    expect(rowPaths()).toEqual([]);
    expect(existsSync(path)).toBe(true);

    expect(sweepOrphans(db, mediaDir, { now })).toEqual({ removedFiles: 1, removedRows: 0 });
    expect(existsSync(path)).toBe(false);
  });

  test("never follows a symlink: a link to an outside file or directory is left alone and its target survives", () => {
    const outsideFile = put(root, "outside.txt", HOUR);
    const outsideDir = join(root, "outside-dir");
    mkdirSync(outsideDir);
    const inner = put(outsideDir, "inner.txt", HOUR);
    symlinkSync(outsideFile, join(mediaDir, "file-link.png"));
    symlinkSync(outsideDir, join(mediaDir, "dir-link"));

    expect(sweepOrphans(db, mediaDir, { now })).toEqual({ removedFiles: 0, removedRows: 0 });

    expect(existsSync(outsideFile)).toBe(true);
    expect(existsSync(inner)).toBe(true);
    expect(listing()).toEqual(["dir-link", "file-link.png"]);
  });

  test("a row that points at a symlink or outside mediaDir counts as having no file; nothing outside is touched", () => {
    const outsideFile = put(root, "outside.txt", HOUR);
    symlinkSync(outsideFile, join(mediaDir, "file-link.png"));
    attach("a-link", "file-link.png");
    attach("a-escape", "../outside.txt");

    expect(sweepOrphans(db, mediaDir, { now })).toEqual({ removedFiles: 0, removedRows: 2 });
    expect(existsSync(outsideFile)).toBe(true);
    expect(existsSync(join(mediaDir, "file-link.png"))).toBe(true);
  });

  test("only touches regular files directly in mediaDir: a subdirectory and what is in it stay", () => {
    mkdirSync(join(mediaDir, "sub"));
    const nested = put(join(mediaDir, "sub"), "old.png", HOUR);
    put(mediaDir, "stray.png", HOUR);

    expect(sweepOrphans(db, mediaDir, { now }).removedFiles).toBe(1);

    expect(existsSync(nested)).toBe(true);
    expect(listing()).toEqual(["sub"]);
  });

  test("never deletes mediaDir itself, empty or not", () => {
    sweepOrphans(db, mediaDir, { now });
    put(mediaDir, "stray.png", HOUR);
    sweepOrphans(db, mediaDir, { now });
    expect(existsSync(mediaDir)).toBe(true);
    expect(listing()).toEqual([]);
  });

  test("a mediaDir that does not exist is an error, and no row is removed (a missing volume must not wipe the table)", () => {
    attach("a1", "kept.png");
    expect(() => sweepOrphans(db, join(root, "no-such-dir"), { now })).toThrow();
    expect(rowPaths()).toEqual(["kept.png"]);
  });

  test("uses the real clock when none is injected", () => {
    const path = join(mediaDir, "fresh.png");
    writeFileSync(path, "x"); // mtime is now: inside the grace period
    expect(sweepOrphans(db, mediaDir).removedFiles).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});

// --- limits and environment ---------------------------------------------------------------------------------------

describe("upload limits and MEDIA_DIR", () => {
  test("uploadLimitBytes is settings.uploadMaxMb in MiB (default 50, follows the stored setting)", () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      expect(uploadLimitBytes(db)).toBe(50 * 1024 * 1024);
      db.run(`INSERT INTO settings (key, value) VALUES ('uploadMaxMb', '80')`);
      expect(uploadLimitBytes(db)).toBe(80 * 1024 * 1024);
    } finally {
      db.close();
    }
  });

  test("MEDIA_DIR defaults to ./data/media relative to the working directory; blank counts as unset", () => {
    expect(DEFAULT_MEDIA_DIR).toBe("./data/media");
    expect(resolveMediaDir({})).toBe(resolve("./data/media"));
    expect(resolveMediaDir({ MEDIA_DIR: "  " })).toBe(resolve("./data/media"));
    expect(resolveMediaDir({ MEDIA_DIR: "/data/media" })).toBe("/data/media");
    expect(resolveMediaDir({ MEDIA_DIR: "rel/media" })).toBe(resolve("rel/media"));
  });
});

// --- the boot hook ---------------------------------------------------------------------------------------------

describe("30-uploads boot hook", () => {
  const HOOK_FILE = "30-uploads.boot.ts";
  const HOOK_PATH = resolve(DEFAULT_BOOT_DIR, HOOK_FILE);
  let db: Database;
  let deps: AppDeps;
  let lines: { level: string; msg: string; fields: Record<string, unknown> }[];
  const log = {
    debug: () => {},
    info: (msg: string, fields: Record<string, unknown> = {}) => lines.push({ level: "info", msg, fields }),
    warn: (msg: string, fields: Record<string, unknown> = {}) => lines.push({ level: "warn", msg, fields }),
    error: (msg: string, fields: Record<string, unknown> = {}) => lines.push({ level: "error", msg, fields }),
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    deps = { db, version: "test" };
    lines = [];
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // some cases close it themselves
    }
  });

  const stray = (name = "stray.png", ageMs = 60 * 60 * 1000): string => {
    const path = join(mediaDir, name);
    writeFileSync(path, "x");
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  };

  test("lives in the boot directory and runs after 20-seed and before 40-backup", () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
    const hooks = readdirSync(DEFAULT_BOOT_DIR)
      .filter((f) => f.endsWith(".boot.ts"))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const at = hooks.indexOf(HOOK_FILE);
    expect(hooks[at - 1]).toBe("20-seed.boot.ts");
    expect(hooks[at + 1]).toBe("40-backup.boot.ts");
  });

  test("runs the sweep at boot: removes a stray file, drops a row without a file, logs the counts", () => {
    const path = stray();
    db.run(
      `INSERT INTO contributions (id, kind, payload, submitter_user_id, content_hash)
       VALUES ('c1', 'new', '{}', 'user-1', '${"a".repeat(64)}')`,
    );
    db.run(
      `INSERT INTO contribution_attachments (id, contribution_id, kind, stored_path, mime, bytes, original_name)
       VALUES ('a1', 'c1', 'image', 'gone.png', 'image/png', 1, 'a.png')`,
    );

    onBoot(deps, { MEDIA_DIR: mediaDir }, { log });

    expect(existsSync(path)).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM contribution_attachments").get()).toEqual({ n: 0 });
    const done = lines.find((l) => l.level === "info" && l.fields.removedFiles !== undefined);
    expect(done?.fields).toMatchObject({ removedFiles: 1, removedRows: 1 });
  });

  test("through the real boot runner: discovered as a hook and the sweep runs on a migrated DB", async () => {
    const path = stray();
    const bootDir = join(root, "boot");
    mkdirSync(bootDir);
    // A temp hook cannot resolve relative imports: it re-exports the real hook by absolute path.
    writeFileSync(join(bootDir, HOOK_FILE), `export { onBoot } from ${JSON.stringify(HOOK_PATH)};\n`);
    const saved = process.env.MEDIA_DIR;
    process.env.MEDIA_DIR = mediaDir;
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runBootHooks(deps, bootDir)).toEqual([HOOK_FILE]);
      const printed = spy.mock.calls.map((c) => String(c[0]));
      expect(printed.some((l) => l.includes('"removedFiles":1'))).toBe(true);
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.MEDIA_DIR;
      else process.env.MEDIA_DIR = saved;
    }
    expect(existsSync(path)).toBe(false);
  });

  test("a MEDIA_DIR that does not exist yet is created and nothing is swept (rows survive)", () => {
    const fresh = join(root, "fresh", "media");
    db.run(
      `INSERT INTO contributions (id, kind, payload, submitter_user_id, content_hash)
       VALUES ('c1', 'new', '{}', 'user-1', '${"a".repeat(64)}')`,
    );
    db.run(
      `INSERT INTO contribution_attachments (id, contribution_id, kind, stored_path, mime, bytes, original_name)
       VALUES ('a1', 'c1', 'image', 'kept.png', 'image/png', 1, 'a.png')`,
    );

    onBoot(deps, { MEDIA_DIR: fresh }, { log });

    expect(existsSync(fresh)).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM contribution_attachments").get()).toEqual({ n: 1 });
    expect(lines.some((l) => l.level === "error")).toBe(false);
  });

  test("a sweep failure is logged and never crashes boot (closed database)", () => {
    stray();
    db.close();

    expect(() => onBoot(deps, { MEDIA_DIR: mediaDir }, { log })).not.toThrow();

    const failure = lines.find((l) => l.level === "error");
    expect(failure?.msg).toBe("uploads sweep failed");
    expect(typeof failure?.fields.error).toBe("string");
  });

  test("a MEDIA_DIR that is a plain file is logged, not thrown", () => {
    const file = join(root, "plain-file");
    writeFileSync(file, "x");
    expect(() => onBoot(deps, { MEDIA_DIR: file }, { log })).not.toThrow();
    expect(lines.some((l) => l.level === "error")).toBe(true);
  });
});
