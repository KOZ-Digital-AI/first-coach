import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { PROBLEM_CONTENT_TYPE, ProblemDetails } from "../shared/primitives";
import { problem } from "./problem";
import { resolveWebDist, serveWeb } from "./static";

// serveWeb is exercised on a BARE Hono app (never createApp): a few stand-in routes
// registered BEFORE the middleware (as the real app mounts it after every route),
// and the repo's problem+json 404 as the app-level notFound.

const SPA_SHELL = "<!doctype html><title>SPA-SHELL</title><div id=root></div>";
const SECRET = "TOP-SECRET-must-never-be-served";
const EVIL_LOOT = "LOOT-in-a-sibling-directory-whose-name-starts-with-dist";
const HASHED_JS = "console.log('hashed');";
const SW_JS = "self.skipWaiting();";
const IMMUTABLE = "public, max-age=31536000, immutable";
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

let base: string; // holds the dist dir, a secret file beside it, and a sibling `dist-evil`
let dist: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "static-"));
  dist = join(base, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  mkdirSync(join(base, "dist-evil"));
  writeFileSync(join(base, "secret.txt"), SECRET);
  writeFileSync(join(base, "dist-evil", "loot.txt"), EVIL_LOOT);
  writeFileSync(join(dist, "index.html"), SPA_SHELL);
  writeFileSync(join(dist, "sw.js"), SW_JS);
  writeFileSync(join(dist, "manifest.webmanifest"), '{"name":"First Coach"}');
  writeFileSync(join(dist, "workbox-1a2b3c4d.js"), "self.workbox = {};");
  writeFileSync(join(dist, "assets-x.js"), "console.log('root file, not a hashed asset');");
  writeFileSync(join(dist, "assets/app-Abc12345.js"), HASHED_JS);
  writeFileSync(join(dist, "assets/style-Def67890.css"), "body{margin:0}");
  writeFileSync(join(dist, "assets/logo-Ghi13579.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dist, "assets/font-Jkl24680.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0x80, 0x0a]));
  writeFileSync(join(dist, "assets/data-Mno11223.json"), "{}");
  writeFileSync(join(dist, "assets/utf8-Pqr99999.js"), "// éééééééééé\n");
  mkdirSync(join(dist, "sub/assets"), { recursive: true });
  writeFileSync(join(dist, "sub/assets/deep.js"), "console.log('nested assets dir');");
  writeFileSync(join(dist, "sub/y.txt"), "inner-y");
  writeFileSync(join(dist, "x.txt"), "outer-x");
  mkdirSync(join(dist, "icons"));
  writeFileSync(join(dist, "icons/192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A bare app: stand-in routes first, the middleware after them, the repo's problem 404 last. */
function mount(webDist: string = dist, withRoutes = true): Hono {
  const app = new Hono();
  if (withRoutes) {
    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/api/hello", (c) => c.json({ hello: "world" }));
    app.get("/train/today", (c) => c.json({ from: "route" }));
  }
  app.use("*", serveWeb(webDist));
  app.notFound((c) => problem(404, "Not Found", `No route matches ${c.req.method} ${c.req.path}`));
  return app;
}

/** Requests through the URL parser, as a normal client would. */
const get = (app: Hono, target: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app.fetch(new Request(`http://localhost${target}`, init)));

/**
 * Hands Hono the request target EXACTLY as written. A real client or server URL
 * parser folds `..`, `.` and `%2e` segments before any handler sees them; this
 * reaches the middleware with those segments intact, so the dot-segment guard is
 * exercised on its own.
 */
class UnnormalisedRequest extends Request {
  #target: string;
  constructor(target: string) {
    super("http://localhost/");
    this.#target = `http://localhost${target}`;
  }
  override get url(): string {
    return this.#target;
  }
}
const getUnnormalised = (app: Hono, target: string): Promise<Response> =>
  Promise.resolve(app.fetch(new UnnormalisedRequest(target)));

async function expectProblem404(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  expect(ProblemDetails.parse(await res.json()).status).toBe(404);
}

/** A 404 that leaks nothing: no secret in any header or the body, and not HTML. */
async function expectCleanNotFound(res: Response): Promise<void> {
  const text = await res.text();
  expect(res.status).toBe(404);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(EVIL_LOOT);
  expect(text).not.toContain("SPA-SHELL");
  expect(res.headers.get("content-type") ?? "").not.toMatch(/html/);
}

/** Sends a request line verbatim over a real socket and returns the raw reply. */
async function rawGet(port: number, target: string): Promise<string> {
  let reply = "";
  const done = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        reply += chunk.toString();
      },
      close() {
        done.resolve();
      },
      error() {
        done.resolve();
      },
    },
  });
  const timer = setTimeout(() => socket.end(), 5000);
  socket.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  await done.promise;
  clearTimeout(timer);
  return reply;
}

describe("serving files from the dist dir", () => {
  test("a hashed asset under assets/ is 200 with immutable long-cache headers", async () => {
    const res = await get(mount(), "/assets/app-Abc12345.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(res.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(await res.text()).toBe(HASHED_JS);
  });

  test("index.html, sw.js, manifest.webmanifest and workbox files are 200 no-cache", async () => {
    const app = mount();
    for (const path of ["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/workbox-1a2b3c4d.js"]) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
    expect(await (await get(app, "/")).text()).toBe(SPA_SHELL);
    expect(await (await get(app, "/sw.js")).text()).toBe(SW_JS);
  });

  test("only the assets/ directory is immutable: a root file merely starting with 'assets' is not", async () => {
    const app = mount();
    const rootFile = await get(app, "/assets-x.js");
    expect(rootFile.status).toBe(200);
    expect(rootFile.headers.get("cache-control")).toBe("no-cache");

    const nested = await get(app, "/sub/assets/deep.js");
    expect(nested.status).toBe(200);
    expect(nested.headers.get("cache-control")).toBe("no-cache");

    const other = await get(app, "/icons/192.png");
    expect(other.status).toBe(200);
    expect(other.headers.get("cache-control")).toBe("no-cache");
  });

  test("content types match the file kind", async () => {
    const app = mount();
    const expected: Record<string, RegExp> = {
      "/assets/app-Abc12345.js": /^text\/javascript/,
      "/assets/style-Def67890.css": /^text\/css/,
      "/assets/logo-Ghi13579.svg": /^image\/svg\+xml/,
      "/assets/font-Jkl24680.woff2": /^font\/woff2/,
      "/assets/data-Mno11223.json": /^application\/json/,
      "/manifest.webmanifest": /^application\/manifest\+json/,
      "/index.html": /^text\/html/,
      "/icons/192.png": /^image\/png/,
    };
    for (const [path, type] of Object.entries(expected)) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(type);
    }
  });

  test("a binary file is served byte-for-byte", async () => {
    const res = await get(mount(), "/assets/font-Jkl24680.woff2");

    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0x80, 0x0a]);
  });

  test("ETag and Last-Modified are sent, and a matching If-None-Match answers 304 with no body", async () => {
    const app = mount();
    for (const path of ["/index.html", "/assets/app-Abc12345.js"]) {
      const first = await get(app, path);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(Number.isNaN(Date.parse(first.headers.get("last-modified") ?? ""))).toBe(false);

      const again = await get(app, path, { headers: { "if-none-match": etag ?? "" } });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
      expect(again.headers.get("etag")).toBe(etag);
      expect(again.headers.get("cache-control")).toBe(first.headers.get("cache-control"));

      const listed = await get(app, path, { headers: { "if-none-match": `"other", ${etag}` } });
      expect(listed.status).toBe(304);

      const wildcard = await get(app, path, { headers: { "if-none-match": "*" } });
      expect(wildcard.status).toBe(304);

      const stale = await get(app, path, { headers: { "if-none-match": 'W/"stale"' } });
      expect(stale.status).toBe(200);
    }
  });

  test("the ETag changes when the file changes", async () => {
    const app = mount();
    const before = (await get(app, "/sw.js")).headers.get("etag");
    writeFileSync(join(dist, "sw.js"), `${SW_JS}\n// a longer body`);
    const after = await get(app, "/sw.js", { headers: { "if-none-match": before ?? "" } });

    expect(after.status).toBe(200);
    expect(await after.text()).toContain("a longer body");
    expect(after.headers.get("etag")).not.toBe(before);
  });

  test("HEAD returns the headers of the GET, an empty body and the byte length", async () => {
    const app = mount();
    const path = "/assets/utf8-Pqr99999.js";
    const bytes = statSync(join(dist, path)).size;
    expect(bytes).toBeGreaterThan("// éééééééééé\n".length); // multi-byte, so bytes != characters

    const getRes = await get(app, path);
    const head = await get(app, path, { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(bytes));
    expect((await getRes.arrayBuffer()).byteLength).toBe(bytes);
    for (const name of ["cache-control", "content-type", "etag", "last-modified"]) {
      expect(head.headers.get(name)).toBe(getRes.headers.get(name));
    }
    expect(head.headers.get("cache-control")).toBe(IMMUTABLE);
  });

  test("HEAD on a deep link carries index.html's headers and length", async () => {
    const head = await get(mount(), "/train/history", { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toMatch(/^text\/html/);
    expect(head.headers.get("cache-control")).toBe("no-cache");
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(SPA_SHELL)));
    expect(await head.text()).toBe("");
  });

  test("a symlinked dist dir is served (the root is resolved once per request)", async () => {
    const link = join(base, "dist-link");
    symlinkSync(dist, link);
    const app = mount(link);

    const asset = await get(app, "/assets/app-Abc12345.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(await (await get(app, "/dashboard")).text()).toBe(SPA_SHELL);
  });

  test("a symlink to another file inside dist is followed", async () => {
    symlinkSync(join(dist, "assets/app-Abc12345.js"), join(dist, "alias.js"));
    const res = await get(mount(), "/alias.js");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HASHED_JS);
  });
});

describe("client routes fall back to index.html", () => {
  test("an extension-less path is index.html: 200 text/html, no-cache", async () => {
    const app = mount();
    for (const path of ["/train", "/settings/profile", "/train/", "/dashboard?x=1", "/icons", "/sub"]) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toBe(SPA_SHELL);
    }
  });

  test("only /api and /health themselves are reserved: /apixyz and /healthy are client routes", async () => {
    const app = mount();
    for (const path of ["/apixyz", "/healthy", "/api2/x", "/health-check"]) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SPA_SHELL);
    }
  });

  test("routes registered before the middleware win over the fallback", async () => {
    const app = mount();

    expect(await (await get(app, "/api/hello")).json()).toEqual({ hello: "world" });
    expect(await (await get(app, "/health")).json()).toEqual({ ok: true });
    const client = await get(app, "/train/today");
    expect(client.headers.get("content-type")).toContain("application/json");
    expect(await client.json()).toEqual({ from: "route" });
  });
});

describe("never HTML where the client expects data or a real 404", () => {
  test("/api and /health paths are never answered from dist: they fall through to the app's 404 problem", async () => {
    mkdirSync(join(dist, "api"));
    mkdirSync(join(dist, "health"));
    writeFileSync(join(dist, "api/file.js"), SECRET);
    writeFileSync(join(dist, "health/file.txt"), SECRET);
    const app = mount();
    for (const [method, path] of [
      ["GET", "/api/unknown"],
      ["GET", "/api"],
      ["GET", "/api/"],
      ["GET", "/api/a/b"],
      ["GET", "/api/file.js"],
      ["GET", "/health/x"],
      ["GET", "/health/"],
      ["GET", "/health/file.txt"],
    ] as const) {
      const res = await get(app, path, { method });
      await expectProblem404(res);
    }
    const head = await get(app, "/api/unknown", { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(head.headers.get("content-type") ?? "").not.toMatch(/html/);
  });

  test("/health without a route of its own is a 404 problem, not the SPA shell", async () => {
    const app = mount(dist, false);

    await expectProblem404(await get(app, "/health"));
    await expectProblem404(await get(app, "/api"));
  });

  test("a non-GET/HEAD request is never answered from dist, on a client path or a real file", async () => {
    const app = mount();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const path of ["/train/history", "/index.html", "/assets/app-Abc12345.js", "/"]) {
        await expectProblem404(await get(app, path, { method }));
      }
    }
  });

  test("a missing file with an extension is a 404 problem, not the SPA shell", async () => {
    const app = mount();
    for (const path of ["/assets/nope.js", "/nope.png", "/train/report.pdf", "/favicon.ico", "/sub/nope.js"]) {
      await expectProblem404(await get(app, path));
    }
  });

  test("nothing missing under assets/ falls back to index.html, extension or not", async () => {
    const app = mount();
    for (const path of ["/assets", "/assets/", "/assets/chunk-without-extension", "/assets/a/b/c"]) {
      await expectProblem404(await get(app, path));
    }
  });

  test("dotfiles and dot-directories are never served, even when they exist", async () => {
    writeFileSync(join(dist, ".env"), SECRET);
    writeFileSync(join(dist, ".secret"), SECRET);
    writeFileSync(join(dist, "assets/.hidden"), SECRET);
    mkdirSync(join(dist, ".vite"));
    writeFileSync(join(dist, ".vite/manifest.json"), SECRET);
    mkdirSync(join(dist, ".well-known"));
    writeFileSync(join(dist, ".well-known/assetlinks.json"), SECRET);
    const app = mount();
    for (const path of [
      "/.env",
      "/.secret",
      "/.vite/manifest.json",
      "/assets/.hidden",
      "/.well-known/assetlinks.json",
      "/.git",
      "/.no-such-route",
      "/train/.nothing",
    ]) {
      await expectCleanNotFound(await get(app, path));
    }
  });

  test("a trailing slash on a path that names a file is a 404, not the file", async () => {
    const app = mount();
    for (const path of ["/sw.js/", "/index.html/", "/manifest.webmanifest/", "/assets/app-Abc12345.js/", "/icons/192.png/"]) {
      await expectCleanNotFound(await get(app, path));
    }
    expect((await get(app, "/sw.js")).status).toBe(200);
  });
});

describe("path traversal is rejected", () => {
  // Survive the URL parser: encoded slashes and backslashes, double encoding, NUL, overlong UTF-8.
  const encoded: string[] = [
    "/..%2fsecret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt",
    "/%2E%2E%2Fsecret.txt",
    "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/%252e%252e%252fsecret.txt",
    "/assets/%5c..%5c..%5csecret.txt",
    "/..%5csecret.txt",
    "/assets\\..\\..\\secret.txt",
    "/secret.txt%00.png",
    "/index.html%00",
    "/%00",
    "/..%c0%afsecret.txt",
    "/%c0%ae%c0%ae/secret.txt",
    `/${"..%2f".repeat(20)}etc/passwd`,
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/assets/../../secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
  ];

  test.each(encoded)("%s never reads outside the dist dir and is a plain 404", async (path) => {
    await expectCleanNotFound(await get(mount(), path));
  });

  // Reach the middleware with the dot segments intact: a URL parser would fold
  // these, so the guard is what stops them. In-root ones (`/./index.html`) resolve
  // to a real file if the guard is missing, so a 200 here would prove it.
  const unnormalised: string[] = [
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/../dist/index.html",
    "/./index.html",
    "/%2e/index.html",
    "/assets/../index.html",
    "/assets/%2e%2e/index.html",
    "/assets/./app-Abc12345.js",
    "/assets/%2e/app-Abc12345.js",
    "/sub/../x.txt",
  ];

  test.each(unnormalised)("%s, sent unnormalised, is a plain 404", async (path) => {
    await expectCleanNotFound(await getUnnormalised(mount(), path));
  });

  test("an encoded slash is not a separator and the path is decoded exactly once", async () => {
    const app = mount();
    expect((await get(app, "/sub/y.txt")).status).toBe(200);
    expect((await get(app, "/x.txt")).status).toBe(200);

    // A second decode would turn these into `/sub/y.txt` and `/x.txt`.
    await expectCleanNotFound(await get(app, "/sub%2fy.txt"));
    await expectCleanNotFound(await get(app, "/sub%2f..%2fx.txt"));
    await expectCleanNotFound(await get(app, "/sub%2F..%2Fx.txt"));
  });

  test("a percent-encoded backslash is rejected even when a file with that literal name exists", async () => {
    writeFileSync(join(dist, "back\\slash.txt"), SECRET);
    const app = mount();

    await expectCleanNotFound(await get(app, "/back%5cslash.txt"));
    await expectCleanNotFound(await get(app, "/back%5Cslash.txt"));
  });

  test("a NUL byte is a 404, not the SPA shell and not a 500", async () => {
    const app = mount();
    for (const path of ["/dashboard%00", "/train%00/history", "/%00", "/index.html%00", "/sw.js%00.png"]) {
      await expectCleanNotFound(await get(app, path));
    }
  });

  test("an absolute path after a leading or interior double slash never addresses a file", async () => {
    const app = mount();
    const secret = join(base, "secret.txt");
    const inside = join(dist, "sw.js");
    const targets = [
      `/${secret}`,
      `/assets/${secret}`,
      `/${inside}`,
      `/assets/${inside}`,
      `//sw.js`,
      `/assets//app-Abc12345.js`,
    ];
    for (const target of targets) {
      await expectCleanNotFound(await get(app, target));
    }
  });

  test("a symlink inside dist that points outside is not followed", async () => {
    symlinkSync(join(base, "secret.txt"), join(dist, "linked.txt"));
    symlinkSync(base, join(dist, "linkeddir"));
    symlinkSync("..", join(dist, "assets/up"));
    const app = mount();

    for (const path of ["/linked.txt", "/linkeddir/secret.txt", "/assets/up/secret.txt"]) {
      await expectCleanNotFound(await get(app, path));
    }
  });

  test("a symlink to a sibling directory that shares the dist dir's name prefix is not followed", async () => {
    symlinkSync(join(base, "dist-evil"), join(dist, "evil"));
    symlinkSync(join(base, "dist-evil", "loot.txt"), join(dist, "loot.txt"));
    const app = mount();

    for (const path of ["/evil/loot.txt", "/loot.txt"]) {
      await expectCleanNotFound(await get(app, path));
    }
  });

  test("a symlink loop is a 404, not a 500", async () => {
    symlinkSync("loop.txt", join(dist, "loop.txt"));

    await expectCleanNotFound(await get(mount(), "/loop.txt"));
  });

  test("the same vectors sent verbatim over a real socket never leak and never 500", async () => {
    const app = mount();
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      const port = Number(server.url.port);
      const secret = join(base, "secret.txt");
      const targets = [...encoded, `/${secret}`, `/assets/${secret}`, "/back%5cslash.txt"];
      for (const target of targets) {
        const reply = await rawGet(port, target);
        expect(reply).not.toContain(SECRET);
        expect(reply).not.toMatch(/^HTTP\/1\.1 5\d\d/);
      }
      // Vectors that reach the middleware unchanged are exact 404s.
      for (const target of ["/secret.txt%00.png", "/dashboard%00", `/${secret}`, `/assets/${secret}`, "/back%5cslash.txt"]) {
        expect(await rawGet(port, target)).toStartWith("HTTP/1.1 404");
      }
      // A control: a legitimate asset over the same socket path is served.
      const ok = await rawGet(port, "/assets/app-Abc12345.js");
      expect(ok).toStartWith("HTTP/1.1 200");
      expect(ok).toContain(HASHED_JS);
    } finally {
      await server.stop(true);
    }
  });
});

describe("dist directory handling", () => {
  test("a missing dist dir makes it inert: routes and the app's 404 problem are untouched", async () => {
    const app = mount(join(base, "does-not-exist"));

    expect(await (await get(app, "/api/hello")).json()).toEqual({ hello: "world" });
    expect(await (await get(app, "/train/today")).json()).toEqual({ from: "route" });
    for (const path of ["/", "/dashboard", "/assets/app-Abc12345.js", "/api/unknown"]) {
      await expectProblem404(await get(app, path));
    }
  });

  test("a dist path that is a file rather than a directory is inert", async () => {
    const app = mount(join(dist, "index.html"));

    await expectProblem404(await get(app, "/"));
    await expectProblem404(await get(app, "/dashboard"));
  });

  test("a dist dir without index.html answers deep links with a 404 problem but still serves its files", async () => {
    rmSync(join(dist, "index.html"));
    const app = mount();

    await expectProblem404(await get(app, "/dashboard"));
    await expectProblem404(await get(app, "/"));
    expect((await get(app, "/assets/app-Abc12345.js")).status).toBe(200);
  });

  test("existence is checked per request: a dist dir built after mounting is picked up, and one removed stops serving", async () => {
    const later = join(base, "later");
    const app = mount(later);
    await expectProblem404(await get(app, "/dashboard"));

    mkdirSync(later);
    writeFileSync(join(later, "index.html"), SPA_SHELL);
    const served = await get(app, "/dashboard");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(SPA_SHELL);

    rmSync(later, { recursive: true, force: true });
    await expectProblem404(await get(app, "/dashboard"));
  });

  test("index.html edits are visible on the next request (no content caching)", async () => {
    const app = mount();
    await get(app, "/");
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>SECOND-BUILD</title>");

    expect(await (await get(app, "/dashboard")).text()).toContain("SECOND-BUILD");
  });
});

describe("resolveWebDist", () => {
  function withWebDist<T>(value: string | undefined, fn: () => T): T {
    const previous = process.env.WEB_DIST;
    if (value === undefined) delete process.env.WEB_DIST;
    else process.env.WEB_DIST = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.WEB_DIST;
      else process.env.WEB_DIST = previous;
    }
  }

  test("the repo root used by these tests really is the repo root", () => {
    expect(existsSync(join(REPO_ROOT, "apps/api/package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "apps/web/package.json"))).toBe(true);
  });

  test("defaults to apps/web/dist under the repo root when WEB_DIST is unset", () => {
    withWebDist(undefined, () => {
      expect(resolveWebDist()).toBe(join(REPO_ROOT, "apps/web/dist"));
      expect(resolveWebDist(undefined)).toBe(join(REPO_ROOT, "apps/web/dist"));
    });
  });

  test("a blank WEB_DIST means the default", () => {
    withWebDist("", () => expect(resolveWebDist()).toBe(join(REPO_ROOT, "apps/web/dist")));
    withWebDist("   ", () => expect(resolveWebDist()).toBe(join(REPO_ROOT, "apps/web/dist")));
  });

  test("WEB_DIST overrides the default: absolute is kept, relative is relative to the repo root", () => {
    withWebDist("/srv/web", () => expect(resolveWebDist()).toBe("/srv/web"));
    withWebDist("build/out", () => expect(resolveWebDist()).toBe(join(REPO_ROOT, "build/out")));
  });

  test("an explicit argument wins over WEB_DIST", () => {
    withWebDist("/from/env", () => {
      expect(resolveWebDist("/from/arg")).toBe("/from/arg");
      expect(resolveWebDist("rel/arg")).toBe(join(REPO_ROOT, "rel/arg"));
    });
  });

  test("the result does not depend on the working directory", () => {
    withWebDist(undefined, () => {
      const before = resolveWebDist();
      const cwd = process.cwd();
      process.chdir(tmpdir());
      try {
        expect(resolveWebDist()).toBe(before);
        expect(resolveWebDist()).toBe(join(REPO_ROOT, "apps/web/dist"));
        expect(resolveWebDist("rel/x")).toBe(join(REPO_ROOT, "rel/x"));
      } finally {
        process.chdir(cwd);
      }
    });
  });
});
