// Restore CLI: `bun apps/api/src/cli/restore.ts <backup-file>`.
// Verifies the backup with PRAGMA integrity_check, then replaces the live DB
// (APP_DB_PATH) while the server is stopped. Refuses if the server is up.
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { parseEnv } from '../env';

const USAGE = 'usage: bun apps/api/src/cli/restore.ts <backup-file>';
const PROBE_TIMEOUT_MS = 500;
const PROBE_HOST = '127.0.0.1';

export type RestoreErrorCode = 'server_up' | 'not_found' | 'corrupt' | 'integrity_failed' | 'usage';

export class RestoreError extends Error {
  readonly code: RestoreErrorCode;

  constructor(code: RestoreErrorCode, message: string) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
  }
}

export interface RestoreOptions {
  /** The backup file to restore from. */
  backupFile: string;
  /** The live database path to replace. */
  dbPath: string;
  /** Server-up probe override. Defaults to a TCP connect to 127.0.0.1:<port>. */
  isServerUp?: () => Promise<boolean> | boolean;
  /** Port the server listens on (default probe only). Defaults to PORT from the environment, else 4111. */
  port?: number;
  /** Clock override (tests); names the safety copy. */
  now?: Date;
}

export interface RestoreResult {
  restored: true;
  dbPath: string;
  /** Where the replaced live DB was kept, or null when there was no live DB. */
  safetyCopy: string | null;
}

/**
 * True when something accepts TCP connections on 127.0.0.1:`port`. A refused
 * connection means down; a connect that hangs past `timeoutMs` counts as up,
 * so an unclear answer errs towards not touching the database.
 */
export function isServerListening(port: number, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: PROBE_HOST });
    const finish = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Only PORT and APP_DB_PATH matter here; NODE_ENV is dropped so production-only secrets are not demanded. */
function readEnv(env: Record<string, string | undefined>) {
  return parseEnv({ ...env, NODE_ENV: undefined });
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Throws RestoreError unless `path` opens as SQLite and PRAGMA integrity_check answers a single "ok". */
function verifyDatabase(path: string): void {
  let rows: { integrity_check: string }[];
  try {
    const db = new Database(path, { readonly: true });
    try {
      rows = db.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
    } finally {
      db.close();
    }
  } catch (e) {
    throw new RestoreError('corrupt', `backup is not a readable SQLite database: ${messageOf(e)}`);
  }
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
    throw new RestoreError('integrity_failed', `backup failed integrity_check: ${rows[0]?.integrity_check ?? 'no result'}`);
  }
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Replaces the live database at `dbPath` with `backupFile`.
 *
 * Order: refuse if the server is up; verify the backup (on a copy placed next
 * to the live DB, which is the file that gets installed); keep the current DB
 * and its -wal as `<dbPath>.pre-restore-<UTC stamp>`; delete the live -wal/-shm
 * (a stale WAL must not be replayed onto the restored file); rename the copy
 * over `dbPath`. Nothing before the sidecar removal changes the live DB.
 */
export async function restoreDatabase(opts: RestoreOptions): Promise<RestoreResult> {
  const { backupFile, dbPath } = opts;
  const port = opts.port ?? readEnv(process.env).PORT;
  const isServerUp = opts.isServerUp ?? (() => isServerListening(port));

  if (await isServerUp()) {
    throw new RestoreError('server_up', 'the server is running; stop it before restoring');
  }

  let size: number;
  try {
    const stat = statSync(backupFile);
    if (!stat.isFile()) throw new RestoreError('not_found', `backup is not a file: ${backupFile}`);
    size = stat.size;
  } catch (e) {
    if (e instanceof RestoreError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RestoreError('not_found', `backup file not found: ${backupFile}`);
    }
    throw e;
  }
  // SQLite treats a 0-byte file as a valid empty database; restoring it would wipe the live DB.
  if (size === 0) throw new RestoreError('corrupt', `backup file is empty: ${backupFile}`);

  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(dbPath)}.restore-${process.pid}.tmp`);
  const sidecars = ['-wal', '-shm'];
  const dropTmp = (): void => {
    for (const suffix of ['', ...sidecars]) rmSync(`${tmp}${suffix}`, { force: true });
  };

  let safetyCopy: string | null = null;
  try {
    dropTmp();
    copyFileSync(backupFile, tmp);
    verifyDatabase(tmp);
    // Opening the copy may have created sidecars; the installed file must have none.
    for (const suffix of sidecars) rmSync(`${tmp}${suffix}`, { force: true });

    if (existsSync(dbPath)) {
      safetyCopy = `${dbPath}.pre-restore-${stampOf(opts.now ?? new Date())}`;
      copyFileSync(dbPath, safetyCopy);
      if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${safetyCopy}-wal`);
    }

    for (const suffix of sidecars) rmSync(`${dbPath}${suffix}`, { force: true });
    renameSync(tmp, dbPath);
  } catch (e) {
    dropTmp();
    throw e;
  }
  return { restored: true, dbPath, safetyCopy };
}

export interface MainDeps {
  env?: Record<string, string | undefined>;
  isServerUp?: () => Promise<boolean> | boolean;
  now?: Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** CLI body: returns the exit code (0 restored, 1 refused or failed, 2 usage). */
export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  if (argv.length !== 1) {
    stderr(USAGE);
    return 2;
  }
  const backupFile = argv[0] as string;

  try {
    const env = readEnv(deps.env ?? process.env);
    const result = await restoreDatabase({
      backupFile,
      dbPath: env.APP_DB_PATH,
      port: env.PORT,
      isServerUp: deps.isServerUp,
      now: deps.now,
    });
    const kept = result.safetyCopy ? `; previous database kept at ${result.safetyCopy}` : '';
    stdout(`restored ${result.dbPath} from ${backupFile}${kept}`);
    return 0;
  } catch (e) {
    stderr(`restore failed: ${messageOf(e).replace(/\s*\n\s*/g, ' ')}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
