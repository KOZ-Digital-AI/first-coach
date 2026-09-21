import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveAuthConfig } from "../apps/api/src/auth/better-auth";

const apiDir = join(import.meta.dir, "..", "apps", "api");
const readScripts = async (): Promise<Record<string, string>> => {
  const pkg = JSON.parse(await Bun.file(join(apiDir, "package.json")).text());
  return pkg.scripts;
};

describe("apps/api dev script", () => {
  test("sets NODE_ENV=development so Better Auth uses its dev fallbacks", async () => {
    const { dev } = await readScripts();
    expect(dev).toMatch(/\bNODE_ENV=development\b/);
  });

  test("still runs src/index.ts with --watch", async () => {
    const { dev } = await readScripts();
    expect(dev).toMatch(/\bbun\b.*--watch\b/);
    expect(dev).toMatch(/\bsrc\/index\.ts\b/);
  });

  test("does not set NODE_ENV to anything but development", async () => {
    const { dev } = await readScripts();
    const assigned = [...dev.matchAll(/\bNODE_ENV=(\S*)/g)].map((m) => m[1]);
    expect(assigned).toEqual(["development"]);
  });
});

describe("apps/api other scripts stay fail-closed", () => {
  test("typecheck and test do not set NODE_ENV (bun test sets test itself)", async () => {
    const scripts = await readScripts();
    expect(scripts.typecheck).toBeDefined();
    expect(scripts.test).toBeDefined();
    expect(scripts.typecheck).not.toMatch(/NODE_ENV/);
    expect(scripts.test).not.toMatch(/NODE_ENV/);
  });

  test("no script other than dev mentions NODE_ENV", async () => {
    const scripts = await readScripts();
    for (const [name, command] of Object.entries(scripts)) {
      if (name === "dev") continue;
      expect({ name, mentionsNodeEnv: /NODE_ENV/.test(command) }).toEqual({ name, mentionsNodeEnv: false });
    }
  });

  test("no script sets NODE_ENV=production", async () => {
    const scripts = await readScripts();
    for (const [name, command] of Object.entries(scripts)) {
      expect({ name, setsProduction: /\bNODE_ENV=production\b/.test(command) }).toEqual({ name, setsProduction: false });
    }
  });
});

describe("auth config pairing (why the dev script needs NODE_ENV=development)", () => {
  test("NODE_ENV=development without a secret resolves with dev fallbacks", () => {
    const db = new Database(":memory:");
    const config = resolveAuthConfig(db, { NODE_ENV: "development" });
    expect(config.production).toBe(false);
    expect(config.baseURL).toBe("http://localhost:4111");
    db.close();
  });

  test("NODE_ENV unset without a secret throws, naming BETTER_AUTH_SECRET", () => {
    const db = new Database(":memory:");
    expect(() => resolveAuthConfig(db, {})).toThrow(/BETTER_AUTH_SECRET/);
    db.close();
  });
});
