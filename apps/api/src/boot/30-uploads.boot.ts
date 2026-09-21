// Boot hook 30 (after 20-seed, before 40-backup): reconcile the upload store with the database once
// per start-up, because a crash or a restart can leave files with no row (the upload wrote its file but
// never inserted the row, or the contribution was deleted and cascaded its rows) and rows with no file.
// It runs uploads.sweepOrphans over MEDIA_DIR and logs the counts through the app logger.
//
// MEDIA_DIR is read when the hook runs (not at import); the default is ./data/media. A directory that
// does not exist yet is created and NOT swept: on a first boot there is nothing to reconcile, and on a
// mis-mounted volume "every file is missing" must not be answered by deleting every attachment row.
//
// The sweep is housekeeping, not a start-up requirement: any failure is logged and boot continues.
import { existsSync, mkdirSync } from "node:fs";
import type { AppDeps } from "../app";
import { type SweepOptions, resolveMediaDir, sweepOrphans } from "../contributions/uploads";
import { type Logger, logger } from "../log";

export type UploadsBootOptions = {
  /** Log sink (tests). Defaults to the process logger. */
  log?: Logger;
  /** Sweep clock / grace (tests). */
  sweep?: SweepOptions;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `env` defaults to process.env, read when the hook runs. */
export function onBoot(
  deps: AppDeps,
  env: Record<string, string | undefined> = process.env,
  opts: UploadsBootOptions = {},
): void {
  const log = opts.log ?? logger;
  let dir: string | undefined;
  try {
    dir = resolveMediaDir(env);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log.info("uploads sweep skipped", { reason: "media directory created", dir });
      return;
    }
    const { removedFiles, removedRows } = sweepOrphans(deps.db, dir, opts.sweep);
    log.info("uploads sweep", { dir, removedFiles, removedRows });
  } catch (error) {
    log.error("uploads sweep failed", { dir, error: messageOf(error) });
  }
}
