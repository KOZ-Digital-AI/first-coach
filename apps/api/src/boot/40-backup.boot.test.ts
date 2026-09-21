import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppDeps } from "../app";
import { openDatabase } from "../db/database";
import { BACKUP_FILE_PATTERN, type backupDatabase } from "../ops/backup";
import { BACKUP_SCHEDULE, getBackupSchedule, onBoot, stopBackupSchedule } from "./40-backup.boot";

type Backup = typeof backupDatabase;
type Result = ReturnType<Backup>;

const HOOK_PATH = resolve(import.meta.dir, "40-backup.boot.ts");

let root: string;
let dbPath: string;
let deps: AppDeps;
let infoLines: string[];
let errorLines: string[];
let log: { info(line: string): void; error(line: string): void };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backup-boot-"));
  dbPath = join(root, "app.db");
  deps = { db: openDatabase(dbPath), version: "test" };
  infoLines = [];
  errorLines = [];
  log = { info: (line) => infoLines.push(line), error: (line) => errorLines.push(line) };
});

afterEach(() => {
  stopBackupSchedule();
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

const okResult = (dir: string): Result => ({ path: join(dir, "first-coach-2026-01-01.sqlite"), pruned: [] });

/** Boots the hook with an env that always has a known BACKUP_DIR unless overridden. */
function boot(
  env: Record<string, string | undefined> = {},
  backup: Backup = (_db, dir) => okResult(dir),
): string {
  const dir = env.BACKUP_DIR ?? join(root, "backups");
  onBoot(deps, { APP_DB_PATH: dbPath, BACKUP_DIR: dir, ...env }, { backup, log });
  return dir;
}

function scheduled() {
  const cron = getBackupSchedule();
  if (cron === undefined) throw new Error("expected a backup schedule to be registered");
  return cron;
}

describe("schedule", () => {
  test("BACKUP_SCHEDULE is 03:00 every night", () => {
    expect(BACKUP_SCHEDULE).toBe("0 3 * * *");
  });

  test("registers the nightly schedule in UTC", () => {
    boot();
    const cron = scheduled();
    expect(cron.getPattern()).toBe(BACKUP_SCHEDULE);
    expect(cron.options.timezone).toBe("UTC");
    expect(cron.isRunning()).toBe(true);
  });

  test("the next run is a future 03:00:00 UTC within a day", () => {
    const before = Date.now();
    boot();
    const next = scheduled().nextRun();
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(before);
    expect(next!.getTime() - before).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect([next!.getUTCHours(), next!.getUTCMinutes(), next!.getUTCSeconds()]).toEqual([3, 0, 0]);
  });

  test("overlapping runs are skipped (protect) and the timer is unref'd", () => {
    boot();
    const cron = scheduled();
    expect(cron.options.protect).toBe(true);
    expect(cron.options.unref).toBe(true);
  });

  test("an in-memory database is not scheduled", () => {
    const memory = openDatabase(":memory:");
    try {
      let called = 0;
      onBoot(
        { db: memory, version: "test" },
        { BACKUP_DIR: join(root, "backups") },
        { backup: (_db, dir) => (called++, okResult(dir)), log },
      );
      expect(getBackupSchedule()).toBeUndefined();
      expect(called).toBe(0);
    } finally {
      memory.close();
    }
  });

  test("an in-memory APP_DB_PATH is not scheduled", () => {
    boot({ APP_DB_PATH: ":memory:" });
    expect(getBackupSchedule()).toBeUndefined();
  });
});

describe("a run", () => {
  test("invokes backup with the database and the configured BACKUP_DIR", async () => {
    const calls: Array<[unknown, string]> = [];
    const dir = boot({ BACKUP_DIR: join(root, "explicit") }, (db, target) => {
      calls.push([db, target]);
      return okResult(target);
    });
    await scheduled().trigger();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(deps.db);
    expect(calls[0]![1]).toBe(dir);
    expect(dir).toBe(join(root, "explicit"));
  });

  test("defaults to a backups directory next to the database file", async () => {
    const dirs: string[] = [];
    onBoot(
      deps,
      { APP_DB_PATH: join(root, "volume", "app.db") },
      { backup: (_db, dir) => (dirs.push(dir), okResult(dir)), log },
    );
    await scheduled().trigger();
    expect(dirs).toEqual([join(root, "volume", "backups")]);
  });

  test("defaults to data/backups when neither variable is set", async () => {
    const dirs: string[] = [];
    onBoot(deps, {}, { backup: (_db, dir) => (dirs.push(dir), okResult(dir)), log });
    await scheduled().trigger();
    expect(dirs).toEqual([join("data", "backups")]);
  });

  test("an explicit BACKUP_DIR wins over the database-sibling default", async () => {
    const dirs: string[] = [];
    onBoot(
      deps,
      { APP_DB_PATH: join(root, "volume", "app.db"), BACKUP_DIR: join(root, "elsewhere") },
      { backup: (_db, dir) => (dirs.push(dir), okResult(dir)), log },
    );
    await scheduled().trigger();
    expect(dirs).toEqual([join(root, "elsewhere")]);
  });

  test("with the real backup, writes a dated backup file into the directory", async () => {
    const dir = join(root, "real-backups");
    deps.db.run("CREATE TABLE t (x INTEGER)");
    onBoot(deps, { APP_DB_PATH: dbPath, BACKUP_DIR: dir }, { log });
    await scheduled().trigger();
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(BACKUP_FILE_PATTERN);
    expect(existsSync(join(dir, files[0]!))).toBe(true);
  });

  test("logs one info line with the file basename and the pruned count", async () => {
    const dir = join(root, "backups");
    boot({ BACKUP_DIR: dir }, () => ({
      path: join(dir, "first-coach-2026-03-04.sqlite"),
      pruned: [join(dir, "a.sqlite"), join(dir, "b.sqlite")],
    }));
    await scheduled().trigger();
    expect(errorLines).toEqual([]);
    expect(infoLines).toHaveLength(1);
    expect(JSON.parse(infoLines[0]!)).toEqual({
      level: "info",
      msg: "backup done",
      file: "first-coach-2026-03-04.sqlite",
      pruned: 2,
    });
  });
});

describe("a failing backup", () => {
  const failing = (): Backup => () => {
    throw new Error("disk full");
  };

  test("is swallowed and logged as one error line with only the message", async () => {
    boot({}, failing());
    await scheduled().trigger();
    expect(infoLines).toEqual([]);
    expect(errorLines).toHaveLength(1);
    expect(JSON.parse(errorLines[0]!)).toEqual({
      level: "error",
      msg: "backup failed",
      error: "disk full",
    });
  });

  test("a non-Error throw is logged by its string form", async () => {
    boot({}, () => {
      throw "boom";
    });
    await scheduled().trigger();
    expect(JSON.parse(errorLines[0]!).error).toBe("boom");
  });

  test("keeps the schedule alive and runs again next time", async () => {
    let calls = 0;
    boot({}, () => {
      calls++;
      throw new Error("disk full");
    });
    const cron = scheduled();
    await cron.trigger();
    await cron.trigger();
    expect(calls).toBe(2);
    expect(errorLines).toHaveLength(2);
    expect(getBackupSchedule()).toBe(cron);
    expect(cron.isRunning()).toBe(true);
    expect(cron.nextRun()).toBeInstanceOf(Date);
  });
});

describe("stopBackupSchedule", () => {
  test("cancels the schedule and clears the handle", () => {
    boot();
    const cron = scheduled();
    stopBackupSchedule();
    expect(cron.nextRun()).toBeNull();
    expect(cron.isRunning()).toBe(false);
    expect(getBackupSchedule()).toBeUndefined();
  });

  test("is idempotent, including when nothing was ever scheduled", () => {
    expect(() => stopBackupSchedule()).not.toThrow();
    boot();
    stopBackupSchedule();
    expect(() => stopBackupSchedule()).not.toThrow();
    expect(getBackupSchedule()).toBeUndefined();
  });
});

describe("a repeated onBoot", () => {
  test("stops the previous schedule so exactly one stays live", () => {
    boot();
    const first = scheduled();
    boot();
    const second = scheduled();
    expect(second).not.toBe(first);
    expect(first.nextRun()).toBeNull();
    expect(first.isRunning()).toBe(false);
    expect(second.isRunning()).toBe(true);
  });

  test("rescheduling after an in-memory boot stops the previous schedule too", () => {
    boot();
    const first = scheduled();
    boot({ APP_DB_PATH: ":memory:" });
    expect(first.isRunning()).toBe(false);
    expect(getBackupSchedule()).toBeUndefined();
  });
});

describe("process lifetime", () => {
  test("a booted hook does not keep the process alive", async () => {
    const script = `
      import { Database } from "bun:sqlite";
      import { onBoot, getBackupSchedule } from ${JSON.stringify(HOOK_PATH)};
      const db = new Database(${JSON.stringify(dbPath)}, { create: true });
      onBoot({ db, version: "child" }, { APP_DB_PATH: ${JSON.stringify(dbPath)} });
      console.log(getBackupSchedule() ? "scheduled" : "none");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 4000,
    });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(out.trim()).toBe("scheduled");
    expect(code).toBe(0);
  }, 10000);
});
