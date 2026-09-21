// Third boot hook (00-env, then this, then 40-backup): load the commons seed into the freshly
// migrated database. A thin wrapper: everything lives in ../commons/seed-loader. An invalid seed
// throws a SeedError naming file and path; the boot runner wraps it as
// "Boot hook 20-seed.boot.ts failed: ..." and start-up aborts.
//
// Seed directory: `<repo root>/config/commons`, or SEED_DIR when set (read when the hook runs, not
// at import; it is deliberately not part of env.ts). The DEFAULT directory missing is not an error
// (the seed content beads create config/commons later, and the Docker image does not copy it yet):
// one info line and no-op. An EXPLICIT directory (SEED_DIR or the dir option) that is missing or
// not a directory aborts the boot with a SeedError: a typo must not start an empty commons.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AppDeps } from "../app";
import { SeedError, loadSeed } from "../commons/seed-loader";

/** apps/api/src/boot -> repo root is four levels up. */
export const DEFAULT_SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");

/** SEED_DIR when set and non-empty, else the default. */
export function resolveSeedDir(env: Record<string, string | undefined> = process.env): string {
  return env.SEED_DIR || DEFAULT_SEED_DIR;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export type SeedBootOptions = {
  /** Seed directory (tests). Wins over SEED_DIR. */
  dir?: string;
  /** Log sink (tests). Defaults to console.log. */
  log?: (line: string) => void;
};

export async function onBoot(deps: AppDeps, opts: SeedBootOptions = {}): Promise<void> {
  const fromEnv = opts.dir === undefined && Boolean(process.env.SEED_DIR);
  const explicit = opts.dir !== undefined || fromEnv;
  const dir = opts.dir ?? resolveSeedDir();
  const log = opts.log ?? ((line: string) => console.log(line));

  if (!isDirectory(dir)) {
    // Somebody named this directory: a typo must not boot an empty commons. Only the unset
    // default, config/commons not existing yet, is a silent skip.
    if (explicit) {
      throw new SeedError([{ file: fromEnv ? "SEED_DIR" : "seed dir", path: dir, message: "does not exist or is not a directory" }]);
    }
    log(JSON.stringify({ level: "info", msg: "seed skipped", reason: "no config/commons" }));
    return;
  }
  log(JSON.stringify({ level: "info", msg: "seed loaded", ...loadSeed(deps.db, dir) }));
}
