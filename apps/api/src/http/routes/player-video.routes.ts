// POST and GET /api/player/video-analyses (fc-mol-8nt.5): the Beta AI Video Coach. A player sends the numbers and a few
// still frames of a short clip; the coach scores each criterion of the skill's rubric and the answer is stored.
//
// CHILD PRIVACY. The frames are pictures of a minor. They are held IN MEMORY for the one request: read from the body,
// handed to the agent, forgotten. They are never written to disk (no MEDIA_DIR, no temp file), never to the database
// (009_video.sql has no column for one, and only the parsed analysis reaches the writer), never to a log (this module
// logs nothing, the AI call log takes ids and codes, and the agent's own errors are swallowed: a provider message may
// quote anything). Nothing the model writes is stored as it came (player/video-repo cleanText), and a raw video is
// never accepted.
//
// ORDER of the checks, each an RFC 9457 problem (http/problem); every response is `Cache-Control: no-store`:
//   1. no session                              401 (requirePlayer, before the body is read);
//   2. the videoAnalysis consent is not granted 403 'consent required' (player/consents requireConsent, fail-closed);
//   3. settings.videoCoachEnabled is false      403 'Video coach disabled' (logged as an ai_calls row: fallback `disabled`);
//   4. aiAvailable() is false (no OpenAI key)   503 type ai_unavailable (logged: fallback `no_key`);
//   5. no profile                               404 not onboarded;
//   6. the body, under a hard limit (below)     415 video/* or an unknown type, 413 too big, 400 unreadable, 422 invalid;
//   7. the clientUuid is already stored         the stored analysis (a replay) or, for another player's, 409;
//   8. the rubric                               422 at /skillSlug (no rubric) or /rubricVersion (not the current one);
//   9. the clip cannot be judged                200 {rerecord: true, reason}: no model call, nothing stored or logged;
//  10. the agent, under a 60 s timeout          504 timeout, 502 the agent failed or answered outside the rubric;
//  11. the analysis is stored and answered      200 VideoAnalysis.
// GET answers the player's history (a session is enough: the player can always read what is theirs).
//
// THE BODY. One request, two encodings:
//   * application/json: the contract's CreateVideoAnalysisRequest (keyframes inline as base64, each with a declared size);
//   * multipart/form-data: a `payload` part (the same JSON without `keyframes`) and 3..6 `keyframes` file parts of
//     image/jpeg. Their size is read from the JPEG itself.
// Both end in the SAME schema (shared/video CreateVideoAnalysisRequest), so every contract limit applies to both. A
// `video/*` Content-Type, a part called `video`, or a part typed video/* is a 415; a keyframes part of any other type
// than image/jpeg is a 415 too. A declared size that is not the JPEG's own is a 422 (the server re-checks the pixels).
// Work and memory per request are bounded, as contributions.routes.ts does it:
//   * the body is read through a byte counter with a total limit (JSON: 6 keyframes as base64 + 64 KiB; multipart:
//     6 x 200 KB + 64 KiB + 64 KiB of framing): a Content-Length over it is refused before a byte is read, and a body
//     without (chunked) or lying about Content-Length is cut off (the source is cancelled) as soon as the counter passes it;
//   * at most 16 parts, counted from the multipart delimiters BEFORE the body is parsed (400 above);
//   * the `payload` part at most 64 KiB (413), a keyframe at most 200 KB decoded (413), 3..6 keyframes (422), at most 20
//     items in a 422's errors[];
//   * the schema never sees more than 6 keyframes: a `keyframes` array over the cap is a 422 BEFORE Zod runs (Zod makes an
//     issue per refused element, so a 1.5 MB array of `{}` would otherwise cost seconds and gigabytes), and a body of
//     unknown keys is reported for its first 20 keys only. The multipart path is bounded by the 16-part cap.
//
// The agent is an INJECTED dependency: `deps.videoAgent` (a fake in the tests), else the real vision agent built on first
// use (mastra/video-agent, model = visionModelId()). `deps.videoTimeoutMs` shortens the 60 s timeout in tests.
//
// Readings the criteria leave open (each pinned by player-video.routes.test.ts)
//   * Statuses the criteria do not fix: disabled 403 (title 'Video coach disabled', not the consent one), no key 503,
//     an agent failure or an answer outside the rubric 502, a clientUuid of another player 409.
//   * too_short is a clip with fewer than MIN_FRAMES_ANALYSED analysed frames; too_dark is not produced (there is no
//     brightness in the pose features and no image is decoded); low_visibility is judged first.
//   * The player's locale (profile) picks the language of labels, drill titles and limitations: the request has none.
//   * Concurrent duplicates (same session player, same clientUuid) share ONE analysis: the second joins the first's
//     in-flight promise, so the paid model call is made once and both get the same answer (a failure too; it is forgotten
//     when it settles, so a retry asks the model again).
//   * ai_calls: one row per request that reached the AI step (a finished analysis, a timeout, a failure, and the two
//     gates above); a replay and a rerecord asked no model and write none.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import { getSettings } from "../../admin/settings";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillGraph, listPublishedVersions } from "../../commons/repo";
import { logAiCall } from "../../mastra/ai-log";
import { aiAvailable, visionModelId } from "../../mastra/model";
import { createVideoAgent, runVideoAnalysis } from "../../mastra/video-agent";
import type { VideoAgentOutput } from "../../mastra/video-agent";
import { candidates } from "../../planner/candidates";
import { requireConsent } from "../../player/consents";
import { DEFAULT_SPORT } from "../../player/journey";
import { getProfile, getRoadmap } from "../../player/profile-repo";
import {
  ClientUuidTakenError,
  cleanText,
  findByClientUuid,
  fitForTable,
  insertAnalysis,
  jpegSize,
  listAnalyses,
  loadRubric,
  pickRecommended,
  toVideoAnalysis,
} from "../../player/video-repo";
import type { AiFallbackCode } from "../../shared/ai";
import type { PlayerProfileView } from "../../shared/domain";
import type { Locale, ProblemError } from "../../shared/primitives";
import {
  ENDPOINTS,
  KEYFRAME_MAX_BYTES,
  KEYFRAME_MAX_COUNT,
  KEYFRAME_MIME_TYPE,
  VIDEO_ANALYSIS_TIMEOUT_MS,
  VIDEO_REQUIRED_CONSENT,
  base64DecodedBytes,
  isRawVideoMediaType,
} from "../../shared/video";
import type { CreateVideoAnalysisRequest, CriterionScore, Rubric, VideoAnalysis } from "../../shared/video";
import { fromZodError, problem } from "../problem";

/** The part of a Mastra Agent the route uses; a fake in the tests. */
export interface VideoAgentLike {
  generate(messages: unknown, options?: { abortSignal?: AbortSignal }): Promise<{ object?: unknown }>;
}

/** The app's deps plus the injection seams of this route. */
export type VideoRouteDeps = AppDeps & {
  /** The vision agent. Default: the real one (createVideoAgent on visionModelId()), built on first use. */
  videoAgent?: VideoAgentLike;
  /** Overrides the 60 s agent timeout (tests). */
  videoTimeoutMs?: number;
};

// --- limits -----------------------------------------------------------------------------------------------------

/** Parts in one request: the payload and 6 keyframes are 7; the rest is room. More is a 400 before the body is parsed. */
const MAX_PARTS = 16;
/** The `payload` part is a handful of numbers; 64 KiB is far more (413 above it). */
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Room for the multipart framing (boundaries and part headers). */
const FRAMING_BYTES = 64 * 1024;
/** Longest base64 text of a KEYFRAME_MAX_BYTES keyframe. */
const KEYFRAME_MAX_BASE64_CHARS = Math.ceil(KEYFRAME_MAX_BYTES / 3) * 4;
const MAX_JSON_BYTES = KEYFRAME_MAX_COUNT * KEYFRAME_MAX_BASE64_CHARS + MAX_PAYLOAD_BYTES;
const MAX_MULTIPART_BYTES = KEYFRAME_MAX_COUNT * KEYFRAME_MAX_BYTES + MAX_PAYLOAD_BYTES + FRAMING_BYTES;
/** Items in a 422's `errors[]`: the first ones, so the answer does not grow with the request. */
const MAX_ISSUES = 20;
/** A clip with fewer analysed frames than this cannot be judged (rerecord too_short). */
export const MIN_FRAMES_ANALYSED = 10;
/** Stored text is bounded: 009_video.sql caps focus_next at 2000 characters and scores at 16384 in all. */
const MAX_NOTE_CHARS = 600;
const MAX_FOCUS_CHARS = 1000;

const DEFAULT_FOCUS: Readonly<Record<Locale, string>> = {
  en: "Keep practising this skill a little every day.",
  ru: "Продолжай понемногу тренировать этот навык каждый день.",
  kk: "Осы дағдыны күн сайын аздап жаттықтыра бер.",
};

type Ctx = Context<{ Variables: AuthVariables }>;
type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response };

/** How an analysis ended, in a form that can be given to every request that joined it (a Response can be read once). */
type Settled = { ok: true; analysis: VideoAnalysis } | { ok: false; status: number; title: string; detail: string };
const refused = (status: number, title: string, detail: string): Settled => ({ ok: false, status, title, detail });

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = <T>(response: Response): Outcome<T> => ({ ok: false, response });

/** Every response of the routes is never cached, whoever produced it (the guards included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

const badRequest = (detail: string): Response => problem(400, "Bad Request", detail);
const unsupported = (detail: string): Response => problem(415, "Unsupported Media Type", detail);
const tooLarge = (detail: string): Response => problem(413, "Payload Too Large", detail);
const invalid = (errors: ProblemError[]): Response =>
  problem(422, "Unprocessable Entity", "The request is invalid.", errors.slice(0, MAX_ISSUES));

const escapePointer = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** One issue per unknown key, at that key's own path, so its pointer names the key. Only the first MAX_ISSUES keys: a body of a million keys is not a million issues. */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys"
        ? issue.keys.slice(0, MAX_ISSUES).map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] }))
        : [issue],
    ),
  );
}

// --- reading the body under a limit ------------------------------------------------------------------------------------

/** The whole body, or undefined as soon as it passes `maxBytes` (the source is cancelled: no more is read). */
async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The boundary parameter of a multipart Content-Type (quoted or not), or undefined. */
function boundaryOf(contentType: string): string | undefined {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s"]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

/**
 * How many times the delimiter `--<boundary>` occurs in the body, counting no further than `limit + 1`. Every part needs
 * its own opening delimiter (plus one closing delimiter), so this is an upper bound on the parts the parser will produce.
 */
function countDelimiters(bytes: Uint8Array, boundary: string, limit: number): number {
  const needle = Buffer.from(`--${boundary}`);
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let found = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && found <= limit; at = haystack.indexOf(needle, at + needle.length)) {
    found += 1;
  }
  return found;
}

// --- the request ---------------------------------------------------------------------------------------------------------

type RawKeyframe = { mimeType: string; data: string; width: number; height: number };

const isRealFile = (value: FormDataEntryValue): value is File => typeof value !== "string";
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const mediaTypeOf = (contentType: string): string => (contentType.split(";")[0] ?? "").trim().toLowerCase();

function parseJsonObject(text: string, what: string): Outcome<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(badRequest(`${what} must be JSON.`));
  }
  return isObject(raw) ? ok(raw) : fail(badRequest(`${what} must be a JSON object.`));
}

/**
 * Work per request is bounded BEFORE the schema runs: Zod materialises an issue for every element it refuses, so a body
 * whose `keyframes` array holds half a million `{}` would cost seconds and gigabytes even under the body limit. The
 * only array in the request is `keyframes`; more than KEYFRAME_MAX_COUNT of them is refused without looking inside.
 * (A multipart request cannot hold more than MAX_PARTS parts, so its keyframes are bounded by that cap.)
 */
function tooManyKeyframes(raw: Record<string, unknown>): Response | undefined {
  const { keyframes } = raw;
  if (Array.isArray(keyframes) && keyframes.length > KEYFRAME_MAX_COUNT) {
    return invalid([{ pointer: "/keyframes", detail: `Send at most ${KEYFRAME_MAX_COUNT} keyframes.` }]);
  }
  return undefined;
}

/** The contract's schema, then the JPEGs' own sizes against the declared ones. */
function validate(raw: Record<string, unknown>): Outcome<CreateVideoAnalysisRequest> {
  const parsed = ENDPOINTS.createAnalysis.request.safeParse(raw);
  if (!parsed.success) return fail(invalid(fromZodError(expandUnknownKeys(parsed.error))));
  const issues: ProblemError[] = [];
  parsed.data.keyframes.forEach((keyframe, index) => {
    const size = jpegSize(Buffer.from(keyframe.data, "base64"));
    if (size === undefined) issues.push({ pointer: `/keyframes/${index}`, detail: "Expected a JPEG with a readable frame header." });
    else {
      if (size.width !== keyframe.width) issues.push({ pointer: `/keyframes/${index}/width`, detail: "The width is not the JPEG's own width." });
      if (size.height !== keyframe.height) issues.push({ pointer: `/keyframes/${index}/height`, detail: "The height is not the JPEG's own height." });
    }
  });
  return issues.length > 0 ? fail(invalid(issues)) : ok(parsed.data);
}

/** application/json: the contract's body. An oversized keyframe is a 413 before the schema judges the rest. */
function readJsonRequest(bytes: Uint8Array): Outcome<CreateVideoAnalysisRequest> {
  const body = parseJsonObject(new TextDecoder().decode(bytes), "The request body");
  if (!body.ok) return body;
  const crowded = tooManyKeyframes(body.value);
  if (crowded !== undefined) return fail(crowded);
  const { keyframes } = body.value;
  if (Array.isArray(keyframes)) {
    for (const keyframe of keyframes) {
      const data = isObject(keyframe) ? keyframe.data : undefined;
      if (typeof data !== "string") continue;
      if (data.length > KEYFRAME_MAX_BASE64_CHARS || (data.length % 4 === 0 && base64DecodedBytes(data) > KEYFRAME_MAX_BYTES)) {
        return fail(tooLarge(`A keyframe is over ${KEYFRAME_MAX_BYTES / 1024} KB.`));
      }
    }
  }
  return validate(body.value);
}

/** multipart/form-data: a `payload` part and the keyframes as file parts. Writes nothing anywhere. */
async function readMultipartRequest(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<Outcome<CreateVideoAnalysisRequest>> {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) return fail(badRequest("The multipart Content-Type has no boundary."));
  // MAX_PARTS parts have MAX_PARTS opening delimiters and one closing one.
  if (countDelimiters(bytes, boundary, MAX_PARTS + 1) > MAX_PARTS + 1) {
    return fail(badRequest(`The request has too many parts: send at most ${MAX_PARTS}.`));
  }
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return fail(badRequest("The multipart body could not be read."));
  }

  const issues: ProblemError[] = [];
  let payload: FormDataEntryValue | undefined;
  let payloadCount = 0;
  const files: File[] = [];
  for (const [name, value] of form.entries()) {
    // raw video is never accepted, whatever it is called or declares
    if (name === "video" || (isRealFile(value) && isRawVideoMediaType(value.type))) {
      return fail(unsupported("Raw video is never accepted: send keyframes."));
    }
    if (name === "payload") {
      payloadCount += 1;
      payload = value;
    } else if (name === "keyframes") {
      if (!isRealFile(value)) issues.push({ pointer: "/keyframes", detail: "`keyframes` parts must be files." });
      else if (mediaTypeOf(value.type) !== KEYFRAME_MIME_TYPE) return fail(unsupported(`A keyframe must be ${KEYFRAME_MIME_TYPE}.`));
      else if (value.size > KEYFRAME_MAX_BYTES) return fail(tooLarge(`A keyframe is over ${KEYFRAME_MAX_BYTES / 1024} KB.`));
      else files.push(value);
    } else {
      issues.push({ pointer: `/${escapePointer(name)}`, detail: "Unknown part." });
    }
  }
  if (payloadCount !== 1 || payload === undefined) return fail(badRequest("There must be exactly one `payload` part."));
  const payloadSize = isRealFile(payload) ? payload.size : Buffer.byteLength(payload);
  if (payloadSize > MAX_PAYLOAD_BYTES) return fail(tooLarge(`The \`payload\` part is over ${MAX_PAYLOAD_BYTES / 1024} KiB.`));
  const body = parseJsonObject(isRealFile(payload) ? await payload.text() : payload, "The `payload` part");
  if (!body.ok) return body;
  if ("keyframes" in body.value) issues.push({ pointer: "/keyframes", detail: "Send the keyframes as `keyframes` file parts, not in the payload." });
  if (issues.length > 0) return fail(invalid(issues));

  // The size of a keyframe is the JPEG's own; the schema then judges count, size and shape like it does a JSON body.
  const keyframes: RawKeyframe[] = [];
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    const size = jpegSize(data);
    keyframes.push({ mimeType: KEYFRAME_MIME_TYPE, data: Buffer.from(data).toString("base64"), width: size?.width ?? 0, height: size?.height ?? 0 });
  }
  return validate({ ...body.value, keyframes });
}

/** Reads the body under its limit and turns it into the contract's request. */
async function readRequest(c: Ctx): Promise<Outcome<CreateVideoAnalysisRequest>> {
  const contentType = c.req.header("content-type") ?? "";
  if (isRawVideoMediaType(contentType)) return fail(unsupported("Raw video is never accepted: send keyframes."));
  const type = mediaTypeOf(contentType);
  if (type !== "application/json" && type !== "multipart/form-data") {
    return fail(unsupported("Send application/json or multipart/form-data."));
  }
  const limit = type === "application/json" ? MAX_JSON_BYTES : MAX_MULTIPART_BYTES;
  const bytes = await readCapped(c.req.raw, limit);
  if (bytes === undefined) return fail(tooLarge(`The request is over ${Math.floor(limit / 1024)} KiB.`));
  return type === "application/json" ? readJsonRequest(bytes) : readMultipartRequest(bytes, contentType);
}

// --- the agent ---------------------------------------------------------------------------------------------------------------

type AgentOutcome =
  | { kind: "answer"; output: VideoAgentOutput }
  | { kind: "invalid"; rules: string[] }
  | { kind: "timeout" }
  | { kind: "error" };

/**
 * Runs the agent once under `timeoutMs`. The frames go to the agent inside `request` and nowhere else; whatever the
 * provider says when it fails is dropped (it may quote the request).
 */
async function runAgent(agent: VideoAgentLike, request: Parameters<typeof runVideoAnalysis>[1], timeoutMs: number): Promise<AgentOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  const run = runVideoAnalysis(agent as unknown as Parameters<typeof runVideoAnalysis>[0], request, { abortSignal: controller.signal });
  run.catch(() => {}); // a run that fails after the timeout won must not become an unhandled rejection
  try {
    const result = await Promise.race([run, timeout]);
    if (result === "timeout") return { kind: "timeout" };
    return result.ok ? { kind: "answer", output: result.output } : { kind: "invalid", rules: [...new Set(result.issues.map((issue) => issue.rule))] };
  } catch {
    return { kind: "error" };
  } finally {
    clearTimeout(timer);
  }
}

// --- the route -----------------------------------------------------------------------------------------------------------------------

/** The ids the server offered for this player: the candidate drills of the sport, or none when it has no skill graph. */
function candidateSet(db: Database, playerId: string, profile: PlayerProfileView, locale: Locale) {
  const graph = getSkillGraph(db, DEFAULT_SPORT, locale);
  if (graph === null) return [];
  const levels = Object.fromEntries((getRoadmap(db, playerId)?.tracks ?? []).map((track) => [track.skill, track.level]));
  return candidates(profile, levels, getSettings(db), listPublishedVersions(db, { sport: DEFAULT_SPORT }), graph);
}

/** The scores as stored: every rubric criterion once, in the rubric's order, with the rubric's label. */
function scoresOf(rubric: Rubric, answered: readonly { key: string; score: number; note: string }[]): CriterionScore[] {
  const byKey = new Map(answered.map((answer) => [answer.key, answer]));
  return rubric.criteria.map((criterion): CriterionScore => {
    const answer = byKey.get(criterion.key) as { score: number; note: string };
    return { key: criterion.key, label: criterion.label, score: answer.score, note: cleanText(answer.note, MAX_NOTE_CHARS) };
  });
}

export async function register(app: Hono, appDeps: AppDeps): Promise<void> {
  const deps = appDeps as VideoRouteDeps;
  // The guards read Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
  // whichever module mounts first.
  await ensureAuthSchema(getAuth(deps), deps.db);
  const { db } = deps;
  const timeoutMs = deps.videoTimeoutMs ?? VIDEO_ANALYSIS_TIMEOUT_MS;
  let realAgent: VideoAgentLike | undefined;
  const agentOf = (): VideoAgentLike => deps.videoAgent ?? (realAgent ??= createVideoAgent({ model: visionModelId() }) as unknown as VideoAgentLike);
  const spec = ENDPOINTS.createAnalysis;
  const listSpec = ENDPOINTS.listAnalyses;

  /** Logs an AI request that never reached the model (a gate that said no). */
  const logRefused = (playerId: string, fallbackCode: AiFallbackCode): void => {
    logAiCall(db, {
      playerId,
      kind: "video",
      model: visionModelId(),
      profileHash: null,
      candidateIds: [],
      chosenIds: [],
      validatorResult: null,
      fallbackCode,
      latencyMs: 0,
      tokensIn: null,
      tokensOut: null,
    });
  };

  /** The requests in flight, by player and clientUuid. */
  const inFlight = new Map<string, Promise<Settled>>();

  /**
   * One analysis: the candidate set, the agent under its timeout, the AI call log, the stored row. It never throws for a
   * refusal, it settles to a problem; whatever it settles to is shared with every duplicate that joined it.
   */
  async function analyse(playerId: string, profile: PlayerProfileView, request: CreateVideoAnalysisRequest, rubric: Rubric): Promise<Settled> {
    const locale = profile.locale;
    const pool = candidateSet(db, playerId, profile, locale);
    const started = Date.now();
    const outcome = await runAgent(
      agentOf(),
      { rubric, features: request.features, durationSec: request.durationSec, keyframes: request.keyframes, locale },
      timeoutMs,
    );
    const offered = pool.map((version) => version.versionId);
    const log = (fallbackCode: AiFallbackCode | null, validatorResult: string | null, chosenIds: string[]): void => {
      logAiCall(db, {
        playerId,
        kind: "video",
        model: visionModelId(),
        profileHash: null,
        candidateIds: offered,
        chosenIds,
        validatorResult,
        fallbackCode,
        latencyMs: Date.now() - started,
        tokensIn: null,
        tokensOut: null,
      });
    };

    if (outcome.kind === "timeout") {
      log("timeout", null, []);
      return refused(504, "Gateway Timeout", "The video coach took too long. Try again.");
    }
    if (outcome.kind === "error") {
      log("provider_error", null, []);
      return refused(502, "Bad Gateway", "The video coach could not analyse the clip. Try again.");
    }
    if (outcome.kind === "invalid") {
      log("invalid_output", outcome.rules.join(","), []);
      return refused(502, "Bad Gateway", "The video coach gave an answer that cannot be used. Try again.");
    }

    const { output } = outcome;
    const scores = scoresOf(rubric, output.scores);
    const recommended = pickRecommended(pool, output.focusSkills, scores.map((s) => s.score), locale);
    log(null, "ok", recommended.map((drill) => drill.drillVersionId));

    // The model has been paid for by now: what it wrote must never turn into a 500. cleanText made the text safe; the
    // table's own limits are re-checked here on the final JSON and anything that would not fit is degraded, not refused.
    const fitted = fitForTable(
      { scores, focusNext: cleanText(output.focusNext, MAX_FOCUS_CHARS) || DEFAULT_FOCUS[locale], recommended },
      DEFAULT_FOCUS[locale],
    );
    try {
      const stored = insertAnalysis(db, {
        id: randomUUID(),
        playerId,
        skillSlug: rubric.skill,
        rubricVersion: rubric.version,
        confidence: output.confidence,
        ...fitted,
        features: request.features,
        clientUuid: request.clientUuid,
      });
      return { ok: true, analysis: toVideoAnalysis(stored, locale) };
    } catch (error) {
      if (error instanceof ClientUuidTakenError) return refused(409, "Conflict", "This clientUuid has already been used.");
      throw error;
    }
  }

  app.post(spec.path, noStore, requirePlayer(deps), requireConsent(deps, VIDEO_REQUIRED_CONSENT), async (c: Ctx) => {
    const playerId = c.var.playerId;
    if (!getSettings(db).videoCoachEnabled) {
      logRefused(playerId, "disabled");
      return problem(403, "Video coach disabled", "The video coach is switched off.");
    }
    if (!aiAvailable()) {
      logRefused(playerId, "no_key");
      return problem(503, "Service Unavailable", "The AI video coach is not available.", undefined, { type: "ai_unavailable" });
    }
    const profile = getProfile(db, playerId);
    if (profile === null) return problem(404, "Not Found", "The player is not onboarded.");
    const locale = profile.locale;

    const read = await readRequest(c);
    if (!read.ok) return read.response;
    const request = read.value;

    // A replay is answered from what is stored, without asking the model again.
    const known = findByClientUuid(db, request.clientUuid);
    if (known !== null) {
      if (known.player_id !== playerId) return problem(409, "Conflict", "This clientUuid has already been used.");
      return c.json(toVideoAnalysis(known, locale), 200);
    }

    const rubric = loadRubric(request.skillSlug, locale);
    if (rubric === undefined) return invalid([{ pointer: "/skillSlug", detail: "There is no rubric for this skill." }]);
    if (rubric.version !== request.rubricVersion) {
      return invalid([{ pointer: "/rubricVersion", detail: `The current rubric version is ${rubric.version}: fetch the rubric again.` }]);
    }

    const { features } = request;
    if (features.meanVisibility < rubric.minVisibility) return c.json({ rerecord: true, reason: "low_visibility" }, 200);
    if (features.framesAnalysed < MIN_FRAMES_ANALYSED) return c.json({ rerecord: true, reason: "too_short" }, 200);

    // A duplicate of a request that is still in flight (a double tap, a retrying outbox) joins it: the paid model call is
    // made once. The key holds the SESSION's player, so another player's request with the same clientUuid never joins.
    const key = `${playerId}:${request.clientUuid}`;
    let pending = inFlight.get(key);
    if (pending === undefined) {
      pending = analyse(playerId, profile, request, rubric).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const settled = await pending;
    return settled.ok ? c.json(settled.analysis, 200) : problem(settled.status, settled.title, settled.detail);
  });

  app.get(listSpec.path, noStore, requirePlayer(deps), (c: Ctx) => {
    const playerId = c.var.playerId;
    const locale = getProfile(db, playerId)?.locale ?? "ru";
    return c.json(listAnalyses(db, playerId, locale), 200);
  });
}
