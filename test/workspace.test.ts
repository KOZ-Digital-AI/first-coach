import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const readJson = async (name: string) => JSON.parse(await Bun.file(join(root, name)).text());
const tempDirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-workspace-"));
  tempDirs.push(dir);
  return dir;
};
const run = (cmd: string[], cwd: string) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("root package.json", () => {
  test("is a private workspace over apps/*", async () => {
    const pkg = await readJson("package.json");
    expect(pkg.private).toBe(true);
    expect(pkg.workspaces).toContain("apps/*");
  });

  test("dev/build/typecheck/test fan out via bun --filter", async () => {
    const { scripts } = await readJson("package.json");
    for (const name of ["dev", "build", "typecheck", "test"]) {
      expect(scripts[name]).toBe(`bun --filter '*' ${name}`);
    }
  });

  test("declares typescript ^5 and @types/bun", async () => {
    const { devDependencies } = await readJson("package.json");
    expect(devDependencies.typescript.startsWith("^5")).toBe(true);
    expect(devDependencies["@types/bun"]).toBeDefined();
  });

  test("has a committed bun.lock", () => {
    expect(existsSync(join(root, "bun.lock"))).toBe(true);
  });
});

test("tsconfig.base.json is strict", async () => {
  const tsconfig = await readJson("tsconfig.base.json");
  expect(tsconfig.compilerOptions.strict).toBe(true);
});

describe(".gitignore", () => {
  const gitignore = join(root, ".gitignore");

  test("keeps the bd/Dolt block", async () => {
    const lines = (await Bun.file(gitignore).text()).split("\n");
    expect(lines).toContain(".dolt/");
    expect(lines).toContain(".beads/proxieddb/");
  });

  test("ignores build/runtime artifacts but not .env.example", () => {
    const dir = tempDir();
    expect(run(["git", "init", "-q"], dir).exitCode).toBe(0);
    copyFileSync(gitignore, join(dir, ".gitignore"));
    const ignored = (path: string) => run(["git", "check-ignore", "-q", path], dir).exitCode === 0;
    for (const path of ["node_modules/x", "dist/x", "coverage/x", "data/x", "apps/web/src/routeTree.gen.ts", ".env"]) {
      expect(ignored(path)).toBe(true);
    }
    expect(ignored(".env.example")).toBe(false);
  });
});

test("script fan-out exits 0 when a workspace app provides all four scripts", () => {
  const dir = tempDir();
  for (const file of ["package.json", "tsconfig.base.json"]) copyFileSync(join(root, file), join(dir, file));
  mkdirSync(join(dir, "apps/stub"), { recursive: true });
  const scripts = Object.fromEntries(["dev", "build", "typecheck", "test"].map((s) => [s, `echo ${s}`]));
  writeFileSync(join(dir, "apps/stub/package.json"), JSON.stringify({ name: "stub", private: true, scripts }));
  for (const script of ["dev", "build", "typecheck", "test"]) {
    expect(run(["bun", "run", script], dir).exitCode).toBe(0);
  }
});
