// Static SPA serving: the built web app (apps/web/dist) is served from the API's
// own origin, so there is no CORS. Mounted AFTER every route (at the SEAM in
// createApp) so it only sees requests nothing else claimed.
//
// Hand-rolled on Bun.file rather than hono/bun serveStatic: that one answers a NUL
// byte in the path with a 500 and sets no Cache-Control or validators.
//
// Contract
// - GET/HEAD only. Every other method falls through (`next()`), so the app's own
//   problem+json 404 answers; the SPA shell is never returned for a POST.
// - `/api`, `/api/*`, `/health`, `/health/*` are never served from here (fall
//   through), so an unknown API path is a problem+json 404, never HTML.
// - An existing file is 200. Only files under `assets/` (Vite's content-hashed
//   output) are `immutable`; everything else (index.html, sw.js,
//   manifest.webmanifest, workbox-*.js, ...) is `no-cache`, revalidated through
//   ETag / If-None-Match (304). Last-Modified is sent as well.
// - A missing path falls back to index.html (client-side deep link) only when it
//   is not under `assets/` and its last segment has no dot. A missing file WITH an
//   extension, or anything missing under `assets/`, falls through to the 404: a
//   stale service worker must never receive HTML for a JS file.
// - Rejected as a plain fall-through 404: dot segments (`.`, `..`, dotfiles such as
//   `.env`, `.vite/`, and `.well-known/`), backslash, NUL, empty segments (a
//   leading `//abs/path` included) and a trailing slash on a path that names a
//   file (`/sw.js/`).
// - The dist dir (and its index.html) is checked on every request: when either is
//   missing the middleware is inert, so a dist built after boot is picked up and
//   an API-only deployment never crashes.
//
// Traversal safety: `c.req.path` is already percent-decoded once by Hono (`%2f`
// stays encoded, `%5c` and `%00` become `\` and NUL). It is NEVER decoded again.
// After the string checks above, the candidate is resolved with `realpath` and
// must sit under `realpath(root) + sep`: the `sep` keeps a sibling such as
// `dist-evil/` from passing a prefix check, and realpath refuses symlink escapes.
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

// apps/api/src/http -> repo root. Located from this file, so independent of cwd.
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DEFAULT_WEB_DIST = "apps/web/dist";

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

/**
 * WEB_DIST as an absolute path. Unset or blank means `apps/web/dist`; a relative
 * value is relative to the repo root (never the cwd); an absolute value is kept.
 */
export function resolveWebDist(raw: string | undefined = process.env.WEB_DIST): string {
  return resolve(REPO_ROOT, raw?.trim() || DEFAULT_WEB_DIST);
}

const isReserved = (path: string): boolean =>
  path === "/api" || path.startsWith("/api/") || path === "/health" || path.startsWith("/health/");

/** The real path and stat of a regular file at `relative` inside `root` (a realpath), or undefined. */
async function findFile(root: string, relative: string) {
  try {
    const real = await realpath(resolve(root, relative));
    if (!real.startsWith(root + sep)) return undefined; // `..`, an absolute path, or a symlink leading out
    const info = await stat(real);
    return info.isFile() ? { real, info } : undefined;
  } catch {
    return undefined; // ENOENT, ENOTDIR, ELOOP, a NUL byte, ...
  }
}

const weak = (tag: string): string => tag.trim().replace(/^W\//, "");

/** Serves the built web app from `webDist` (an absolute path). */
export function serveWeb(webDist: string): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path; // decoded once by Hono; do not decode again
    if ((method !== "GET" && method !== "HEAD") || isReserved(path)) return next();

    if (path.includes("\0") || path.includes("\\")) return next();
    const relative = path.slice(1);
    const trailingSlash = relative.endsWith("/");
    const segments = relative === "" ? [] : (trailingSlash ? relative.slice(0, -1) : relative).split("/");
    if (segments.some((segment) => segment === "" || segment.startsWith("."))) return next();

    let root: string;
    try {
      root = await realpath(webDist);
    } catch {
      return next(); // no dist dir: API-only (a dist path that is a file fails every lookup below)
    }

    // A trailing slash names a directory, never a file.
    let hit = !trailingSlash && segments.length > 0 ? await findFile(root, segments.join("/")) : undefined;
    const underAssets = segments[0] === "assets";
    if (!hit && !underAssets && !(segments.at(-1) ?? "").includes(".")) {
      hit = await findFile(root, "index.html");
    }
    if (!hit) return next();

    const { real, info } = hit;
    const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "cache-control": underAssets && real.startsWith(`${root}${sep}assets${sep}`) ? IMMUTABLE : NO_CACHE,
      etag,
      "last-modified": info.mtime.toUTCString(),
    };

    const candidates = c.req.header("if-none-match")?.split(",").map(weak);
    if (candidates?.includes(weak(etag)) || candidates?.includes("*")) {
      return new Response(null, { status: 304, headers });
    }

    const file = Bun.file(real);
    // Hono drops a HEAD reply's body; state the length the GET would have.
    if (method === "HEAD") headers["content-length"] = String(info.size);
    return new Response(file, { headers: { ...headers, "content-type": file.type } });
  };
}
