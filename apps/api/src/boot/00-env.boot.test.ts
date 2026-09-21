import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppDeps } from "../app";
import { DEFAULT_BOOT_DIR, runBootHooks } from "../boot";
import { openDatabase } from "../db/database";
import { onBoot } from "./00-env.boot";

const HOOK_FILE = "00-env.boot.ts";
const HOOK_PATH = resolve(DEFAULT_BOOT_DIR, HOOK_FILE);

/** Short on purpose: too short for production, so it is rejected while being a value that must never leak. */
const SECRET_MARKER = "s3cr3t-marker-9f2c";
const VALID_SECRET = "0123456789abcdef0123456789abcdef-valid";
const VALID_PRODUCTION = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: VALID_SECRET,
  BETTER_AUTH_URL: "https://coach.example.test",
};

let deps: AppDeps;
beforeEach(() => {
  deps = { db: openDatabase(":memory:"), version: "test" };
});
afterEach(() => {
  deps.db.close();
});

/** Runs the hook as the runner would (sync throws become rejections) and returns the failure, if any. */
const failureOf = async (env: Record<string, string | undefined>): Promise<unknown> =>
  (async () => onBoot(deps, env))().then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with a nullish value"),
  );

/** Everything a log line or crash report could render from an error. */
const renderings = (error: unknown): string[] => {
  const out = [String(error), JSON.stringify(error)];
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    out.push(e.message, e.stack ?? "", e.name);
  }
  return out;
};

describe("00-env.boot onBoot with an injected env", () => {
  test("production without BETTER_AUTH_SECRET rejects, naming the variable", async () => {
    const failure = await failureOf({ NODE_ENV: "production", BETTER_AUTH_URL: "https://coach.example.test" });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("BETTER_AUTH_SECRET");
  });

  test("a rejected secret value never appears in the rejection", async () => {
    const failure = await failureOf({ ...VALID_PRODUCTION, BETTER_AUTH_SECRET: SECRET_MARKER });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("BETTER_AUTH_SECRET");
    for (const text of renderings(failure)) expect(text).not.toContain(SECRET_MARKER);
  });

  test("a bad non-secret value is not echoed either", async () => {
    const failure = await failureOf({ ...VALID_PRODUCTION, PORT: `port-${SECRET_MARKER}` });

    expect((failure as Error).message).toContain("PORT");
    for (const text of renderings(failure)) expect(text).not.toContain(SECRET_MARKER);
  });

  test("a valid production env lets boot continue", async () => {
    expect(await failureOf(VALID_PRODUCTION)).toBeUndefined();
  });

  test("a development env with nothing set lets boot continue", async () => {
    expect(await failureOf({})).toBeUndefined();
  });
});

describe("00-env.boot orders first", () => {
  test("its name sorts before 10- and 40- style hooks by plain string comparison", () => {
    expect(HOOK_FILE < "10-migrations.boot.ts").toBe(true);
    expect(HOOK_FILE < "40-seed.boot.ts").toBe(true);
    expect(HOOK_FILE < "auth.boot.ts").toBe(true);
  });

  test("it lives in the default boot dir and sorts first among the hooks there", async () => {
    expect(await Bun.file(HOOK_PATH).exists()).toBe(true);
    const hooks = readdirSync(DEFAULT_BOOT_DIR)
      .filter((f) => f.endsWith(".boot.ts"))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(hooks[0]).toBe(HOOK_FILE);
  });
});

describe("00-env.boot through the real boot runner", () => {
  // The hook reads process.env at call time; these are the only variables the cases touch.
  const TOUCHED = ["NODE_ENV", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "PORT"] as const;
  const shared = globalThis as unknown as { __bootLog?: string[] };
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
    // Temp hooks cannot resolve relative imports, so this one re-exports the real hook by absolute path.
    // A later hook records that it ran, to show whether boot continued past the env hook.
    dir = mkdtempSync(join(tmpdir(), "env-boot-"));
    writeFileSync(join(dir, HOOK_FILE), `export { onBoot } from ${JSON.stringify(HOOK_PATH)};\n`);
    writeFileSync(
      join(dir, "10-after.boot.ts"),
      `export function onBoot() { globalThis.__bootLog.push("10-after"); }\n`,
    );
    shared.__bootLog = [];
  });

  afterEach(() => {
    for (const name of TOUCHED) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    delete shared.__bootLog;
  });

  const setEnv = (env: Record<string, string | undefined>): void => {
    for (const name of TOUCHED) delete process.env[name];
    for (const [name, value] of Object.entries(env)) if (value !== undefined) process.env[name] = value;
  };

  test("a missing required secret aborts start with a wrapped error naming the variable; later hooks never run", async () => {
    setEnv({ NODE_ENV: "production", BETTER_AUTH_URL: "https://coach.example.test" });

    const failure = await runBootHooks(deps, dir).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain(`Boot hook ${HOOK_FILE} failed`);
    expect(failure?.message).toContain("BETTER_AUTH_SECRET");
    expect(shared.__bootLog).toEqual([]);
  });

  test("a rejected secret never appears in the wrapped error", async () => {
    setEnv({ ...VALID_PRODUCTION, BETTER_AUTH_SECRET: SECRET_MARKER });

    const failure = await runBootHooks(deps, dir).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("BETTER_AUTH_SECRET");
    for (const text of renderings(failure)) expect(text).not.toContain(SECRET_MARKER);
  });

  test("a valid env runs the env hook first and lets the next hook run", async () => {
    setEnv(VALID_PRODUCTION);

    expect(await runBootHooks(deps, dir)).toEqual([HOOK_FILE, "10-after.boot.ts"]);
    expect(shared.__bootLog).toEqual(["10-after"]);
  });
});
