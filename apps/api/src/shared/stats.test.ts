import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EndpointSpec } from "./domain";
import { CommonsStats, ENDPOINTS } from "./stats";

const KEYS = ["drills", "tracks", "contributions", "sports"] as const;

/** A realistic landing-page payload; each case below breaks exactly one thing. */
function statsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { drills: 120, tracks: 8, contributions: 34, sports: 1, ...overrides };
}

describe("CommonsStats", () => {
  test("parses a realistic payload and keeps all four counts", () => {
    expect(CommonsStats.parse(statsPayload())).toEqual({ drills: 120, tracks: 8, contributions: 34, sports: 1 });
  });

  test("accepts zero for every count (an empty commons)", () => {
    const parsed = CommonsStats.safeParse({ drills: 0, tracks: 0, contributions: 0, sports: 0 });
    expect(parsed.success).toBe(true);
  });

  test.each([...KEYS])("rejects a payload missing %s", (key) => {
    const payload = statsPayload();
    delete payload[key];
    expect(CommonsStats.safeParse(payload).success).toBe(false);
  });

  test.each([...KEYS])("rejects a negative %s", (key) => {
    expect(CommonsStats.safeParse(statsPayload({ [key]: -1 })).success).toBe(false);
  });

  test.each([...KEYS])("rejects a fractional %s", (key) => {
    expect(CommonsStats.safeParse(statsPayload({ [key]: 1.5 })).success).toBe(false);
  });

  test.each([...KEYS])("rejects a numeric string for %s", (key) => {
    expect(CommonsStats.safeParse(statsPayload({ [key]: "5" })).success).toBe(false);
  });

  test.each([...KEYS])("rejects null for %s", (key) => {
    expect(CommonsStats.safeParse(statsPayload({ [key]: null })).success).toBe(false);
  });

  test("ignores a key the server adds later (responses are not strict)", () => {
    const parsed = CommonsStats.safeParse(statsPayload({ contributors: 9 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ drills: 120, tracks: 8, contributions: 34, sports: 1 });
  });
});

describe("ENDPOINTS", () => {
  test("getStats is the public GET /api/commons/stats returning CommonsStats", () => {
    const spec: EndpointSpec = ENDPOINTS.getStats;
    expect(spec.method).toBe("GET");
    expect(spec.path).toBe("/api/commons/stats");
    expect(spec.public).toBe(true);
    expect(spec.response).toBe(CommonsStats);
  });

  test("the slice has exactly one endpoint and it is a read (no mutation)", () => {
    expect(Object.keys(ENDPOINTS)).toEqual(["getStats"]);
    for (const spec of Object.values<EndpointSpec>(ENDPOINTS)) {
      expect(spec.method).toBe("GET");
      expect(spec.request).toBeUndefined();
    }
  });
});

describe("web-bundle safety", () => {
  test("imports only zod, ./primitives and ./domain", () => {
    const source = readFileSync(join(import.meta.dir, "stats.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/^\s*import\s+(["'])([^"']+)\1/gm),
      ...source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(["zod", "./primitives", "./domain"]).toContain(specifier);
  });
});
