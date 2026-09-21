import type { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Backups are named first-coach-YYYY-MM-DD.sqlite (UTC date). */
export const BACKUP_FILE_PATTERN = /^first-coach-(\d{4}-\d{2}-\d{2})\.sqlite$/;

const DEFAULT_KEEP = 14;

export interface BackupOptions {
  /** Clock override (tests). Defaults to the current time. */
  now?: Date;
  /** Number of newest backups to keep. Defaults to 14. */
  keep?: number;
}

export interface BackupResult {
  /** Path (dir joined with the file name) of the backup written by this run. */
  path: string;
  /** Paths of older backups deleted by retention. */
  pruned: string[];
}

/**
 * Names of backup files in `dir`, newest first. Only regular files matching
 * BACKUP_FILE_PATTERN count; ordering is by the date in the name, not mtime.
 * A missing directory yields an empty list.
 */
export function listBackups(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && BACKUP_FILE_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * Writes a consistent copy of `db` into `dir` with VACUUM INTO, then deletes
 * all but the newest `keep` backups. Unrelated files are never touched.
 *
 * The copy goes to a temp name first and is renamed over the day's file, so a
 * same-day re-run replaces the earlier backup and a failed run leaves it intact.
 */
export function backupDatabase(db: Database, dir: string, opts: BackupOptions = {}): BackupResult {
  const keep = opts.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new RangeError(`keep must be an integer >= 1, got ${keep}`);
  }
  const now = opts.now ?? new Date();

  mkdirSync(dir, { recursive: true });
  const name = `first-coach-${now.toISOString().slice(0, 10)}.sqlite`;
  const path = join(dir, name);
  const tmp = join(dir, `.${name}.tmp`);

  rmSync(tmp, { force: true }); // VACUUM INTO refuses an existing file
  try {
    db.query('VACUUM INTO ?').run(tmp);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }

  const pruned: string[] = [];
  for (const stale of listBackups(dir).slice(keep)) {
    const stalePath = join(dir, stale);
    rmSync(stalePath);
    pruned.push(stalePath);
  }
  return { path, pruned };
}
