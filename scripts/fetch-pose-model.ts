// fc-mol-8nt.11: downloads the MediaPipe pose_landmarker_lite .task model and the @mediapipe/tasks-vision WASM files into
// apps/web/public/mediapipe (git-ignored), so the Beta AI Video Coach is self-hosted: no third-party CDN at run time.
//
// Run by apps/web's `prebuild` script (`bun ../../scripts/fetch-pose-model.ts`), so `bun run build` fetches them first.
//
// - The model is verified against a pinned SHA-256; a mismatch is a hard error and the unverified file is never kept.
// - Idempotent: a model whose SHA-256 matches, and a WASM file that exists and is not empty, is skipped (no request).
//   Anything missing, empty or corrupt is fetched again, and only that.
// - Files are written to `<name>.part` and renamed, so an interrupted run never leaves a half-written file under its real name.
// - A failed download (HTTP error, network error, dropped body, checksum mismatch) makes the process exit 1 with a message
//   that names the file, the URL and the reason, which fails the build.
//
// Reading of the criteria where they are open: only the model is checksum-pinned (the criterion says so); the WASM files
// come from an exact-version, immutable npm URL (the version in bun.lock) and are treated as valid when present and non-empty.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The official MediaPipe pose_landmarker_lite (float16) model bundle. */
export const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
export const POSE_MODEL_FILE = "pose_landmarker_lite.task";

/**
 * Pinned SHA-256 (lowercase hex) of the model at POSE_MODEL_URL.
 *
 * UNCONFIRMED PLACEHOLDER (all zeros): no authoritative SHA-256 is published for this file (Google Cloud Storage lists only
 * CRC32C and MD5 for it), and it was not downloaded when this script was written. It MUST be confirmed at the first real
 * download: run
 *   curl -sSL <POSE_MODEL_URL> | sha256sum
 * (or read the "actual" digest that the mismatch error of this script prints), check the file is the intended model, and
 * replace this constant. Until then the build fails closed with a checksum mismatch, by design.
 */
export const POSE_MODEL_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

/** tasks-vision WASM runtime, from the exact version locked in bun.lock (keep in step with @mediapipe/tasks-vision). */
export const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm/";
export const WASM_FILES: readonly string[] = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

export const DEFAULT_OUT_DIR = resolve(import.meta.dir, "..", "apps", "web", "public", "mediapipe");

/** A download or verification failure; the message is written to be shown to whoever runs the build. */
export class PoseModelFetchError extends Error {
  override name = "PoseModelFetchError";
}

export interface FetchPoseModelOptions {
  outDir?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Expected SHA-256 of the model (hex, any case); defaults to POSE_MODEL_SHA256. */
  modelSha256?: string;
  log?: (message: string) => void;
}

export interface FetchPoseModelResult {
  downloaded: string[];
  skipped: string[];
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function download(fetchImpl: typeof fetch, url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new PoseModelFetchError(`could not download ${url}: ${reason(error)}`);
  }
  if (!response.ok) {
    throw new PoseModelFetchError(`could not download ${url}: HTTP ${response.status} ${response.statusText}`.trimEnd());
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new PoseModelFetchError(`could not download ${url}: the connection broke while reading the body (${reason(error)})`);
  }
  if (bytes.byteLength === 0) throw new PoseModelFetchError(`could not download ${url}: the response body is empty`);
  return bytes;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Writes through `<path>.part` and renames, so `path` only ever holds a complete file. */
function writeAtomically(path: string, bytes: Uint8Array): void {
  const partial = `${path}.part`;
  try {
    writeFileSync(partial, bytes);
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
}

export async function fetchPoseModel(options: FetchPoseModelOptions = {}): Promise<FetchPoseModelResult> {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const fetchImpl = options.fetch ?? fetch;
  const expected = (options.modelSha256 ?? POSE_MODEL_SHA256).toLowerCase();
  const log = options.log ?? (() => {});
  const result: FetchPoseModelResult = { downloaded: [], skipped: [] };

  mkdirSync(outDir, { recursive: true });

  // The model first: it is the file with a checksum, so a bad pin fails before the larger WASM files are fetched.
  const modelPath = join(outDir, POSE_MODEL_FILE);
  if (existsSync(modelPath) && sha256Hex(readFileSync(modelPath)) === expected) {
    result.skipped.push(POSE_MODEL_FILE);
    log(`skipped ${POSE_MODEL_FILE} (already present, SHA-256 verified)`);
  } else {
    const bytes = await download(fetchImpl, POSE_MODEL_URL);
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      throw new PoseModelFetchError(
        `${POSE_MODEL_FILE} (from ${POSE_MODEL_URL}) failed the SHA-256 check: expected ${expected}, actual ${actual}. ` +
          "The file was not saved. If the model was updated on purpose, set POSE_MODEL_SHA256 in scripts/fetch-pose-model.ts to the actual value.",
      );
    }
    writeAtomically(modelPath, bytes);
    result.downloaded.push(POSE_MODEL_FILE);
    log(`downloaded ${POSE_MODEL_FILE} (SHA-256 verified)`);
  }

  for (const name of WASM_FILES) {
    const path = join(outDir, name);
    if (existsSync(path) && statSync(path).size > 0) {
      result.skipped.push(name);
      log(`skipped ${name} (already present)`);
      continue;
    }
    writeAtomically(path, await download(fetchImpl, `${WASM_BASE_URL}${name}`));
    result.downloaded.push(name);
    log(`downloaded ${name}`);
  }

  return result;
}

export interface RunCliOptions extends FetchPoseModelOptions {
  error?: (message: string) => void;
}

/** The build entry point: returns the process exit code (0 = files in place, 1 = the build must fail). */
export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(`fetch-pose-model: ${message}`));
  const error = options.error ?? ((message: string) => console.error(message));
  try {
    await fetchPoseModel({ ...options, log });
    return 0;
  } catch (failure) {
    error(`fetch-pose-model: FAILED: ${reason(failure)}`);
    error("fetch-pose-model: the pose model and WASM files are required by the web build (apps/web/public/mediapipe); failing the build.");
    return 1;
  }
}

if (import.meta.main) process.exit(await runCli());
