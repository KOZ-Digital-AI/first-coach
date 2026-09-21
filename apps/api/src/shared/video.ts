// Contract: player analyses a short clip with the Beta AI Video Coach (fc-mol-0g0).
//
// Serves the video coach screens: the rubric ("what will be judged, how to film"), the
// analysis of one clip, and the history of earlier analyses. Errors on every endpoint are
// ProblemDetails (see ./primitives); not redeclared here.
//
// PRIVACY BY CONSTRUCTION: the raw video never leaves the device. The client extracts pose
// features and 3..6 small JPEG keyframes and sends only those. The request is a strict object,
// so a `video` key (or anything else unknown) fails; a `video/*` part is answered 415
// (isRawVideoMediaType is the check the server runs on the incoming Content-Type).
//
// Reading of "keyframes (image/jpeg data, each <= 200 KB, longest side <= 512 px)": each
// keyframe is { mimeType: "image/jpeg", data: <bare base64>, width, height } inside the JSON
// body. The size limit applies to the DECODED bytes. width/height are client-declared; the
// server must re-check them against the JPEG itself (a schema cannot read pixels). `data`
// must begin with the JPEG marker (FF D8 FF, base64 "/9j/").
//
// Reading of "durationSec 10-30": a real number of seconds (a clip measures 12.4 s, not 12),
// inclusive. A clip shorter than 10 s is a 422 from this schema; `too_short` is the server's
// re-record verdict for a clip whose usable content is too short (e.g. too few frames analysed).
//
// The answer to POST /api/player/video-analyses is one of two variants, both HTTP 200:
//   - VideoAnalysis: scores per rubric criterion, each 1-10, with a note;
//   - RerecordResponse { rerecord: true, reason }: NO scores at all (`scores` must be absent).
// There is deliberately NO overall number ("you play at 63/100") anywhere in the schema: the
// only numbers a VideoAnalysis holds are the per-criterion scores and the fixed
// repeatAfterSessions.
//
// Call budget: analysing takes <= 2 calls (ANALYSE_JOURNEY: rubric, then analysis). The
// analysis is SYNCHRONOUS with a 60 s server timeout (VIDEO_ANALYSIS_TIMEOUT_MS) answered
// with a 504 problem when exceeded: no async job, so no status endpoint to poll.
//
// Gate-tested / server-side, NOT parse-tested (a schema parse cannot prove them): the 403
// `consent required` problem when consent videoAnalysis is missing, the same gate for
// settings.videoCoachEnabled (its status code is not fixed by the criteria), the 415 on a
// video/* part, the 60 s timeout itself, and that keyframes really are within the pixel limit.
//
// Requests are strict: an unknown key fails. Responses stay plain objects: unknown server
// keys are stripped, so additive server changes never break cached PWA clients.
//
// Bundled into the browser through the @api-types alias: imports ONLY "zod", "./primitives",
// "./domain" and (type only) "./privacy" (no node/bun APIs, no Buffer, no side effects).
// Consumers must use `import type` for type-only names (verbatimModuleSyntax).
import { z } from "zod";
import { Timestamp } from "./domain";
import type { EndpointSpec } from "./domain";
import type { Consents } from "./privacy";
import { EntityId, Locale } from "./primitives";

// --- Limits and problem constants -----------------------------------------------------------

export const KEYFRAME_MIN_COUNT = 3;
export const KEYFRAME_MAX_COUNT = 6;
/** Decoded size limit of one keyframe: 200 KB. */
export const KEYFRAME_MAX_BYTES = 200 * 1024;
export const KEYFRAME_MAX_SIDE_PX = 512;
export const KEYFRAME_MIME_TYPE = "image/jpeg";
export const DURATION_SEC_MIN = 10;
export const DURATION_SEC_MAX = 30;
/** Hard server timeout of the (synchronous) analysis call; the web aborts its request with it. */
export const VIDEO_ANALYSIS_TIMEOUT_MS = 60_000;
/** The analysis tells the player to film again after this many sessions. */
export const REPEAT_AFTER_SESSIONS = 3;

/** The consent that gates the analysis endpoint (403 problem when it is not granted). */
export const VIDEO_REQUIRED_CONSENT = "videoAnalysis" satisfies keyof Consents;
/** The player setting that gates the video coach. */
export const VIDEO_REQUIRED_SETTING = "videoCoachEnabled";
/** `title` of the 403 ProblemDetails returned when the consent is missing. */
export const CONSENT_REQUIRED_TITLE = "consent required";

export const VIDEO_PROBLEM_STATUS = {
  consentRequired: 403,
  rawVideoRejected: 415,
  timeout: 504,
} as const;

/** True for a `video/*` Content-Type (case-insensitive, parameters allowed): the server answers 415. */
export function isRawVideoMediaType(contentType: string): boolean {
  return /^\s*video\//i.test(contentType);
}

// --- Enums ------------------------------------------------------------------------------------

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export const Confidence = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof Confidence>;

export const RERECORD_REASONS = ["low_visibility", "too_dark", "too_short"] as const;
export const RerecordReason = z.enum(RERECORD_REASONS);
export type RerecordReason = z.infer<typeof RerecordReason>;

// --- GET /api/video/rubrics/:skillSlug?locale -----------------------------------------------

export const RubricParams = z.strictObject({ skillSlug: EntityId });
export type RubricParams = z.infer<typeof RubricParams>;

/** Optional: the server picks its default locale when it is omitted. */
export const RubricQuery = z.strictObject({ locale: Locale.optional() });
export type RubricQuery = z.infer<typeof RubricQuery>;

/** A 0..1 ratio (visibility, share). */
const Ratio = z.number().min(0).max(1);

export const RubricCriterion = z.object({
  key: EntityId,
  label: z.string().min(1),
  description: z.string(),
  lookFor: z.array(z.string()),
});
export type RubricCriterion = z.infer<typeof RubricCriterion>;

/** Text is already localised by the server for the requested locale. */
export const Rubric = z.object({
  skill: EntityId,
  version: z.int().positive(),
  criteria: z.array(RubricCriterion).min(1),
  recordingTips: z.array(z.string()),
  /** Below this mean landmark visibility the server answers `rerecord: low_visibility`. */
  minVisibility: Ratio,
});
export type Rubric = z.infer<typeof Rubric>;

// --- POST /api/player/video-analyses: request -------------------------------------------------

/** Longest possible base64 text of KEYFRAME_MAX_BYTES bytes (guards the regex from huge input). */
const KEYFRAME_MAX_BASE64_CHARS = Math.ceil(KEYFRAME_MAX_BYTES / 3) * 4;

/** Decoded byte length of a well-formed (padded) base64 string. Pure arithmetic: no Buffer/atob. */
export function base64DecodedBytes(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return (base64.length / 4) * 3 - padding;
}

export const Keyframe = z.strictObject({
  mimeType: z.literal(KEYFRAME_MIME_TYPE),
  data: z
    .string()
    .min(4)
    .max(KEYFRAME_MAX_BASE64_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, { error: "Expected bare base64 (no data: URL prefix)" })
    .refine((data) => data.length % 4 === 0, { error: "Base64 must be padded to a multiple of 4" })
    .refine((data) => data.startsWith("/9j/"), { error: "Expected JPEG data (FF D8 FF marker)" })
    .refine((data) => base64DecodedBytes(data) <= KEYFRAME_MAX_BYTES, {
      error: `Keyframe exceeds ${KEYFRAME_MAX_BYTES} bytes`,
    }),
  width: z.int().positive().max(KEYFRAME_MAX_SIDE_PX),
  height: z.int().positive().max(KEYFRAME_MAX_SIDE_PX),
});
export type Keyframe = z.infer<typeof Keyframe>;

/** Summary statistics of one joint angle over the clip, in degrees; min <= mean <= max. */
const angleStats = (lowest: number, highest: number) =>
  z
    .strictObject({
      mean: z.number().min(lowest).max(highest),
      min: z.number().min(lowest).max(highest),
      max: z.number().min(lowest).max(highest),
      stdDev: z.number().nonnegative(),
    })
    .refine((stats) => stats.min <= stats.mean && stats.mean <= stats.max, {
      error: "Expected min <= mean <= max",
    });

/** Knee flexion: 0 (straight) .. 180 degrees. */
export const KneeAngleStats = angleStats(0, 180);
/** Trunk lean from vertical: negative is backwards, positive is forwards. */
export const TrunkLeanStats = angleStats(-90, 90);

/** Pose features computed on the device from the clip. Only visibility and frame count are mandatory. */
export const PoseFeatures = z.strictObject({
  cadencePerMin: z.number().nonnegative().optional(),
  /** Share of touches / load on the left side: 0 all right, 1 all left. */
  leftRightBalance: Ratio.optional(),
  kneeAngleStats: KneeAngleStats.optional(),
  trunkLeanStats: TrunkLeanStats.optional(),
  meanVisibility: Ratio,
  framesAnalysed: z.int().positive(),
});
export type PoseFeatures = z.infer<typeof PoseFeatures>;

export const CreateVideoAnalysisRequest = z.strictObject({
  skillSlug: EntityId,
  rubricVersion: z.int().positive(),
  durationSec: z.number().min(DURATION_SEC_MIN).max(DURATION_SEC_MAX),
  features: PoseFeatures,
  keyframes: z.array(Keyframe).min(KEYFRAME_MIN_COUNT).max(KEYFRAME_MAX_COUNT),
  clientUuid: z.uuid().toLowerCase(),
});
export type CreateVideoAnalysisRequest = z.infer<typeof CreateVideoAnalysisRequest>;

// --- POST /api/player/video-analyses: response -----------------------------------------------

export const CriterionScore = z.object({
  key: EntityId,
  label: z.string().min(1),
  score: z.int().min(1).max(10),
  note: z.string(),
});
export type CriterionScore = z.infer<typeof CriterionScore>;

export const RecommendedDrill = z.object({
  drillVersionId: EntityId,
  slug: EntityId,
  title: z.string().min(1),
  reason: z.string().min(1),
});
export type RecommendedDrill = z.infer<typeof RecommendedDrill>;

/**
 * A finished analysis. There is NO overall score field. `rerecord` must be absent:
 * `z.never().optional()` accepts a missing key and rejects any value.
 */
export const VideoAnalysis = z.object({
  id: EntityId,
  skillSlug: EntityId,
  createdAt: Timestamp,
  beta: z.literal(true),
  confidence: Confidence,
  scores: z.array(CriterionScore).min(1),
  focusNext: z.string().min(1),
  recommended: z.array(RecommendedDrill),
  repeatAfterSessions: z.literal(REPEAT_AFTER_SESSIONS),
  limitations: z.array(z.string()),
  rerecord: z.never().optional(),
});
export type VideoAnalysis = z.infer<typeof VideoAnalysis>;

/** The clip cannot be judged: film again. `scores` must be absent (any value fails). */
export const RerecordResponse = z.object({
  rerecord: z.literal(true),
  reason: RerecordReason,
  scores: z.never().optional(),
});
export type RerecordResponse = z.infer<typeof RerecordResponse>;

export const CreateVideoAnalysisResponse = z.union([VideoAnalysis, RerecordResponse]);
export type CreateVideoAnalysisResponse = z.infer<typeof CreateVideoAnalysisResponse>;

// --- GET /api/player/video-analyses ------------------------------------------------------------

/** Only finished analyses are stored; a rerecord verdict is not a history entry. */
export const VideoAnalysisList = z.array(VideoAnalysis);
export type VideoAnalysisList = z.infer<typeof VideoAnalysisList>;

// --- Endpoints ---------------------------------------------------------------------------------

export const ENDPOINTS = {
  getRubric: {
    method: "GET",
    path: "/api/video/rubrics/:skillSlug",
    params: RubricParams,
    query: RubricQuery,
    response: Rubric,
  },
  createAnalysis: {
    method: "POST",
    path: "/api/player/video-analyses",
    request: CreateVideoAnalysisRequest,
    response: CreateVideoAnalysisResponse,
  },
  listAnalyses: {
    method: "GET",
    path: "/api/player/video-analyses",
    response: VideoAnalysisList,
  },
} as const satisfies Record<string, EndpointSpec>;

/** Analysing a clip: rubric, then analysis. The call budget is 2. */
export const ANALYSE_JOURNEY = ["getRubric", "createAnalysis"] as const satisfies readonly (keyof typeof ENDPOINTS)[];
