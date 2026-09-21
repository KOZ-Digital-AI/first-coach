import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStoredFile, storeUpload } from "./uploads";

// resolveStoredFile(mediaDir, storedPath): the path of a stored upload, for the media route to read.
// It returns the absolute path of a REGULAR file that sits directly in the real mediaDir and whose
// name has the stored-name shape `<[A-Za-z0-9_-]{1,64}>.<ext of an allowed type>`; for anything else
// (missing, unsafe, wrong shape, symlink, directory, no media dir) it returns undefined and never a
// path outside mediaDir. Temp dirs only, removed in afterEach.

let root: string;
let mediaDir: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uploads-resolve-"));
  mediaDir = join(root, "media");
  outside = join(root, "outside");
  mkdirSync(mediaDir);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

async function stored(): Promise<string> {
  const { storedPath } = await storeUpload(
    { body: new Blob([PNG]), declaredMime: "image/png", originalName: "a.png" },
    { mediaDir, maxBytes: 1024 },
  );
  return storedPath;
}

describe("resolveStoredFile", () => {
  test("a stored upload resolves to its file inside the real media dir", async () => {
    const storedPath = await stored();
    const path = resolveStoredFile(mediaDir, storedPath);
    expect(path).toBe(join(realpathSync(mediaDir), storedPath));
    expect(new Uint8Array(readFileSync(path!))).toEqual(PNG);
  });

  test("every allowed extension is a valid stored name", () => {
    for (const ext of ["mp4", "webm", "mov", "jpg", "png", "pdf"]) {
      writeFileSync(join(mediaDir, `abc123_-XYZ.${ext}`), "x");
      expect(resolveStoredFile(mediaDir, `abc123_-XYZ.${ext}`)).toBe(join(realpathSync(mediaDir), `abc123_-XYZ.${ext}`));
    }
  });

  test("a name with no file is undefined", () => {
    expect(resolveStoredFile(mediaDir, "0123456789abcdef.png")).toBeUndefined();
  });

  test("a media dir that does not exist is undefined, not an error", () => {
    expect(resolveStoredFile(join(root, "missing"), "0123456789abcdef.png")).toBeUndefined();
  });

  test("traversal, absolute, nested, backslash and NUL names are refused even when the target exists", () => {
    writeFileSync(join(outside, "secret.png"), "secret");
    writeFileSync(join(mediaDir, "ok.png"), "x");
    mkdirSync(join(mediaDir, "sub"));
    writeFileSync(join(mediaDir, "sub", "deep.png"), "x");
    const bad = [
      "../outside/secret.png",
      "..%2Foutside%2Fsecret.png",
      join(outside, "secret.png"),
      "/etc/passwd",
      "sub/deep.png",
      "./ok.png",
      "ok.png/",
      "..\\outside\\secret.png",
      "ok.png\0.txt",
      "ok\0.png",
      "..",
      ".",
      "",
      " ok.png",
      "ok.png ",
      "ok.png\n",
    ];
    for (const name of bad) expect(resolveStoredFile(mediaDir, name)).toBeUndefined();
  });

  test("a name that is not the stored-name shape is refused even when the file exists", () => {
    for (const name of ["plain", "notes.txt", "page.html", "x.svg", "UPPER.PNG", "x.Mp4", ".png", "a b.png", "a.b.png", "name..png", `${"a".repeat(65)}.png`]) {
      writeFileSync(join(mediaDir, name), "x");
      expect(resolveStoredFile(mediaDir, name)).toBeUndefined();
    }
    writeFileSync(join(mediaDir, `${"a".repeat(64)}.png`), "x");
    expect(resolveStoredFile(mediaDir, `${"a".repeat(64)}.png`)).toBeDefined();
  });

  test("a non-string is refused", () => {
    expect(resolveStoredFile(mediaDir, undefined as unknown as string)).toBeUndefined();
    expect(resolveStoredFile(mediaDir, 5 as unknown as string)).toBeUndefined();
    expect(resolveStoredFile(mediaDir, null as unknown as string)).toBeUndefined();
  });

  test("a symlink is refused, whether it points outside or inside the media dir", () => {
    writeFileSync(join(outside, "secret.png"), "secret");
    writeFileSync(join(mediaDir, "real.png"), "x");
    symlinkSync(join(outside, "secret.png"), join(mediaDir, "out.png"));
    symlinkSync(join(mediaDir, "real.png"), join(mediaDir, "in.png"));
    expect(resolveStoredFile(mediaDir, "out.png")).toBeUndefined();
    expect(resolveStoredFile(mediaDir, "in.png")).toBeUndefined();
    expect(resolveStoredFile(mediaDir, "real.png")).toBeDefined();
  });

  test("a dangling symlink and a directory are refused", () => {
    symlinkSync(join(outside, "nothing.png"), join(mediaDir, "dangling.png"));
    mkdirSync(join(mediaDir, "folder.png"));
    expect(resolveStoredFile(mediaDir, "dangling.png")).toBeUndefined();
    expect(resolveStoredFile(mediaDir, "folder.png")).toBeUndefined();
  });

  test("a media dir that is itself a symlink to the volume still works", async () => {
    const storedPath = await stored();
    const link = join(root, "media-link");
    symlinkSync(mediaDir, link);
    expect(resolveStoredFile(link, storedPath)).toBe(join(realpathSync(mediaDir), storedPath));
  });
});
