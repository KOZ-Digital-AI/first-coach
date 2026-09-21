import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { format } from "node:util";
import type { Hono } from "hono";
import { getSettings, updateSettings } from "../../admin/settings";
import { createApp, type AppDeps } from "../../app";
import { DEFAULT_SEED_DIR } from "../../boot/20-seed.boot";
import { getSkillGraph, listPublishedVersions } from "../../commons/repo";
import { loadSeed } from "../../commons/seed-loader";
import { openDatabase } from "../../db/database";
import { MIGRATIONS_DIR, migrate } from "../../db/migrate";
import type { VideoAgentOutput } from "../../mastra/video-agent";
import { candidates } from "../../planner/candidates";
import { setConsents } from "../../player/consents";
import type { PlayerProfile } from "../../shared/domain";
import { ENDPOINTS as ONBOARDING, StartResponse } from "../../shared/onboarding";
import type { BaselineResult, StartRequest } from "../../shared/onboarding";
import { LOCALES, PROBLEM_CONTENT_TYPE, ProblemDetails } from "../../shared/primitives";
import type { Locale } from "../../shared/primitives";
import {
  CONSENT_REQUIRED_TITLE,
  ENDPOINTS,
  KEYFRAME_MAX_BYTES,
  KEYFRAME_MAX_COUNT,
  KEYFRAME_MAX_SIDE_PX,
  REPEAT_AFTER_SESSIONS,
  RerecordResponse,
  VideoAnalysis,
  VideoAnalysisList,
} from "../../shared/video";
import type { VideoAgentLike, VideoRouteDeps } from "./player-video.routes";

// POST and GET /api/player/video-analyses (fc-mol-8nt.5): the Beta AI Video Coach endpoint. Every test runs the real
// createApp on a fresh in-memory database migrated with the real migrations (001-009) and loaded with the REAL football
// seed (drills, skill graph, rubrics), with the real Better Auth handler and the real consent store. Players are real
// anonymous sign-ins that onboard through POST /api/player/start; consent is granted through the real setConsents. The
// ONLY fake is the vision agent, injected through the route module's deps (no network, no OpenAI key: OPENAI_API_KEY is
// a dummy so aiAvailable() is true, and the fake never leaves the process).
//
// PRIVACY is the point of this file: a child's keyframes are held in memory for the request only. The success tests
// prove that a temp MEDIA_DIR stays empty, that no table (and no byte of the database file) holds any frame, and that
// nothing written to the console (log lines included) holds a frame either, on the success path AND on every error path.
//
// Readings the criteria leave open, pinned here (each is also stated in the route module):
//   * Two encodings of ONE request: application/json (the contract's body, keyframes inline as base64) and
//     multipart/form-data (a `payload` part with the JSON minus `keyframes`, and 3..6 `keyframes` file parts of
//     image/jpeg; the server reads their size from the JPEG itself). A `video/*` Content-Type or part is a 415.
//   * Refusals and their statuses: 401 no session; 403 'consent required'; 403 'video coach disabled'; 503 no key;
//     404 not onboarded; 413 body / payload part / one keyframe over its cap; 400 body not readable or too many parts;
//     415 video/* or another type; 422 the contract's schema, a rubric version that is not the current one, an unknown
//     skill, a keyframe whose declared size is not the JPEG's; 409 a clientUuid that belongs to another player;
//     502 the agent failed or answered outside the rubric; 504 the agent took longer than the timeout.
//   * A rerecord answer (low_visibility, too_short) stores nothing, calls no model and writes no ai_calls row (no AI
//     request was made). GET needs a session only (not the consent: a player can always read their own history).
//   * recommended = the server candidate set (planner candidates) whose skills intersect the agent's focusSkills, at most
//     3; a low score (lowest <= 4) prefers the easiest drills (regressions), otherwise the hardest (progressions). An
//     empty intersection recommends nothing: the agent's words never become a recommendation.

const SOURCE_DIR = resolve(import.meta.dir);
const SEED_DIR = resolve(import.meta.dir, "../../../../../config/commons");
const ROUTE_FILES = ["player-video.routes.ts", "player-start.routes.ts", "auth.routes.ts"] as const;
const DEV_ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const PATH = ENDPOINTS.createAnalysis.path;
const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_VISION_MODEL", "MEDIA_DIR", "SEED_DIR"] as const;

let dir: string;
let mediaDir: string;
let db: Database;
let app: Hono;
let agent: FakeAgent;
let videoTimeoutMs: number | undefined;
const savedEnv: Record<string, string | undefined> = {};

// --- the seed as the oracle --------------------------------------------------------------------------

type Text = Record<Locale, string>;
interface RawRubric {
  skill: string;
  version: number;
  minVisibility: number;
  criteria: { key: string; label: Text }[];
}
const rawRubrics = (JSON.parse(readFileSync(join(DEFAULT_SEED_DIR, "football", "rubrics.json"), "utf8")) as { rubrics: RawRubric[] }).rubrics;
const SKILL = "ball-mastery";
const RUBRIC = rawRubrics.find((r) => r.skill === SKILL) as RawRubric;
const CRITERIA = RUBRIC.criteria.map((c) => c.key);

// --- the fake agent (the only fake) ---------------------------------------------------------------------

type Answer = (call: number) => unknown | Promise<unknown>;

interface FakeAgent extends VideoAgentLike {
  calls: { messages: unknown; abortSignal?: AbortSignal }[];
  answer: Answer;
}

const outputOf = (over: Partial<VideoAgentOutput> = {}): VideoAgentOutput => ({
  confidence: "medium",
  scores: CRITERIA.map((key, i) => ({ key, score: 6 + (i % 3), note: `Nice work on ${key}: keep the rhythm steady.` })),
  focusNext: "Keep your head up between touches.",
  focusSkills: [SKILL],
  ...over,
});

function makeAgent(answer: Answer = () => outputOf()): FakeAgent {
  const fake: FakeAgent = {
    calls: [],
    answer,
    async generate(messages, options) {
      fake.calls.push({ messages, ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}) });
      return { object: await fake.answer(fake.calls.length) };
    },
  };
  return fake;
}

// --- app -------------------------------------------------------------------------------------------------

async function buildApp(): Promise<Hono> {
  const routesDir = join(dir, "routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of ROUTE_FILES) {
    writeFileSync(join(routesDir, file), `export { register } from ${JSON.stringify(join(SOURCE_DIR, file))};\n`);
  }
  const deps: VideoRouteDeps = { db, version: "test", videoAgent: agent, ...(videoTimeoutMs === undefined ? {} : { videoTimeoutMs }) };
  return createApp(deps as AppDeps, routesDir, { webDist: join(dir, "no-dist") });
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "player-video-routes-"));
  mediaDir = join(dir, "media");
  mkdirSync(mediaDir);
  process.env.MEDIA_DIR = mediaDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  db = openDatabase(":memory:");
  migrate(db, MIGRATIONS_DIR);
  loadSeed(db, SEED_DIR);
  agent = makeAgent();
  videoTimeoutMs = undefined;
  app = await buildApp();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Rebuilds the app (a new agent, a new timeout): the deps are read when the routes are mounted. */
async function rebuild(): Promise<void> {
  rmSync(join(dir, "routes"), { recursive: true, force: true });
  app = await buildApp();
}

// --- real sessions and onboarding -----------------------------------------------------------------------------

const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

type Player = { cookie: string; id: string };

async function signInPlayer(): Promise<Player> {
  const res = await app.request("/api/auth/sign-in/anonymous", {
    method: "POST",
    headers: { "content-type": "application/json", origin: DEV_ORIGIN },
    body: "{}",
  });
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: cookieOf(res), id: body.user.id };
}

const PROFILE: PlayerProfile = {
  age: 12,
  level: "basic",
  goal: "dribbling",
  equipment: "full_field",
  space: "field",
  partner: true,
  daysPerWeek: 3,
  minutesPerSession: 20,
  locale: "ru",
};

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const baseline = (first: number): BaselineResult[] => [
  { testSlug: "juggling-max-touches", value: 30, attempts: 3, clientUuid: uuid(first) },
  { testSlug: "wall-passing-60s", value: 20, clientUuid: uuid(first + 1) },
  { testSlug: "ball-mastery-30s", value: 95, clientUuid: uuid(first + 2) },
  { testSlug: "slalom-time", value: 9, errors: 1, clientUuid: uuid(first + 3) },
  { testSlug: "weak-foot-passes", value: 4, clientUuid: uuid(first + 4) },
];

let nextBaseline = 1_000;

/** A signed-in player who has onboarded (no consent yet). */
async function onboardedPlayer(over: Partial<PlayerProfile> = {}): Promise<Player> {
  const player = await signInPlayer();
  const body: StartRequest = { profile: { ...PROFILE, ...over }, baseline: baseline(nextBaseline) };
  nextBaseline += 10;
  const res = await app.request(ONBOARDING.start.path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: player.cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  StartResponse.parse(await res.json());
  return player;
}

const grantConsent = (player: Player): void => {
  setConsents(db, player.id, { videoAnalysis: true, guardianConfirmed: true });
};

/** An onboarded player who has granted the video consent (a guardian confirmed, as the age needs). */
async function readyPlayer(over: Partial<PlayerProfile> = {}): Promise<Player> {
  const player = await onboardedPlayer(over);
  grantConsent(player);
  return player;
}

// --- frames ------------------------------------------------------------------------------------------------------

let frameSeq = 0;

/** A minimal JPEG: SOI, APP0, a SOF0 that declares width x height, ASCII filler carrying a unique tag, EOI. */
function jpegBytes(width: number, height: number, size = 4096, tag = `FRAMETAG${(frameSeq += 1)}`): Uint8Array<ArrayBuffer> {
  const head = [
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ];
  const bytes = new Uint8Array(Math.max(size, head.length + 2));
  bytes.set(head);
  const filler = new TextEncoder().encode(`${tag}-`);
  for (let i = head.length; i < bytes.length - 2; i += 1) bytes[i] = filler[(i - head.length) % filler.length] as number;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

interface Frame {
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  base64: string;
  tag: string;
}

function frame(width = 320, height = 240, size = 4096): Frame {
  const tag = `FRAMETAG${(frameSeq += 1)}`;
  const bytes = jpegBytes(width, height, size, tag);
  return { bytes, width, height, base64: Buffer.from(bytes).toString("base64"), tag };
}

const frames = (count = 3): Frame[] => Array.from({ length: count }, () => frame());

const keyframeJson = (f: Frame) => ({ mimeType: "image/jpeg", data: f.base64, width: f.width, height: f.height });

let nextClient = 1;
const freshUuid = (): string => uuid(nextClient++);

const FEATURES = {
  cadencePerMin: 120,
  leftRightBalance: 0.4,
  kneeAngleStats: { mean: 60, min: 30, max: 95, stdDev: 12.5 },
  meanVisibility: 0.9,
  framesAnalysed: 120,
};

/** The contract's JSON body; `over` replaces top-level keys (a key set to undefined is removed). */
function requestBody(over: Record<string, unknown> = {}, sent: Frame[] = frames()): Record<string, unknown> {
  const body: Record<string, unknown> = {
    skillSlug: SKILL,
    rubricVersion: RUBRIC.version,
    durationSec: 15.5,
    features: FEATURES,
    keyframes: sent.map(keyframeJson),
    clientUuid: freshUuid(),
    ...over,
  };
  for (const [key, value] of Object.entries(over)) if (value === undefined) delete body[key];
  return body;
}

const postJson = (player: Player | undefined, body: unknown, headers: Record<string, string> = {}) =>
  app.request(PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...(player ? { cookie: player.cookie } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** The multipart encoding: a `payload` part (JSON without keyframes) and one `keyframes` file part per frame. */
function multipartOf(payload: Record<string, unknown>, sent: Frame[], extra: (form: FormData) => void = () => {}): FormData {
  const { keyframes: _dropped, ...rest } = payload;
  const form = new FormData();
  form.append("payload", JSON.stringify(rest));
  sent.forEach((f, i) => form.append("keyframes", new Blob([f.bytes], { type: "image/jpeg" }), `frame-${i}.jpg`));
  extra(form);
  return form;
}

const postForm = (player: Player | undefined, form: FormData, headers: Record<string, string> = {}) =>
  app.request(PATH, { method: "POST", headers: { ...(player ? { cookie: player.cookie } : {}), ...headers }, body: form });

const list = (player: Player | undefined) => app.request(PATH, { headers: player ? { cookie: player.cookie } : {} });

type Problem = { type: string; title: string; status: number; detail?: string; errors?: { pointer: string; detail: string }[] };

async function expectProblem(res: Response, status: number): Promise<Problem> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Problem;
  expect(ProblemDetails.safeParse(body).success).toBe(true);
  expect(body.status).toBe(status);
  return body;
}

const rows = (table: string, where = "1 = 1"): number => (db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

/** Nothing was stored and no model was asked. */
function expectNothingHappened(): void {
  expect(agent.calls).toHaveLength(0);
  expect(rows("video_analyses")).toBe(0);
}

// --- privacy oracles -------------------------------------------------------------------------------------------------

/** Every distinctive piece of a frame: its raw tag, slices of its base64 and the JPEG marker in base64. */
function fingerprints(sent: Frame[]): string[] {
  return [
    "/9j/",
    ...sent.flatMap((f) => [f.tag, f.base64.slice(30, 90), f.base64.slice(Math.floor(f.base64.length / 2), Math.floor(f.base64.length / 2) + 60)]),
  ];
}

function tablesText(): string {
  const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  const parts: string[] = [];
  for (const name of names) {
    for (const row of db.query(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      for (const value of Object.values(row)) {
        parts.push(value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : String(value));
      }
    }
  }
  return parts.join("\n");
}

function expectNoImageBytes(sent: Frame[]): void {
  // the temp MEDIA_DIR (and the whole temp dir, minus the routes and the sqlite-free layout) holds no file
  expect(readdirSync(mediaDir)).toEqual([]);
  const text = tablesText();
  const file = Buffer.from(db.serialize()).toString("latin1");
  for (const print of fingerprints(sent)) {
    expect(text.includes(print)).toBe(false);
    expect(file.includes(print)).toBe(false);
  }
  // no BLOB value anywhere in the video tables
  expect((db.query("SELECT count(*) AS n FROM video_analyses WHERE typeof(scores) = 'blob' OR typeof(features_summary) = 'blob'").get() as { n: number }).n).toBe(0);
}

/** Everything the process printed while `run` ran. */
async function captureOutput<T>(run: () => T | Promise<T>): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(format(...args));
    }),
  );
  const stdout = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  try {
    return { result: await run(), output: lines.join("\n") };
  } finally {
    for (const spy of [...spies, stdout, stderr]) spy.mockRestore();
  }
}

const expectClean = (text: string, sent: Frame[]): void => {
  for (const print of fingerprints(sent)) expect(text.includes(print)).toBe(false);
};

// --- the gates ---------------------------------------------------------------------------------------------------------

describe("the gates run before the body is read", () => {
  test("no session is a 401 and the agent is not asked", async () => {
    await expectProblem(await postJson(undefined, requestBody()), 401);
    await expectProblem(await list(undefined), 401);
    expectNothingHappened();
  });

  test("a player who has not granted the video consent gets a 403 'consent required'", async () => {
    const player = await onboardedPlayer();
    const body = await expectProblem(await postJson(player, requestBody()), 403);
    expect(body.title).toBe(CONSENT_REQUIRED_TITLE);
    expectNothingHappened();
  });

  test("a revoked consent is a 403 again", async () => {
    const player = await readyPlayer();
    setConsents(db, player.id, { videoAnalysis: false });
    const body = await expectProblem(await postJson(player, requestBody()), 403);
    expect(body.title).toBe(CONSENT_REQUIRED_TITLE);
    expectNothingHappened();
  });

  test("the modelImprovement consent does not open the video gate", async () => {
    const player = await onboardedPlayer();
    setConsents(db, player.id, { modelImprovement: true });
    expect((await expectProblem(await postJson(player, requestBody()), 403)).title).toBe(CONSENT_REQUIRED_TITLE);
    expectNothingHappened();
  });

  test("settings.videoCoachEnabled = false is a 403 that is not the consent one, and the call is logged as disabled", async () => {
    const player = await readyPlayer();
    updateSettings(db, { videoCoachEnabled: false });
    const body = await expectProblem(await postJson(player, requestBody()), 403);
    expect(body.title).not.toBe(CONSENT_REQUIRED_TITLE);
    expectNothingHappened();
    expect(db.query("SELECT kind, fallback_code FROM ai_calls").all()).toEqual([{ kind: "video", fallback_code: "disabled" }]);
  });

  test("without an OpenAI key (aiAvailable() false) the answer is a 503 and the call is logged as no_key", async () => {
    const player = await readyPlayer();
    delete process.env.OPENAI_API_KEY;
    await expectProblem(await postJson(player, requestBody()), 503);
    expectNothingHappened();
    expect(db.query("SELECT kind, fallback_code FROM ai_calls").all()).toEqual([{ kind: "video", fallback_code: "no_key" }]);
  });

  test("a blank OpenAI key counts as no key", async () => {
    const player = await readyPlayer();
    process.env.OPENAI_API_KEY = "   ";
    await expectProblem(await postJson(player, requestBody()), 503);
    expectNothingHappened();
  });

  test("the gates refuse an oversized body without reading it", async () => {
    const player = await onboardedPlayer(); // no consent
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(65);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
        if (pulled > 8 * 1024 * 1024) controller.close();
      },
    });
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: player.cookie },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expectProblem(res, 403);
    expect(pulled).toBeLessThanOrEqual(2 * chunk.length);
  });

  test("a player who has not onboarded but holds a session is refused (no consent can exist without a profile)", async () => {
    const player = await signInPlayer();
    const res = await postJson(player, requestBody());
    expect([403, 404]).toContain(res.status);
    expectNothingHappened();
  });
});

// --- raw video is never accepted -----------------------------------------------------------------------------------------

describe("raw video is refused with 415", () => {
  test("a video/* Content-Type", async () => {
    const player = await readyPlayer();
    for (const type of ["video/mp4", "VIDEO/webm", "video/quicktime; codecs=avc1"]) {
      const res = await app.request(PATH, { method: "POST", headers: { "content-type": type, cookie: player.cookie }, body: new Uint8Array(2048) });
      await expectProblem(res, 415);
    }
    expectNothingHappened();
  });

  test("a part named `video`, whatever its type", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const form = multipartOf(requestBody({}, sent), sent, (f) => f.append("video", new Blob([new Uint8Array(512)], { type: "video/mp4" }), "clip.mp4"));
    await expectProblem(await postForm(player, form), 415);
    const disguised = multipartOf(requestBody({}, sent), sent, (f) => f.append("video", new Blob([jpegBytes(320, 240)], { type: "image/jpeg" }), "clip.jpg"));
    await expectProblem(await postForm(player, disguised), 415);
    expectNothingHappened();
  });

  test("a keyframes part whose type is video/*", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const form = multipartOf(requestBody({}, sent), sent, (f) => f.append("keyframes", new Blob([new Uint8Array(512)], { type: "video/webm" }), "f.webm"));
    await expectProblem(await postForm(player, form), 415);
    expectNothingHappened();
  });

  test("a keyframes part that is not image/jpeg", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const form = multipartOf(requestBody({}, sent), sent, (f) => f.append("keyframes", new Blob([new Uint8Array(512)], { type: "image/png" }), "f.png"));
    await expectProblem(await postForm(player, form), 415);
    expectNothingHappened();
  });

  test("a body that is neither JSON nor multipart", async () => {
    const player = await readyPlayer();
    const res = await app.request(PATH, { method: "POST", headers: { "content-type": "text/plain", cookie: player.cookie }, body: "hello" });
    await expectProblem(res, 415);
    expectNothingHappened();
  });

  test("a video key in the JSON body is refused by the strict contract", async () => {
    const player = await readyPlayer();
    const body = await expectProblem(await postJson(player, requestBody({ video: "AAAA" })), 422);
    expect(body.errors?.map((e) => e.pointer)).toContain("/video");
    expectNothingHappened();
  });
});

// --- keyframes: count, size, shape -------------------------------------------------------------------------------------------

describe("keyframes are bounded", () => {
  test("more than six or fewer than three keyframes is a 422 at /keyframes", async () => {
    const player = await readyPlayer();
    for (const count of [KEYFRAME_MAX_COUNT + 1, 2, 0]) {
      const body = await expectProblem(await postJson(player, requestBody({}, frames(count))), 422);
      expect(body.errors?.some((e) => e.pointer === "/keyframes")).toBe(true);
    }
    const sent = frames(KEYFRAME_MAX_COUNT + 1);
    await expectProblem(await postForm(player, multipartOf(requestBody({}, sent), sent)), 422);
    const few = frames(2);
    await expectProblem(await postForm(player, multipartOf(requestBody({}, few), few)), 422);
    expectNothingHappened();
  });

  test("exactly three and exactly six keyframes are accepted", async () => {
    const player = await readyPlayer();
    for (const count of [3, KEYFRAME_MAX_COUNT]) {
      const res = await postJson(player, requestBody({}, frames(count)));
      expect(res.status).toBe(200);
    }
    expect(agent.calls).toHaveLength(2);
  });

  test("a keyframe over 200 KB decoded is a 413 (JSON and multipart); exactly 200 KB is accepted", async () => {
    const player = await readyPlayer();
    const big = frame(320, 240, KEYFRAME_MAX_BYTES + 1);
    await expectProblem(await postJson(player, requestBody({}, [big, frame(), frame()])), 413);
    await expectProblem(await postForm(player, multipartOf(requestBody({}, [big, frame(), frame()]), [big, frame(), frame()])), 413);
    expect(agent.calls).toHaveLength(0);
    expect(rows("video_analyses")).toBe(0);

    const exact = [frame(320, 240, KEYFRAME_MAX_BYTES), frame(), frame()];
    expect((await postJson(player, requestBody({}, exact))).status).toBe(200);
    const exactForm = [frame(320, 240, KEYFRAME_MAX_BYTES), frame(), frame()];
    expect((await postForm(player, multipartOf(requestBody({}, exactForm), exactForm))).status).toBe(200);
  });

  test("a keyframe over 512 px on its longest side is a 422 at that keyframe", async () => {
    const player = await readyPlayer();
    const tall = frame(320, KEYFRAME_MAX_SIDE_PX + 1);
    const body = await expectProblem(await postJson(player, requestBody({}, [frame(), tall, frame()])), 422);
    expect(body.errors?.some((e) => e.pointer.startsWith("/keyframes/1"))).toBe(true);
    // in multipart the size is read from the JPEG itself
    const sent = [frame(), tall, frame()];
    await expectProblem(await postForm(player, multipartOf(requestBody({}, sent), sent)), 422);
    expectNothingHappened();
    const edge = frame(KEYFRAME_MAX_SIDE_PX, KEYFRAME_MAX_SIDE_PX);
    expect((await postJson(player, requestBody({}, [edge, frame(), frame()]))).status).toBe(200);
  });

  test("a declared size that is not the JPEG's own size is a 422 (the server reads the pixels' size itself)", async () => {
    const player = await readyPlayer();
    const real = frame(640, 480); // really 640 x 480
    const lie = { ...keyframeJson(real), width: 320, height: 240 };
    const body = requestBody({ keyframes: [lie, keyframeJson(frame()), keyframeJson(frame())] });
    const problem = await expectProblem(await postJson(player, body), 422);
    expect(problem.errors?.some((e) => e.pointer.startsWith("/keyframes/0"))).toBe(true);
    expectNothingHappened();
  });

  test("data that is not a JPEG is a 422", async () => {
    const player = await readyPlayer();
    const notJpeg = { mimeType: "image/jpeg", data: Buffer.from("just some text, not an image at all").toString("base64"), width: 320, height: 240 };
    await expectProblem(await postJson(player, requestBody({ keyframes: [notJpeg, keyframeJson(frame()), keyframeJson(frame())] })), 422);
    // a JPEG marker with no readable frame header
    const headless = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0]).toString("base64");
    const stub = { mimeType: "image/jpeg", data: headless, width: 320, height: 240 };
    await expectProblem(await postJson(player, requestBody({ keyframes: [stub, keyframeJson(frame()), keyframeJson(frame())] })), 422);
    expectNothingHappened();
  });
});

// --- the body is bounded ---------------------------------------------------------------------------------------------------------

/** The body limit the criteria allow at most: six keyframes in base64 plus generous room for the rest. */
const CEILING = KEYFRAME_MAX_COUNT * Math.ceil(KEYFRAME_MAX_BYTES / 3) * 4 + 512 * 1024;

function bigStream(totalBytes: number, chunkBytes = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(97);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= totalBytes) return controller.close();
        state.pulled += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { state, stream, chunkBytes };
}

describe("the body is read under a hard limit", () => {
  test("a Content-Length over the limit is a 413 and no byte is read", async () => {
    const player = await readyPlayer();
    const { state, stream } = bigStream(20 * 1024 * 1024);
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(20 * 1024 * 1024), cookie: player.cookie },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expectProblem(res, 413);
    expect(state.pulled).toBe(0);
    expectNothingHappened();
  });

  test("a body with no Content-Length (chunked) is cut off at the limit: nothing is buffered beyond it", async () => {
    const player = await readyPlayer();
    const { state, stream, chunkBytes } = bigStream(40 * 1024 * 1024);
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: player.cookie },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expectProblem(res, 413);
    expect(state.pulled).toBeGreaterThan(0);
    expect(state.pulled).toBeLessThanOrEqual(CEILING + 2 * chunkBytes);
    expect(state.cancelled).toBe(true);
    expectNothingHappened();
  });

  test("a Content-Length that lies (says small, sends more) is cut off at the limit too", async () => {
    const player = await readyPlayer();
    const { state, stream, chunkBytes } = bigStream(40 * 1024 * 1024);
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100", cookie: player.cookie },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expectProblem(res, 413);
    expect(state.pulled).toBeLessThanOrEqual(CEILING + 2 * chunkBytes);
    expectNothingHappened();
  });

  test("the same limits hold for a multipart body", async () => {
    const player = await readyPlayer();
    const boundary = "----limit";
    const { state, stream, chunkBytes } = bigStream(40 * 1024 * 1024);
    const res = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie: player.cookie },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expectProblem(res, 413);
    expect(state.pulled).toBeLessThanOrEqual(CEILING + 2 * chunkBytes);
    const declared = await app.request(PATH, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(30 * 1024 * 1024), cookie: player.cookie },
      body: "--x--",
    });
    await expectProblem(declared, 413);
    expectNothingHappened();
  });

  test("a body that is not JSON, or not a JSON object, is a 400", async () => {
    const player = await readyPlayer();
    await expectProblem(await postJson(player, "{not json"), 400);
    await expectProblem(await postJson(player, "[1,2,3]"), 400);
    await expectProblem(await postJson(player, "null"), 400);
    expectNothingHappened();
  });

  test("a multipart body with no boundary, no payload part, or a payload that is not JSON is a 400", async () => {
    const player = await readyPlayer();
    await expectProblem(
      await app.request(PATH, { method: "POST", headers: { "content-type": "multipart/form-data", cookie: player.cookie }, body: "x" }),
      400,
    );
    const sent = frames();
    const noPayload = new FormData();
    sent.forEach((f) => noPayload.append("keyframes", new Blob([f.bytes], { type: "image/jpeg" }), "f.jpg"));
    await expectProblem(await postForm(player, noPayload), 400);
    const notJson = new FormData();
    notJson.append("payload", "{nope");
    sent.forEach((f) => notJson.append("keyframes", new Blob([f.bytes], { type: "image/jpeg" }), "f.jpg"));
    await expectProblem(await postForm(player, notJson), 400);
    expectNothingHappened();
  });

  test("at most 16 parts: 16 are read (and the unknown ones are a 422), 17 are a 400 before any part is read", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const withExtras = (extras: number) =>
      multipartOf(requestBody({}, sent), sent, (form) => {
        for (let i = 0; i < extras; i += 1) form.append(`extra${i}`, "x");
      });
    // payload + 3 keyframes = 4 parts; 12 more = 16
    const sixteen = await expectProblem(await postForm(player, withExtras(12)), 422);
    expect(sixteen.errors?.some((e) => e.pointer === "/extra0")).toBe(true);
    await expectProblem(await postForm(player, withExtras(13)), 400);
    expectNothingHappened();
  });

  test("the `payload` part is limited (413) and there is exactly one", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const huge = new FormData();
    huge.append("payload", JSON.stringify({ ...requestBody({}, sent), keyframes: undefined, padding: "x".repeat(300 * 1024) }));
    sent.forEach((f) => huge.append("keyframes", new Blob([f.bytes], { type: "image/jpeg" }), "f.jpg"));
    await expectProblem(await postForm(player, huge), 413);
    const twice = multipartOf(requestBody({}, sent), sent, (form) => form.append("payload", "{}"));
    await expectProblem(await postForm(player, twice), 400);
    expectNothingHappened();
  });

  test("keyframes inside the multipart payload are refused: they travel as parts", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const form = new FormData();
    form.append("payload", JSON.stringify(requestBody({}, sent)));
    const body = await expectProblem(await postForm(player, form), 422);
    expect(body.errors?.some((e) => e.pointer.startsWith("/keyframes"))).toBe(true);
    expectNothingHappened();
  });
});

// --- the request itself ---------------------------------------------------------------------------------------------------------------

describe("the request is validated", () => {
  test("a player id in the body is a 422: the player is the session's", async () => {
    const player = await readyPlayer();
    const other = await readyPlayer();
    const body = await expectProblem(await postJson(player, requestBody({ playerId: other.id })), 422);
    expect(body.errors?.map((e) => e.pointer)).toContain("/playerId");
    expectNothingHappened();
  });

  test("each contract violation is a 422 at its pointer", async () => {
    const player = await readyPlayer();
    const cases: [string, Record<string, unknown>, string][] = [
      ["a clip shorter than 10 s", { durationSec: 9.9 }, "/durationSec"],
      ["a clip longer than 30 s", { durationSec: 30.1 }, "/durationSec"],
      ["a clientUuid that is not a uuid", { clientUuid: "not-a-uuid" }, "/clientUuid"],
      ["no features", { features: undefined }, "/features"],
      ["a visibility above 1", { features: { ...FEATURES, meanVisibility: 1.2 } }, "/features/meanVisibility"],
      ["a rubric version 0", { rubricVersion: 0 }, "/rubricVersion"],
    ];
    for (const [, over, pointer] of cases) {
      const body = await expectProblem(await postJson(player, requestBody(over)), 422);
      expect(body.errors?.some((e) => e.pointer === pointer)).toBe(true);
    }
    expectNothingHappened();
  });

  test("an unknown skill is a 422 at /skillSlug, and a rubric version that is not the current one at /rubricVersion", async () => {
    const player = await readyPlayer();
    const unknown = await expectProblem(await postJson(player, requestBody({ skillSlug: "no-such-skill" })), 422);
    expect(unknown.errors?.some((e) => e.pointer === "/skillSlug")).toBe(true);
    const stale = await expectProblem(await postJson(player, requestBody({ rubricVersion: RUBRIC.version + 1 })), 422);
    expect(stale.errors?.some((e) => e.pointer === "/rubricVersion")).toBe(true);
    expectNothingHappened();
  });
});

// --- rerecord ---------------------------------------------------------------------------------------------------------------------------

describe("a clip that cannot be judged is a rerecord answer", () => {
  test("mean visibility below the rubric minimum: {rerecord, low_visibility}, no scores, no model call, nothing stored", async () => {
    const player = await readyPlayer();
    const res = await postJson(player, requestBody({ features: { ...FEATURES, meanVisibility: RUBRIC.minVisibility - 0.01 } }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(RerecordResponse.parse(json)).toEqual({ rerecord: true, reason: "low_visibility" });
    expect(json).not.toHaveProperty("scores");
    expectNothingHappened();
    expect(rows("ai_calls")).toBe(0); // no AI request was made
  });

  test("the same over multipart", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const res = await postForm(player, multipartOf(requestBody({ features: { ...FEATURES, meanVisibility: 0.1 } }, sent), sent));
    expect(RerecordResponse.parse(await res.json())).toEqual({ rerecord: true, reason: "low_visibility" });
    expectNothingHappened();
  });

  test("a visibility exactly at the minimum is judged", async () => {
    const player = await readyPlayer();
    const res = await postJson(player, requestBody({ features: { ...FEATURES, meanVisibility: RUBRIC.minVisibility } }));
    expect(res.status).toBe(200);
    expect(VideoAnalysis.safeParse(await res.json()).success).toBe(true);
    expect(agent.calls).toHaveLength(1);
  });

  test("the minimum is the rubric's own (a 0.57 clip is fine for a skill whose minimum is 0.55, not for 0.6)", async () => {
    const player = await readyPlayer();
    const lenient = rawRubrics.find((r) => r.minVisibility < 0.6) as RawRubric;
    const strict = rawRubrics.find((r) => r.minVisibility >= 0.6) as RawRubric;
    const features = { ...FEATURES, meanVisibility: 0.575 };
    agent = makeAgent(() => outputOf({ scores: lenient.criteria.map((c) => ({ key: c.key, score: 7, note: "Good." })), focusSkills: [lenient.skill] }));
    await rebuild();
    const ok = await postJson(player, requestBody({ skillSlug: lenient.skill, rubricVersion: lenient.version, features }));
    expect(VideoAnalysis.safeParse(await ok.json()).success).toBe(true);
    const low = await postJson(player, requestBody({ skillSlug: strict.skill, rubricVersion: strict.version, features }));
    expect(RerecordResponse.parse(await low.json()).reason).toBe("low_visibility");
    expect(agent.calls).toHaveLength(1);
  });

  test("too few analysed frames is {rerecord, too_short}", async () => {
    const player = await readyPlayer();
    const res = await postJson(player, requestBody({ features: { ...FEATURES, framesAnalysed: 1 } }));
    expect(RerecordResponse.parse(await res.json())).toEqual({ rerecord: true, reason: "too_short" });
    expectNothingHappened();
  });
});

// --- success ---------------------------------------------------------------------------------------------------------------------------------

describe("a finished analysis", () => {
  test("stores ONE row, answers the contract's VideoAnalysis, and never keeps a frame", async () => {
    const player = await readyPlayer();
    const sent = frames(4);
    const body = requestBody({}, sent);
    const { result: res, output } = await captureOutput(() => postJson(player, body));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const analysis = VideoAnalysis.parse(JSON.parse(text));

    expect(analysis.beta).toBe(true);
    expect(analysis.skillSlug).toBe(SKILL);
    expect(analysis.repeatAfterSessions).toBe(REPEAT_AFTER_SESSIONS);
    expect(analysis.confidence).toBe("medium");
    expect(analysis.focusNext).toBe("Keep your head up between touches.");
    expect(analysis.scores.map((s) => s.key).sort()).toEqual([...CRITERIA].sort());
    // labels come from the rubric in the player's locale (ru), never from the model
    for (const score of analysis.scores) {
      expect(score.label).toBe((RUBRIC.criteria.find((c) => c.key === score.key) as RawRubric["criteria"][number]).label.ru);
    }
    // no overall number anywhere
    expect(Object.keys(JSON.parse(text) as object).join(" ")).not.toMatch(/total|overall|grade|rating|talent/i);

    // one row, the caller's, with the contract's columns
    expect(rows("video_analyses")).toBe(1);
    const row = db.query("SELECT * FROM video_analyses").get() as Record<string, unknown>;
    expect(row).toMatchObject({ id: analysis.id, player_id: player.id, skill_slug: SKILL, rubric_version: RUBRIC.version, confidence: "medium", client_uuid: body.clientUuid });
    expect(JSON.parse(row.features_summary as string)).toEqual({
      cadencePerMin: 120,
      leftRightBalance: 0.4,
      kneeAngleStats: { mean: 60, min: 30, max: 95, stdDev: 12.5 },
      meanVisibility: 0.9,
      framesAnalysed: 120,
    });
    expect(row.features_summary as string).not.toContain(" "); // compact: the table's CHECK needs it
    expect(analysis.createdAt).toBe(row.created_at as string);

    // the agent saw the frames, in memory, and only the agent
    expect(agent.calls).toHaveLength(1);
    const message = (agent.calls[0] as FakeAgent["calls"][number]).messages as { content: { type: string; image?: string }[] }[];
    const images = message.flatMap((m) => m.content.filter((part) => part.type === "image").map((part) => part.image));
    expect(images).toEqual(sent.map((f) => f.base64));

    // nothing of any frame at rest, in the response, or in the process output
    expectNoImageBytes(sent);
    expectClean(text, sent);
    expectClean(output, sent);
  });

  test("the media store and the whole temp dir hold no file after an analysis", async () => {
    const player = await readyPlayer();
    expect((await postJson(player, requestBody())).status).toBe(200);
    const sent = frames();
    expect((await postForm(player, multipartOf(requestBody({}, sent), sent))).status).toBe(200);
    expect(readdirSync(mediaDir)).toEqual([]);
    const leftovers = readdirSync(dir).filter((name) => name !== "routes" && name !== "media");
    expect(leftovers).toEqual([]);
    expect(existsSync(join(dir, "media"))).toBe(true);
  });

  test("a multipart request is analysed like a JSON one and its frames are held in memory too", async () => {
    const player = await readyPlayer();
    const sent = frames(5);
    const { result: res, output } = await captureOutput(() => postForm(player, multipartOf(requestBody({}, sent), sent)));
    expect(res.status).toBe(200);
    VideoAnalysis.parse(await res.json());
    expect(rows("video_analyses")).toBe(1);
    const message = (agent.calls[0] as FakeAgent["calls"][number]).messages as { content: { type: string; image?: string; mimeType?: string }[] }[];
    const images = message.flatMap((m) => m.content.filter((part) => part.type === "image"));
    expect(images.map((part) => part.image)).toEqual(sent.map((f) => f.base64));
    expect(images.every((part) => part.mimeType === "image/jpeg")).toBe(true);
    expectNoImageBytes(sent);
    expectClean(output, sent);
  });

  test("the notes are in the player's locale: the labels of a kk player are the rubric's Kazakh", async () => {
    const player = await readyPlayer({ locale: "kk" });
    const res = await postJson(player, requestBody());
    const analysis = VideoAnalysis.parse(await res.json());
    for (const score of analysis.scores) {
      expect(score.label).toBe((RUBRIC.criteria.find((c) => c.key === score.key) as RawRubric["criteria"][number]).label.kk);
    }
    expect(LOCALES).toContain("kk");
  });

  test("the player is the session's: two players' analyses stay apart", async () => {
    const a = await readyPlayer();
    const b = await readyPlayer();
    const first = VideoAnalysis.parse(await (await postJson(a, requestBody())).json());
    const second = VideoAnalysis.parse(await (await postJson(b, requestBody())).json());
    expect(first.id).not.toBe(second.id);
    expect(db.query("SELECT player_id FROM video_analyses WHERE id = ?").get(first.id)).toEqual({ player_id: a.id });
    expect(db.query("SELECT player_id FROM video_analyses WHERE id = ?").get(second.id)).toEqual({ player_id: b.id });
  });

  test("text the model echoes (even a run that looks like an image) never makes the write fail or reaches the table", async () => {
    const player = await readyPlayer();
    const sent = frames();
    const echoed = sent[0]?.base64 as string;
    agent = makeAgent(() =>
      outputOf({
        scores: CRITERIA.map((key) => ({ key, score: 5, note: `Looks like ${echoed} ok` })),
        focusNext: `Try again ${echoed}`,
      }),
    );
    await rebuild();
    const res = await postJson(player, requestBody({}, sent));
    expect(res.status).toBe(200);
    const text = await res.text();
    VideoAnalysis.parse(JSON.parse(text));
    expect(text.includes(echoed)).toBe(false);
    expectNoImageBytes(sent);
    expect(rows("video_analyses")).toBe(1);
  });

  test("a very long model note is bounded, not a 500", async () => {
    const player = await readyPlayer();
    agent = makeAgent(() => outputOf({ scores: CRITERIA.map((key) => ({ key, score: 5, note: "Good work. ".repeat(2000) })), focusNext: "Go on. ".repeat(2000) }));
    await rebuild();
    const res = await postJson(player, requestBody());
    expect(res.status).toBe(200);
    const analysis = VideoAnalysis.parse(await res.json());
    expect(analysis.focusNext.length).toBeLessThanOrEqual(2000);
  });

  test("the answer is the one GET would give for the same analysis", async () => {
    const player = await readyPlayer();
    const created = VideoAnalysis.parse(await (await postJson(player, requestBody())).json());
    const listed = VideoAnalysisList.parse(await (await list(player)).json());
    expect(listed).toEqual([created]);
  });
});

// --- recommendations -----------------------------------------------------------------------------------------------------------------------------

/** The server's candidate set for this player, computed independently of the route. */
function candidateSet(player: Player) {
  const profile = db.query("SELECT age, equipment, space, partner FROM player_profiles WHERE player_id = ?").get(player.id) as {
    age: number;
    equipment: PlayerProfile["equipment"];
    space: PlayerProfile["space"];
    partner: number;
  };
  const tracks = db.query("SELECT json FROM roadmaps WHERE player_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(player.id) as { json: string } | null;
  const levels = Object.fromEntries(((tracks ? JSON.parse(tracks.json) : { tracks: [] }) as { tracks: { skill: string; level: number }[] }).tracks.map((t) => [t.skill, t.level]));
  const graph = getSkillGraph(db, "football", "en");
  if (graph === null) throw new Error("no skill graph");
  return candidates({ ...profile, partner: profile.partner === 1 }, levels, getSettings(db), listPublishedVersions(db, { sport: "football" }), graph);
}

const LEVEL_RANK = { beginner: 1, basic: 2, intermediate: 3 } as const;

async function recommendedFor(player: Player, output: VideoAgentOutput) {
  agent = makeAgent(() => output);
  await rebuild();
  const res = await postJson(player, requestBody());
  expect(res.status).toBe(200);
  return VideoAnalysis.parse(await res.json());
}

describe("recommended drills are never free text", () => {
  test("2-3 drills, every id from the server candidate set and training a skill the agent focused on", async () => {
    const player = await readyPlayer();
    const analysis = await recommendedFor(player, outputOf({ focusSkills: [SKILL] }));
    const pool = candidateSet(player);
    const byVersion = new Map(pool.map((v) => [v.versionId, v]));
    expect(analysis.recommended.length).toBeGreaterThanOrEqual(2);
    expect(analysis.recommended.length).toBeLessThanOrEqual(3);
    expect(new Set(analysis.recommended.map((r) => r.drillVersionId)).size).toBe(analysis.recommended.length);
    for (const rec of analysis.recommended) {
      const version = byVersion.get(rec.drillVersionId);
      expect(version).toBeDefined();
      expect(version?.slug).toBe(rec.slug);
      expect(version?.skills).toContain(SKILL);
      expect(rec.title.length).toBeGreaterThan(0);
      expect(rec.reason.length).toBeGreaterThan(0);
    }
    // stored as well
    const stored = JSON.parse((db.query("SELECT recommended FROM video_analyses").get() as { recommended: string }).recommended) as { drillVersionId: string }[];
    expect(stored.map((r) => r.drillVersionId)).toEqual(analysis.recommended.map((r) => r.drillVersionId));
  });

  test("the title is the drill's own, in the player's locale", async () => {
    const player = await readyPlayer();
    const analysis = await recommendedFor(player, outputOf());
    const pool = candidateSet(player);
    for (const rec of analysis.recommended) {
      const version = pool.find((v) => v.versionId === rec.drillVersionId);
      const title = version?.content.title ?? version?.content.goal;
      expect(title).toBeDefined();
      expect(Object.values(title ?? {})).toContain(rec.title);
    }
  });

  test("low scores prefer regressions (the easiest drills), high scores prefer progressions (the hardest)", async () => {
    const player = await readyPlayer();
    const pool = candidateSet(player).filter((v) => v.skills.includes(SKILL));
    const ranks = new Set(pool.map((v) => LEVEL_RANK[v.level]));
    expect(ranks.size).toBeGreaterThan(1); // the premise: the seed offers more than one level for this skill

    const low = await recommendedFor(player, outputOf({ scores: CRITERIA.map((key) => ({ key, score: 2, note: "Keep trying." })) }));
    const high = await recommendedFor(player, outputOf({ scores: CRITERIA.map((key) => ({ key, score: 9, note: "Great." })) }));
    const rank = (id: string) => LEVEL_RANK[(pool.find((v) => v.versionId === id) as (typeof pool)[number]).level];

    const lowIds = new Set(low.recommended.map((r) => r.drillVersionId));
    const highIds = new Set(high.recommended.map((r) => r.drillVersionId));
    const lowLevels = low.recommended.map((r) => rank(r.drillVersionId));
    const others = pool.filter((v) => !lowIds.has(v.versionId)).map((v) => LEVEL_RANK[v.level]);
    expect(Math.max(...lowLevels)).toBeLessThanOrEqual(Math.min(...others));

    const highLevels = high.recommended.map((r) => rank(r.drillVersionId));
    const highOthers = pool.filter((v) => !highIds.has(v.versionId)).map((v) => LEVEL_RANK[v.level]);
    expect(Math.min(...highLevels)).toBeGreaterThanOrEqual(Math.max(...highOthers));

    expect(Math.max(...lowLevels)).toBeLessThan(Math.max(...highLevels));
  });

  test("a skill the agent invents (or one with no candidate drill) recommends nothing: the agent's words are not a recommendation", async () => {
    const player = await readyPlayer();
    for (const focusSkills of [["no-such-skill"], ["balance-footwork"], []]) {
      const analysis = await recommendedFor(player, outputOf({ focusSkills, focusNext: "Do the ball-mastery-sole-taps drill (id whatever)." }));
      expect(analysis.recommended).toEqual([]);
    }
  });

  test("only drills this player may be given: a ball-only player is never sent a drill that needs a wall, cones or a field", async () => {
    const player = await readyPlayer({ equipment: "ball", space: "yard", partner: false });
    const analysis = await recommendedFor(player, outputOf({ focusSkills: [SKILL, "dribbling", "weak-foot", "passing-first-touch", "juggling-coordination"] }));
    expect(analysis.recommended.length).toBeGreaterThan(0);
    const pool = new Set(candidateSet(player).map((v) => v.versionId));
    for (const rec of analysis.recommended) {
      expect(pool.has(rec.drillVersionId)).toBe(true);
      const drill = db.query("SELECT equipment FROM drill_versions WHERE id = ?").get(rec.drillVersionId) as { equipment: string };
      expect(["nothing", "ball"]).toContain(drill.equipment);
    }
  });

  test("raising the minimum trust status to EXPERT_VERIFIED empties the pool: nothing is recommended", async () => {
    const player = await readyPlayer();
    updateSettings(db, { minStatusByAgeBand: { u10: "EXPERT_VERIFIED", u14: "EXPERT_VERIFIED", adult: "EXPERT_VERIFIED" } });
    expect(candidateSet(player)).toEqual([]);
    const analysis = await recommendedFor(player, outputOf());
    expect(analysis.recommended).toEqual([]);
    expect(analysis.scores.length).toBeGreaterThan(0);
  });
});

// --- the AI call log --------------------------------------------------------------------------------------------------------------------------------------

describe("every AI call is logged", () => {
  test("a finished analysis writes one ai_calls row of kind video with the offered and the chosen ids", async () => {
    const player = await readyPlayer();
    const analysis = VideoAnalysis.parse(await (await postJson(player, requestBody())).json());
    const logged = db.query("SELECT * FROM ai_calls").all() as Record<string, unknown>[];
    expect(logged).toHaveLength(1);
    const row = logged[0] as Record<string, unknown>;
    expect(row).toMatchObject({ player_id: player.id, kind: "video", fallback_code: null });
    expect(String(row.model)).toMatch(/^openai\//);
    expect(row.latency_ms as number).toBeGreaterThanOrEqual(0);
    expect(row.profile_hash).toBeNull();
    const offered = JSON.parse(row.candidate_ids as string) as string[];
    expect(new Set(offered)).toEqual(new Set(candidateSet(player).map((v) => v.versionId)));
    expect(JSON.parse(row.chosen_ids as string)).toEqual(analysis.recommended.map((r) => r.drillVersionId));
    expect(row.validator_result).not.toBeNull();
  });

  test("the vision model is the configured one", async () => {
    const player = await readyPlayer();
    process.env.OPENAI_VISION_MODEL = "gpt-vision-test";
    await postJson(player, requestBody());
    expect((db.query("SELECT model FROM ai_calls").get() as { model: string }).model).toBe("openai/gpt-vision-test");
  });

  test("an answer outside the rubric (an unknown key, a missing key, a repeated key, not an object) is a 502, logged invalid_output, stores nothing", async () => {
    const player = await readyPlayer();
    const answers: unknown[] = [
      outputOf({ scores: [...outputOf().scores, { key: "invented", score: 5, note: "x" }] }),
      outputOf({ scores: outputOf().scores.slice(1) }),
      outputOf({ scores: [...outputOf().scores.slice(1), outputOf().scores[1] as VideoAgentOutput["scores"][number]] }),
      { confidence: "high", overall: 63 },
      undefined,
    ];
    for (const answer of answers) {
      agent = makeAgent(() => answer);
      await rebuild();
      await expectProblem(await postJson(player, requestBody()), 502);
    }
    expect(rows("video_analyses")).toBe(0);
    const codes = (db.query("SELECT fallback_code AS code FROM ai_calls").all() as { code: string }[]).map((r) => r.code);
    expect(codes).toEqual(answers.map(() => "invalid_output"));
  });

  test("a failing provider is a 502, logged provider_error, and its message (which may hold anything) is not echoed or logged", async () => {
    const player = await readyPlayer();
    const sent = frames();
    agent = makeAgent(() => {
      throw new Error(`provider exploded while reading ${sent[0]?.base64}`);
    });
    await rebuild();
    const { result: res, output } = await captureOutput(() => postJson(player, requestBody({}, sent)));
    await expectProblem(res, 502);
    expect(rows("video_analyses")).toBe(0);
    expect(db.query("SELECT fallback_code FROM ai_calls").all()).toEqual([{ fallback_code: "provider_error" }]);
    expectClean(output, sent);
    expectNoImageBytes(sent);
  });
});

// --- the timeout ---------------------------------------------------------------------------------------------------------------------------------------------------

describe("the agent runs under a 60 s timeout", () => {
  test("an agent that never answers is a 504 problem, its signal is aborted, nothing is stored, the call is logged timeout", async () => {
    const player = await readyPlayer();
    agent = makeAgent(() => new Promise(() => {}));
    videoTimeoutMs = 40;
    await rebuild();
    const started = Date.now();
    await expectProblem(await postJson(player, requestBody()), 504);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.abortSignal?.aborted).toBe(true);
    expect(rows("video_analyses")).toBe(0);
    expect(db.query("SELECT fallback_code FROM ai_calls").all()).toEqual([{ fallback_code: "timeout" }]);
  });

  test("an agent that answers inside the timeout is not cut off, and its timer is cleared", async () => {
    const player = await readyPlayer();
    agent = makeAgent(async () => {
      await Bun.sleep(30);
      return outputOf();
    });
    videoTimeoutMs = 2_000;
    await rebuild();
    const res = await postJson(player, requestBody());
    expect(res.status).toBe(200);
    expect(agent.calls[0]?.abortSignal?.aborted).toBe(false);
    await Bun.sleep(20);
    expect(agent.calls[0]?.abortSignal?.aborted).toBe(false);
  });

  test("by default the timeout is 60 seconds", async () => {
    const player = await readyPlayer();
    const timers = spyOn(globalThis, "setTimeout");
    try {
      expect((await postJson(player, requestBody())).status).toBe(200);
      const delays = timers.mock.calls.map((call) => call[1]);
      expect(delays).toContain(60_000);
    } finally {
      timers.mockRestore();
    }
  });
});

// --- idempotency ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("idempotent by clientUuid", () => {
  test("a replay answers the stored analysis without asking the model again: one row, one log line", async () => {
    const player = await readyPlayer();
    const body = requestBody();
    const first = await postJson(player, body);
    const second = await postJson(player, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(agent.calls).toHaveLength(1);
    expect(rows("video_analyses")).toBe(1);
    expect(rows("ai_calls")).toBe(1);
  });

  test("the replay is the same for an upper-case clientUuid, and the replay's frames are not looked at", async () => {
    const player = await readyPlayer();
    const body = requestBody();
    const first = VideoAnalysis.parse(await (await postJson(player, body)).json());
    const replay = VideoAnalysis.parse(await (await postJson(player, { ...body, clientUuid: (body.clientUuid as string).toUpperCase() })).json());
    expect(replay.id).toBe(first.id);
    expect(agent.calls).toHaveLength(1);
    expect(rows("video_analyses")).toBe(1);
  });

  test("two requests in flight with the same clientUuid store ONE row and both answer it", async () => {
    const player = await readyPlayer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    agent = makeAgent(async (call) => {
      if (call >= 2) release();
      await gate;
      return outputOf();
    });
    await rebuild();
    const body = requestBody();
    const [a, b] = await Promise.all([postJson(player, body), postJson(player, body)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const first = VideoAnalysis.parse(await a.json());
    const second = VideoAnalysis.parse(await b.json());
    expect(second.id).toBe(first.id);
    expect(rows("video_analyses")).toBe(1);
  });

  test("a clientUuid that belongs to ANOTHER player is a 409 and never returns their analysis", async () => {
    const owner = await readyPlayer();
    const other = await readyPlayer();
    const body = requestBody();
    const theirs = VideoAnalysis.parse(await (await postJson(owner, body)).json());
    const calls = agent.calls.length;

    const res = await postJson(other, body);
    const problem = await expectProblem(res, 409);
    expect(JSON.stringify(problem)).not.toContain(theirs.id);
    expect(agent.calls).toHaveLength(calls); // not even asked
    expect(rows("video_analyses")).toBe(1);
    expect(db.query("SELECT player_id FROM video_analyses").get()).toEqual({ player_id: owner.id });
    expect(VideoAnalysisList.parse(await (await list(other)).json())).toEqual([]);
  });

  test("the same when both players' requests are in flight together: one 200, one 409, one row, no leak", async () => {
    const one = await readyPlayer();
    const two = await readyPlayer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    agent = makeAgent(async (call) => {
      if (call >= 2) release();
      await gate;
      return outputOf();
    });
    await rebuild();
    const body = requestBody();
    const [a, b] = await Promise.all([postJson(one, body), postJson(two, body)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    const won = VideoAnalysis.parse(await winner.json());
    expect(JSON.stringify(await loser.json())).not.toContain(won.id);
    expect(rows("video_analyses")).toBe(1);
  });

  test("a rerecord answer is not remembered: the same clientUuid can be sent again with a better clip", async () => {
    const player = await readyPlayer();
    const clientUuid = freshUuid();
    const low = await postJson(player, requestBody({ clientUuid, features: { ...FEATURES, meanVisibility: 0.1 } }));
    expect(RerecordResponse.safeParse(await low.json()).success).toBe(true);
    const better = await postJson(player, requestBody({ clientUuid }));
    expect(VideoAnalysis.safeParse(await better.json()).success).toBe(true);
    expect(rows("video_analyses")).toBe(1);
  });
});

// --- history ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("GET /api/player/video-analyses lists the history", () => {
  test("empty for a player who has none, no-store, and the consent is not needed to read it", async () => {
    const player = await onboardedPlayer();
    const res = await list(player);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual([]);
  });

  test("the caller's own analyses, newest first, and nobody else's", async () => {
    const player = await readyPlayer();
    const other = await readyPlayer();
    const first = VideoAnalysis.parse(await (await postJson(player, requestBody())).json());
    await Bun.sleep(15);
    const second = VideoAnalysis.parse(await (await postJson(player, requestBody())).json());
    await Bun.sleep(15);
    const foreign = VideoAnalysis.parse(await (await postJson(other, requestBody())).json());

    const listed = VideoAnalysisList.parse(await (await list(player)).json());
    expect(listed.map((a) => a.id)).toEqual([second.id, first.id]);
    expect(listed.map((a) => a.id)).not.toContain(foreign.id);
    expect(VideoAnalysisList.parse(await (await list(other)).json()).map((a) => a.id)).toEqual([foreign.id]);
  });

  test("history stays readable after the consent is revoked", async () => {
    const player = await readyPlayer();
    const made = VideoAnalysis.parse(await (await postJson(player, requestBody())).json());
    setConsents(db, player.id, { videoAnalysis: false });
    const listed = VideoAnalysisList.parse(await (await list(player)).json());
    expect(listed.map((a) => a.id)).toEqual([made.id]);
  });

  test("a player's analyses go with the player (the cascade), and the list holds no image", async () => {
    const player = await readyPlayer();
    const sent = frames();
    await postJson(player, requestBody({}, sent));
    const text = await (await list(player)).text();
    expectClean(text, sent);
    db.query("DELETE FROM player_profiles WHERE player_id = ?").run(player.id);
    expect(rows("video_analyses")).toBe(0);
  });
});
