import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fromZodError } from "../http/problem";
import type { EndpointSpec } from "./domain";
import { CommonsExport, DrillDetail, DrillListQuery, DrillListResponse, SkillGraph } from "./commons";
import {
  CommonsDrillParams,
  CommonsDrillQuery,
  CommonsJsonSchemaDocument,
  CommonsLocaleQuery,
  CommonsSkillGraphParams,
  ENDPOINTS,
} from "./commons-api";
import { EQUIPMENT, EXPERIENCE_LEVELS, LOCALES, TRUST_STATUSES } from "./primitives";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

/** The Zod issue paths of a failed parse (empty when it parsed). */
const issuePaths = (schema: z.ZodType, value: unknown): PropertyKey[][] => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => [...issue.path]);
};

/** The RFC 6901 pointers the repo's fromZodError yields for a failed parse. */
const pointers = (schema: z.ZodType, value: unknown): string[] => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : fromZodError(parsed.error).map((error) => error.pointer);
};

const pathParams = (path: string): string[] => [...path.matchAll(/:(\w+)/g)].map((match) => match[1] as string);

/** A value that is deliberately NOT a member of the named primitive enum (guarded below). */
const notIn = (values: readonly string[], candidate: string): string => {
  expect(values).not.toContain(candidate);
  return candidate;
};

const AT = "2026-09-01T10:00:00Z";

// A full query as the library sends it: every value is a string, as in a URL.
const fullQuery = () =>
  ({
    skill: "dribbling",
    status: "REVIEWED",
    equipment: "cones",
    level: "basic",
    q: "slalom",
    locale: "kk",
  }) as const;

describe("CommonsDrillQuery", () => {
  test("accepts no filters at all (the plain library page)", () => {
    expect(CommonsDrillQuery.parse({})).toEqual({});
  });

  test("accepts every filter together and keeps each value", () => {
    expect(CommonsDrillQuery.parse(fullQuery())).toEqual(fullQuery());
  });

  test("accepts skill on its own", () => {
    expect(CommonsDrillQuery.parse({ skill: "ball-control" })).toEqual({ skill: "ball-control" });
  });

  test.each([...TRUST_STATUSES])("accepts status %s on its own", (status) => {
    expect(CommonsDrillQuery.parse({ status })).toEqual({ status });
  });

  test.each([...EQUIPMENT])("accepts equipment %s on its own", (equipment) => {
    expect(CommonsDrillQuery.parse({ equipment })).toEqual({ equipment });
  });

  test.each([...EXPERIENCE_LEVELS])("accepts level %s on its own", (level) => {
    expect(CommonsDrillQuery.parse({ level })).toEqual({ level });
  });

  test("accepts q on its own and keeps the text verbatim", () => {
    expect(CommonsDrillQuery.parse({ q: "five gate slalom" })).toEqual({ q: "five gate slalom" });
  });

  test.each([...LOCALES])("accepts locale %s on its own", (locale) => {
    expect(CommonsDrillQuery.parse({ locale })).toEqual({ locale });
  });

  test("rejects an unknown status", () => {
    expect(ok(CommonsDrillQuery, { status: notIn(TRUST_STATUSES, "PUBLISHED") })).toBe(false);
  });

  test("rejects a status in the wrong case", () => {
    expect(ok(CommonsDrillQuery, { status: notIn(TRUST_STATUSES, "reviewed") })).toBe(false);
  });

  test("rejects an unknown equipment", () => {
    expect(ok(CommonsDrillQuery, { equipment: notIn(EQUIPMENT, "trampoline") })).toBe(false);
  });

  test("rejects an unknown level", () => {
    expect(ok(CommonsDrillQuery, { level: notIn(EXPERIENCE_LEVELS, "expert") })).toBe(false);
  });

  test("rejects a numeric level: levels are the primitives' strings, not numbers", () => {
    expect(ok(CommonsDrillQuery, { level: "2" })).toBe(false);
  });

  test("accepts an empty q: a cleared search box sends ?q= and must not be a 400", () => {
    expect(CommonsDrillQuery.parse({ q: "" })).toEqual({ q: "" });
  });

  test("rejects a bad locale", () => {
    expect(ok(CommonsDrillQuery, { locale: notIn(LOCALES, "de") })).toBe(false);
  });

  test("rejects a skill that is not an EntityId", () => {
    expect(ok(CommonsDrillQuery, { skill: "ball control" })).toBe(false);
  });

  test("rejects an empty skill", () => {
    expect(ok(CommonsDrillQuery, { skill: "" })).toBe(false);
  });

  test("rejects an unknown query key (strict)", () => {
    expect(ok(CommonsDrillQuery, { ...fullQuery(), colour: "red" })).toBe(false);
  });

  test("rejects a repeated parameter that arrives as an array", () => {
    expect(ok(CommonsDrillQuery, { status: ["COMMUNITY", "REVIEWED"] })).toBe(false);
  });
});

describe("query failures become a 400 problem with a pointer", () => {
  test("an unknown status fails at the single key ['status']", () => {
    expect(issuePaths(CommonsDrillQuery, { status: notIn(TRUST_STATUSES, "PUBLISHED") })).toEqual([["status"]]);
  });

  test("the repo's fromZodError turns an unknown status into the pointer /status", () => {
    expect(pointers(CommonsDrillQuery, { status: notIn(TRUST_STATUSES, "PUBLISHED") })).toEqual(["/status"]);
  });

  test("an unknown equipment points at /equipment", () => {
    expect(pointers(CommonsDrillQuery, { equipment: notIn(EQUIPMENT, "trampoline") })).toEqual(["/equipment"]);
  });

  test("an unknown level points at /level", () => {
    expect(pointers(CommonsDrillQuery, { level: notIn(EXPERIENCE_LEVELS, "expert") })).toEqual(["/level"]);
  });

  test("a bad locale points at /locale", () => {
    expect(pointers(CommonsDrillQuery, { locale: notIn(LOCALES, "de") })).toEqual(["/locale"]);
  });

  test.each([
    ["status", "PUBLISHED", TRUST_STATUSES],
    ["equipment", "trampoline", EQUIPMENT],
    ["level", "expert", EXPERIENCE_LEVELS],
    ["locale", "de", LOCALES],
  ] as const)("an unknown %s value fails at the single key, path [%s] and pointer /%s", (key, value, allowed) => {
    const query = { [key]: notIn(allowed, value) };
    expect(issuePaths(CommonsDrillQuery, query)).toEqual([[key]]);
    expect(pointers(CommonsDrillQuery, query)).toEqual([`/${key}`]);
  });

  test("an UNRECOGNIZED query key (space=yard) fails at the empty path [], pointer \"\", and the detail names the key", () => {
    const query = { space: "yard" };
    expect(issuePaths(CommonsDrillQuery, query)).toEqual([[]]);
    const parsed = CommonsDrillQuery.safeParse(query);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const errors = fromZodError(parsed.error);
    expect(errors.map((error) => error.pointer)).toEqual([""]);
    expect(errors[0]?.detail).toContain("space");
  });

  test("a valid status alongside an unknown equipment reports only the equipment", () => {
    expect(pointers(CommonsDrillQuery, { status: "REVIEWED", equipment: notIn(EQUIPMENT, "trampoline") })).toEqual([
      "/equipment",
    ]);
  });

  test("two unknown enum values report both pointers", () => {
    const found = pointers(CommonsDrillQuery, {
      status: notIn(TRUST_STATUSES, "PUBLISHED"),
      level: notIn(EXPERIENCE_LEVELS, "expert"),
    });
    expect([...found].sort()).toEqual(["/level", "/status"]);
  });
});

describe("CommonsDrillQuery pagination (cursor and limit, so nextCursor can be followed)", () => {
  test("accepts a cursor on its own and keeps it verbatim", () => {
    expect(CommonsDrillQuery.parse({ cursor: "eyJvIjoyMH0" })).toEqual({ cursor: "eyJvIjoyMH0" });
  });

  test("accepts a limit on its own", () => {
    expect(CommonsDrillQuery.parse({ limit: 20 })).toEqual({ limit: 20 });
  });

  test("a limit that arrives as a query string parses to the number", () => {
    expect(CommonsDrillQuery.parse({ limit: "20" })).toEqual({ limit: 20 });
  });

  test("accepts cursor and limit together", () => {
    expect(CommonsDrillQuery.parse({ cursor: "abc", limit: "5" })).toEqual({ cursor: "abc", limit: 5 });
  });

  test("accepts cursor and limit together with the six criteria keys", () => {
    expect(CommonsDrillQuery.parse({ ...fullQuery(), cursor: "abc", limit: "50" })).toEqual({
      ...fullQuery(),
      cursor: "abc",
      limit: 50,
    });
  });

  test("the six criteria parameters are unchanged: they still parse alone", () => {
    expect(CommonsDrillQuery.parse(fullQuery())).toEqual(fullQuery());
  });

  test("rejects a limit of 0", () => {
    expect(ok(CommonsDrillQuery, { limit: 0 })).toBe(false);
  });

  test("rejects a negative limit", () => {
    expect(ok(CommonsDrillQuery, { limit: -1 })).toBe(false);
  });

  test("rejects a limit that is not a number", () => {
    expect(ok(CommonsDrillQuery, { limit: "abc" })).toBe(false);
  });

  test("rejects a fractional limit", () => {
    expect(ok(CommonsDrillQuery, { limit: 1.5 })).toBe(false);
  });

  test("rejects a fractional limit that arrives as a string", () => {
    expect(ok(CommonsDrillQuery, { limit: "1.5" })).toBe(false);
  });

  test("rejects a limit of 0 that arrives as a string", () => {
    expect(ok(CommonsDrillQuery, { limit: "0" })).toBe(false);
  });

  test("accepts an empty cursor: it is not a criteria rule", () => {
    expect(CommonsDrillQuery.parse({ cursor: "" })).toEqual({ cursor: "" });
  });

  test("a bad limit points at /limit", () => {
    expect(pointers(CommonsDrillQuery, { limit: 0 })).toEqual(["/limit"]);
  });

  test.each(["", "abc", "eyJvIjoyMH0", " ", "a b", 20, null, ["abc"]])(
    "cursor %p is judged exactly as commons.ts's DrillListQuery judges it",
    (cursor) => {
      expect(ok(CommonsDrillQuery, { cursor })).toBe(ok(DrillListQuery, { cursor }));
    },
  );

  test("still rejects an unknown key next to a valid cursor and limit", () => {
    expect(ok(CommonsDrillQuery, { cursor: "abc", limit: 20, colour: "red" })).toBe(false);
  });

  test.each(["20", 20, "1", "0", 0, "-1", -1, "abc", "1.5", 1.5, "", " ", "1e2", "0x10"])(
    "limit %p is judged exactly as commons.ts's DrillListQuery judges it",
    (limit) => {
      expect(ok(CommonsDrillQuery, { limit })).toBe(ok(DrillListQuery, { limit }));
    },
  );
});

describe("CommonsDrillParams", () => {
  test("accepts a slug", () => {
    expect(CommonsDrillParams.parse({ slug: "five-gate-slalom" })).toEqual({ slug: "five-gate-slalom" });
  });

  test("requires the slug", () => {
    expect(ok(CommonsDrillParams, {})).toBe(false);
  });

  test("rejects an empty slug", () => {
    expect(ok(CommonsDrillParams, { slug: "" })).toBe(false);
  });

  test("rejects a slug containing a slash", () => {
    expect(ok(CommonsDrillParams, { slug: "five/gate" })).toBe(false);
  });

  test("rejects an unknown param key (strict)", () => {
    expect(ok(CommonsDrillParams, { slug: "five-gate-slalom", sport: "football" })).toBe(false);
  });
});

describe("CommonsSkillGraphParams", () => {
  test("accepts a sport", () => {
    expect(CommonsSkillGraphParams.parse({ sport: "football" })).toEqual({ sport: "football" });
  });

  test("requires the sport", () => {
    expect(ok(CommonsSkillGraphParams, {})).toBe(false);
  });

  test("rejects an empty sport", () => {
    expect(ok(CommonsSkillGraphParams, { sport: "" })).toBe(false);
  });

  test("rejects a sport that is not an EntityId", () => {
    expect(ok(CommonsSkillGraphParams, { sport: "foot ball" })).toBe(false);
  });

  test("rejects an unknown param key (strict)", () => {
    expect(ok(CommonsSkillGraphParams, { sport: "football", slug: "x" })).toBe(false);
  });
});

describe("CommonsLocaleQuery", () => {
  test("accepts no locale", () => {
    expect(CommonsLocaleQuery.parse({})).toEqual({});
  });

  test.each([...LOCALES])("accepts locale %s", (locale) => {
    expect(CommonsLocaleQuery.parse({ locale })).toEqual({ locale });
  });

  test("rejects a bad locale at /locale", () => {
    expect(pointers(CommonsLocaleQuery, { locale: notIn(LOCALES, "de") })).toEqual(["/locale"]);
  });

  test("rejects an unknown query key (strict)", () => {
    expect(ok(CommonsLocaleQuery, { locale: "ru", status: "COMMUNITY" })).toBe(false);
  });
});

describe("CommonsJsonSchemaDocument", () => {
  test("accepts a JSON Schema document (an object with arbitrary keys)", () => {
    expect(ok(CommonsJsonSchemaDocument, { type: "object", properties: { a: { type: "string" } } })).toBe(true);
  });

  test.each([
    ["an array", [{ type: "object" }]],
    ["null", null],
    ["a string", "{}"],
  ])("rejects %s", (_label, value) => {
    expect(ok(CommonsJsonSchemaDocument, value)).toBe(false);
  });
});

describe("ENDPOINTS", () => {
  const CASES = [
    ["listDrills", "GET", "/api/commons/drills"],
    ["getDrill", "GET", "/api/commons/drills/:slug"],
    ["getSkillGraph", "GET", "/api/commons/skill-graph/:sport"],
    ["exportCommons", "GET", "/api/commons/export.json"],
    ["commonsSchema", "GET", "/api/commons/schema.json"],
  ] as const;

  test.each(CASES.map(([name]) => name))("declares the criteria endpoint %s", (name) => {
    expect(ENDPOINTS).toHaveProperty(name);
  });

  test.each([...CASES])("%s is the public %s %s", (name, method, path) => {
    const spec: EndpointSpec = ENDPOINTS[name];
    expect(spec.method).toBe(method);
    expect(spec.path).toBe(path);
    expect(spec.public).toBe(true);
  });

  test("listDrills reads CommonsDrillQuery and returns commons.ts's DrillListResponse", () => {
    expect(Object.is(ENDPOINTS.listDrills.query, CommonsDrillQuery)).toBe(true);
    expect(Object.is(ENDPOINTS.listDrills.response, DrillListResponse)).toBe(true);
  });

  test("getDrill reads CommonsDrillParams and CommonsLocaleQuery and returns commons.ts's DrillDetail", () => {
    expect(Object.is(ENDPOINTS.getDrill.params, CommonsDrillParams)).toBe(true);
    expect(Object.is(ENDPOINTS.getDrill.query, CommonsLocaleQuery)).toBe(true);
    expect(Object.is(ENDPOINTS.getDrill.response, DrillDetail)).toBe(true);
  });

  test("getSkillGraph reads CommonsSkillGraphParams and CommonsLocaleQuery and returns commons.ts's SkillGraph", () => {
    expect(Object.is(ENDPOINTS.getSkillGraph.params, CommonsSkillGraphParams)).toBe(true);
    expect(Object.is(ENDPOINTS.getSkillGraph.query, CommonsLocaleQuery)).toBe(true);
    expect(Object.is(ENDPOINTS.getSkillGraph.response, SkillGraph)).toBe(true);
  });

  test("exportCommons returns commons.ts's CommonsExport as application/json", () => {
    expect(Object.is(ENDPOINTS.exportCommons.response, CommonsExport)).toBe(true);
    expect(ENDPOINTS.exportCommons.contentType).toBe("application/json");
  });

  test("commonsSchema returns a CommonsJsonSchemaDocument as application/json", () => {
    expect(Object.is(ENDPOINTS.commonsSchema.response, CommonsJsonSchemaDocument)).toBe(true);
    expect(ENDPOINTS.commonsSchema.contentType).toBe("application/json");
  });

  test("getDrill: every :param in the path has a params key and nothing else", () => {
    expect(pathParams(ENDPOINTS.getDrill.path)).toEqual(Object.keys(ENDPOINTS.getDrill.params.shape));
  });

  test("getSkillGraph: every :param in the path has a params key and nothing else", () => {
    expect(pathParams(ENDPOINTS.getSkillGraph.path)).toEqual(Object.keys(ENDPOINTS.getSkillGraph.params.shape));
  });

  test("the paths without a :param declare no params schema", () => {
    for (const name of ["listDrills", "exportCommons", "commonsSchema"] as const) {
      expect(pathParams(ENDPOINTS[name].path)).toEqual([]);
      expect("params" in ENDPOINTS[name]).toBe(false);
    }
  });
});

describe("the export endpoint response (attribution for every drill)", () => {
  const attribution = () => ({
    author: "FIRST COACH Genesis",
    source: "FIRST COACH Genesis",
    license: "CC-BY-SA-4.0",
    createdAt: AT,
    semver: "1.0.0",
  });

  const drill = (slug: string, extra: Record<string, unknown> = {}) => ({
    slug,
    versionId: `${slug}-v1`,
    content: {
      goal: { en: "Close control while turning" },
      instructions: { en: "Dribble through five gates." },
      dose: { durationSec: 60 },
      conditions: { equipment: "cones", spaces: ["yard"] },
    },
    attribution: attribution(),
    history: [],
    reviews: [],
    ...extra,
  });

  const exportOf = (drills: unknown[]) => ({
    schema_version: "0.1.0",
    license: "CC-BY-SA-4.0",
    attribution_notice: "Source: Open Sport Commons, CC BY-SA 4.0",
    generated_at: AT,
    sports: [
      {
        slug: "football",
        name: { en: "Football" },
        graph: { sport: "football", version: "0.1.0", nodes: [] },
        tests: [],
        drills,
      },
    ],
  });

  test("accepts an export whose every drill carries attribution", () => {
    expect(ok(ENDPOINTS.exportCommons.response, exportOf([drill("a"), drill("b")]))).toBe(true);
  });

  test("rejects an export where one drill has no attribution", () => {
    const { attribution: _dropped, ...bare } = drill("b");
    expect(ok(ENDPOINTS.exportCommons.response, exportOf([drill("a"), bare]))).toBe(false);
  });

  test("rejects an export without the top-level attribution notice", () => {
    const { attribution_notice: _dropped, ...rest } = exportOf([drill("a")]);
    expect(ok(ENDPOINTS.exportCommons.response, rest)).toBe(false);
  });

  test("rejects an export without the licence", () => {
    const { license: _dropped, ...rest } = exportOf([drill("a")]);
    expect(ok(ENDPOINTS.exportCommons.response, rest)).toBe(false);
  });
});

describe("schema.json is generatable from the merged contract", () => {
  const generated = z.toJSONSchema(CommonsExport) as Record<string, unknown>;

  test("z.toJSONSchema(CommonsExport) is an object schema", () => {
    expect(generated.type).toBe("object");
  });

  test.each(["schema_version", "license", "attribution_notice", "generated_at", "sports"])(
    "the generated schema has a %s property",
    (key) => {
      expect(Object.keys(generated.properties as Record<string, unknown>)).toContain(key);
    },
  );

  test("the generated document is accepted as the schema.json response", () => {
    expect(ok(ENDPOINTS.commonsSchema.response, generated)).toBe(true);
  });

  test("the generated document survives a JSON round trip (it is what the API serves)", () => {
    expect(ok(ENDPOINTS.commonsSchema.response, JSON.parse(JSON.stringify(generated)))).toBe(true);
  });
});

describe("web-bundle safety", () => {
  const raw = readFileSync(join(import.meta.dir, "commons-api.ts"), "utf8");
  // Comments may name things the module must not use, so scan code only.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("commons-api.ts imports only zod, ./primitives, ./domain and ./commons", () => {
    const specifiers = [
      ...code.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...code.matchAll(/^\s*import\s+(["'])([^"']+)\1/gm),
      ...code.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...code.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(["zod", "./primitives", "./domain", "./commons"]).toContain(specifier);
  });

  test("commons-api.ts does not use z.toJSONSchema at runtime (the API side generates schema.json)", () => {
    expect(code).not.toMatch(/toJSONSchema/);
  });
});
