/**
 * Versioned SQL migration runner.
 *
 * Rules for migration authors:
 *  - No BEGIN/COMMIT inside a migration: the runner already wraps each file in
 *    a transaction, so a failure rolls the whole file back.
 *  - No PRAGMA foreign_keys toggling: it is a no-op inside a transaction. Use
 *    PRAGMA defer_foreign_keys if you need to defer FK checks.
 *  - Editing or renaming an applied file is forbidden (checksum and name are
 *    verified on every run).
 *  - Each file is owned by exactly one bead.
 *  - Files are numbered NNN_name.sql from 001 with no gaps.
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MIGRATIONS_DIR = resolve(import.meta.dir, 'migrations');

const FILE_NAME = /^(\d{3,})_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  version: number;
  file: string;
  name: string;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function listMigrationFiles(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const files: MigrationFile[] = [];
  for (const file of entries) {
    if (!file.endsWith('.sql')) continue;
    const match = FILE_NAME.exec(file);
    if (!match) {
      throw new Error(`migration file name "${file}" does not match NNN_name.sql`);
    }
    files.push({
      version: Number.parseInt(match[1] as string, 10),
      file,
      name: file.slice(0, -'.sql'.length),
    });
  }
  files.sort((a, b) => a.version - b.version || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  files.forEach((f, i) => {
    const prev = files[i - 1];
    if (prev && prev.version === f.version) {
      throw new Error(`duplicate migration version ${f.version}: ${prev.file} and ${f.file}`);
    }
    if (f.version !== i + 1) {
      throw new Error(`migration gap: expected version ${i + 1} but found ${f.file}`);
    }
  });
  return files;
}

/**
 * Applies pending numbered *.sql files from `dir` in version order, each in
 * its own immediate transaction, and returns the versions newly applied.
 */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): number[] {
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       checksum TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );

  const files = listMigrationFiles(dir);
  const contents = new Map<number, Buffer>();
  for (const f of files) contents.set(f.version, readFileSync(join(dir, f.file)));
  const checksumOf = (version: number): string =>
    createHash('sha256')
      .update(contents.get(version) as Buffer)
      .digest('hex');

  const applied = db
    .query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as AppliedRow[];
  const appliedVersions = new Set(applied.map((a) => a.version));

  for (const row of applied) {
    const f = files.find((x) => x.version === row.version);
    if (!f) throw new Error(`applied migration ${row.name} has no file in ${dir}`);
    if (checksumOf(row.version) !== row.checksum) {
      throw new Error(
        `checksum mismatch for applied migration ${f.file}: file was edited after it was applied`,
      );
    }
    if (f.name !== row.name) {
      throw new Error(`applied migration ${row.version} was renamed from ${row.name} to ${f.name}`);
    }
  }

  const highestApplied = applied.at(-1)?.version ?? 0;
  for (let v = 1; v < highestApplied; v++) {
    if (!appliedVersions.has(v)) {
      const next = applied.find((a) => a.version > v) as AppliedRow;
      throw new Error(`applied migrations are not contiguous: missing version ${v} before ${next.version}`);
    }
  }

  const pending = files.filter((f) => !appliedVersions.has(f.version));
  for (const f of pending) {
    if ((contents.get(f.version) as Buffer).toString('utf8').trim() === '') {
      throw new Error(`migration ${f.file} is empty`);
    }
  }

  const insert = db.query(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  const newlyApplied: number[] = [];
  for (const f of pending) {
    const sql = (contents.get(f.version) as Buffer).toString('utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      // bun:sqlite swallows a mid-script "cannot start a transaction within a
      // transaction", so a stray COMMIT silently ends the runner's transaction
      // and the migration's DDL is already committed. Refuse to record the
      // migration; this is an operator-recovery case.
      if (!db.inTransaction) {
        throw new Error(
          `migration ${f.file} ended the surrounding transaction (BEGIN/COMMIT inside a migration is forbidden); the database may be partially migrated — restore from backup`,
        );
      }
      insert.run(f.version, f.name, checksumOf(f.version), new Date().toISOString());
    });
    try {
      apply.immediate();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`migration ${f.file} failed: ${reason}`, { cause: e });
    }
    newlyApplied.push(f.version);
  }
  return newlyApplied;
}
