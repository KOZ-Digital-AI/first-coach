// Boot sequence: open the DB, migrate, run boot hooks, build the app.
//
// Order is load-bearing: migrations BEFORE hooks (a seed load needs tables),
// hooks BEFORE createApp (env validation must fail before any route module is
// imported; hooks may register things routes need).
//
// Boot hooks live in ./boot/ and are named `<name>.boot.ts`. Each exports
// `onBoot(deps)`. Later beads add start-up work by dropping a file there,
// never by editing index.ts or this file.
// - Hooks run one at a time in filename order (plain code-unit comparison; use
//   a numeric prefix such as `10-env.boot.ts` to order them).
// - Hooks receive the same deps object the app is created with.
// - A load error, a missing `onBoot`, or a throwing/rejecting hook aborts
//   startup with an error that names the hook file (original error in `cause`).
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "./app";
import { openDatabase } from "./db/database";
import { migrate } from "./db/migrate";

export type BootHook = { onBoot(deps: AppDeps): void | Promise<void> };

export type BootOptions = {
  /** SQLite path; default per openDatabase (APP_DB_PATH, else ./data/app.db). */
  dbPath?: string;
  /** Migrations directory; default per migrate. */
  migrationsDir?: string;
  /** Boot hook directory; default apps/api/src/boot. */
  bootDir?: string;
  /** Route module directory; default per createApp. */
  routesDir?: string;
  /** Overrides BUILD_VERSION and the package.json version. */
  version?: string;
};

export const DEFAULT_BOOT_DIR = resolve(import.meta.dir, "boot");
const PACKAGE_JSON = resolve(import.meta.dir, "..", "package.json");

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** `version` from apps/api/package.json (located from this file, so cwd-independent); "0.0.0" if absent. */
function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
}

/**
 * Imports every `*.boot.ts` in `dir` in filename order and awaits its
 * `onBoot(deps)`. A missing or empty directory is a no-op. Returns the hook
 * file names in the order they ran.
 */
export async function runBootHooks(
  deps: AppDeps,
  dir: string = DEFAULT_BOOT_DIR,
): Promise<string[]> {
  if (!isDirectory(dir)) return [];

  const files = [...new Bun.Glob("*.boot.ts").scanSync({ cwd: dir, onlyFiles: true })].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

  for (const file of files) {
    let mod: Partial<BootHook>;
    try {
      mod = (await import(resolve(dir, file))) as Partial<BootHook>;
    } catch (cause) {
      throw new Error(`Boot hook ${file} failed to load: ${messageOf(cause)}`, { cause });
    }
    if (typeof mod.onBoot !== "function") {
      throw new Error(`Boot hook ${file} must export an onBoot(deps) function`);
    }
    try {
      await mod.onBoot(deps);
    } catch (cause) {
      throw new Error(`Boot hook ${file} failed: ${messageOf(cause)}`, { cause });
    }
  }
  return files;
}

/**
 * The whole start-up sequence, minus listening: open DB, migrate, run boot
 * hooks, create the app. On any failure the DB is closed and the error rethrown.
 */
export async function runBoot(options: BootOptions = {}): Promise<{ app: Hono; deps: AppDeps }> {
  const db = openDatabase(options.dbPath);
  try {
    migrate(db, options.migrationsDir);
    const deps: AppDeps = {
      db,
      version: options.version ?? (process.env.BUILD_VERSION?.trim() || packageVersion()),
    };
    await runBootHooks(deps, options.bootDir);
    const app = await createApp(deps, options.routesDir);
    return { app, deps };
  } catch (error) {
    db.close();
    throw error;
  }
}
