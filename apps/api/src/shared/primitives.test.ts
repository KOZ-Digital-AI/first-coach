import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import { z } from "zod";
import {
  ClientUuid,
  DATABASE_STATES,
  DEFAULT_LICENSE_ID,
  DrillContent,
  DrillVersionRef,
  EQUIPMENT,
  EXPERIENCE_LEVELS,
  Equipment,
  EntityId,
  ExperienceLevel,
  GOALS,
  Goal,
  HealthResponse,
  LICENSE_IDS,
  LOCALES,
  LOCALE_FALLBACKS,
  LicenseId,
  Locale,
  LocalizedText,
  PROBLEM_CONTENT_TYPE,
  ProblemDetails,
  SPACES,
  SkillRef,
  Space,
  TRUST_STATUSES,
  TrustStatus,
  paginated,
  pickLocalized,
} from "./primitives";

type EnumCase = {
  name: string;
  schema: ZodType;
  values: readonly string[];
  accepts: string[];
  rejects: unknown[];
};

const enumCases: EnumCase[] = [
  {
    name: "Locale",
    schema: Locale,
    values: LOCALES,
    accepts: ["kk", "ru", "en"],
    rejects: ["de", "KK", "", null, 1],
  },
  {
    name: "TrustStatus",
    schema: TrustStatus,
    values: TRUST_STATUSES,
    accepts: ["COMMUNITY", "REVIEWED", "EXPERT_VERIFIED", "ACADEMY_VERIFIED"],
    rejects: ["community", "Reviewed", "VERIFIED", "", undefined],
  },
  {
    name: "Equipment",
    schema: Equipment,
    values: EQUIPMENT,
    accepts: ["nothing", "ball", "ball_wall", "cones", "full_field"],
    rejects: ["markers", "ball + wall", "BALL", "", 0],
  },
  {
    name: "Space",
    schema: Space,
    values: SPACES,
    accepts: ["home_3x3", "yard", "field", "gym"],
    rejects: ["room", "home", "YARD", "", null],
  },
  {
    name: "ExperienceLevel",
    schema: ExperienceLevel,
    values: EXPERIENCE_LEVELS,
    accepts: ["beginner", "basic", "intermediate"],
    rejects: ["expert", "Beginner", "", 1],
  },
  {
    name: "Goal",
    schema: Goal,
    values: GOALS,
    accepts: ["control", "dribbling", "passing", "weakfoot", "coordination"],
    rejects: ["weak-foot", "shooting", "Control", "", null],
  },
  {
    name: "LicenseId",
    schema: LicenseId,
    values: LICENSE_IDS,
    accepts: ["CC-BY-SA-4.0", "CC-BY-4.0", "CC0-1.0"],
    rejects: ["CC BY-SA 4.0", "MIT", "cc-by-sa-4.0", "", null],
  },
];

describe.each(enumCases)("enum $name", ({ schema, values, accepts, rejects }) => {
  test.each(accepts)("accepts %p", (sample) => {
    expect(schema.safeParse(sample).success).toBe(true);
  });

  test("rejects forbidden values", () => {
    for (const sample of rejects) {
      expect(schema.safeParse(sample).success).toBe(false);
    }
  });

  test("values array contains the sample values", () => {
    for (const sample of accepts) {
      expect(values).toContain(sample);
    }
  });

  test("every element of the values array parses", () => {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(schema.safeParse(value).success).toBe(true);
    }
  });
});

describe("LicenseId default", () => {
  test("DEFAULT_LICENSE_ID is CC-BY-SA-4.0", () => {
    expect(DEFAULT_LICENSE_ID).toBe("CC-BY-SA-4.0");
  });

  test("a default applied by the schema yields CC-BY-SA-4.0 for undefined", () => {
    const withDefault = z.object({ license: LicenseId.default(DEFAULT_LICENSE_ID) });
    expect(withDefault.parse({}).license).toBe("CC-BY-SA-4.0");
    expect(withDefault.parse({ license: "CC0-1.0" }).license).toBe("CC0-1.0");
  });
});

describe("Locale fallbacks", () => {
  test("fallback order is ru then en", () => {
    expect([...LOCALE_FALLBACKS]).toEqual(["ru", "en"]);
  });
});

describe("LocalizedText", () => {
  test("accepts text with a single locale", () => {
    expect(LocalizedText.safeParse({ ru: "Привет" }).success).toBe(true);
  });

  test("accepts text with all locales", () => {
    expect(LocalizedText.safeParse({ kk: "Сәлем", ru: "Привет", en: "Hello" }).success).toBe(true);
  });

  test("rejects an empty object", () => {
    expect(LocalizedText.safeParse({}).success).toBe(false);
  });

  test("rejects all-blank values", () => {
    expect(LocalizedText.safeParse({ kk: "", ru: "   ", en: "\n\t" }).success).toBe(false);
  });

  test("rejects unknown keys", () => {
    expect(LocalizedText.safeParse({ ru: "Привет", de: "Hallo" }).success).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(LocalizedText.safeParse({ ru: 5 }).success).toBe(false);
  });
});

describe("pickLocalized", () => {
  test("returns the requested locale when present", () => {
    expect(pickLocalized({ kk: "Сәлем", ru: "Привет", en: "Hello" }, "kk")).toBe("Сәлем");
    expect(pickLocalized({ kk: "Сәлем", ru: "Привет", en: "Hello" }, "en")).toBe("Hello");
  });

  test("falls back from the requested locale to ru", () => {
    expect(pickLocalized({ ru: "Привет", en: "Hello" }, "kk")).toBe("Привет");
  });

  test("falls back to en when both requested and ru are missing", () => {
    expect(pickLocalized({ en: "Hello" }, "kk")).toBe("Hello");
    expect(pickLocalized({ en: "Hello" }, "ru")).toBe("Hello");
  });

  test("treats blank and whitespace-only values as missing", () => {
    expect(pickLocalized({ kk: "", ru: "Привет", en: "Hello" }, "kk")).toBe("Привет");
    expect(pickLocalized({ kk: "  ", ru: "\t", en: "Hello" }, "kk")).toBe("Hello");
  });

  test("returns undefined for a kk-only text when ru or en is requested", () => {
    expect(pickLocalized({ kk: "Сәлем" }, "ru")).toBeUndefined();
    expect(pickLocalized({ kk: "Сәлем" }, "en")).toBeUndefined();
  });

  test("returns undefined when nothing is usable", () => {
    expect(pickLocalized({ kk: " ", ru: "", en: "  " }, "ru")).toBeUndefined();
    expect(pickLocalized({}, "en")).toBeUndefined();
  });
});

describe("EntityId", () => {
  test("accepts slugs", () => {
    expect(EntityId.safeParse("first-touch.v2_a").success).toBe(true);
  });

  test("accepts a nanoid-style id with mixed case and underscore/hyphen", () => {
    expect(EntityId.safeParse("V1StGXR8_Z5jdHi6B-myT").success).toBe(true);
  });

  test("accepts ids starting with - or _", () => {
    expect(EntityId.safeParse("-abc").success).toBe(true);
    expect(EntityId.safeParse("_abc").success).toBe(true);
  });

  test("rejects spaces", () => {
    expect(EntityId.safeParse("has space").success).toBe(false);
  });

  test("rejects empty", () => {
    expect(EntityId.safeParse("").success).toBe(false);
  });

  test("rejects too long", () => {
    expect(EntityId.safeParse("a".repeat(129)).success).toBe(false);
    expect(EntityId.safeParse("a".repeat(128)).success).toBe(true);
  });

  test("rejects path separators and non-ASCII", () => {
    expect(EntityId.safeParse("a/b").success).toBe(false);
    expect(EntityId.safeParse("привет").success).toBe(false);
  });
});

describe("SkillRef and DrillVersionRef", () => {
  test("SkillRef parses a skillId", () => {
    expect(SkillRef.parse({ skillId: "weakfoot" })).toEqual({ skillId: "weakfoot" });
  });

  test("SkillRef rejects a missing or invalid skillId", () => {
    expect(SkillRef.safeParse({}).success).toBe(false);
    expect(SkillRef.safeParse({ skillId: "bad id" }).success).toBe(false);
  });

  test("DrillVersionRef parses a positive integer version", () => {
    expect(DrillVersionRef.parse({ drillId: "w1", version: 3 })).toEqual({
      drillId: "w1",
      version: 3,
    });
  });

  test("DrillVersionRef rejects version 0", () => {
    expect(DrillVersionRef.safeParse({ drillId: "w1", version: 0 }).success).toBe(false);
  });

  test("DrillVersionRef rejects negative and fractional versions", () => {
    expect(DrillVersionRef.safeParse({ drillId: "w1", version: -1 }).success).toBe(false);
    expect(DrillVersionRef.safeParse({ drillId: "w1", version: 1.5 }).success).toBe(false);
  });
});

describe("ClientUuid", () => {
  const v4 = "3f2b8c1e-5d4a-4b7e-9a61-0c2d7e8f9a10";

  test("accepts a v4 uuid", () => {
    expect(ClientUuid.parse(v4)).toBe(v4);
  });

  test("lowercases an uppercase uuid", () => {
    expect(ClientUuid.parse(v4.toUpperCase())).toBe(v4);
  });

  test("rejects garbage", () => {
    expect(ClientUuid.safeParse("not-a-uuid").success).toBe(false);
    expect(ClientUuid.safeParse("").success).toBe(false);
    expect(ClientUuid.safeParse(42).success).toBe(false);
  });
});

describe("DrillContent", () => {
  const minimal = {
    goal: { ru: "Улучшить контроль" },
    instructions: { ru: "Сделайте 50 касаний" },
    dose: { reps: 50 },
    conditions: { equipment: "ball", spaces: ["yard"] },
  };

  test("parses a minimal valid drill without a title and applies defaults", () => {
    const parsed = DrillContent.parse(minimal);
    expect(parsed.title).toBeUndefined();
    expect(parsed.mistakes).toEqual([]);
    expect(parsed.progressions).toEqual([]);
    expect(parsed.regressions).toEqual([]);
    expect(parsed.safety).toEqual([]);
    expect(parsed.media).toEqual([]);
    expect(parsed.conditions.partner).toBe(false);
  });

  test("accepts an optional title", () => {
    const parsed = DrillContent.parse({ ...minimal, title: { en: "Weak Foot 50" } });
    expect(parsed.title).toEqual({ en: "Weak Foot 50" });
  });

  test("accepts a sets-only dose", () => {
    expect(DrillContent.safeParse({ ...minimal, dose: { sets: 3 } }).success).toBe(true);
  });

  test("accepts a duration-only dose", () => {
    expect(DrillContent.safeParse({ ...minimal, dose: { durationSec: 300 } }).success).toBe(true);
  });

  test("rejects a dose with none of reps, sets, durationSec", () => {
    expect(DrillContent.safeParse({ ...minimal, dose: {} }).success).toBe(false);
  });

  test("rejects a missing dose", () => {
    const { dose: _dose, ...rest } = minimal;
    expect(DrillContent.safeParse(rest).success).toBe(false);
  });

  test("rejects unknown top-level keys", () => {
    expect(DrillContent.safeParse({ ...minimal, surprise: true }).success).toBe(false);
  });

  test("rejects empty spaces", () => {
    expect(
      DrillContent.safeParse({ ...minimal, conditions: { equipment: "ball", spaces: [] } }).success,
    ).toBe(false);
  });

  test("rejects an unknown equipment or space", () => {
    expect(
      DrillContent.safeParse({ ...minimal, conditions: { equipment: "markers", spaces: ["yard"] } })
        .success,
    ).toBe(false);
    expect(
      DrillContent.safeParse({ ...minimal, conditions: { equipment: "ball", spaces: ["room"] } })
        .success,
    ).toBe(false);
  });

  test("accepts partner and age bounds", () => {
    const parsed = DrillContent.parse({
      ...minimal,
      conditions: { equipment: "cones", spaces: ["field", "gym"], partner: true, ageMin: 8, ageMax: 14 },
    });
    expect(parsed.conditions.partner).toBe(true);
    expect(parsed.conditions.ageMin).toBe(8);
    expect(parsed.conditions.ageMax).toBe(14);
  });

  test("accepts lists of localized mistakes, progressions, regressions and safety", () => {
    const parsed = DrillContent.parse({
      ...minimal,
      mistakes: [{ ru: "Носок вместо подъёма" }],
      progressions: [{ en: "One-touch" }],
      regressions: [{ en: "Stay at 2m" }],
      safety: [{ en: "Warm up first" }],
    });
    expect(parsed.mistakes).toHaveLength(1);
    expect(parsed.progressions).toHaveLength(1);
    expect(parsed.regressions).toHaveLength(1);
    expect(parsed.safety).toHaveLength(1);
  });

  describe("media urls", () => {
    const withMedia = (url: string) =>
      DrillContent.safeParse({ ...minimal, media: [{ kind: "video", url }] });

    test.each(["https://cdn.example.com/a.mp4", "http://example.com/a.png", "/uploads/x.mp4"])(
      "accepts %p",
      (url) => {
        expect(withMedia(url).success).toBe(true);
      },
    );

    test.each([
      "javascript:alert(1)",
      "//evil.example/x",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "uploads/x.mp4",
      "",
    ])("rejects %p", (url) => {
      expect(withMedia(url).success).toBe(false);
    });

    test("accepts kinds video, image, document and an optional caption", () => {
      for (const kind of ["video", "image", "document"]) {
        expect(
          DrillContent.safeParse({
            ...minimal,
            media: [{ kind, url: "/uploads/x", caption: { en: "Demo" } }],
          }).success,
        ).toBe(true);
      }
    });

    test("rejects an unknown media kind", () => {
      expect(
        DrillContent.safeParse({ ...minimal, media: [{ kind: "audio", url: "/uploads/x" }] }).success,
      ).toBe(false);
    });
  });
});

describe("ProblemDetails", () => {
  test("PROBLEM_CONTENT_TYPE is application/problem+json", () => {
    expect(PROBLEM_CONTENT_TYPE).toBe("application/problem+json");
  });

  test("applies defaults for type and errors", () => {
    const parsed = ProblemDetails.parse({ title: "Not Found", status: 404 });
    expect(parsed.type).toBe("about:blank");
    expect(parsed.errors).toEqual([]);
  });

  test("parses errors[] with pointer and detail", () => {
    const parsed = ProblemDetails.parse({
      type: "https://example.com/problems/validation",
      title: "Validation failed",
      status: 422,
      detail: "One or more fields are invalid",
      instance: "/api/drills",
      errors: [
        { pointer: "/dose/reps", detail: "Required" },
        { pointer: "", detail: "Whole document invalid" },
      ],
    });
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toEqual({ pointer: "/dose/reps", detail: "Required" });
    expect(parsed.errors[1]?.pointer).toBe("");
  });

  test("extension members survive parsing", () => {
    const parsed = ProblemDetails.parse({
      title: "Too Many Requests",
      status: 429,
      retryAfterSec: 30,
    }) as Record<string, unknown>;
    expect(parsed.retryAfterSec).toBe(30);
  });

  test("error entries keep their own extension members", () => {
    const parsed = ProblemDetails.parse({
      title: "Bad",
      status: 400,
      errors: [{ pointer: "/a", detail: "x", code: "too_small" }],
    });
    expect((parsed.errors[0] as Record<string, unknown>).code).toBe("too_small");
  });

  test("rejects a pointer without a leading slash", () => {
    expect(
      ProblemDetails.safeParse({
        title: "Bad",
        status: 400,
        errors: [{ pointer: "dose/reps", detail: "Required" }],
      }).success,
    ).toBe(false);
  });

  test("rejects an error entry without detail", () => {
    expect(
      ProblemDetails.safeParse({ title: "Bad", status: 400, errors: [{ pointer: "/a" }] }).success,
    ).toBe(false);
  });

  test("rejects status outside 100-599 and non-integers", () => {
    expect(ProblemDetails.safeParse({ title: "x", status: 99 }).success).toBe(false);
    expect(ProblemDetails.safeParse({ title: "x", status: 600 }).success).toBe(false);
    expect(ProblemDetails.safeParse({ title: "x", status: 404.5 }).success).toBe(false);
  });

  test("rejects a missing title", () => {
    expect(ProblemDetails.safeParse({ status: 404 }).success).toBe(false);
  });
});

describe("HealthResponse", () => {
  test("DATABASE_STATES contains ok and error", () => {
    expect(DATABASE_STATES).toContain("ok");
    expect(DATABASE_STATES).toContain("error");
  });

  test("accepts {ok, version, database: 'ok'}", () => {
    expect(HealthResponse.safeParse({ ok: true, version: "0.1.0", database: "ok" }).success).toBe(true);
  });

  test("accepts database 'error'", () => {
    expect(HealthResponse.safeParse({ ok: false, version: "0.1.0", database: "error" }).success).toBe(
      true,
    );
  });

  test("keeps extra fields", () => {
    const parsed = HealthResponse.parse({
      ok: true,
      version: "0.1.0",
      database: "ok",
      drillCount: 12,
    }) as Record<string, unknown>;
    expect(parsed.drillCount).toBe(12);
  });

  test("rejects database 'up'", () => {
    expect(HealthResponse.safeParse({ ok: true, version: "0.1.0", database: "up" }).success).toBe(false);
  });

  test("rejects an empty version and a non-boolean ok", () => {
    expect(HealthResponse.safeParse({ ok: true, version: "", database: "ok" }).success).toBe(false);
    expect(HealthResponse.safeParse({ ok: "yes", version: "1", database: "ok" }).success).toBe(false);
  });
});

describe("paginated()", () => {
  const Page = paginated(z.object({ id: z.string() }));

  test("parses items with nextCursor null", () => {
    const parsed = Page.parse({ items: [{ id: "a" }, { id: "b" }], nextCursor: null });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.nextCursor).toBeNull();
  });

  test("parses a string cursor and an optional total", () => {
    const parsed = Page.parse({ items: [], nextCursor: "abc", total: 40 });
    expect(parsed.nextCursor).toBe("abc");
    expect(parsed.total).toBe(40);
  });

  test("rejects items failing the item schema", () => {
    expect(Page.safeParse({ items: [{ id: 1 }], nextCursor: null }).success).toBe(false);
  });

  test("rejects a missing nextCursor and a fractional total", () => {
    expect(Page.safeParse({ items: [] }).success).toBe(false);
    expect(Page.safeParse({ items: [], nextCursor: null, total: 1.5 }).success).toBe(false);
  });
});

describe("web-bundle safety", () => {
  test("primitives.ts imports only from 'zod'", () => {
    const source = readFileSync(join(import.meta.dir, "primitives.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/\bimport\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((m) => m[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toBe("zod");
    }
  });
});
