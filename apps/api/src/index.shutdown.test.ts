import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppDeps } from "./app";
import { getBackupSchedule, onBoot, stopBackupSchedule } from "./boot/40-backup.boot";
import { openDatabase } from "./db/database";

const INDEX_PATH = resolve(import.meta.dir, "index.ts");

type Fakes = {
  calls: string[];
  lines: object[];
  exits: number[];
  ctx: { server: { stop(): unknown }; db: { close(): void } };
  hooks: {
    log: (line: object) => void;
    stopBackup: () => void;
    exit: (code: number) => void;
  };
};

/** Recording fakes: every collaborator appends to one ordered call log. */
function fakes(overrides: { stop?: () => unknown; close?: () => void } = {}): Fakes {
  const calls: string[] = [];
  const lines: object[] = [];
  const exits: number[] = [];
  return {
    calls,
    lines,
    exits,
    ctx: {
      server: {
        stop: () => {
          calls.push("server.stop");
          return overrides.stop?.();
        },
      },
      db: {
        close: () => {
          calls.push("db.close");
          overrides.close?.();
        },
      },
    },
    hooks: {
      log: (line) => {
        calls.push("log");
        lines.push(line);
      },
      stopBackup: () => calls.push("stopBackup"),
      exit: (code) => {
        calls.push("exit");
        exits.push(code);
      },
    },
  };
}

async function loadSequence() {
  const { shutdownSequence } = await import("./index");
  return shutdownSequence;
}

describe("shutdownSequence (exported seam)", () => {
  test("stops the backup schedule, then the server, then the DB, then exits 0", async () => {
    const shutdownSequence = await loadSequence();
    const f = fakes();

    const code = await shutdownSequence({ ...f.ctx, ...f.hooks }, "SIGTERM");

    expect(f.calls).toEqual(["log", "stopBackup", "server.stop", "db.close", "exit"]);
    expect(f.exits).toEqual([0]);
    expect(code).toBe(0);
  });

  test("logs the exact 'shutting down' info line with the signal", async () => {
    const shutdownSequence = await loadSequence();
    const f = fakes();

    await shutdownSequence({ ...f.ctx, ...f.hooks }, "SIGINT");

    expect(f.lines).toEqual([{ level: "info", msg: "shutting down", signal: "SIGINT" }]);
  });

  test("awaits an async server.stop before closing the DB", async () => {
    const shutdownSequence = await loadSequence();
    const order: string[] = [];
    const f = fakes({
      stop: () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            order.push("stopped");
            done();
          }, 10),
        ),
      close: () => order.push("closed"),
    });

    await shutdownSequence({ ...f.ctx, ...f.hooks }, "SIGTERM");

    expect(order).toEqual(["stopped", "closed"]);
  });

  test("a failing server.stop logs 'shutdown failed', skips db.close and exits 1, after stopBackup ran first", async () => {
    const shutdownSequence = await loadSequence();
    const f = fakes({
      stop: () => {
        throw new Error("port busy");
      },
    });

    const code = await shutdownSequence({ ...f.ctx, ...f.hooks }, "SIGTERM");

    expect(f.calls).toEqual(["log", "stopBackup", "server.stop", "log", "exit"]);
    expect(f.lines[1]).toEqual({ level: "error", msg: "shutdown failed", error: "port busy" });
    expect(f.exits).toEqual([1]);
    expect(code).toBe(1);
  });

  test("a failing db.close logs 'shutdown failed' and exits 1", async () => {
    const shutdownSequence = await loadSequence();
    const f = fakes({
      close: () => {
        throw new Error("db locked");
      },
    });

    const code = await shutdownSequence({ ...f.ctx, ...f.hooks }, "SIGTERM");

    expect(f.lines[1]).toEqual({ level: "error", msg: "shutdown failed", error: "db locked" });
    expect(f.exits).toEqual([1]);
    expect(code).toBe(1);
  });

  test("a failing stopBackup logs 'shutdown failed' and exits 1", async () => {
    const shutdownSequence = await loadSequence();
    const f = fakes();
    const stopBackup = () => {
      f.calls.push("stopBackup");
      throw new Error("cron broke");
    };

    const code = await shutdownSequence({ ...f.ctx, ...f.hooks, stopBackup }, "SIGTERM");

    expect(f.lines[1]).toEqual({ level: "error", msg: "shutdown failed", error: "cron broke" });
    expect(f.exits).toEqual([1]);
    expect(code).toBe(1);
  });

  test("the default stopBackup is the real stopBackupSchedule: the live schedule is cancelled", async () => {
    const shutdownSequence = await loadSequence();
    const root = mkdtempSync(join(tmpdir(), "index-shutdown-"));
    const deps: AppDeps = { db: openDatabase(join(root, "app.db")), version: "test" };
    try {
      onBoot(deps, { APP_DB_PATH: join(root, "app.db"), BACKUP_DIR: join(root, "backups") });
      expect(getBackupSchedule()).toBeDefined();
      const f = fakes();

      await shutdownSequence(
        { server: f.ctx.server, db: f.ctx.db, log: f.hooks.log, exit: f.hooks.exit },
        "SIGTERM",
      );

      expect(getBackupSchedule()).toBeUndefined();
      expect(f.calls).toEqual(["log", "server.stop", "db.close", "exit"]);
    } finally {
      stopBackupSchedule();
      deps.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spawned server on SIGTERM", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "index-spawn-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Accumulates the child's stdout from the start, so nothing is lost between waiting and the final read. */
  function captureStdout(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
    let text = "";
    const done = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) text += decoder.decode(chunk, { stream: true });
    })().catch(() => undefined);
    return { text: () => text, done };
  }

  async function waitFor(check: () => boolean, deadlineMs: number, what: string): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`${what} did not appear within ${deadlineMs} ms`);
      await Bun.sleep(20);
    }
  }

  test("exits 0 within 2 s of SIGTERM, logs 'shutting down' and no backup line after it", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    await probe.stop(true);

    const proc = Bun.spawn(["bun", INDEX_PATH], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        APP_DB_PATH: join(root, "app.db"),
        PORT: String(port),
        BACKUP_DIR: join(root, "backups"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const out = captureStdout(proc);
      await waitFor(() => out.text().includes('"msg":"listening"'), 10_000, 'the "listening" line');

      const sentAt = Date.now();
      proc.kill("SIGTERM");
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2_000)),
      ]);
      const elapsed = Date.now() - sentAt;

      expect(exitCode).toBe(0);
      expect(elapsed).toBeLessThan(2_000);

      await out.done;
      const stdout = out.text();
      const afterListening = stdout.slice(stdout.indexOf('"msg":"listening"'));
      const lines = afterListening.split("\n").filter((line) => line !== "");
      const shutdownAt = lines.findIndex((line) => line.includes('"msg":"shutting down"'));
      expect(shutdownAt).toBeGreaterThan(-1);
      expect(lines.slice(shutdownAt + 1).filter((line) => line.includes("backup"))).toEqual([]);
    } finally {
      proc.kill("SIGKILL");
    }
  }, 20_000);
});
