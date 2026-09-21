// Third boot hook (00-env, then this, then 40-backup): load the commons seed into the freshly
// migrated database. A thin wrapper: everything lives in ../commons/seed-loader. An invalid seed
// throws a SeedError naming file and path; the boot runner wraps it as
// "Boot hook 20-seed.boot.ts failed: ..." and start-up aborts.
//
// Seed directory: `<repo root>/config/commons`, or SEED_DIR when set (read when the hook runs, not
// at import; it is deliberately not part of env.ts). A missing directory is not an error: the seed
// content beads create config/commons later, and the Docker image does not copy it yet.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AppDeps } from "../app";
import { loadSeed } from "../commons/seed-loader";

/** apps/api/src/boot -> repo root is four levels up. */
export const DEFAULT_SEED_DIR = resolve(import.meta.dir, "../../../../config/commons");

/** SEED_DIR when set and non-empty, else the default. */
export function resolveSeedDir(env: Record<string, string | undefined> = process.env): string {
  return env.SEED_DIR || DEFAULT_SEED_DIR;
}

export type SeedBootOptions = {
  /** Seed directory (tests). Wins over SEED_DIR. */
  dir?: string;
  /** Log sink (tests). Defaults to console.log. */
  log?: (line: string) => void;
};

export async function onBoot(deps: AppDeps, opts: SeedBootOptions = {}): Promise<void> {
  const dir = opts.dir ?? resolveSeedDir();
  const log = opts.log ?? ((line: string) => console.log(line));

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const reason = dir === DEFAULT_SEED_DIR ? "no config/commons" : "no seed dir";
    log(JSON.stringify({ level: "info", msg: "seed skipped", reason }));
    return;
  }
  log(JSON.stringify({ level: "info", msg: "seed loaded", ...loadSeed(deps.db, dir) }));
}
