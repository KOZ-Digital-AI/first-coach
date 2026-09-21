import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const pkgPath = join(import.meta.dir, "..", "package.json");
const lockPath = join(import.meta.dir, "..", "..", "..", "bun.lock");

const pkg = JSON.parse(await Bun.file(pkgPath).text());

const dependencyNames = [
  "hono",
  "zod",
  "better-auth",
  "@mastra/core",
  "@mastra/memory",
  "@mastra/libsql",
  "@mastra/loggers",
  "ai",
  "@ai-sdk/openai",
  "croner",
  "nanoid",
];

const devDependencyNames = ["ajv", "ajv-formats", "@types/bun"];

const sqliteDrivers = ["better-sqlite3", "sqlite3", "bun-sqlite", "node-sqlite3"];

describe("apps/api/package.json dependencies", () => {
  test.each(dependencyNames)("declares %s in dependencies", (name) => {
    expect(pkg.dependencies).toHaveProperty([name]);
  });

  test.each(devDependencyNames)("declares %s in devDependencies", (name) => {
    expect(pkg.devDependencies).toHaveProperty([name]);
  });

  test.each(sqliteDrivers)("does not declare sqlite driver %s (bun:sqlite is built in)", (name) => {
    expect(pkg.dependencies ?? {}).not.toHaveProperty([name]);
    expect(pkg.devDependencies ?? {}).not.toHaveProperty([name]);
  });
});

describe("apps/api/package.json scripts", () => {
  test("dev runs bun --watch src/index.ts", () => {
    expect(pkg.scripts.dev).toMatch(/\bbun --watch src\/index\.ts$/);
  });

  test("typecheck runs tsc --noEmit", () => {
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
  });

  test("test runs bun test", () => {
    expect(pkg.scripts.test).toBe("bun test");
  });
});

describe("root bun.lock", () => {
  test("exists as a text file recording the api workspace and hono", async () => {
    const file = Bun.file(lockPath);
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    expect(text).toContain("@first-coach/api");
    expect(text).toContain("hono");
  });
});
