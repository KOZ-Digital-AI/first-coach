import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from "./shared/primitives";
import { createApp, mountRoutes, type AppDeps } from "./app";

// Temp route modules cannot resolve bare specifiers from os.tmpdir(), so they
// import hono's HTTPException by absolute URL (keeps `instanceof` intact) and
// report ordering through a shared array on globalThis.
const HTTP_EXCEPTION_URL = import.meta.resolve("hono/http-exception");
const shared = globalThis as unknown as { __routeOrder?: string[] };

/** One place to touch when AppDeps gains fields. */
function deps(): AppDeps {
  return { db: new Database(":memory:"), version: "test" };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "routes-"));
  shared.__routeOrder = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete shared.__routeOrder;
});

function writeRoute(name: string, source: string): void {
  writeFileSync(join(dir, name), source);
}

/** A route module whose register() records its own name into the shared order. */
function recordingModule(name: string): string {
  return `export function register() { globalThis.__routeOrder.push(${JSON.stringify(name)}); }\n`;
}

async function readProblem(res: Response): Promise<ProblemDetails> {
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  return ProblemDetails.parse(await res.json());
}

describe("not found handling", () => {
  test("an unknown /api path returns a 404 problem+json", async () => {
    const app = await createApp(deps(), dir);
    const res = await app.request("/api/does-not-exist");

    expect(res.status).toBe(404);
    const body = await readProblem(res);
    expect(body.status).toBe(404);
    expect(body.title).toBe("Not Found");
  });

  test("an unknown non-/api path returns a 404 problem+json", async () => {
    const app = await createApp(deps(), dir);
    const res = await app.request("/somewhere/else");

    expect(res.status).toBe(404);
    expect((await readProblem(res)).title).toBe("Not Found");
  });

  test("/api, /api/ and nested /api paths are all 404 problems", async () => {
    const app = await createApp(deps(), dir);
    for (const path of ["/api", "/api/", "/api/a/b"]) {
      const res = await app.request(path, { method: "POST" });
      expect(res.status).toBe(404);
      expect((await readProblem(res)).status).toBe(404);
    }
  });

  test("a catch-all mounted after createApp never serves an unknown /api path", async () => {
    const app = await createApp(deps(), dir);
    app.get("*", (c) => c.html("<html>spa</html>"));

    const apiRes = await app.request("/api/nope");
    expect(apiRes.status).toBe(404);
    expect((await readProblem(apiRes)).status).toBe(404);
    expect((await app.request("/api/a/b")).status).toBe(404);

    // Lookalikes are not /api paths, so the catch-all is allowed to serve them.
    for (const path of ["/dashboard", "/apix", "/API/x"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("spa");
    }
  });
});

describe("error handling", () => {
  test("a throwing route yields a 500 problem+json without stack or original message", async () => {
    writeRoute(
      "boom.routes.ts",
      `export function register(app) {
         app.get("/api/boom", () => { throw new Error("secret-db-password-xyz"); });
       }\n`,
    );
    const app = await createApp(deps(), dir);
    const res = await app.request("/api/boom");

    expect(res.status).toBe(500);
    const body = await readProblem(res);
    expect(body.status).toBe(500);
    expect(body.title).toBe("Internal Server Error");

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret-db-password-xyz");
    expect(raw).not.toContain("stack");
    expect(raw).not.toMatch(/\bat .*(\.ts|\.js|<anonymous>)/);
  });

  test("an unhandled error is logged server-side as one JSON line with the stack", async () => {
    writeRoute(
      "boom.routes.ts",
      `export function register(app) {
         app.get("/api/boom", () => { throw new Error("secret-db-password-xyz"); });
       }\n`,
    );
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = await createApp(deps(), dir);
      await app.request("/api/boom");

      expect(spy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
      expect(line.level).toBe("error");
      expect(line.msg).toBe("unhandled error");
      expect(line.path).toBe("/api/boom");
      expect(line.method).toBe("GET");
      expect(line.error).toBe("secret-db-password-xyz");
      expect(typeof line.stack).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });

  test("an HTTPException below 500 keeps its status as a problem+json", async () => {
    writeRoute(
      "auth.routes.ts",
      `import { HTTPException } from ${JSON.stringify(HTTP_EXCEPTION_URL)};
       export function register(app) {
         app.get("/api/secret", () => { throw new HTTPException(401, { message: "token required" }); });
       }\n`,
    );
    const app = await createApp(deps(), dir);
    const res = await app.request("/api/secret");

    expect(res.status).toBe(401);
    const body = await readProblem(res);
    expect(body.status).toBe(401);
    expect(body.title).toBe("Unauthorized");
    expect(body.detail).toBe("token required");
  });

  test("an HTTPException carrying a custom response returns that response untouched", async () => {
    writeRoute(
      "auth.routes.ts",
      `import { HTTPException } from ${JSON.stringify(HTTP_EXCEPTION_URL)};
       export function register(app) {
         app.get("/api/secret", () => {
           const res = new Response("custom-body", { status: 401, headers: { "www-authenticate": "Bearer" } });
           throw new HTTPException(401, { res });
         });
       }\n`,
    );
    const app = await createApp(deps(), dir);
    const res = await app.request("/api/secret");

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.text()).toBe("custom-body");
  });

  test("a 5xx HTTPException is masked as a generic 500 problem", async () => {
    writeRoute(
      "down.routes.ts",
      `import { HTTPException } from ${JSON.stringify(HTTP_EXCEPTION_URL)};
       export function register(app) {
         app.get("/api/down", () => { throw new HTTPException(503, { message: "db host internal-7 unreachable" }); });
       }\n`,
    );
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = await createApp(deps(), dir);
      const res = await app.request("/api/down");

      expect(res.status).toBe(500);
      const body = await readProblem(res);
      expect(body.title).toBe("Internal Server Error");
      expect(JSON.stringify(body)).not.toContain("internal-7");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("route discovery", () => {
  test("every *.routes.ts file is discovered and mounted in alphabetical order", async () => {
    writeRoute("zeta.routes.ts", recordingModule("zeta.routes.ts"));
    writeRoute("alpha.routes.ts", recordingModule("alpha.routes.ts"));
    writeRoute("mid.routes.ts", recordingModule("mid.routes.ts"));

    await createApp(deps(), dir);

    expect(shared.__routeOrder).toEqual(["alpha.routes.ts", "mid.routes.ts", "zeta.routes.ts"]);
  });

  test("a discovered module's routes are served and receive deps", async () => {
    writeRoute(
      "hello.routes.ts",
      `export function register(app, deps) {
         app.get("/api/hello", (c) => c.json({ version: deps.version }));
       }\n`,
    );
    const app = await createApp(deps(), dir);
    const res = await app.request("/api/hello");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "test" });
  });

  test("mountRoutes returns the mounted file names in mounting order", async () => {
    writeRoute("b.routes.ts", recordingModule("b.routes.ts"));
    writeRoute("a.routes.ts", recordingModule("a.routes.ts"));

    const mounted = await mountRoutes(new Hono(), deps(), dir);

    expect(mounted).toEqual(["a.routes.ts", "b.routes.ts"]);
  });

  test("ordering is by plain code-unit comparison, not locale", async () => {
    for (const name of ["a.routes.ts", "B.routes.ts", "00-first.routes.ts"]) {
      writeRoute(name, recordingModule(name));
    }

    const mounted = await mountRoutes(new Hono(), deps(), dir);

    // Locale-aware collation would put a.routes.ts before B.routes.ts.
    expect(mounted).toEqual(["00-first.routes.ts", "B.routes.ts", "a.routes.ts"]);
  });

  test("*.routes.test.ts files and other files are ignored", async () => {
    writeRoute("real.routes.ts", recordingModule("real.routes.ts"));
    writeRoute("real.routes.test.ts", recordingModule("real.routes.test.ts"));
    writeRoute("helper.ts", recordingModule("helper.ts"));

    const mounted = await mountRoutes(new Hono(), deps(), dir);

    expect(mounted).toEqual(["real.routes.ts"]);
    expect(shared.__routeOrder).toEqual(["real.routes.ts"]);
  });

  test("a 00- prefixed middleware module runs before later route modules", async () => {
    writeRoute(
      "00-mw.routes.ts",
      `export function register(app) {
         app.use("*", async (c, next) => { c.header("x-mw", "ran"); await next(); });
       }\n`,
    );
    writeRoute(
      "zz.routes.ts",
      `export function register(app) {
         app.get("/api/late", (c) => c.json({ ok: true }));
       }\n`,
    );
    const app = await createApp(deps(), dir);
    const res = await app.request("/api/late");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-mw")).toBe("ran");
  });

  test("a missing routes directory is a clean no-op", async () => {
    const missing = join(dir, "does-not-exist");

    expect(await mountRoutes(new Hono(), deps(), missing)).toEqual([]);

    const app = await createApp(deps(), missing);
    expect((await app.request("/api/x")).status).toBe(404);
  });

  test("an empty routes directory is a clean no-op", async () => {
    expect(await mountRoutes(new Hono(), deps(), dir)).toEqual([]);

    const app = await createApp(deps(), dir);
    const res = await app.request("/api/x");
    expect(res.status).toBe(404);
    expect((await readProblem(res)).status).toBe(404);
  });
});

describe("route discovery failures name the file", () => {
  test("a module without a register export is rejected", async () => {
    writeRoute("noregister.routes.ts", `export const nothing = 1;\n`);

    await expect(createApp(deps(), dir)).rejects.toThrow(/noregister\.routes\.ts/);
    await expect(createApp(deps(), dir)).rejects.toThrow(/register\(app, deps\)/);
  });

  test("a module that throws at import time is rejected", async () => {
    writeRoute("explodes.routes.ts", `throw new Error("import-time kaboom");\nexport function register() {}\n`);

    const error = await createApp(deps(), dir).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("explodes.routes.ts");
    expect(error?.message).toContain("import-time kaboom");
  });

  test("a rejecting async register is rejected", async () => {
    writeRoute(
      "asyncfail.routes.ts",
      `export async function register() { throw new Error("async register failed"); }\n`,
    );

    const error = await createApp(deps(), dir).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("asyncfail.routes.ts");
    expect(error?.message).toContain("async register failed");
  });

  test("a module with a syntax error is rejected", async () => {
    writeRoute("broken.routes.ts", `export function register( {{{\n`);

    const error = await createApp(deps(), dir).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("broken.routes.ts");
  });
});
