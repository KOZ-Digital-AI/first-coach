import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

// Asserts existence first so a missing file fails cleanly, not with ENOENT.
const read = (name: string): string => {
  const path = join(repoRoot, name);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8");
};

// Collapse all whitespace runs so phrases match across line wraps.
const normalise = (text: string): string => text.replace(/\s+/g, " ");

// Every token hex from the prototype :root (first-coach-demo.html), design §3.
const TOKEN_HEXES = [
  "#f4f3ee", // --bg
  "#fffefa", // --paper
  "#101815", // --ink
  "#68716c", // --muted
  "#d8ddd8", // --line
  "#2e7d53", // --accent
  "#dff1e6", // --accent-2
  "#a16a18", // --warning
  "#b8473d", // --danger
];

const SHADOW = "0 18px 60px rgba(19, 34, 27, .08)";

const HEADINGS = [
  "## Overview",
  "## Colors",
  "## Typography",
  "## Layout",
  "## Elevation & Depth",
  "## Shapes",
  "## Components",
  "## Do's and Don'ts",
];

const FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "colors",
  "typography",
  "rounded",
  "spacing",
  "components",
]);

describe("DESIGN.md (Design Context)", () => {
  test("exists at the repo root", () => {
    expect(existsSync(join(repoRoot, "DESIGN.md"))).toBe(true);
  });

  for (const hex of TOKEN_HEXES) {
    test(`records token colour ${hex}`, () => {
      expect(read("DESIGN.md").toLowerCase()).toContain(hex);
    });
  }

  for (const token of ["18px", "12px", "Inter", SHADOW]) {
    test(`records token ${token}`, () => {
      expect(normalise(read("DESIGN.md"))).toContain(token);
    });
  }

  test("has the eight canonical headings in order", () => {
    const text = read("DESIGN.md");
    let last = -1;
    for (const heading of HEADINGS) {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`^${escaped}\\s*$`, "m").exec(text);
      expect(match).not.toBeNull();
      const index = match?.index ?? -1;
      expect(index).toBeGreaterThan(last);
      last = index;
    }
  });

  for (const phrase of [
    "State is never conveyed by colour alone",
    "Light theme only",
    "No casino gamification",
  ]) {
    test(`states the rule "${phrase}"`, () => {
      expect(normalise(read("DESIGN.md"))).toContain(phrase);
    });
  }

  test("YAML frontmatter uses only the schema's top-level keys", () => {
    const text = read("DESIGN.md");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    expect(match).not.toBeNull();
    const keys = (match?.[1] ?? "")
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z][\w-]*):/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(FRONTMATTER_KEYS.has(key)).toBe(true);
    }
  });
});

describe("PRODUCT.md (impeccable product context)", () => {
  test("exists at the repo root", () => {
    expect(existsSync(join(repoRoot, "PRODUCT.md"))).toBe(true);
  });

  test("carries the current product-schema stamp", () => {
    expect(read("PRODUCT.md")).toContain("<!-- impeccable:product-schema 1 -->");
  });

  for (const heading of ["## Users", "## Product Principles", "## Brand Commitments"]) {
    test(`has the heading ${heading}`, () => {
      expect(read("PRODUCT.md")).toMatch(new RegExp(`^${heading}\\s*$`, "m"));
    });
  }

  for (const word of ["children", "coaches", "Android"]) {
    test(`names the audience word "${word}"`, () => {
      expect(read("PRODUCT.md")).toContain(word);
    });
  }

  for (const antiReference of ["casino", "leaderboard"]) {
    test(`lists the anti-reference "${antiReference}"`, () => {
      expect(read("PRODUCT.md").toLowerCase()).toContain(antiReference);
    });
  }
});

describe("CLAUDE.md (bd content kept, Design Context added)", () => {
  const END = "<!-- END BEADS INTEGRATION -->";

  test("keeps the beads integration block markers", () => {
    const text = read("CLAUDE.md");
    expect(text).toMatch(/^<!-- BEGIN BEADS INTEGRATION/m);
    expect(text).toContain(END);
  });

  test("keeps its existing bd sections", () => {
    const text = read("CLAUDE.md");
    expect(text).toContain("## Session Completion");
    expect(text).toContain("## Conventions & Patterns");
  });

  test("has a Design Context section after the beads block pointing to DESIGN.md", () => {
    const text = read("CLAUDE.md");
    const end = text.indexOf(END);
    expect(end).toBeGreaterThan(-1);
    const heading = /^## Design Context\s*$/m.exec(text);
    expect(heading).not.toBeNull();
    const start = heading?.index ?? -1;
    expect(start).toBeGreaterThan(end);
    const rest = text.slice(start + (heading?.[0].length ?? 0));
    const next = rest.search(/^## /m);
    const section = next === -1 ? rest : rest.slice(0, next);
    expect(section).toContain("DESIGN.md");
  });
});

describe("repo hygiene", () => {
  test("has no .impeccable/ directory", () => {
    expect(existsSync(join(repoRoot, ".impeccable"))).toBe(false);
  });
});
