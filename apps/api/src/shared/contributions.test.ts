import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  Contribution,
  ContributionMeta,
  ContributionMetaQuery,
  ContributionParams,
  ContributionPayloadBase,
  ContributionPayloadRequest,
  ContributionPayloadView,
  EDITABLE_STATES,
  ENDPOINTS,
  IMPROVEMENT_KINDS,
  MyContributionsResponse,
  UPLOAD_MIME_TYPES,
} from "./contributions";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const firstPath = (schema: z.ZodType, value: unknown): PropertyKey[] | undefined => {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.path;
};

const AT = "2026-09-21T08:00:00Z";

// --- Local factories: realistic payloads, fresh objects per call, one field varied per case ----

const makePayload = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "new",
  locale: "ru",
  name: "Слалом через 5 ворот",
  sport: "football",
  skill: "dribbling",
  ageMin: 8,
  ageMax: 14,
  level: "beginner",
  goal: "dribbling",
  instructions: "Поставьте пять ворот на расстоянии 1,5-2 м и проведите мяч обеими ногами.",
  durationMin: 7,
  equipment: "cones",
  mistakes: "Мяч далеко от тела.",
  progression: "Засеките время.",
  regression: "Увеличьте расстояние между воротами.",
  safety: "Разминка перед началом.",
  source: "Собственная методика",
  author: "Айгүл Т.",
  rightsAttested: true,
  noCommercialContent: true,
  website: "",
  ...patch,
});

const makeImprovement = (patch: Record<string, unknown> = {}): Record<string, unknown> =>
  makePayload({
    kind: "improvement",
    targetDrillSlug: "five-gate-slalom",
    improvementKind: "simpler_variant",
    ...patch,
  });

/** A stored payload as the server returns it: no attestations, no honeypot. */
const makeStoredPayload = (patch: Record<string, unknown> = {}): Record<string, unknown> =>
  without(without(makePayload(patch), "rightsAttested"), "noCommercialContent");

const makeAttachment = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a-1",
  kind: "video",
  url: "/media/a-1.mp4",
  ...patch,
});

const makeContribution = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "c-1",
  state: "pending",
  payload: makeStoredPayload(),
  attachments: [makeAttachment()],
  createdAt: AT,
  updatedAt: AT,
  ...patch,
});

const makeMeta = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  sports: [{ slug: "football", name: { ru: "Футбол", en: "Football" } }],
  skills: [
    {
      slug: "ball-control",
      name: { ru: "Контроль мяча", en: "Ball control" },
      children: [
        {
          slug: "basic-touches",
          name: { ru: "Базовые касания", en: "Basic touches" },
          children: [{ slug: "inside-touch", name: { en: "Inside touch" }, children: [] }],
        },
      ],
    },
    { slug: "dribbling", name: { ru: "Дриблинг", en: "Dribbling" }, children: [] },
  ],
  levels: ["beginner", "basic", "intermediate"],
  equipment: ["nothing", "ball", "ball_wall", "cones", "full_field"],
  spaces: ["home_3x3", "yard", "field", "gym"],
  licenses: ["CC-BY-SA-4.0", "CC-BY-4.0", "CC0-1.0"],
  improvementKinds: [...IMPROVEMENT_KINDS],
  upload: { maxMb: 100, mimeTypes: [...UPLOAD_MIME_TYPES] },
  ...patch,
});

// --- Request: ContributionPayloadRequest -------------------------------------------------------

describe("ContributionPayloadRequest success", () => {
  test("parses a realistic new contribution", () => {
    const parsed = ContributionPayloadRequest.parse(makePayload());
    expect(parsed.kind).toBe("new");
    expect(parsed.name).toBe("Слалом через 5 ворот");
  });

  test("parses an improvement that names its target drill", () => {
    const parsed = ContributionPayloadRequest.parse(makeImprovement());
    expect(parsed.kind).toBe("improvement");
    expect(parsed.targetDrillSlug).toBe("five-gate-slalom");
  });

  test("a new contribution needs no targetDrillSlug", () => {
    expect(ok(ContributionPayloadRequest, without(makePayload(), "targetDrillSlug"))).toBe(true);
  });

  test("improvementKind is optional, even for an improvement", () => {
    expect(ok(ContributionPayloadRequest, without(makeImprovement(), "improvementKind"))).toBe(true);
  });
});

describe("ContributionPayloadRequest attestations", () => {
  test.each(["rightsAttested", "noCommercialContent"])("%s: false fails", (key) => {
    expect(ok(ContributionPayloadRequest, makePayload({ [key]: false }))).toBe(false);
  });

  test.each(["rightsAttested", "noCommercialContent"])("%s: missing fails", (key) => {
    expect(ok(ContributionPayloadRequest, without(makePayload(), key))).toBe(false);
  });

  test.each(["rightsAttested", "noCommercialContent"])("%s: an attestation failure points at the field", (key) => {
    expect(firstPath(ContributionPayloadRequest, makePayload({ [key]: false }))).toEqual([key]);
  });
});

describe("ContributionPayloadRequest improvement rule", () => {
  test("an improvement without targetDrillSlug fails, pointed at targetDrillSlug", () => {
    const payload = without(makeImprovement(), "targetDrillSlug");
    expect(ok(ContributionPayloadRequest, payload)).toBe(false);
    expect(firstPath(ContributionPayloadRequest, payload)).toEqual(["targetDrillSlug"]);
  });

  test("the unrefined base carries no improvement rule and stays composable (pick works)", () => {
    expect(ok(ContributionPayloadBase, without(makeImprovement(), "targetDrillSlug"))).toBe(true);
    expect(() => ContributionPayloadBase.pick({ name: true })).not.toThrow();
  });

  test("kind must be new or improvement", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ kind: "edit" }))).toBe(false);
  });

  test.each([...IMPROVEMENT_KINDS])("accepts improvementKind %p", (improvementKind) => {
    expect(ok(ContributionPayloadRequest, makeImprovement({ improvementKind }))).toBe(true);
  });

  test("rejects an unknown improvementKind", () => {
    expect(ok(ContributionPayloadRequest, makeImprovement({ improvementKind: "typo" }))).toBe(false);
  });
});

describe("ContributionPayloadRequest honeypot", () => {
  test("a non-empty website fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ website: "http://spam.example" }))).toBe(false);
  });

  test("a whitespace-only website fails (it must be empty)", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ website: " " }))).toBe(false);
  });

  test("an empty website passes", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ website: "" }))).toBe(true);
  });

  test("an absent website passes", () => {
    expect(ok(ContributionPayloadRequest, without(makePayload(), "website"))).toBe(true);
  });

  test("the honeypot failure points at website", () => {
    expect(firstPath(ContributionPayloadRequest, makePayload({ website: "x" }))).toEqual(["website"]);
  });
});

describe("ContributionPayloadRequest fields", () => {
  test.each([
    "kind",
    "locale",
    "name",
    "sport",
    "skill",
    "ageMin",
    "ageMax",
    "level",
    "goal",
    "instructions",
    "durationMin",
    "equipment",
    "mistakes",
    "progression",
    "regression",
    "safety",
    "source",
    "author",
  ])("%s is required", (key) => {
    expect(ok(ContributionPayloadRequest, without(makePayload(), key))).toBe(false);
  });

  test.each(["name", "instructions", "author", "source"])("%s must not be empty", (key) => {
    expect(ok(ContributionPayloadRequest, makePayload({ [key]: "" }))).toBe(false);
  });

  test.each(["mistakes", "progression", "regression", "safety"])("%s may be blank but must be present", (key) => {
    expect(ok(ContributionPayloadRequest, makePayload({ [key]: "" }))).toBe(true);
    expect(ok(ContributionPayloadRequest, without(makePayload(), key))).toBe(false);
  });

  test("a negative ageMin fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ ageMin: -1 }))).toBe(false);
  });

  test("a negative ageMax fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ ageMax: -1 }))).toBe(false);
  });

  test("a fractional ageMin fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ ageMin: 8.5 }))).toBe(false);
  });

  test("a fractional ageMax fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ ageMax: 14.5 }))).toBe(false);
  });

  test("a young minimum age (4) is legitimate: there is no 5..99 window", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ ageMin: 4, ageMax: 6 }))).toBe(true);
    expect(ok(ContributionPayloadRequest, makePayload({ ageMin: 0 }))).toBe(true);
  });

  test("durationMin: 0 fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ durationMin: 0 }))).toBe(false);
  });

  test("durationMin: negative fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ durationMin: -3 }))).toBe(false);
  });

  test("durationMin: non-integer fails", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ durationMin: 2.5 }))).toBe(false);
  });

  test("durationMin: a positive integer passes", () => {
    expect(ContributionPayloadRequest.parse(makePayload({ durationMin: 12 })).durationMin).toBe(12);
  });

  test.each([
    ["level", "expert"],
    ["goal", "juggling-master"],
    ["equipment", "markers"],
    ["locale", "de"],
  ])("rejects %s = %p", (key, value) => {
    expect(ok(ContributionPayloadRequest, makePayload({ [key]: value }))).toBe(false);
  });

  test("sourceUrl is optional", () => {
    expect(ok(ContributionPayloadRequest, without(makePayload(), "sourceUrl"))).toBe(true);
  });

  test("sourceUrl accepts an http(s) URL", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ sourceUrl: "https://example.org/method" }))).toBe(true);
  });

  test("sourceUrl rejects a non-http scheme", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ sourceUrl: "javascript:alert(1)" }))).toBe(false);
  });

  test("sourceUrl rejects a non-URL", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ sourceUrl: "not a url" }))).toBe(false);
  });

  test("rejects an unknown key in a request (strict)", () => {
    expect(ok(ContributionPayloadRequest, makePayload({ state: "approved" }))).toBe(false);
  });

  test("validation errors carry per-field pointers into the payload", () => {
    const result = ContributionPayloadRequest.safeParse(makePayload({ name: "", durationMin: 0 }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0]).sort()).toEqual(["durationMin", "name"]);
    }
  });
});

// --- Response: ContributionPayloadView + Contribution -----------------------------------------

describe("ContributionPayloadView (loose, refinement-free)", () => {
  test("parses a stored payload without attestations or honeypot", () => {
    expect(ContributionPayloadView.parse(makeStoredPayload()).name).toBe("Слалом через 5 ворот");
  });

  test("an improvement without a target does not fail the parse (older stored payload)", () => {
    expect(ok(ContributionPayloadView, without(makeStoredPayload({ kind: "improvement" }), "targetDrillSlug"))).toBe(
      true,
    );
  });

  test("a stored attestation of false or a non-empty honeypot does not fail the parse", () => {
    expect(ok(ContributionPayloadView, makePayload({ rightsAttested: false, website: "x" }))).toBe(true);
  });

  test("an unknown server key is stripped, not rejected", () => {
    const parsed = ContributionPayloadView.parse(makeStoredPayload({ reviewScore: 4 }));
    expect(parsed).not.toHaveProperty("reviewScore");
  });

  test("a missing required field still fails", () => {
    expect(ok(ContributionPayloadView, without(makeStoredPayload(), "name"))).toBe(false);
  });
});

describe("Contribution", () => {
  test("parses a pending contribution with a minimal attachment", () => {
    const parsed = Contribution.parse(makeContribution());
    expect(parsed.id).toBe("c-1");
    expect(parsed.state).toBe("pending");
    expect(parsed.attachments).toEqual([{ id: "a-1", kind: "video", url: "/media/a-1.mp4" }]);
  });

  test("an attachment may carry filename, mimeType and size", () => {
    const attachment = makeAttachment({ filename: "slalom.mp4", mimeType: "video/mp4", size: 5_000_000 });
    const parsed = Contribution.parse(makeContribution({ attachments: [attachment] }));
    expect(parsed.attachments[0]).toMatchObject({ filename: "slalom.mp4", mimeType: "video/mp4", size: 5_000_000 });
  });

  test("a contribution with no attachments parses", () => {
    expect(ok(Contribution, makeContribution({ attachments: [] }))).toBe(true);
  });

  test.each(["pending", "changes_requested", "approved", "rejected", "withdrawn"])("accepts state %p", (state) => {
    expect(ok(Contribution, makeContribution({ state }))).toBe(true);
  });

  test("rejects an unknown state", () => {
    expect(ok(Contribution, makeContribution({ state: "draft" }))).toBe(false);
  });

  test("reviewerNote and resultingDrillSlug are optional and kept when present", () => {
    expect(ok(Contribution, makeContribution())).toBe(true);
    const parsed = Contribution.parse(
      makeContribution({ state: "approved", reviewerNote: "Thanks!", resultingDrillSlug: "five-gate-slalom" }),
    );
    expect(parsed.reviewerNote).toBe("Thanks!");
    expect(parsed.resultingDrillSlug).toBe("five-gate-slalom");
  });

  test.each(["id", "state", "payload", "attachments", "createdAt", "updatedAt"])(
    "rejects a contribution missing %s",
    (key) => {
      expect(ok(Contribution, without(makeContribution(), key))).toBe(false);
    },
  );

  test.each(["createdAt", "updatedAt"])("%s must be an ISO timestamp", (key) => {
    expect(ok(Contribution, makeContribution({ [key]: "yesterday" }))).toBe(false);
  });

  test.each(["id", "kind", "url"])("an attachment missing %s fails", (key) => {
    expect(ok(Contribution, makeContribution({ attachments: [without(makeAttachment(), key)] }))).toBe(false);
  });

  test("an attachment with an unknown kind fails", () => {
    expect(ok(Contribution, makeContribution({ attachments: [makeAttachment({ kind: "audio" })] }))).toBe(false);
  });

  test("an attachment with a negative size fails", () => {
    expect(ok(Contribution, makeContribution({ attachments: [makeAttachment({ size: -1 })] }))).toBe(false);
  });

  test("the payload of a response is validated (a missing name fails)", () => {
    expect(ok(Contribution, makeContribution({ payload: without(makeStoredPayload(), "name") }))).toBe(false);
  });

  test("an unknown server key is stripped from the response, its attachments and its payload", () => {
    const parsed = Contribution.parse(
      makeContribution({
        internalFlag: true,
        payload: makeStoredPayload({ reviewScore: 4 }),
        attachments: [makeAttachment({ storageKey: "s3://x" })],
      }),
    );
    expect(parsed).not.toHaveProperty("internalFlag");
    expect(parsed.payload).not.toHaveProperty("reviewScore");
    expect(parsed.attachments[0]).not.toHaveProperty("storageKey");
  });
});

describe("MyContributionsResponse", () => {
  test("is a bare array of contributions", () => {
    expect(ok(MyContributionsResponse, [makeContribution(), makeContribution({ id: "c-2" })])).toBe(true);
  });

  test("an empty list parses", () => {
    expect(ok(MyContributionsResponse, [])).toBe(true);
  });

  test("an envelope object is not a bare array", () => {
    expect(ok(MyContributionsResponse, { items: [makeContribution()] })).toBe(false);
  });

  test("one bad contribution fails the list", () => {
    expect(ok(MyContributionsResponse, [makeContribution(), makeContribution({ state: "draft" })])).toBe(false);
  });
});

describe("EDITABLE_STATES", () => {
  test("only changes_requested and pending are editable", () => {
    expect([...EDITABLE_STATES].sort()).toEqual(["changes_requested", "pending"]);
  });
});

// --- GET /api/contribute/meta ------------------------------------------------------------------

describe("ContributionMeta", () => {
  test("parses a realistic meta payload", () => {
    const parsed = ContributionMeta.parse(makeMeta());
    expect(parsed.sports[0]?.slug).toBe("football");
    expect(parsed.upload.maxMb).toBe(100);
    expect(parsed.upload.mimeTypes).toEqual([...UPLOAD_MIME_TYPES]);
  });

  test("the skills tree recurses two levels deep", () => {
    const parsed = ContributionMeta.parse(makeMeta());
    expect(parsed.skills[0]?.children[0]?.children[0]?.slug).toBe("inside-touch");
  });

  test("a bad node deep in the skills tree fails", () => {
    const skills = [
      {
        slug: "a",
        name: { en: "A" },
        children: [{ slug: "b", name: { en: "B" }, children: [{ slug: "bad id", name: { en: "C" }, children: [] }] }],
      },
    ];
    expect(ok(ContributionMeta, makeMeta({ skills }))).toBe(false);
  });

  test("a skill node without children fails", () => {
    const skills = [{ slug: "dribbling", name: { en: "Dribbling" } }];
    expect(ok(ContributionMeta, makeMeta({ skills }))).toBe(false);
  });

  test("a skill name with no usable text fails", () => {
    const skills = [{ slug: "dribbling", name: {}, children: [] }];
    expect(ok(ContributionMeta, makeMeta({ skills }))).toBe(false);
  });

  test("an empty sports list fails", () => {
    expect(ok(ContributionMeta, makeMeta({ sports: [] }))).toBe(false);
  });

  test("a sport name with no usable text fails", () => {
    expect(ok(ContributionMeta, makeMeta({ sports: [{ slug: "football", name: {} }] }))).toBe(false);
  });

  test("an empty upload.mimeTypes list fails", () => {
    expect(ok(ContributionMeta, makeMeta({ upload: { maxMb: 100, mimeTypes: [] } }))).toBe(false);
  });

  test.each([0, -5])("upload.maxMb: %p fails", (maxMb) => {
    expect(ok(ContributionMeta, makeMeta({ upload: { maxMb, mimeTypes: [...UPLOAD_MIME_TYPES] } }))).toBe(false);
  });

  test("upload.maxMb may be fractional", () => {
    expect(ok(ContributionMeta, makeMeta({ upload: { maxMb: 0.5, mimeTypes: ["image/png"] } }))).toBe(true);
  });

  test("the server may add upload mime types (items are plain strings)", () => {
    const upload = { maxMb: 100, mimeTypes: [...UPLOAD_MIME_TYPES, "image/webp"] };
    expect(ok(ContributionMeta, makeMeta({ upload }))).toBe(true);
  });

  test("an empty upload mime type string fails", () => {
    expect(ok(ContributionMeta, makeMeta({ upload: { maxMb: 100, mimeTypes: [""] } }))).toBe(false);
  });

  test.each(["sports", "skills", "levels", "equipment", "spaces", "licenses", "improvementKinds", "upload"])(
    "rejects meta missing %s",
    (key) => {
      expect(ok(ContributionMeta, without(makeMeta(), key))).toBe(false);
    },
  );

  test.each(["maxMb", "mimeTypes"])("rejects upload missing %s", (key) => {
    expect(ok(ContributionMeta, makeMeta({ upload: without({ maxMb: 100, mimeTypes: ["image/png"] }, key) }))).toBe(
      false,
    );
  });

  test("an unknown level, equipment, space or license fails", () => {
    expect(ok(ContributionMeta, makeMeta({ levels: ["expert"] }))).toBe(false);
    expect(ok(ContributionMeta, makeMeta({ equipment: ["markers"] }))).toBe(false);
    expect(ok(ContributionMeta, makeMeta({ spaces: ["moon"] }))).toBe(false);
    expect(ok(ContributionMeta, makeMeta({ licenses: ["MIT"] }))).toBe(false);
  });

  test("an unknown improvement kind fails", () => {
    expect(ok(ContributionMeta, makeMeta({ improvementKinds: ["typo"] }))).toBe(false);
  });

  test.each([...IMPROVEMENT_KINDS])("accepts improvement kind %p", (kind) => {
    expect(ok(ContributionMeta, makeMeta({ improvementKinds: [kind] }))).toBe(true);
  });

  test("an unknown server key is stripped", () => {
    expect(ContributionMeta.parse(makeMeta({ extra: 1 }))).not.toHaveProperty("extra");
  });
});

describe("criteria constants", () => {
  test("the improvement kinds are exactly the eight the criteria name", () => {
    expect([...IMPROVEMENT_KINDS]).toEqual([
      "explanation",
      "progression",
      "simpler_variant",
      "age_adaptation",
      "translation",
      "video",
      "accessibility",
      "safety",
    ]);
  });

  test("the upload mime types are exactly the six the criteria name", () => {
    expect([...UPLOAD_MIME_TYPES]).toEqual([
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "image/jpeg",
      "image/png",
      "application/pdf",
    ]);
  });
});

// --- Endpoints ---------------------------------------------------------------------------------

describe("ENDPOINTS", () => {
  test("getMeta is GET /api/contribute/meta with an optional locale query", () => {
    expect(ENDPOINTS.getMeta).toMatchObject({ method: "GET", path: "/api/contribute/meta" });
    expect(ENDPOINTS.getMeta.response).toBe(ContributionMeta);
    expect(ENDPOINTS.getMeta.query).toBe(ContributionMetaQuery);
    expect(ok(ContributionMetaQuery, {})).toBe(true);
    expect(ok(ContributionMetaQuery, { locale: "kk" })).toBe(true);
    expect(ok(ContributionMetaQuery, { locale: "de" })).toBe(false);
    expect(ok(ContributionMetaQuery, { extra: "1" })).toBe(false);
  });

  test("createContribution is a multipart POST /api/contributions returning a Contribution", () => {
    expect(ENDPOINTS.createContribution).toMatchObject({
      method: "POST",
      path: "/api/contributions",
      contentType: "multipart/form-data",
    });
    expect(ENDPOINTS.createContribution.request).toBe(ContributionPayloadRequest);
    expect(ENDPOINTS.createContribution.response).toBe(Contribution);
  });

  test("listMine is GET /api/contributions/mine returning the bare array", () => {
    expect(ENDPOINTS.listMine).toMatchObject({ method: "GET", path: "/api/contributions/mine" });
    expect(ENDPOINTS.listMine.response).toBe(MyContributionsResponse);
  });

  test("updateContribution is a multipart PUT /api/contributions/:id returning a Contribution", () => {
    expect(ENDPOINTS.updateContribution).toMatchObject({
      method: "PUT",
      path: "/api/contributions/:id",
      contentType: "multipart/form-data",
    });
    expect(ENDPOINTS.updateContribution.params).toBe(ContributionParams);
    expect(ENDPOINTS.updateContribution.request).toBe(ContributionPayloadRequest);
    expect(ENDPOINTS.updateContribution.response).toBe(Contribution);
  });

  test("withdrawContribution is DELETE /api/contributions/:id returning a Contribution", () => {
    expect(ENDPOINTS.withdrawContribution).toMatchObject({ method: "DELETE", path: "/api/contributions/:id" });
    expect(ENDPOINTS.withdrawContribution.params).toBe(ContributionParams);
    expect(ENDPOINTS.withdrawContribution.response).toBe(Contribution);
  });

  test("the id param is a strict EntityId", () => {
    expect(ok(ContributionParams, { id: "c-1" })).toBe(true);
    expect(ok(ContributionParams, {})).toBe(false);
    expect(ok(ContributionParams, { id: "bad id" })).toBe(false);
    expect(ok(ContributionParams, { id: "c-1", extra: "x" })).toBe(false);
  });

  test("every :param in a path has a params schema key", () => {
    for (const endpoint of [ENDPOINTS.updateContribution, ENDPOINTS.withdrawContribution]) {
      expect([...endpoint.path.matchAll(/:(\w+)/g)].map((m) => m[1])).toEqual(Object.keys(endpoint.params.shape));
    }
  });
});

// --- Web-bundle safety -------------------------------------------------------------------------

describe("web-bundle safety", () => {
  test("imports only zod, ./primitives and ./domain", () => {
    const source = readFileSync(join(import.meta.dir, "contributions.ts"), "utf8");
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
