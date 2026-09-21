// Nightly database backup: schedules ops/backup.ts with croner at 03:00 UTC,
// writing into BACKUP_DIR (default: a `backups` directory next to the DB file,
// i.e. on the same volume).
//
// The boot runner has no shutdown seam, so the Cron is created with `unref`
// (its timer can never keep the process alive) and `stopBackupSchedule` is
// exported for the graceful-shutdown path to call. A failed backup is logged
// and never crashes the process; the schedule stays registered.
import { basename, dirname, join } from "node:path";
import { Cron } from "croner";
import type { AppDeps } from "../app";
import { parseEnv } from "../env";
import { backupDatabase } from "../ops/backup";

/** 03:00 every night, evaluated in UTC. */
export const BACKUP_SCHEDULE = "0 3 * * *";

const IN_MEMORY = ":memory:";

export type BackupLog = { info(line: string): void; error(line: string): void };

export type BackupBootOptions = {
  /** Backup function (tests). Defaults to ops/backup's backupDatabase. */
  backup?: typeof backupDatabase;
  /** Log sink (tests). Defaults to console.log / console.error. */
  log?: BackupLog;
};

const defaultLog: BackupLog = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let active: Cron | undefined;

/** The live backup schedule, or undefined when none is registered. */
export function getBackupSchedule(): Cron | undefined {
  return active;
}

/** Cancels the nightly schedule. Idempotent. */
export function stopBackupSchedule(): void {
  active?.stop();
  active = undefined;
}

/** `env` defaults to process.env, read when the hook runs (not at import). */
export function onBoot(
  deps: AppDeps,
  env: Record<string, string | undefined> = process.env,
  opts: BackupBootOptions = {},
): void {
  stopBackupSchedule();

  const { APP_DB_PATH, BACKUP_DIR } = parseEnv(env);
  if (APP_DB_PATH === IN_MEMORY || deps.db.filename === IN_MEMORY) return; // nothing to back up

  const dir = BACKUP_DIR ?? join(dirname(APP_DB_PATH), "backups");
  const backup = opts.backup ?? backupDatabase;
  const log = opts.log ?? defaultLog;

  active = new Cron(BACKUP_SCHEDULE, { timezone: "UTC", unref: true, protect: true }, () => {
    try {
      const result = backup(deps.db, dir);
      log.info(
        JSON.stringify({
          level: "info",
          msg: "backup done",
          file: basename(result.path),
          pruned: result.pruned.length,
        }),
      );
    } catch (error) {
      log.error(JSON.stringify({ level: "error", msg: "backup failed", error: messageOf(error) }));
    }
  });
}
