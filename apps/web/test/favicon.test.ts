import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../../api/src/app";

// Bug found by the S0 gate: GET /favicon.ico -> 404 -> a console error on the web
// root. Fix: an on-brand SVG favicon plus a <link rel="icon"> in index.html; a
// browser that finds the link never probes /favicon.ico.
//
// Reading of "served through the real static server": createApp() from the API,
// mounted on a temp dist dir holding index.html and a copy of the file the icon link
// names (what vite does with public/ -> dist root), with an empty routes dir and an
// in-memory db, so the only thing that can answer is serveWeb (apps/api/src/http/static.ts).

const webDir = join(import.meta.dir, "..");
const html = readFileSync(join(webDir, "index.html"), "utf8");

/** The href of the first `<link rel="icon" ...>` in index.html (attribute order free), or undefined. */
function iconHref(source: string): string | undefined {
  for (const [tag] of source.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?icon["']?[\s/>]/i.test(tag)) continue;
    return /\bhref\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bhref\s*=\s*'([^']*)'/i.exec(tag)?.[1];
  }
  return undefined;
}

/** Well-formedness check: every start tag is closed in order. Returns the root element name. */
function rootElementOf(xml: string): string {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const stack: string[] = [];
  let root: string | undefined;
  let rest = body;
  while (rest.length > 0) {
    const tag = /^<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/.exec(rest);
    if (tag) {
      const [whole, closing, name, , selfClosing] = tag;
      if (closing) {
        if (stack.pop() !== name) throw new Error(`mismatched </${name}>`);
      } else {
        if (root === undefined) root = name;
        else if (stack.length === 0) throw new Error("more than one root element");
        if (!selfClosing) stack.push(name);
      }
      rest = rest.slice(whole.length);
    } else if (rest.startsWith("<")) {
      throw new Error(`malformed markup near ${rest.slice(0, 20)}`);
    } else {
      const next = rest.indexOf("<");
      const text = next === -1 ? rest : rest.slice(0, next);
      if (stack.length === 0 && text.trim() !== "") throw new Error("text outside the root element");
      rest = next === -1 ? "" : rest.slice(next);
    }
  }
  if (stack.length > 0 || root === undefined) throw new Error("unclosed element or no root");
  return root;
}

describe("index.html favicon link", () => {
  const href = iconHref(html);

  test("declares a <link rel=icon type=image/svg+xml> pointing at /favicon.svg", () => {
    expect(href).toBe("/favicon.svg");
    const tag = /<link\b[^>]*rel="icon"[^>]*>/i.exec(html)?.[0] ?? "";
    expect(tag).toMatch(/type="image\/svg\+xml"/i);
  });

  test("the icon link points to a file that exists in apps/web/public", () => {
    expect(href).toBeDefined();
    expect(existsSync(join(webDir, "public", (href ?? "").replace(/^\//, "")))).toBe(true);
  });
});

describe("public/favicon.svg", () => {
  // Read per test (not at describe time) so a missing file fails those tests, not the whole file.
  const read = () => readFileSync(join(webDir, "public", "favicon.svg"), "utf8");

  test("is well-formed XML whose root element is <svg> in the SVG namespace", () => {
    const svg = read();
    expect(rootElementOf(svg)).toBe("svg");
    expect(svg).toMatch(/<svg\b[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  test("has a viewBox with a positive width and height", () => {
    const svg = read();
    const box = /<svg\b[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1];
    expect(box).toBeDefined();
    const [, , w, h] = (box ?? "").trim().split(/[\s,]+/).map(Number);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });

  test("has no script, foreignObject, event-handler attribute or javascript: URL", () => {
    const svg = read();
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<foreignObject/i);
    expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
    expect(svg).not.toMatch(/javascript:/i);
  });

  test("has no external references (href, src, url(), @import, DOCTYPE, ENTITY)", () => {
    const svg = read();
    for (const [, value] of svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
      expect(value?.startsWith("#")).toBe(true); // only in-document references
    }
    expect(svg).not.toMatch(/\bsrc\s*=/i);
    expect(svg).not.toMatch(/url\(\s*["']?(?!#)/i);
    expect(svg).not.toMatch(/@import/i);
    expect(svg).not.toMatch(/<!DOCTYPE|<!ENTITY/i);
    expect(svg).not.toMatch(/(?:https?:)?\/\/(?!www\.w3\.org\/2000\/svg)/i);
  });

  test("is tiny (under 2 KiB)", () => {
    const svg = read();
    expect(Buffer.byteLength(svg)).toBeLessThan(2048);
  });

  test("uses the DESIGN.md brand tokens as literal hex: Ink #101815, Field Green #2e7d53, Notebook Page #fffefa", () => {
    const svg = read();
    for (const hex of ["#101815", "#2e7d53", "#fffefa"]) expect(svg.toLowerCase()).toContain(hex);
  });
});

describe("served through the API's real static server (createApp -> serveWeb)", () => {
  let base: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const db = new Database(":memory:");
  const href = iconHref(html) ?? "/favicon.svg";

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "favicon-"));
    const dist = join(base, "dist");
    const routes = join(base, "routes");
    mkdirSync(dist, { recursive: true });
    mkdirSync(routes);
    // vite copies apps/web/public/* to the dist root as-is.
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>SPA-SHELL</title><div id=root></div>");
    const source = join(webDir, "public", href.replace(/^\//, ""));
    if (existsSync(source)) {
      const target = join(dist, href.replace(/^\//, ""));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    app = await createApp({ db, version: "test" }, routes, { webDist: dist });
  });

  afterAll(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  const request = (path: string) => Promise.resolve(app.fetch(new Request(`http://localhost${path}`)));

  test("the icon href answers 200 with an image/svg+xml content type and the svg bytes", async () => {
    const res = await request(href);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(await res.text()).toBe(readFileSync(join(webDir, "public", "favicon.svg"), "utf8"));
  });

  test("an unknown /favicon.ico is a real 404, never the SPA shell with 200 (must not be masked)", async () => {
    const res = await request("/favicon.ico");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SPA-SHELL");
  });
});
