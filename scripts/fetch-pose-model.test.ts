// fc-mol-8nt.11: scripts/fetch-pose-model.ts downloads the MediaPipe pose_landmarker_lite .task model and the
// tasks-vision WASM files into apps/web/public/mediapipe so the app can self-host them (no third-party CDN at run time).
//
// Every test injects a STUBBED fetch: nothing here touches the network, and the real model is never downloaded.
// Temp directories are created per test and removed in afterEach.
//
// Assertions name what must hold (files written with the served bytes, a second run skips, a checksum mismatch or a failed
// download fails with a clear message and leaves no bad file behind, the web `prebuild` runs the script, the output dir is
// git-ignored, the build image carries the script). They never pin the exact list of WASM files or the exact wording.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OUT_DIR,
  POSE_MODEL_FILE,
  POSE_MODEL_SHA256,
  POSE_MODEL_URL,
  PoseModelFetchError,
  WASM_BASE_URL,
  WASM_FILES,
  fetchPoseModel,
  runCli,
} from "./fetch-pose-model";

const repoRoot = join(import.meta.dir, "..");

// ---------------------------------------------------------------- stub fetch

const MODEL_BYTES = new TextEncoder().encode("stub pose_landmarker_lite model bytes");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const MODEL_SHA = sha256(MODEL_BYTES);

/** The bytes the stub serves for a WASM file: distinct per name, so a swapped file is visible. */
const wasmBytes = (name: string): Uint8Array => new TextEncoder().encode(`stub wasm bytes for ${name}`);

type FetchLike = typeof fetch;

/** A stubbed fetch that serves the model and every WASM file and records each requested URL. */
function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}): {
  fetch: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const override = overrides[url];
    if (override) return override();
    if (url === POSE_MODEL_URL) return new Response(MODEL_BYTES);
    if (url.startsWith(WASM_BASE_URL)) {
      const name = url.slice(WASM_BASE_URL.length);
      if (WASM_FILES.includes(name)) return new Response(wasmBytes(name));
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  return { fetch: impl as unknown as FetchLike, calls };
}

// ---------------------------------------------------------------- temp dirs

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "fetch-pose-model-"));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(outDir, name)));

// ---------------------------------------------------------------- what is fetched

describe("what is fetched and where it goes", () => {
  test("the model comes from the official MediaPipe pose_landmarker_lite .task URL", () => {
    expect(POSE_MODEL_URL).toBe(
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    );
    expect(POSE_MODEL_FILE).toBe("pose_landmarker_lite.task");
  });

  test("the pinned model SHA-256 is a 64-digit lowercase hex constant", () => {
    expect(POSE_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the WASM files come from one exact-version @mediapipe/tasks-vision wasm/ base URL", () => {
    expect(WASM_BASE_URL).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@\d+\.\d+\.\d+\/wasm\/$/);
    expect(WASM_FILES).toContain("vision_wasm_internal.js");
    expect(WASM_FILES).toContain("vision_wasm_internal.wasm");
    expect(WASM_FILES.every((name) => /^vision_wasm[a-z_]*\.(js|wasm)$/.test(name))).toBe(true);
  });

  test("the default output directory is apps/web/public/mediapipe of this repo", () => {
    expect(DEFAULT_OUT_DIR).toBe(join(repoRoot, "apps", "web", "public", "mediapipe"));
  });
});

// ---------------------------------------------------------------- writes files

describe("first run", () => {
  test("writes the model and every WASM file with the bytes the server sent, creating the directory", async () => {
    const target = join(outDir, "nested", "mediapipe");
    const { fetch } = stubFetch();

    const result = await fetchPoseModel({ outDir: target, fetch, modelSha256: MODEL_SHA });

    expect(new Uint8Array(readFileSync(join(target, POSE_MODEL_FILE)))).toEqual(MODEL_BYTES);
    for (const name of WASM_FILES) {
      expect(new Uint8Array(readFileSync(join(target, name)))).toEqual(wasmBytes(name));
    }
    expect(result.downloaded.sort()).toEqual([POSE_MODEL_FILE, ...WASM_FILES].sort());
    expect(result.skipped).toEqual([]);
  });

  test("requests the model URL and each WASM URL, once each", async () => {
    const { fetch, calls } = stubFetch();

    await fetchPoseModel({ outDir, fetch, modelSha256: MODEL_SHA });

    expect(calls.filter((url) => url === POSE_MODEL_URL)).toHaveLength(1);
    for (const name of WASM_FILES) expect(calls.filter((url) => url === `${WASM_BASE_URL}${name}`)).toHaveLength(1);
    expect(calls).toHaveLength(1 + WASM_FILES.length);
  });

  test("leaves no temporary or partial file next to the downloads", async () => {
    const { fetch } = stubFetch();

    await fetchPoseModel({ outDir, fetch, modelSha256: MODEL_SHA });

    expect(readdirSync(outDir).sort()).toEqual([POSE_MODEL_FILE, ...WASM_FILES].sort());
  });
});

// ---------------------------------------------------------------- idempotent

describe("second run", () => {
  test("skips everything when the files are present and valid: no request is made, the files are untouched", async () => {
    await fetchPoseModel({ outDir, fetch: stubFetch().fetch, modelSha256: MODEL_SHA });
    const second = stubFetch();

    const result = await fetchPoseModel({ outDir, fetch: second.fetch, modelSha256: MODEL_SHA });

    expect(second.calls).toEqual([]);
    expect(result.downloaded).toEqual([]);
    expect(result.skipped.sort()).toEqual([POSE_MODEL_FILE, ...WASM_FILES].sort());
    expect(read(POSE_MODEL_FILE)).toEqual(MODEL_BYTES);
  });

  test("re-downloads a model whose checksum no longer matches (a corrupt or stale file is not 'valid')", async () => {
    await fetchPoseModel({ outDir, fetch: stubFetch().fetch, modelSha256: MODEL_SHA });
    writeFileSync(join(outDir, POSE_MODEL_FILE), "corrupted on disk");
    const second = stubFetch();

    const result = await fetchPoseModel({ outDir, fetch: second.fetch, modelSha256: MODEL_SHA });

    expect(second.calls).toEqual([POSE_MODEL_URL]);
    expect(result.downloaded).toEqual([POSE_MODEL_FILE]);
    expect(read(POSE_MODEL_FILE)).toEqual(MODEL_BYTES);
  });

  test("fetches only what is missing: one deleted WASM file is requested again, nothing else", async () => {
    await fetchPoseModel({ outDir, fetch: stubFetch().fetch, modelSha256: MODEL_SHA });
    const missing = WASM_FILES[0] as string;
    rmSync(join(outDir, missing));
    const second = stubFetch();

    const result = await fetchPoseModel({ outDir, fetch: second.fetch, modelSha256: MODEL_SHA });

    expect(second.calls).toEqual([`${WASM_BASE_URL}${missing}`]);
    expect(result.downloaded).toEqual([missing]);
    expect(read(missing)).toEqual(wasmBytes(missing));
  });

  test("an empty WASM file (an interrupted earlier run) counts as missing and is fetched again", async () => {
    await fetchPoseModel({ outDir, fetch: stubFetch().fetch, modelSha256: MODEL_SHA });
    const emptied = WASM_FILES[0] as string;
    writeFileSync(join(outDir, emptied), "");
    const second = stubFetch();

    await fetchPoseModel({ outDir, fetch: second.fetch, modelSha256: MODEL_SHA });

    expect(second.calls).toEqual([`${WASM_BASE_URL}${emptied}`]);
    expect(read(emptied)).toEqual(wasmBytes(emptied));
  });
});

// ---------------------------------------------------------------- checksum

describe("checksum mismatch", () => {
  const WRONG_SHA = "0".repeat(64);

  test("fails with a PoseModelFetchError that names the file and both the expected and the actual SHA-256", async () => {
    const { fetch } = stubFetch();

    const failure = await fetchPoseModel({ outDir, fetch, modelSha256: WRONG_SHA }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PoseModelFetchError);
    const message = (failure as PoseModelFetchError).message;
    expect(message).toContain(POSE_MODEL_FILE);
    expect(message).toContain("SHA-256");
    expect(message).toContain(WRONG_SHA);
    expect(message).toContain(MODEL_SHA);
  });

  test("keeps the bad model out of the output directory (no file, no partial) and fetches no WASM file", async () => {
    const { fetch, calls } = stubFetch();

    await fetchPoseModel({ outDir, fetch, modelSha256: WRONG_SHA }).catch(() => undefined);

    expect(existsSync(join(outDir, POSE_MODEL_FILE))).toBe(false);
    expect(readdirSync(outDir)).toEqual([]);
    expect(calls).toEqual([POSE_MODEL_URL]);
  });

  test("replaces a previously stored model that does not match the pin only with a verified one", async () => {
    writeFileSync(join(outDir, POSE_MODEL_FILE), "old model that is not the pinned one");
    const { fetch } = stubFetch();

    await fetchPoseModel({ outDir, fetch, modelSha256: WRONG_SHA }).catch(() => undefined);

    // The failed verification must not have swapped in the unverified download.
    expect(readFileSync(join(outDir, POSE_MODEL_FILE), "utf8")).toBe("old model that is not the pinned one");
  });

  test("the SHA-256 comparison ignores the case of the pinned hex digest", async () => {
    const { fetch } = stubFetch();

    await fetchPoseModel({ outDir, fetch, modelSha256: MODEL_SHA.toUpperCase() });

    expect(read(POSE_MODEL_FILE)).toEqual(MODEL_BYTES);
  });
});

// ---------------------------------------------------------------- download failures

describe("download failure", () => {
  test("an HTTP error status fails with a message naming the URL and the status, and writes nothing", async () => {
    const { fetch } = stubFetch({ [POSE_MODEL_URL]: () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }) });

    const failure = await fetchPoseModel({ outDir, fetch, modelSha256: MODEL_SHA }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PoseModelFetchError);
    const message = (failure as PoseModelFetchError).message;
    expect(message).toContain(POSE_MODEL_URL);
    expect(message).toContain("503");
    expect(readdirSync(outDir)).toEqual([]);
  });

  test("a network error fails with a message naming the URL and the cause", async () => {
    const wasmUrl = `${WASM_BASE_URL}${WASM_FILES[0]}`;
    const { fetch } = stubFetch({
      [wasmUrl]: () => {
        throw new TypeError("connection refused");
      },
    });

    const failure = await fetchPoseModel({ outDir, fetch, modelSha256: MODEL_SHA }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PoseModelFetchError);
    const message = (failure as PoseModelFetchError).message;
    expect(message).toContain(wasmUrl);
    expect(message).toContain("connection refused");
    // Only complete files are ever left behind.
    for (const name of readdirSync(outDir)) expect([POSE_MODEL_FILE, ...WASM_FILES]).toContain(name);
  });

  test("a body that cannot be read (the connection drops mid-download) leaves no partial file", async () => {
    const wasmUrl = `${WASM_BASE_URL}${WASM_FILES[0]}`;
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("socket hang up"));
      },
    });
    const { fetch } = stubFetch({ [wasmUrl]: () => new Response(broken) });

    const failure = await fetchPoseModel({ outDir, fetch, modelSha256: MODEL_SHA }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PoseModelFetchError);
    expect(existsSync(join(outDir, WASM_FILES[0] as string))).toBe(false);
    expect(readdirSync(outDir).filter((name) => ![POSE_MODEL_FILE, ...WASM_FILES].includes(name))).toEqual([]);
  });
});

// ---------------------------------------------------------------- the build entry point

describe("runCli (what `prebuild` runs)", () => {
  test("returns exit code 0 and logs nothing to the error stream when everything is in place", async () => {
    const errors: string[] = [];

    const code = await runCli({ outDir, fetch: stubFetch().fetch, modelSha256: MODEL_SHA, log: () => {}, error: (m) => errors.push(m) });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(read(POSE_MODEL_FILE)).toEqual(MODEL_BYTES);
  });

  test("returns a non-zero exit code with a clear message on a failed download, so the build fails", async () => {
    const errors: string[] = [];
    const { fetch } = stubFetch({ [POSE_MODEL_URL]: () => new Response("gone", { status: 404, statusText: "Not Found" }) });

    const code = await runCli({ outDir, fetch, modelSha256: MODEL_SHA, log: () => {}, error: (m) => errors.push(m) });

    expect(code).not.toBe(0);
    const text = errors.join("\n");
    expect(text).toContain(POSE_MODEL_URL);
    expect(text).toContain("404");
  });

  test("returns a non-zero exit code with the expected and actual hashes on a checksum mismatch", async () => {
    const errors: string[] = [];

    const code = await runCli({ outDir, fetch: stubFetch().fetch, modelSha256: "f".repeat(64), log: () => {}, error: (m) => errors.push(m) });

    expect(code).not.toBe(0);
    const text = errors.join("\n");
    expect(text).toContain("f".repeat(64));
    expect(text).toContain(MODEL_SHA);
  });

  test("a second run reports that it skipped the files that were already in place", async () => {
    await runCli({ outDir, fetch: stubFetch().fetch, modelSha256: MODEL_SHA, log: () => {}, error: () => {} });
    const logs: string[] = [];
    const second = stubFetch();

    const code = await runCli({ outDir, fetch: second.fetch, modelSha256: MODEL_SHA, log: (m) => logs.push(m), error: () => {} });

    expect(code).toBe(0);
    expect(second.calls).toEqual([]);
    expect(logs.join("\n").toLowerCase()).toContain("skip");
  });
});

// ---------------------------------------------------------------- repo wiring

describe("repo wiring", () => {
  const webManifest = (): { scripts: Record<string, string>; dependencies: Record<string, string> } =>
    JSON.parse(readFileSync(join(repoRoot, "apps", "web", "package.json"), "utf8"));

  test("apps/web/package.json has a `prebuild` script that runs scripts/fetch-pose-model.ts, which exists", () => {
    const prebuild = webManifest().scripts.prebuild;

    expect(prebuild).toBeDefined();
    expect(prebuild).toContain("fetch-pose-model.ts");
    // The script path is relative to apps/web (the workspace directory the script runs in).
    const relative = /(\S*fetch-pose-model\.ts)/.exec(prebuild ?? "")?.[1] ?? "";
    expect(existsSync(join(repoRoot, "apps", "web", relative))).toBe(true);
  });

  test("the existing web scripts and the mediapipe dependency are still there (only `prebuild` was added)", () => {
    const manifest = webManifest();
    for (const name of ["dev", "build", "typecheck", "test"]) expect(manifest.scripts[name]).toBeDefined();
    expect(manifest.dependencies["@mediapipe/tasks-vision"]).toBeDefined();
  });

  test("apps/web/public/mediapipe/ is git-ignored", () => {
    const result = Bun.spawnSync(["git", "check-ignore", "-q", "apps/web/public/mediapipe/pose_landmarker_lite.task"], { cwd: repoRoot });
    expect(result.exitCode).toBe(0);
    const wasm = Bun.spawnSync(["git", "check-ignore", "-q", "apps/web/public/mediapipe/vision_wasm_internal.wasm"], { cwd: repoRoot });
    expect(wasm.exitCode).toBe(0);
  });
});
