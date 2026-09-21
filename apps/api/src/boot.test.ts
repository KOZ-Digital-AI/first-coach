import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppDeps } from "./app";
import { DEFAULT_BOOT_DIR, runBoot, runBootHooks } from "./boot";
import { openDatabase } from "./db/database";
import { PROBLEM_CONTENT_TYPE } from "./shared/primitives";

// Temp hook modules cannot resolve bare specifiers from os.tmpdir(), so they
// report through a shared array on globalThis. A fresh mkdtemp per test keeps
// Bun's module cache from leaking one test's modules into the next.
const shared = globalThis as unknown as { __bootLog?: unknown[] };

let root: string;
let bootDir: string;
let migrationsDir: string;
let routesDir: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boot-"));
  bootDir = join(root, "boot");
  migrationsDir = join(root, "migrations");
  routesDir = join(root, "routes");
  dbPath = join(root, "data", "app.db");
  for (const dir of [bootDir, migrationsDir, routesDir]) mkdirSync(dir);
  writeFileSync(join(migrationsDir, "001_alpha.sql"), "CREATE TABLE alpha (id INTEGER PRIMARY KEY);");
  writeFileSync(join(migrationsDir, "002_beta.sql"), "CREATE TABLE beta (id INTEGER PRIMARY KEY);");
  shared.__bootLog = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete shared.__bootLog;
});

const writeHook = (name: string, source: string): void => writeFileSync(join(bootDir, name), source);

/** A hook that records its own name. */
const recordingHook = (name: string): string =>
  `export function onBoot() { globalThis.__bootLog.push(${JSON.stringify(name)}); }\n`;

const options = () => ({ dbPath, migrationsDir, bootDir, routesDir, version: "test" });

describe("runBoot ordering", () => {
  test("migrations are applied before any hook runs", async () => {
    writeHook(
      "check.boot.ts",
      `export function onBoot(deps) {
         const rows = deps.db.query("SELECT COUNT(*) AS n FROM schema_migrations").get();
         const tables = deps.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
         globalThis.__bootLog.push({ migrations: rows.n, tables });
       }\n`,
    );

    await runBoot(options());

    const [seen] = shared.__bootLog as { migrations: number; tables: string[] }[];
    expect(seen?.migrations).toBe(2);
    expect(seen?.tables).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  test("hooks run in filename order regardless of creation order", async () => {
    writeHook("zeta.boot.ts", recordingHook("zeta"));
    writeHook("alpha.boot.ts", recordingHook("alpha"));
    writeHook("mid.boot.ts", recordingHook("mid"));

    await runBoot(options());

    expect(shared.__bootLog).toEqual(["alpha", "mid", "zeta"]);
  });

  test("a numeric prefix orders a hook first, and files that are not *.boot.ts are ignored", async () => {
    writeHook("alpha.boot.ts", recordingHook("alpha"));
    writeHook("00-first.boot.ts", recordingHook("00-first"));
    writeHook("helper.ts", recordingHook("helper"));
    writeHook("notes.boot.txt", "not a module");

    await runBoot(options());

    expect(shared.__bootLog).toEqual(["00-first", "alpha"]);
  });

  test("hooks run before the app is created (they can register what routes need)", async () => {
    writeHook("seed.boot.ts", `export function onBoot() { globalThis.__bootLog.push("hook"); }\n`);
    writeFileSync(
      join(routesDir, "probe.routes.ts"),
      `export function register() { globalThis.__bootLog.push("route-register"); }\n`,
    );

    await runBoot(options());

    expect(shared.__bootLog).toEqual(["hook", "route-register"]);
  });

  test("an async hook is awaited before the next hook starts", async () => {
    writeHook(
      "a-slow.boot.ts",
      `export async function onBoot() {
         await Bun.sleep(30);
         globalThis.__bootLog.push("slow-done");
       }\n`,
    );
    writeHook("b-next.boot.ts", recordingHook("next"));

    await runBoot(options());

    expect(shared.__bootLog).toEqual(["slow-done", "next"]);
  });

  test("hooks and route modules receive the very same deps object the boot returns", async () => {
    writeHook("deps.boot.ts", `export function onBoot(deps) { globalThis.__bootLog.push(deps); }\n`);
    writeFileSync(
      join(routesDir, "deps.routes.ts"),
      `export function register(app, deps) { globalThis.__bootLog.push(deps); }\n`,
    );

    const { deps } = await runBoot(options());

    expect(shared.__bootLog?.[0]).toBe(deps);
    expect(shared.__bootLog?.[1]).toBe(deps);
    expect(deps.version).toBe("test");
  });
});

describe("runBoot failures", () => {
  test("a throwing hook aborts startup with a message naming the hook", async () => {
    writeHook("10-ok.boot.ts", recordingHook("ok"));
    writeHook("20-bad.boot.ts", `export function onBoot() { throw new Error("missing SECRET"); }\n`);
    writeHook("30-never.boot.ts", recordingHook("never"));
    writeFileSync(
      join(routesDir, "probe.routes.ts"),
      `export function register() { globalThis.__bootLog.push("route-register"); }\n`,
    );

    const failure = await runBoot(options()).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(Error);
    const error = failure as Error;
    expect(error.message).toContain("Boot hook 20-bad.boot.ts failed");
    expect(error.message).toContain("missing SECRET");
    expect((error.cause as Error).message).toBe("missing SECRET");
    // the hook before it ran; nothing after it did, and the app was never created
    expect(shared.__bootLog).toEqual(["ok"]);
  });

  test("a rejecting async hook aborts startup with a message naming the hook", async () => {
    writeHook(
      "seed.boot.ts",
      `export async function onBoot() { await Bun.sleep(1); throw new Error("seed file unreadable"); }\n`,
    );

    await expect(runBoot(options())).rejects.toThrow(/seed\.boot\.ts.*seed file unreadable/);
  });

  test("a hook module without onBoot fails with a message naming the file", async () => {
    writeHook("empty.boot.ts", `export const nothing = 1;\n`);

    await expect(runBoot(options())).rejects.toThrow(
      "Boot hook empty.boot.ts must export an onBoot(deps) function",
    );
  });

  test("a hook module that fails to import names the file and keeps the cause", async () => {
    writeHook("broken.boot.ts", `export function onBoot( {\n`);

    const failure = await runBoot(options()).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(failure?.message).toContain("Boot hook broken.boot.ts failed to load");
    expect(failure?.cause).toBeDefined();
  });

  test("a failing migration aborts before any hook runs", async () => {
    writeFileSync(join(migrationsDir, "003_bad.sql"), "THIS IS NOT SQL;");
    writeHook("only.boot.ts", recordingHook("only"));

    await expect(runBoot(options())).rejects.toThrow(/003_bad\.sql/);
    expect(shared.__bootLog).toEqual([]);
  });

  test("the database handle is closed after a failed hook", async () => {
    writeHook(
      "bad.boot.ts",
      `export function onBoot(deps) { globalThis.__bootLog.push(deps.db); throw new Error("nope"); }\n`,
    );
    await expect(runBoot(options())).rejects.toThrow(/bad\.boot\.ts/);

    const [db] = shared.__bootLog as Database[];
    expect(() => db?.query("SELECT 1").get()).toThrow();
  });

  test("the database handle is closed after a failed route module too", async () => {
    writeHook("grab.boot.ts", `export function onBoot(deps) { globalThis.__bootLog.push(deps.db); }\n`);
    writeFileSync(
      join(routesDir, "bad.routes.ts"),
      `export function register() { throw new Error("route boom"); }\n`,
    );
    await expect(runBoot(options())).rejects.toThrow(/bad\.routes\.ts/);

    const [db] = shared.__bootLog as Database[];
    expect(() => db?.query("SELECT 1").get()).toThrow();
  });
});

describe("runBoot without hooks", () => {
  test("a missing boot dir is a no-op and the app is still returned", async () => {
    rmSync(bootDir, { recursive: true });

    const { app } = await runBoot(options());

    expect((await app.request("/api/nope")).status).toBe(404);
  });

  test("an empty boot dir is a no-op", async () => {
    const { app } = await runBoot(options());

    expect((await app.request("/api/nope")).status).toBe(404);
  });

  test("creates the database file (and its parent directory) at dbPath", async () => {
    await runBoot(options());

    expect(await Bun.file(dbPath).exists()).toBe(true);
  });
});

describe("runBoot result", () => {
  test("the app answers an unknown /api path with a 404 problem+json", async () => {
    const { app } = await runBoot(options());
    const res = await app.request("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
    expect(await res.json()).toMatchObject({ status: 404, title: "Not Found" });
  });

  test("route modules receive the booted deps", async () => {
    writeFileSync(
      join(routesDir, "ver.routes.ts"),
      `export function register(app, deps) {
         app.get("/api/ver", (c) => c.json({ version: deps.version, n: deps.db.query("SELECT COUNT(*) AS n FROM beta").get().n }));
       }\n`,
    );

    const { app } = await runBoot(options());
    const res = await app.request("/api/ver");

    expect(await res.json()).toEqual({ version: "test", n: 0 });
  });
});

describe("version resolution", () => {
  let savedVersion: string | undefined;
  beforeEach(() => {
    savedVersion = process.env.BUILD_VERSION;
  });
  afterEach(() => {
    if (savedVersion === undefined) delete process.env.BUILD_VERSION;
    else process.env.BUILD_VERSION = savedVersion;
  });

  const versionWith = async (version?: string): Promise<string> =>
    (await runBoot({ ...options(), version })).deps.version;

  test("the version option wins over BUILD_VERSION", async () => {
    process.env.BUILD_VERSION = "from-env";
    expect(await versionWith("from-option")).toBe("from-option");
  });

  test("BUILD_VERSION is used when no option is given", async () => {
    process.env.BUILD_VERSION = "from-env";
    expect(await versionWith()).toBe("from-env");
  });

  test("BUILD_VERSION is trimmed", async () => {
    process.env.BUILD_VERSION = "  1.2.3 \n";
    expect(await versionWith()).toBe("1.2.3");
  });

  test.each(["", "   "])("a blank BUILD_VERSION (%p) counts as unset and falls back to a non-empty version", async (blank) => {
    process.env.BUILD_VERSION = blank;
    const version = await versionWith();
    expect(version.trim()).not.toBe("");
    expect(version).not.toBe(blank);
  });

  test("with BUILD_VERSION unset the version falls back to a non-empty string", async () => {
    delete process.env.BUILD_VERSION;
    const version = await versionWith();
    expect(typeof version).toBe("string");
    expect(version.trim()).not.toBe("");
  });
});

describe("runBootHooks", () => {
  const deps = (): AppDeps => ({ db: openDatabase(":memory:"), version: "test" });

  test("returns the hook file names in the order they ran", async () => {
    writeHook("b.boot.ts", recordingHook("b"));
    writeHook("a.boot.ts", recordingHook("a"));

    expect(await runBootHooks(deps(), bootDir)).toEqual(["a.boot.ts", "b.boot.ts"]);
  });

  test("a missing dir returns an empty list", async () => {
    expect(await runBootHooks(deps(), join(root, "does-not-exist"))).toEqual([]);
  });

  test("the default boot directory is apps/api/src/boot, resolved from the module", () => {
    expect(DEFAULT_BOOT_DIR).toBe(resolve(import.meta.dir, "boot"));
    expect(DEFAULT_BOOT_DIR.endsWith("/src/boot")).toBe(true);
  });

  test("without a dir argument, every *.boot.ts present in src/boot is run", async () => {
    // Positive, open-world check: later beads add hooks there, so only assert
    // that whatever is on disk is discovered (vacuous when the dir is absent;
    // the test above pins where the default directory points).
    let onDisk: string[] = [];
    try {
      onDisk = readdirSync(resolve(import.meta.dir, "boot")).filter((f) => f.endsWith(".boot.ts"));
    } catch {
      // no src/boot yet
    }

    const ran = await runBootHooks(deps());

    for (const file of onDisk) expect(ran).toContain(file);
  });
});

describe("parsePort (index.ts is import-safe: importing it opens no port)", () => {
  test("defaults to 4111 when PORT is unset or empty", async () => {
    const { parsePort } = await import("./index");
    expect(parsePort(undefined)).toBe(4111);
    expect(parsePort("")).toBe(4111);
  });

  test("accepts numeric ports in range", async () => {
    const { parsePort } = await import("./index");
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  test("the error for a non-numeric PORT quotes the value", async () => {
    const { parsePort } = await import("./index");
    expect(() => parsePort("abc")).toThrow('PORT must be an integer between 1 and 65535, got "abc"');
  });

  test.each(["12.5", "-1", "0", "65536", "70000", "80 ", "0x50", "1e3"])(
    "rejects PORT=%p with a message naming PORT",
    async (raw) => {
      const { parsePort } = await import("./index");
      expect(() => parsePort(raw)).toThrow(/^PORT must be an integer between 1 and 65535/);
    },
  );
});

describe("index.ts as a process", () => {
  const INDEX = join(import.meta.dir, "index.ts");
  const READY_DEADLINE_MS = 10_000;

  /** Only what the boot needs: nothing ambient (BUILD_VERSION, PORT, APP_DB_PATH...) leaks in. */
  const childEnv = (extra: Record<string, string>): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? root,
    ...extra,
  });

  const freePort = (): number => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = server.port as number;
    void server.stop(true);
    return port;
  };

  const spawn = (env: Record<string, string>) =>
    Bun.spawn([process.execPath, INDEX], { cwd: root, env: childEnv(env), stdout: "pipe", stderr: "pipe" });

  test(
    "serves problem+json 404s on PORT and exits 0 on SIGTERM",
    async () => {
      const port = freePort();
      const proc = spawn({ PORT: String(port), APP_DB_PATH: join(root, "proc.db") });
      try {
        let res: Response | undefined;
        const deadline = Date.now() + READY_DEADLINE_MS;
        while (!res && Date.now() < deadline) {
          if (proc.exitCode !== null) {
            throw new Error(`index.ts exited early (${proc.exitCode}): ${await new Response(proc.stderr).text()}`);
          }
          res = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`).catch(() => undefined);
          if (!res) await Bun.sleep(50);
        }
        if (!res) throw new Error(`index.ts did not start listening on ${port} within ${READY_DEADLINE_MS} ms`);

        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);

        proc.kill("SIGTERM");
        expect(await proc.exited).toBe(0);
      } finally {
        proc.kill("SIGKILL");
      }
    },
    15_000,
  );

  test(
    "an invalid PORT logs a fatal 'boot failed' line and exits 1",
    async () => {
      const proc = spawn({ PORT: "abc", APP_DB_PATH: join(root, "proc.db") });
      try {
        const [code, out, err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        expect(code).toBe(1);
        expect(out + err).toContain('"boot failed"');
        expect(out + err).toContain("PORT must be an integer");
      } finally {
        proc.kill("SIGKILL");
      }
    },
    15_000,
  );
});
