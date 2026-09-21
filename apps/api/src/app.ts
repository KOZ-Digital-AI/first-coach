// App factory: builds the Hono app, auto-mounts route modules and installs the
// problem+json 404/500 handlers.
//
// Route modules live in ./http/routes/ and are named `<name>.routes.ts`. Each
// exports `register(app, deps)`; later beads add routes by dropping a file
// there, never by editing this one.
//
// Conventions for route-module authors:
// - Modules are mounted in ALPHABETICAL file order (plain code-unit comparison,
//   so the order is identical on every machine).
// - A module that must run before the others (request-id, rate limiting, body
//   limits, ...) is named with a `00-` prefix, e.g. `00-request-id.routes.ts`,
//   and calls `app.use(...)` inside register().
// - Headers set by middleware are NOT present on the app-level notFound/onError
//   responses: Hono returns those handlers' own Response, so a later CORS or
//   request-id bead must account for that (e.g. set headers inside the handlers).
// - A discovery failure (import error, syntax error, missing `register`, a
//   rejecting register) aborts startup with an error that names the file.
// - Mounts that must come after every discovered route (e.g. the static SPA
//   `app.use("*", serveWeb(...))`) go at the SEAM marker in createApp().
import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { STATUS_CODES } from "node:http";
import { resolve } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { problem } from "./http/problem";
import { resolveWebDist, serveWeb } from "./http/static";

/** Everything route modules may need; later beads add fields. */
export type AppDeps = { db: Database; version: string };

/** `webDist`: the built web app to serve; defaults to `resolveWebDist()` (WEB_DIST or apps/web/dist). */
export type AppOptions = { webDist?: string };

export type RouteModule = {
  register(app: Hono, deps: AppDeps): void | Promise<void>;
};

const DEFAULT_ROUTES_DIR = resolve(import.meta.dir, "http/routes");

const messageOf = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown } | null)?.message === "string"
      ? (error as { message: string }).message
      : String(error);

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/**
 * Imports every `*.routes.ts` in `dir` (alphabetical, code-unit order) and calls
 * its `register(app, deps)`. A missing or empty directory is a no-op. Returns
 * the mounted file names in mounting order.
 */
export async function mountRoutes(
  app: Hono,
  deps: AppDeps,
  dir: string = DEFAULT_ROUTES_DIR,
): Promise<string[]> {
  if (!isDirectory(dir)) return [];

  const files = [...new Bun.Glob("*.routes.ts").scanSync({ cwd: dir, onlyFiles: true })].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

  for (const file of files) {
    let mod: Partial<RouteModule>;
    try {
      mod = (await import(resolve(dir, file))) as Partial<RouteModule>;
    } catch (cause) {
      throw new Error(`Route module ${file} failed to load: ${messageOf(cause)}`, { cause });
    }
    if (typeof mod.register !== "function") {
      throw new Error(`Route module ${file} must export a register(app, deps) function`);
    }
    try {
      await mod.register(app, deps);
    } catch (cause) {
      throw new Error(`Route module ${file} failed to load: ${messageOf(cause)}`, { cause });
    }
  }
  return files;
}

export async function createApp(
  deps: AppDeps,
  routesDir?: string,
  options: AppOptions = {},
): Promise<Hono> {
  const app = new Hono();

  await mountRoutes(app, deps, routesDir);

  // Unknown /api paths must 404 here so the static SPA mount below cannot
  // answer them with HTML.
  app.all("/api/*", (c) => c.notFound());

  // --- SEAM: mounts that must come after every discovered route go here ---
  app.use("*", serveWeb(options.webDist ?? resolveWebDist()));

  app.notFound((c) => problem(404, "Not Found", `No route matches ${c.req.method} ${c.req.path}`));

  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status < 500) {
      // A custom response (e.g. a WWW-Authenticate challenge) is returned untouched.
      if (err.res) return err.res;
      return problem(err.status, STATUS_CODES[err.status] ?? "Error", err.message);
    }
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unhandled error",
        path: c.req.path,
        method: c.req.method,
        error: messageOf(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    return problem(500, "Internal Server Error", "An unexpected error occurred.");
  });

  return app;
}
