import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { PlayerProfileView, Roadmap } from "./domain";
import {
  Consents,
  DEFAULT_CONSENTS,
  ENDPOINTS,
  PlayerExport,
  RECOVERY_CODE_PATTERN,
  RecoverRequest,
  RecoverResponse,
  RecoveryCodeResponse,
  UpdateConsentsRequest,
  isConsentUpdateAllowed,
  normalizeRecoveryCode,
} from "./privacy";
import type { Consents as ConsentsType } from "./privacy";

// --- Local factories: a realistic payload, then ONE violation per negative case ------

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = (value: object, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

const AT = "2026-09-21T08:00:00Z";
const CODE = "ABCD-EF12-GH34-JK56";

const makeConsents = (): ConsentsType => ({
  videoAnalysis: { granted: true, at: AT, guardianConfirmed: true },
  modelImprovement: { granted: false },
});

const makeProfile = (): PlayerProfileView => ({
  age: 12,
  level: "beginner",
  goal: "control",
  equipment: "ball",
  space: "yard",
  partner: false,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: "ru",
});

const makeRoadmap = (): Roadmap => ({
  currentLevelLabel: "Foundation",
  tracks: [{ skill: "ball", level: 2, source: "test" }],
  goal: "control",
  weeks: 4,
  sessionsPerWeek: 3,
  minutesPerSession: 20,
  focus: [
    { skill: "passing", level: 1, targetLevel: 2, reason: "Weakest area." },
    { skill: "ball", level: 2, targetLevel: 3, reason: "Your goal." },
  ],
});

/** The consents with `patch` merged into videoAnalysis. */
const consentsWithVideo = (patch: Record<string, unknown>) => ({
  ...makeConsents(),
  videoAnalysis: { ...makeConsents().videoAnalysis, ...patch },
});

/** The consents with `patch` merged into modelImprovement. */
const consentsWithModel = (patch: Record<string, unknown>) => ({
  ...makeConsents(),
  modelImprovement: { ...makeConsents().modelImprovement, ...patch },
});

// --- Consents (GET /api/player/consents, PUT response) ------------------------------------

describe("Consents", () => {
  test("parses a granted video-analysis consent with a guardian and keeps the values", () => {
    const parsed = Consents.parse(makeConsents());
    expect(parsed.videoAnalysis).toEqual({ granted: true, at: AT, guardianConfirmed: true });
    expect(parsed.modelImprovement).toEqual({ granted: false });
  });

  test("a granted model-improvement consent carries its timestamp", () => {
    const parsed = Consents.parse(consentsWithModel({ granted: true, at: AT }));
    expect(parsed.modelImprovement).toEqual({ granted: true, at: AT });
  });

  test("at is optional on both consents", () => {
    const parsed = Consents.parse({ videoAnalysis: { granted: false }, modelImprovement: { granted: false } });
    expect(parsed.videoAnalysis.at).toBeUndefined();
    expect(parsed.modelImprovement.at).toBeUndefined();
  });

  test("guardianConfirmed is accepted on videoAnalysis (true and false) and optional", () => {
    expect(Consents.parse(consentsWithVideo({ guardianConfirmed: true })).videoAnalysis.guardianConfirmed).toBe(true);
    expect(Consents.parse(consentsWithVideo({ guardianConfirmed: false })).videoAnalysis.guardianConfirmed).toBe(false);
    expect(Consents.parse(consentsWithVideo({ guardianConfirmed: undefined })).videoAnalysis.guardianConfirmed).toBeUndefined();
  });

  test("rejects a non-boolean guardianConfirmed", () => {
    expect(ok(Consents, consentsWithVideo({ guardianConfirmed: "yes" }))).toBe(false);
  });

  test.each(["videoAnalysis", "modelImprovement"])("rejects consents missing %s", (key) => {
    expect(ok(Consents, without(makeConsents(), key))).toBe(false);
  });

  test("rejects videoAnalysis without granted", () => {
    expect(ok(Consents, consentsWithVideo({ granted: undefined }))).toBe(false);
  });

  test("rejects modelImprovement without granted", () => {
    expect(ok(Consents, consentsWithModel({ granted: undefined }))).toBe(false);
  });

  test("rejects a null granted", () => {
    expect(ok(Consents, consentsWithVideo({ granted: null }))).toBe(false);
  });

  test("rejects videoAnalysis granted 'yes'", () => {
    expect(ok(Consents, consentsWithVideo({ granted: "yes" }))).toBe(false);
  });

  test("rejects modelImprovement granted 'yes'", () => {
    expect(ok(Consents, consentsWithModel({ granted: "yes" }))).toBe(false);
  });

  test("rejects a videoAnalysis 'at' that is not a timestamp", () => {
    expect(ok(Consents, consentsWithVideo({ at: "today" }))).toBe(false);
  });

  test("rejects a modelImprovement 'at' that is not a timestamp", () => {
    expect(ok(Consents, consentsWithModel({ at: "2026-09-21" }))).toBe(false);
  });

  test("unknown server keys are stripped at the top level and inside each consent", () => {
    const parsed = Consents.parse({
      ...makeConsents(),
      extra: 1,
      videoAnalysis: { ...makeConsents().videoAnalysis, serverOnly: true },
      modelImprovement: { granted: false, guardianConfirmed: true },
    });
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed.videoAnalysis).not.toHaveProperty("serverOnly");
    expect(parsed.modelImprovement).not.toHaveProperty("guardianConfirmed");
  });
});

describe("DEFAULT_CONSENTS: both default false", () => {
  test("parses as Consents", () => {
    expect(ok(Consents, DEFAULT_CONSENTS)).toBe(true);
  });

  test("video analysis is off", () => {
    expect(DEFAULT_CONSENTS.videoAnalysis.granted).toBe(false);
  });

  test("model improvement is off", () => {
    expect(DEFAULT_CONSENTS.modelImprovement.granted).toBe(false);
  });

  test("the default is a constant, not a schema default: an empty object still fails to parse", () => {
    expect(ok(Consents, {})).toBe(false);
  });
});

// --- UpdateConsentsRequest (PUT /api/player/consents) ------------------------------------

describe("UpdateConsentsRequest", () => {
  test("an empty update parses (every key is optional)", () => {
    expect(UpdateConsentsRequest.parse({})).toEqual({});
  });

  test.each([
    ["videoAnalysis", true],
    ["videoAnalysis", false],
    ["modelImprovement", true],
    ["modelImprovement", false],
    ["guardianConfirmed", true],
    ["guardianConfirmed", false],
  ])("%s: %p alone is a valid update", (key, value) => {
    expect(UpdateConsentsRequest.parse({ [key]: value })).toEqual({ [key]: value });
  });

  test("all three keys parse together and keep their values", () => {
    const update = { videoAnalysis: true, modelImprovement: false, guardianConfirmed: true };
    expect(UpdateConsentsRequest.parse(update)).toEqual(update);
  });

  test("rejects an unknown key", () => {
    expect(ok(UpdateConsentsRequest, { videoAnalysis: true, extra: 1 })).toBe(false);
  });

  test("a client cannot set the server's timestamp: 'at' is rejected", () => {
    expect(ok(UpdateConsentsRequest, { videoAnalysis: true, at: AT })).toBe(false);
  });

  test("values are booleans, not the response's {granted} objects", () => {
    expect(ok(UpdateConsentsRequest, { videoAnalysis: { granted: true } })).toBe(false);
  });

  test("rejects a non-boolean videoAnalysis", () => {
    expect(ok(UpdateConsentsRequest, { videoAnalysis: "true" })).toBe(false);
  });

  test("rejects a non-boolean modelImprovement", () => {
    expect(ok(UpdateConsentsRequest, { modelImprovement: 1 })).toBe(false);
  });

  test("rejects a non-boolean guardianConfirmed", () => {
    expect(ok(UpdateConsentsRequest, { guardianConfirmed: "yes" })).toBe(false);
  });

  test("rejects a null value", () => {
    expect(ok(UpdateConsentsRequest, { videoAnalysis: null })).toBe(false);
  });
});

// --- The under-13 rule ----------------------------------------------------------------------

describe("isConsentUpdateAllowed: players under 13 need a guardian to grant video analysis", () => {
  test("age 12 granting videoAnalysis without a guardian is refused", () => {
    expect(isConsentUpdateAllowed(12, { videoAnalysis: true })).toBe(false);
  });

  test("age 12 granting videoAnalysis with guardianConfirmed false is refused", () => {
    expect(isConsentUpdateAllowed(12, { videoAnalysis: true, guardianConfirmed: false })).toBe(false);
  });

  test("age 12 granting videoAnalysis with guardianConfirmed true is allowed", () => {
    expect(isConsentUpdateAllowed(12, { videoAnalysis: true, guardianConfirmed: true })).toBe(true);
  });

  test("age 13 granting videoAnalysis without a guardian is allowed (13 is not under 13)", () => {
    expect(isConsentUpdateAllowed(13, { videoAnalysis: true })).toBe(true);
  });

  test("age 5 (the youngest player) granting videoAnalysis without a guardian is refused", () => {
    expect(isConsentUpdateAllowed(5, { videoAnalysis: true })).toBe(false);
  });

  test("age 5 granting videoAnalysis with guardianConfirmed true is allowed", () => {
    expect(isConsentUpdateAllowed(5, { videoAnalysis: true, guardianConfirmed: true })).toBe(true);
  });

  test("age 12 revoking videoAnalysis is always allowed", () => {
    expect(isConsentUpdateAllowed(12, { videoAnalysis: false })).toBe(true);
  });

  test("age 12 revoking videoAnalysis is allowed even with guardianConfirmed false", () => {
    expect(isConsentUpdateAllowed(12, { videoAnalysis: false, guardianConfirmed: false })).toBe(true);
  });

  test("age 5 revoking videoAnalysis is allowed", () => {
    expect(isConsentUpdateAllowed(5, { videoAnalysis: false })).toBe(true);
  });

  test("age 12 granting modelImprovement is not gated", () => {
    expect(isConsentUpdateAllowed(12, { modelImprovement: true })).toBe(true);
  });

  test("age 12 sending only guardianConfirmed (no videoAnalysis) is not gated", () => {
    expect(isConsentUpdateAllowed(12, { guardianConfirmed: true })).toBe(true);
  });

  test("age 12 sending an empty update is not gated", () => {
    expect(isConsentUpdateAllowed(12, {})).toBe(true);
  });

  test("age 12 granting modelImprovement and revoking videoAnalysis together is allowed", () => {
    expect(isConsentUpdateAllowed(12, { videoAnalysis: false, modelImprovement: true })).toBe(true);
  });

  test("age 12 granting both consents without a guardian is refused (the video grant is gated)", () => {
    expect(isConsentUpdateAllowed(12, { videoAnalysis: true, modelImprovement: true })).toBe(false);
  });

  test("age 99 granting videoAnalysis without a guardian is allowed", () => {
    expect(isConsentUpdateAllowed(99, { videoAnalysis: true })).toBe(true);
  });
});

// --- Recovery code: the format is pinned on the REQUEST side only ----------------------------

describe("RECOVERY_CODE_PATTERN: the canonical form", () => {
  test("matches four hyphen-separated groups of four upper-case letters or digits", () => {
    expect(RECOVERY_CODE_PATTERN.test(CODE)).toBe(true);
    expect(RECOVERY_CODE_PATTERN.test("0000-0000-0000-0000")).toBe(true);
    expect(RECOVERY_CODE_PATTERN.test("ZZZZ-9999-AAAA-1111")).toBe(true);
  });

  test("does not match lower case", () => {
    expect(RECOVERY_CODE_PATTERN.test("abcd-ef12-gh34-jk56")).toBe(false);
  });

  test("does not match without hyphens (that is what normalizeRecoveryCode adds)", () => {
    expect(RECOVERY_CODE_PATTERN.test("ABCDEF12GH34JK56")).toBe(false);
  });

  test("is anchored at the start", () => {
    expect(RECOVERY_CODE_PATTERN.test(`x${CODE}`)).toBe(false);
  });

  test("is anchored at the end", () => {
    expect(RECOVERY_CODE_PATTERN.test(`${CODE}x`)).toBe(false);
  });

  test("has no global or sticky flag (a stateful regex would alternate its answer)", () => {
    expect(RECOVERY_CODE_PATTERN.global).toBe(false);
    expect(RECOVERY_CODE_PATTERN.sticky).toBe(false);
    expect(RECOVERY_CODE_PATTERN.test(CODE)).toBe(true);
    expect(RECOVERY_CODE_PATTERN.test(CODE)).toBe(true);
  });
});

describe("normalizeRecoveryCode", () => {
  test("a canonical code is unchanged", () => {
    expect(normalizeRecoveryCode(CODE)).toBe(CODE);
  });

  test("lower case is upper-cased", () => {
    expect(normalizeRecoveryCode("abcd-ef12-gh34-jk56")).toBe(CODE);
  });

  test("spaces between groups become hyphens", () => {
    expect(normalizeRecoveryCode("abcd ef12 gh34 jk56")).toBe(CODE);
  });

  test("no separators at all get hyphens", () => {
    expect(normalizeRecoveryCode("abcdef12gh34jk56")).toBe(CODE);
  });

  test("mixed hyphens and spaces normalise", () => {
    expect(normalizeRecoveryCode("abcd efgh-ijkl mnop")).toBe("ABCD-EFGH-IJKL-MNOP");
  });

  test("surrounding whitespace is dropped", () => {
    expect(normalizeRecoveryCode("  abcd-ef12-gh34-jk56\n")).toBe(CODE);
  });

  test("is idempotent", () => {
    const once = normalizeRecoveryCode("abcd efgh-ijkl mnop");
    expect(normalizeRecoveryCode(once)).toBe(once);
  });

  test("garbage in does not throw: a 15-character input is not padded", () => {
    expect(normalizeRecoveryCode("abcdef12gh34jk5")).toBe("ABCD-EF12-GH34-JK5");
  });

  test("an empty input stays empty", () => {
    expect(normalizeRecoveryCode("")).toBe("");
  });

  test("a normalised 16-character input matches the canonical pattern", () => {
    expect(RECOVERY_CODE_PATTERN.test(normalizeRecoveryCode("abcd efgh-ijkl mnop"))).toBe(true);
  });
});

describe("RecoverRequest: the typed code is normalised, then validated", () => {
  const parseCode = (code: unknown) => RecoverRequest.parse({ code }).code;

  test("the canonical code parses to itself", () => {
    expect(parseCode(CODE)).toBe(CODE);
  });

  test("a lower-case code parses to the canonical form", () => {
    expect(parseCode("abcd-ef12-gh34-jk56")).toBe(CODE);
  });

  test("a code typed with spaces parses to the canonical form", () => {
    expect(parseCode("abcd ef12 gh34 jk56")).toBe(CODE);
  });

  test("a code typed with no separators parses to the canonical form", () => {
    expect(parseCode("abcdef12gh34jk56")).toBe(CODE);
  });

  test("a code typed with mixed hyphens and spaces parses to the canonical form", () => {
    expect(parseCode("abcd efgh-ijkl mnop")).toBe("ABCD-EFGH-IJKL-MNOP");
  });

  test("a code with surrounding whitespace parses to the canonical form", () => {
    expect(parseCode("  abcd-ef12-gh34-jk56  ")).toBe(CODE);
  });

  test("rejects a 15-character code", () => {
    expect(ok(RecoverRequest, { code: "abcdef12gh34jk5" })).toBe(false);
  });

  test("rejects a 17-character code", () => {
    expect(ok(RecoverRequest, { code: "abcdef12gh34jk567" })).toBe(false);
  });

  test("rejects a code containing '!'", () => {
    expect(ok(RecoverRequest, { code: "ABCD-EF1!-GH34-JK56" })).toBe(false);
  });

  test("rejects a code containing '_'", () => {
    expect(ok(RecoverRequest, { code: "ABCD-EF1_-GH34-JK56" })).toBe(false);
  });

  test("rejects a code containing a non-ASCII letter", () => {
    expect(ok(RecoverRequest, { code: "ABCD-EF1é-GH34-JK56" })).toBe(false);
  });

  test("rejects an empty code", () => {
    expect(ok(RecoverRequest, { code: "" })).toBe(false);
  });

  test("rejects a whitespace-only code", () => {
    expect(ok(RecoverRequest, { code: "   " })).toBe(false);
  });

  test("rejects a non-string code", () => {
    expect(ok(RecoverRequest, { code: 1234567812345678 })).toBe(false);
  });

  test("rejects a request with no code", () => {
    expect(ok(RecoverRequest, {})).toBe(false);
  });

  test("rejects an unknown key", () => {
    expect(ok(RecoverRequest, { code: CODE, extra: 1 })).toBe(false);
  });

  test("a malformed code is reported at /code", () => {
    const result = RecoverRequest.safeParse({ code: "ABCD-EF12" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["code"]);
  });
});

describe("RecoveryCodeResponse: the shown-once code is not re-validated on the client", () => {
  test("parses a code and its creation time", () => {
    expect(RecoveryCodeResponse.parse({ code: CODE, createdAt: AT })).toEqual({ code: CODE, createdAt: AT });
  });

  test("accepts a code in a format other than 4x4 (the format is pinned on the request side only)", () => {
    expect(ok(RecoveryCodeResponse, { code: "abc-123", createdAt: AT })).toBe(true);
  });

  test("rejects an empty code", () => {
    expect(ok(RecoveryCodeResponse, { code: "", createdAt: AT })).toBe(false);
  });

  test("rejects a response with no code", () => {
    expect(ok(RecoveryCodeResponse, { createdAt: AT })).toBe(false);
  });

  test("rejects a response with no createdAt", () => {
    expect(ok(RecoveryCodeResponse, { code: CODE })).toBe(false);
  });

  test("rejects a createdAt that is not a timestamp", () => {
    expect(ok(RecoveryCodeResponse, { code: CODE, createdAt: "yesterday" })).toBe(false);
  });

  test("rejects a non-string code", () => {
    expect(ok(RecoveryCodeResponse, { code: 123456, createdAt: AT })).toBe(false);
  });

  test("unknown server keys are stripped", () => {
    expect(RecoveryCodeResponse.parse({ code: CODE, createdAt: AT, hash: "x" })).not.toHaveProperty("hash");
  });
});

// --- RecoverResponse (POST /api/player/recover) --------------------------------------------

describe("RecoverResponse: the recovered profile and roadmap", () => {
  test("parses a profile with a full roadmap and keeps the values", () => {
    const parsed = RecoverResponse.parse({ profile: makeProfile(), roadmap: makeRoadmap() });
    expect(parsed.profile.age).toBe(12);
    expect(parsed.roadmap?.weeks).toBe(4);
    expect(parsed.roadmap?.focus).toHaveLength(2);
  });

  test("a null roadmap parses (the recovered player had reset their plan)", () => {
    const parsed = RecoverResponse.parse({ profile: makeProfile(), roadmap: null });
    expect(parsed.roadmap).toBeNull();
  });

  test("rejects a response with the roadmap key missing (null, not omitted)", () => {
    expect(ok(RecoverResponse, { profile: makeProfile() })).toBe(false);
  });

  test("rejects a response with no profile", () => {
    expect(ok(RecoverResponse, { roadmap: makeRoadmap() })).toBe(false);
  });

  test("rejects a profile missing a field", () => {
    expect(ok(RecoverResponse, { profile: without(makeProfile(), "age"), roadmap: null })).toBe(false);
  });

  test("rejects an out-of-bound profile field", () => {
    expect(ok(RecoverResponse, { profile: { ...makeProfile(), age: 4 }, roadmap: null })).toBe(false);
  });

  test("rejects an invalid roadmap", () => {
    expect(ok(RecoverResponse, { profile: makeProfile(), roadmap: { ...makeRoadmap(), weeks: 3 } })).toBe(false);
  });

  test("an unknown key on the profile is stripped, not rejected", () => {
    const parsed = RecoverResponse.parse({ profile: { ...makeProfile(), id: "p1" }, roadmap: null });
    expect(parsed.profile).not.toHaveProperty("id");
  });

  test("an unknown top-level key is stripped", () => {
    const parsed = RecoverResponse.parse({ profile: makeProfile(), roadmap: null, extra: 1 });
    expect(parsed).not.toHaveProperty("extra");
  });
});

// --- PlayerExport (GET /api/player/export) --------------------------------------------------

describe("PlayerExport: everything stored about the player", () => {
  test("arbitrary keys parse and are kept", () => {
    const payload = { profile: makeProfile(), results: [{ value: 1 }], anything: { nested: true }, n: 3 };
    expect(PlayerExport.parse(payload)).toEqual(payload);
  });

  test("an empty object parses", () => {
    expect(ok(PlayerExport, {})).toBe(true);
  });

  test("rejects an array", () => {
    expect(ok(PlayerExport, [])).toBe(false);
  });

  test("rejects a string", () => {
    expect(ok(PlayerExport, "text")).toBe(false);
  });

  test("rejects null", () => {
    expect(ok(PlayerExport, null)).toBe(false);
  });
});

// --- ENDPOINTS ---------------------------------------------------------------------------------

describe("ENDPOINTS", () => {
  test("getConsents: GET /api/player/consents answers Consents", () => {
    expect(ENDPOINTS.getConsents).toMatchObject({ method: "GET", path: "/api/player/consents" });
    expect(ENDPOINTS.getConsents.response).toBe(Consents);
    expect(ENDPOINTS.getConsents).not.toHaveProperty("request");
  });

  test("updateConsents: PUT /api/player/consents takes UpdateConsentsRequest and returns the updated Consents", () => {
    expect(ENDPOINTS.updateConsents).toMatchObject({ method: "PUT", path: "/api/player/consents" });
    expect(ENDPOINTS.updateConsents.request).toBe(UpdateConsentsRequest);
    expect(ENDPOINTS.updateConsents.response).toBe(Consents);
  });

  test("createRecoveryCode: POST /api/player/recovery-code takes no body and answers RecoveryCodeResponse", () => {
    expect(ENDPOINTS.createRecoveryCode).toMatchObject({ method: "POST", path: "/api/player/recovery-code" });
    expect(ENDPOINTS.createRecoveryCode.response).toBe(RecoveryCodeResponse);
    expect(ENDPOINTS.createRecoveryCode).not.toHaveProperty("request");
  });

  test("recover: POST /api/player/recover takes RecoverRequest and answers RecoverResponse", () => {
    expect(ENDPOINTS.recover).toMatchObject({ method: "POST", path: "/api/player/recover" });
    expect(ENDPOINTS.recover.request).toBe(RecoverRequest);
    expect(ENDPOINTS.recover.response).toBe(RecoverResponse);
  });

  test("recover is not public: the client signs in anonymously first, then recover moves the data to that session", () => {
    expect(ENDPOINTS.recover).not.toHaveProperty("public");
  });

  test("exportPlayer: GET /api/player/export answers PlayerExport as application/json", () => {
    expect(ENDPOINTS.exportPlayer).toMatchObject({
      method: "GET",
      path: "/api/player/export",
      contentType: "application/json",
    });
    expect(ENDPOINTS.exportPlayer.response).toBe(PlayerExport);
  });

  test("deletePlayer: DELETE /api/player answers 204 with no response schema and no request", () => {
    expect(ENDPOINTS.deletePlayer).toEqual({ method: "DELETE", path: "/api/player", status: 204 });
    expect(ENDPOINTS.deletePlayer).not.toHaveProperty("response");
    expect(ENDPOINTS.deletePlayer).not.toHaveProperty("request");
  });

  test("the contract has exactly the six endpoints of the criteria", () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(
      ["createRecoveryCode", "deletePlayer", "exportPlayer", "getConsents", "recover", "updateConsents"].sort(),
    );
  });

  test("every endpoint is authenticated (none is marked public)", () => {
    for (const endpoint of Object.values(ENDPOINTS)) expect(endpoint).not.toHaveProperty("public");
  });
});

// --- Web-bundle safety ----------------------------------------------------------------------------

describe("web-bundle safety", () => {
  const source = readFileSync(join(import.meta.dir, "privacy.ts"), "utf8");

  test("imports only zod, ./primitives and ./domain", () => {
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
