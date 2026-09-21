import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  ANALYSE_JOURNEY,
  CONFIDENCE_LEVELS,
  CONSENT_REQUIRED_TITLE,
  CreateVideoAnalysisRequest,
  CreateVideoAnalysisResponse,
  DURATION_SEC_MAX,
  DURATION_SEC_MIN,
  ENDPOINTS,
  KEYFRAME_MAX_BYTES,
  KEYFRAME_MAX_COUNT,
  KEYFRAME_MAX_SIDE_PX,
  KEYFRAME_MIME_TYPE,
  KEYFRAME_MIN_COUNT,
  Keyframe,
  PoseFeatures,
  REPEAT_AFTER_SESSIONS,
  RERECORD_REASONS,
  RerecordResponse,
  Rubric,
  RubricParams,
  RubricQuery,
  VIDEO_ANALYSIS_TIMEOUT_MS,
  VIDEO_PROBLEM_STATUS,
  VIDEO_REQUIRED_CONSENT,
  VIDEO_REQUIRED_SETTING,
  VideoAnalysis,
  VideoAnalysisList,
  base64DecodedBytes,
  isRawVideoMediaType,
} from "./video";

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

const without = <T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
};

// --- Local factories: realistic payloads, one field varied per negative case -------------------

/** A JPEG-looking payload of exactly `bytes` bytes (SOI marker FF D8 FF, then zeros), base64 encoded. */
const jpegBase64 = (bytes: number): string => {
  const buffer = Buffer.alloc(bytes);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  return buffer.toString("base64");
};

const makeKeyframe = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  mimeType: "image/jpeg",
  data: jpegBase64(30_000),
  width: 512,
  height: 288,
  ...patch,
});

const makeFeatures = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  cadencePerMin: 84,
  leftRightBalance: 0.62,
  kneeAngleStats: { mean: 112, min: 74, max: 168, stdDev: 21 },
  trunkLeanStats: { mean: 8, min: -3, max: 19, stdDev: 5 },
  meanVisibility: 0.86,
  framesAnalysed: 240,
  ...patch,
});

const makeRequest = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  skillSlug: "dribbling",
  rubricVersion: 2,
  durationSec: 18.5,
  features: makeFeatures(),
  keyframes: [makeKeyframe(), makeKeyframe(), makeKeyframe()],
  clientUuid: "3f2b8c1e-5d4a-4e7b-9a6c-1b2d3e4f5a6b",
  ...patch,
});

const makeCriterion = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "close-control",
  label: "Close control",
  description: "How close the ball stays to the feet while moving.",
  lookFor: ["Ball stays within a step of the body", "Small touches, head up"],
  ...patch,
});

const makeRubric = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  skill: "dribbling",
  version: 2,
  criteria: [makeCriterion(), makeCriterion({ key: "rhythm", label: "Rhythm" })],
  recordingTips: ["Film from the side at hip height", "Keep the whole body in frame"],
  minVisibility: 0.6,
  ...patch,
});

const makeScore = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: "close-control",
  label: "Close control",
  score: 7,
  note: "The ball stayed close on most touches.",
  ...patch,
});

const makeRecommended = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  drillVersionId: "cone-weave-v1",
  slug: "cone-weave",
  title: "Cone weave",
  reason: "Trains the close control you scored lowest on.",
  ...patch,
});

const makeAnalysis = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "va-1",
  skillSlug: "dribbling",
  createdAt: "2026-09-21T10:00:00Z",
  beta: true,
  confidence: "medium",
  scores: [makeScore(), makeScore({ key: "rhythm", label: "Rhythm", score: 5, note: "Uneven pace." })],
  focusNext: "Keep the head up between touches.",
  recommended: [makeRecommended()],
  repeatAfterSessions: 3,
  limitations: ["Beta: based on a few frames from one clip."],
  ...patch,
});

const makeRerecord = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  rerecord: true,
  reason: "low_visibility",
  ...patch,
});

// --- Constants -----------------------------------------------------------------------------

describe("limits stated by the criteria", () => {
  test("keyframe, duration, timeout and repeat limits", () => {
    expect(KEYFRAME_MIN_COUNT).toBe(3);
    expect(KEYFRAME_MAX_COUNT).toBe(6);
    expect(KEYFRAME_MAX_BYTES).toBe(200 * 1024);
    expect(KEYFRAME_MAX_SIDE_PX).toBe(512);
    expect(KEYFRAME_MIME_TYPE).toBe("image/jpeg");
    expect(DURATION_SEC_MIN).toBe(10);
    expect(DURATION_SEC_MAX).toBe(30);
    expect(VIDEO_ANALYSIS_TIMEOUT_MS).toBe(60_000);
    expect(REPEAT_AFTER_SESSIONS).toBe(3);
  });

  test("confidence levels and re-record reasons are exposed to consumers", () => {
    expect([...CONFIDENCE_LEVELS]).toEqual(["low", "medium", "high"]);
    expect([...RERECORD_REASONS]).toEqual(["low_visibility", "too_dark", "too_short"]);
  });

  test("problem statuses and the gating consent / setting are exposed", () => {
    expect(VIDEO_PROBLEM_STATUS.consentRequired).toBe(403);
    expect(VIDEO_PROBLEM_STATUS.rawVideoRejected).toBe(415);
    expect(VIDEO_PROBLEM_STATUS.timeout).toBe(504);
    expect(CONSENT_REQUIRED_TITLE).toBe("consent required");
    expect(VIDEO_REQUIRED_CONSENT).toBe("videoAnalysis");
    expect(VIDEO_REQUIRED_SETTING).toBe("videoCoachEnabled");
  });
});

// --- GET /api/video/rubrics/:skillSlug -----------------------------------------------------

describe("Rubric", () => {
  test("accepts a full rubric", () => {
    expect(ok(Rubric, makeRubric())).toBe(true);
  });

  test("requires skill, version, criteria, recordingTips and minVisibility", () => {
    for (const key of ["skill", "version", "criteria", "recordingTips", "minVisibility"]) {
      expect(ok(Rubric, without(makeRubric(), key))).toBe(false);
    }
  });

  test("minVisibility is a 0..1 ratio", () => {
    expect(ok(Rubric, makeRubric({ minVisibility: 0 }))).toBe(true);
    expect(ok(Rubric, makeRubric({ minVisibility: 1 }))).toBe(true);
    expect(ok(Rubric, makeRubric({ minVisibility: 1.01 }))).toBe(false);
    expect(ok(Rubric, makeRubric({ minVisibility: -0.1 }))).toBe(false);
  });

  test("every criterion needs key, label, description and lookFor", () => {
    for (const key of ["key", "label", "description", "lookFor"]) {
      expect(ok(Rubric, makeRubric({ criteria: [without(makeCriterion(), key)] }))).toBe(false);
    }
  });

  test("criteria must not be empty; label must not be blank", () => {
    expect(ok(Rubric, makeRubric({ criteria: [] }))).toBe(false);
    expect(ok(Rubric, makeRubric({ criteria: [makeCriterion({ label: "" })] }))).toBe(false);
  });

  test("version is a positive integer", () => {
    expect(ok(Rubric, makeRubric({ version: 0 }))).toBe(false);
    expect(ok(Rubric, makeRubric({ version: 1.5 }))).toBe(false);
  });

  test("unknown server keys are stripped, not fatal", () => {
    const parsed = Rubric.parse(makeRubric({ internalNote: "x" }));
    expect("internalNote" in parsed).toBe(false);
  });
});

describe("RubricParams and RubricQuery", () => {
  test("params carry the skill slug", () => {
    expect(ok(RubricParams, { skillSlug: "dribbling" })).toBe(true);
    expect(ok(RubricParams, {})).toBe(false);
    expect(ok(RubricParams, { skillSlug: "" })).toBe(false);
  });

  test("locale is optional and must be kk, ru or en", () => {
    expect(ok(RubricQuery, {})).toBe(true);
    for (const locale of ["kk", "ru", "en"]) expect(ok(RubricQuery, { locale })).toBe(true);
    expect(ok(RubricQuery, { locale: "de" })).toBe(false);
  });
});

// --- POST /api/player/video-analyses: request ----------------------------------------------

describe("CreateVideoAnalysisRequest", () => {
  test("accepts a full request", () => {
    expect(ok(CreateVideoAnalysisRequest, makeRequest())).toBe(true);
  });

  test("requires skillSlug, rubricVersion, durationSec, features, keyframes and clientUuid", () => {
    for (const key of ["skillSlug", "rubricVersion", "durationSec", "features", "keyframes", "clientUuid"]) {
      expect(ok(CreateVideoAnalysisRequest, without(makeRequest(), key))).toBe(false);
    }
  });

  test("clientUuid must be a UUID", () => {
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ clientUuid: "not-a-uuid" }))).toBe(false);
  });

  test("durationSec is bounded to 10..30 seconds inclusive", () => {
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ durationSec: 10 }))).toBe(true);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ durationSec: 30 }))).toBe(true);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ durationSec: 9.9 }))).toBe(false);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ durationSec: 30.1 }))).toBe(false);
  });

  test("keyframe count is 3..6 inclusive", () => {
    const frames = (n: number) => Array.from({ length: n }, () => makeKeyframe());
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ keyframes: frames(2) }))).toBe(false);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ keyframes: frames(3) }))).toBe(true);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ keyframes: frames(6) }))).toBe(true);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ keyframes: frames(7) }))).toBe(false);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ keyframes: [] }))).toBe(false);
  });

  test("one bad keyframe fails the whole request", () => {
    const bad = makeKeyframe({ width: 513 });
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ keyframes: [makeKeyframe(), makeKeyframe(), bad] }))).toBe(false);
  });

  test("raw video is never accepted: unknown keys (video, videoBase64) fail", () => {
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ video: jpegBase64(100) }))).toBe(false);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ videoBase64: "AAAA" }))).toBe(false);
  });

  test("rubricVersion is a positive integer", () => {
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ rubricVersion: 0 }))).toBe(false);
    expect(ok(CreateVideoAnalysisRequest, makeRequest({ rubricVersion: 1.5 }))).toBe(false);
  });
});

describe("Keyframe", () => {
  test("accepts a JPEG within limits", () => {
    expect(ok(Keyframe, makeKeyframe())).toBe(true);
  });

  test("size limit: exactly 200 KB passes, one byte more fails", () => {
    expect(ok(Keyframe, makeKeyframe({ data: jpegBase64(KEYFRAME_MAX_BYTES) }))).toBe(true);
    expect(ok(Keyframe, makeKeyframe({ data: jpegBase64(KEYFRAME_MAX_BYTES + 1) }))).toBe(false);
  });

  test("longest side limit: 512 px passes on either axis, 513 fails on either axis", () => {
    expect(ok(Keyframe, makeKeyframe({ width: 512, height: 512 }))).toBe(true);
    expect(ok(Keyframe, makeKeyframe({ width: 288, height: 512 }))).toBe(true);
    expect(ok(Keyframe, makeKeyframe({ width: 513, height: 288 }))).toBe(false);
    expect(ok(Keyframe, makeKeyframe({ width: 288, height: 513 }))).toBe(false);
  });

  test("dimensions are positive integers", () => {
    expect(ok(Keyframe, makeKeyframe({ width: 0 }))).toBe(false);
    expect(ok(Keyframe, makeKeyframe({ height: -1 }))).toBe(false);
    expect(ok(Keyframe, makeKeyframe({ width: 100.5 }))).toBe(false);
  });

  test("only image/jpeg is accepted", () => {
    expect(ok(Keyframe, makeKeyframe({ mimeType: "image/png" }))).toBe(false);
    expect(ok(Keyframe, makeKeyframe({ mimeType: "video/mp4" }))).toBe(false);
  });

  test("data must be base64 of JPEG bytes", () => {
    expect(ok(Keyframe, makeKeyframe({ data: "" }))).toBe(false);
    expect(ok(Keyframe, makeKeyframe({ data: "not base64 !!!" }))).toBe(false);
    // Valid base64, but the bytes are not a JPEG (no FF D8 FF marker).
    expect(ok(Keyframe, makeKeyframe({ data: Buffer.alloc(100).toString("base64") }))).toBe(false);
  });

  test("a data: URL is not accepted (bare base64 only)", () => {
    expect(ok(Keyframe, makeKeyframe({ data: `data:image/jpeg;base64,${jpegBase64(100)}` }))).toBe(false);
  });
});

describe("base64DecodedBytes", () => {
  test("counts decoded bytes for every padding case", () => {
    for (const n of [1, 2, 3, 4, 5, 100, 1000, 204_800]) {
      expect(base64DecodedBytes(Buffer.alloc(n).toString("base64"))).toBe(n);
    }
  });
});

describe("isRawVideoMediaType", () => {
  test("recognises video/* media types, case-insensitively and with parameters", () => {
    expect(isRawVideoMediaType("video/mp4")).toBe(true);
    expect(isRawVideoMediaType("VIDEO/webm")).toBe(true);
    expect(isRawVideoMediaType("video/mp4; codecs=avc1")).toBe(true);
  });

  test("does not flag images or JSON", () => {
    expect(isRawVideoMediaType("image/jpeg")).toBe(false);
    expect(isRawVideoMediaType("application/json")).toBe(false);
    expect(isRawVideoMediaType("")).toBe(false);
  });
});

describe("PoseFeatures", () => {
  test("only meanVisibility and framesAnalysed are required", () => {
    expect(ok(PoseFeatures, { meanVisibility: 0.7, framesAnalysed: 120 })).toBe(true);
  });

  test("accepts every optional statistic", () => {
    expect(ok(PoseFeatures, makeFeatures())).toBe(true);
  });

  test("meanVisibility and framesAnalysed are mandatory", () => {
    expect(ok(PoseFeatures, without(makeFeatures(), "meanVisibility"))).toBe(false);
    expect(ok(PoseFeatures, without(makeFeatures(), "framesAnalysed"))).toBe(false);
  });

  test("meanVisibility is a 0..1 ratio; framesAnalysed a positive integer", () => {
    expect(ok(PoseFeatures, makeFeatures({ meanVisibility: 1.2 }))).toBe(false);
    expect(ok(PoseFeatures, makeFeatures({ meanVisibility: -0.1 }))).toBe(false);
    expect(ok(PoseFeatures, makeFeatures({ framesAnalysed: 0 }))).toBe(false);
    expect(ok(PoseFeatures, makeFeatures({ framesAnalysed: 10.5 }))).toBe(false);
  });

  test("leftRightBalance is a 0..1 share; cadence is non-negative", () => {
    expect(ok(PoseFeatures, makeFeatures({ leftRightBalance: 0 }))).toBe(true);
    expect(ok(PoseFeatures, makeFeatures({ leftRightBalance: 1 }))).toBe(true);
    expect(ok(PoseFeatures, makeFeatures({ leftRightBalance: 1.5 }))).toBe(false);
    expect(ok(PoseFeatures, makeFeatures({ cadencePerMin: -1 }))).toBe(false);
  });

  test("angle stats keep min <= mean <= max and need all of mean/min/max", () => {
    expect(ok(PoseFeatures, makeFeatures({ kneeAngleStats: { mean: 100, min: 120, max: 160, stdDev: 5 } }))).toBe(false);
    expect(ok(PoseFeatures, makeFeatures({ trunkLeanStats: { mean: 30, min: 0, max: 20, stdDev: 5 } }))).toBe(false);
    expect(ok(PoseFeatures, makeFeatures({ kneeAngleStats: { mean: 100, min: 80 } }))).toBe(false);
  });

  test("knee angle is within 0..180 degrees", () => {
    expect(ok(PoseFeatures, makeFeatures({ kneeAngleStats: { mean: 100, min: 80, max: 181, stdDev: 5 } }))).toBe(false);
    expect(ok(PoseFeatures, makeFeatures({ kneeAngleStats: { mean: 100, min: -5, max: 150, stdDev: 5 } }))).toBe(false);
  });

  test("features are strict: an unknown key (raw landmarks) fails", () => {
    expect(ok(PoseFeatures, makeFeatures({ landmarks: [[0, 0]] }))).toBe(false);
  });
});

// --- Responses ------------------------------------------------------------------------------

describe("VideoAnalysis", () => {
  test("accepts a full analysis", () => {
    expect(ok(VideoAnalysis, makeAnalysis())).toBe(true);
  });

  test("requires every documented field", () => {
    for (const key of [
      "id",
      "skillSlug",
      "createdAt",
      "beta",
      "confidence",
      "scores",
      "focusNext",
      "recommended",
      "repeatAfterSessions",
      "limitations",
    ]) {
      expect(ok(VideoAnalysis, without(makeAnalysis(), key))).toBe(false);
    }
  });

  test("beta is always the literal true", () => {
    expect(ok(VideoAnalysis, makeAnalysis({ beta: false }))).toBe(false);
  });

  test("repeatAfterSessions is always 3", () => {
    expect(ok(VideoAnalysis, makeAnalysis({ repeatAfterSessions: 3 }))).toBe(true);
    expect(ok(VideoAnalysis, makeAnalysis({ repeatAfterSessions: 2 }))).toBe(false);
    expect(ok(VideoAnalysis, makeAnalysis({ repeatAfterSessions: 4 }))).toBe(false);
  });

  test("confidence is low, medium or high", () => {
    for (const confidence of ["low", "medium", "high"]) {
      expect(ok(VideoAnalysis, makeAnalysis({ confidence }))).toBe(true);
    }
    expect(ok(VideoAnalysis, makeAnalysis({ confidence: "certain" }))).toBe(false);
  });

  test("each score is an integer 1..10", () => {
    for (const score of [1, 10]) expect(ok(VideoAnalysis, makeAnalysis({ scores: [makeScore({ score })] }))).toBe(true);
    for (const score of [0, 11, 5.5, -1]) {
      expect(ok(VideoAnalysis, makeAnalysis({ scores: [makeScore({ score })] }))).toBe(false);
    }
  });

  test("each score needs key, label, score and note", () => {
    for (const key of ["key", "label", "score", "note"]) {
      expect(ok(VideoAnalysis, makeAnalysis({ scores: [without(makeScore(), key)] }))).toBe(false);
    }
  });

  test("an analysis carries at least one score (scores empty is the rerecord variant)", () => {
    expect(ok(VideoAnalysis, makeAnalysis({ scores: [] }))).toBe(false);
  });

  test("each recommended drill needs drillVersionId, slug, title and reason", () => {
    expect(ok(VideoAnalysis, makeAnalysis({ recommended: [] }))).toBe(true);
    for (const key of ["drillVersionId", "slug", "title", "reason"]) {
      expect(ok(VideoAnalysis, makeAnalysis({ recommended: [without(makeRecommended(), key)] }))).toBe(false);
    }
  });

  test("limitations is a list of strings", () => {
    expect(ok(VideoAnalysis, makeAnalysis({ limitations: [] }))).toBe(true);
    expect(ok(VideoAnalysis, makeAnalysis({ limitations: [1] }))).toBe(false);
  });

  test("createdAt is an ISO timestamp", () => {
    expect(ok(VideoAnalysis, makeAnalysis({ createdAt: "yesterday" }))).toBe(false);
  });
});

describe("no overall 'you play at 63/100' number", () => {
  const FORBIDDEN = /total|overall|aggregate|average|rating|percent|^score$|^index$|^grade$/i;

  test("no top-level field of VideoAnalysis is an overall score", () => {
    for (const key of Object.keys(VideoAnalysis.shape)) expect(key).not.toMatch(FORBIDDEN);
  });

  test("the only numeric fields on VideoAnalysis are the fixed repeatAfterSessions and per-criterion scores", () => {
    const parsed = VideoAnalysis.parse(makeAnalysis());
    const numericKeys = Object.entries(parsed)
      .filter(([, value]) => typeof value === "number")
      .map(([key]) => key);
    expect(numericKeys).toEqual(["repeatAfterSessions"]);
  });

  test("a server-sent overall number is stripped from the parsed analysis", () => {
    const parsed = VideoAnalysis.parse(makeAnalysis({ overallScore: 63, total: 63, score: 63, rating: "63/100" }));
    for (const key of ["overallScore", "total", "score", "rating"]) expect(key in parsed).toBe(false);
  });

  test("the same stripping applies through the union response", () => {
    const parsed = CreateVideoAnalysisResponse.parse(makeAnalysis({ overallScore: 63 }));
    expect("overallScore" in parsed).toBe(false);
  });
});

describe("RerecordResponse", () => {
  test("accepts every reason", () => {
    for (const reason of RERECORD_REASONS) expect(ok(RerecordResponse, makeRerecord({ reason }))).toBe(true);
  });

  test("rerecord must be true and the reason is required and one of the enum", () => {
    expect(ok(RerecordResponse, makeRerecord({ rerecord: false }))).toBe(false);
    expect(ok(RerecordResponse, without(makeRerecord(), "reason"))).toBe(false);
    expect(ok(RerecordResponse, makeRerecord({ reason: "blurry" }))).toBe(false);
    expect(ok(RerecordResponse, without(makeRerecord(), "rerecord"))).toBe(false);
  });

  test("carries no scores: any scores value fails", () => {
    expect(ok(RerecordResponse, makeRerecord({ scores: [] }))).toBe(false);
    expect(ok(RerecordResponse, makeRerecord({ scores: [makeScore()] }))).toBe(false);
  });
});

describe("CreateVideoAnalysisResponse", () => {
  test("accepts an analysis", () => {
    const parsed = CreateVideoAnalysisResponse.parse(makeAnalysis());
    expect("scores" in parsed).toBe(true);
    expect("rerecord" in parsed).toBe(false);
  });

  test("accepts a rerecord variant with no scores", () => {
    const parsed = CreateVideoAnalysisResponse.parse(makeRerecord({ reason: "too_dark" }));
    expect("rerecord" in parsed && parsed.rerecord).toBe(true);
    expect("scores" in parsed).toBe(false);
  });

  test("a rerecord carrying scores is not accepted", () => {
    expect(ok(CreateVideoAnalysisResponse, makeRerecord({ scores: [makeScore()] }))).toBe(false);
  });

  test("an analysis flagged rerecord is not accepted", () => {
    expect(ok(CreateVideoAnalysisResponse, makeAnalysis({ rerecord: true }))).toBe(false);
  });

  test("an empty object and a bare reason are not accepted", () => {
    expect(ok(CreateVideoAnalysisResponse, {})).toBe(false);
    expect(ok(CreateVideoAnalysisResponse, { reason: "too_short" })).toBe(false);
  });
});

describe("VideoAnalysisList", () => {
  test("is an array of VideoAnalysis (empty allowed)", () => {
    expect(ok(VideoAnalysisList, [])).toBe(true);
    expect(ok(VideoAnalysisList, [makeAnalysis(), makeAnalysis({ id: "va-2" })])).toBe(true);
  });

  test("a rerecord result is not a stored analysis", () => {
    expect(ok(VideoAnalysisList, [makeRerecord()])).toBe(false);
  });

  test("one malformed item fails the list", () => {
    expect(ok(VideoAnalysisList, [makeAnalysis(), makeAnalysis({ beta: false })])).toBe(false);
  });
});

// --- Endpoints -------------------------------------------------------------------------------

describe("ENDPOINTS", () => {
  test("getRubric: GET /api/video/rubrics/:skillSlug with locale query", () => {
    expect(ENDPOINTS.getRubric.method).toBe("GET");
    expect(ENDPOINTS.getRubric.path).toBe("/api/video/rubrics/:skillSlug");
    expect(ENDPOINTS.getRubric.params).toBe(RubricParams);
    expect(ENDPOINTS.getRubric.query).toBe(RubricQuery);
    expect(ENDPOINTS.getRubric.response).toBe(Rubric);
  });

  test("createAnalysis: POST /api/player/video-analyses", () => {
    expect(ENDPOINTS.createAnalysis.method).toBe("POST");
    expect(ENDPOINTS.createAnalysis.path).toBe("/api/player/video-analyses");
    expect(ENDPOINTS.createAnalysis.request).toBe(CreateVideoAnalysisRequest);
    expect(ENDPOINTS.createAnalysis.response).toBe(CreateVideoAnalysisResponse);
  });

  test("listAnalyses: GET /api/player/video-analyses", () => {
    expect(ENDPOINTS.listAnalyses.method).toBe("GET");
    expect(ENDPOINTS.listAnalyses.path).toBe("/api/player/video-analyses");
    expect(ENDPOINTS.listAnalyses.response).toBe(VideoAnalysisList);
  });

  test("the analyse journey (rubric + analysis) meets the call budget of 2", () => {
    expect(ANALYSE_JOURNEY.length).toBeLessThanOrEqual(2);
    expect([...ANALYSE_JOURNEY]).toEqual(["getRubric", "createAnalysis"]);
    for (const step of ANALYSE_JOURNEY) expect(ENDPOINTS[step]).toBeDefined();
  });

  test("the analysis is synchronous: there is no status/poll endpoint", () => {
    for (const [key, spec] of Object.entries(ENDPOINTS)) {
      expect(key).not.toMatch(/status|poll|job/i);
      expect(spec.path).not.toMatch(/status|poll|job/i);
    }
  });
});

describe("web-bundle safety", () => {
  test("video.ts imports only zod, ./primitives, ./domain and ./privacy", () => {
    const source = readFileSync(join(import.meta.dir, "video.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g),
      ...source.matchAll(/^\s*import\s+(["'])([^"']+)\1/gm),
      ...source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
      ...source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g),
    ].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(["zod", "./primitives", "./domain", "./privacy"]).toContain(specifier);
  });
});
