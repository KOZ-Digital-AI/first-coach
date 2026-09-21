import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const webDir = join(import.meta.dir, "..");
const rootDir = join(webDir, "..", "..");
const pkgPath = join(webDir, "package.json");
const lockPath = join(rootDir, "bun.lock");

const pkg = JSON.parse(await Bun.file(pkgPath).text());

const dependencyNames = [
  "react",
  "react-dom",
  "@tanstack/react-router",
  "@tanstack/react-query",
  "@tanstack/react-query-persist-client",
  "idb-keyval",
  "better-auth",
  "zod",
  "i18next",
  "react-i18next",
  "i18next-browser-languagedetector",
  "sonner",
  "lucide-react",
  "clsx",
  "tailwind-merge",
  "class-variance-authority",
  "@radix-ui/react-dialog",
  "nanoid",
  "@fontsource-variable/inter",
  "workbox-window",
  "@mediapipe/tasks-vision",
];

const devDependencyNames = [
  "vite",
  "@vitejs/plugin-react",
  "@tanstack/router-plugin",
  "@tanstack/router-cli",
  "tailwindcss",
  "@tailwindcss/vite",
  "vite-plugin-pwa",
  "happy-dom",
  "@happy-dom/global-registrator",
  "@testing-library/react",
  "@testing-library/user-event",
  "@types/react",
  "@types/react-dom",
];

const typecheckGuard = "(test ! -f src/routes/__root.tsx || tsr generate) && tsc --noEmit";

describe("apps/web/package.json dependencies", () => {
  test("is a private workspace package named @first-coach/web", () => {
    expect(pkg.name).toBe("@first-coach/web");
    expect(pkg.private).toBe(true);
  });

  test.each(dependencyNames)("declares %s in dependencies", (name) => {
    expect(pkg.dependencies).toHaveProperty([name]);
  });

  test.each(devDependencyNames)("declares %s in devDependencies", (name) => {
    expect(pkg.devDependencies).toHaveProperty([name]);
  });
});

describe("apps/web/package.json scripts", () => {
  test.each(["dev", "build", "typecheck", "test"])("defines the %s script", (name) => {
    expect(typeof pkg.scripts[name]).toBe("string");
    expect(pkg.scripts[name].length).toBeGreaterThan(0);
  });

  test("typecheck is the exact route-tree guard followed by tsc --noEmit", () => {
    expect(pkg.scripts.typecheck).toBe(typecheckGuard);
  });

  test("typecheck generates the route tree before running tsc", () => {
    const script: string = pkg.scripts.typecheck;
    expect(script).toContain("tsr generate");
    expect(script.indexOf("tsr generate")).toBeLessThan(script.indexOf("tsc --noEmit"));
  });
});

describe("root bun.lock", () => {
  test("exists and records the web workspace", async () => {
    const file = Bun.file(lockPath);
    expect(await file.exists()).toBe(true);
    expect(await file.text()).toContain("@first-coach/web");
  });
});

// Behavioural check of the typecheck script: a string comparison alone can be
// satisfied by a script that never actually generates the tree or checks types.
describe("apps/web typecheck script behaviour", () => {
  const fixtures: string[] = [];
  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  });

  const binPath = [join(webDir, "node_modules", ".bin"), join(rootDir, "node_modules", ".bin")];
  // Whichever node_modules holds the router package is where the fixture
  // resolves its imports from (bun may hoist to the root or keep it per-app).
  const modulesDir = [join(webDir, "node_modules"), join(rootDir, "node_modules")].find((dir) =>
    existsSync(join(dir, "@tanstack", "react-router")),
  );

  function makeFixture(withRootRoute: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "web-typecheck-"));
    fixtures.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: [],
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src/**/*.ts", "src/**/*.tsx"],
      }),
    );
    if (modulesDir) symlinkSync(modulesDir, join(dir, "node_modules"), "dir");
    if (withRootRoute) {
      mkdirSync(join(dir, "src", "routes"), { recursive: true });
      writeFileSync(
        join(dir, "src", "routes", "__root.tsx"),
        [
          "import { createRootRoute, Outlet } from '@tanstack/react-router';",
          "export const Route = createRootRoute({ component: Outlet });",
          "",
        ].join("\n"),
      );
    } else {
      writeFileSync(join(dir, "src", "ok.ts"), "export const ok: number = 1;\n");
    }
    return dir;
  }

  function runTypecheck(cwd: string): { code: number; output: string } {
    const result = Bun.spawnSync(["sh", "-c", pkg.scripts.typecheck], {
      cwd,
      env: { ...process.env, PATH: [...binPath, process.env.PATH ?? ""].join(delimiter) },
    });
    return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
  }

  // Encode the output in the compared value so a failure shows why.
  const exitCodeWithOutput = (r: { code: number; output: string }) => `exit ${r.code}\n${r.output}`;

  test("generates src/routeTree.gen.ts and exits 0 when src/routes/__root.tsx exists", () => {
    const dir = makeFixture(true);
    const result = runTypecheck(dir);
    expect(exitCodeWithOutput(result)).toStartWith("exit 0\n");
    expect(existsSync(join(dir, "src", "routeTree.gen.ts"))).toBe(true);
  }, 60_000);

  test("exits non-zero once a type error is injected", () => {
    const dir = makeFixture(true);
    expect(exitCodeWithOutput(runTypecheck(dir))).toStartWith("exit 0\n");

    writeFileSync(join(dir, "src", "bad.ts"), "export const x: number = 'a';\n");
    const result = runTypecheck(dir);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("bad.ts");
  }, 60_000);

  test("skips route-tree generation and still exits 0 when src/routes/__root.tsx is absent", () => {
    const dir = makeFixture(false);
    const result = runTypecheck(dir);
    expect(exitCodeWithOutput(result)).toStartWith("exit 0\n");
    expect(existsSync(join(dir, "src", "routeTree.gen.ts"))).toBe(false);
  }, 60_000);
});
