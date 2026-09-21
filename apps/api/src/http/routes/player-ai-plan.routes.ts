// POST /api/player/today/ai-plan (fc-mol-zo6.7): the player asks the AI Coach to personalise today's session.
//
// Behind requirePlayer (anonymous players included), which runs BEFORE the body is read. The player is always the
// session's (`c.var.playerId`); the body is the contract's strict AiPlanRequest {note?} (a `playerId` key is a 422).
// Every response, the guard's 401 and the problems included, is `Cache-Control: no-store`.
//
// What it does
//   1. today's session is read through GET /api/player/today's own handler (see "Reading" below), so a first call of
//      the day creates the deterministic session exactly as GET does; a player who is not onboarded is that route's
//      404, an unknown ?locale its 400, an unseeded graph its 503, all relayed as it answers them;
//   2. the SERVER computes the candidate set (getSettings -> candidates over the published versions, the player's
//      profile and roadmap levels, the skill graph: the pool pickSession and the swap use) and the time budget;
//   3. the coach agent runs ONCE under planWithFallback's timeout (an AbortController, AI_PLAN_TIMEOUT_MS = 20 s by
//      default), and its answer is judged by validatePlan: a plan is used only when EVERY id is a server candidate
//      and every rule holds. A failure of any kind (setting off, no key, timeout, provider error, invalid output)
//      answers the deterministic session unchanged plus `fallback: {code}`, ALWAYS with status 200;
//   4. a valid plan is stored in the day's session (planner 'ai') and answered as the GET route views it;
//   5. every request that gets this far writes one ai_calls row through logAiCall (ids, hash and codes only, never
//      the note; it never throws).
// Errors that are not AI-side are RFC 9457 problems: 401 (the guard), 400, 404, 422, 503. A provider failure is never
// one of them.
//
// Readings the criteria leave open (each pinned by player-ai-plan.routes.test.ts)
//   * FINISHED ITEMS: an item with `done: true` is never rewritten, reordered past its place or dropped: the stored
//     session becomes [the finished items, byte for byte, in their order] + [the AI's items]. The AI plans only the
//     REST: the budget it is given is minutesPerSession minus the finished items' minutes minus the skill test's 2
//     minutes, and the drills of finished items are not offered to it. The AI's items get fresh itemIds
//     (item-<n+1>...) after the highest id the session ever used, so an id of a dropped item is never reused (the
//     events log may name it). The unfinished items the plan replaces are dropped.
//   * The write runs in ONE immediate transaction that RE-READS the stored items: an item the player finished while
//     the agent was running (up to 20 s) is kept as finished, and a plan item for its drill is dropped, so a slow
//     agent can never undo a tick. A session that already turned 'ai' meanwhile (a concurrent request) is left alone.
//   * ONE PAID CALL PER DAY: when the day's session is already an AI plan, a repeat request answers it as stored
//     (200, planner 'ai') without calling the agent, and is logged with validator_result "already_planned". The
//     contract's failure variant has planner 'rules', so a stored AI plan could not be answered as "unchanged" after
//     a failed second attempt; this also stops repeated requests from costing a provider call each. CONTRACT GAP: a
//     re-plan (a new note later the same day) needs a way to ask for it.
//   * NOTHING TO PLAN: when the rest of the budget is below what the validator can accept (a plan is at least two
//     drills of two minutes, and may run 3 over: budget < 1) or fewer than two candidates remain, no plan can be
//     valid, so the agent is not called; the session is answered unchanged with fallback `invalid_output` (the
//     contract's closest code: no valid AI plan exists) and validator_result "nothing_to_plan". `disabled` and
//     `no_key` still win, as in planWithFallback.
//   * THE AGENT IS INJECTABLE: `createAgent(deps)` receives what createCoachAgent needs (the candidates, graph,
//     levels, locale) and returns anything with generate(prompt, {abortSignal}) -> {object, usage?}. The default
//     builds the real Mastra coach agent on `openai/<OPENAI_MODEL>` (or `model`). `env` is the key/model source
//     (default process.env, read at call time) and `timeoutMs` the hard limit (default 20 s); tests pass a fake
//     agent and an env, so nothing needs a key or the network. The module's `register` is createAiPlanRegister()
//     with the defaults (routes auto-load through `register`).
//   * The note goes to the agent ONLY inside a <data> block (buildCoachPrompt) and is stored and logged nowhere.
//   * The profile hash is the sha-256 of the stored profile's fields (keys sorted): the player id is not in it, so
//     equal profiles group together.
//   * validator_result: "ok" for a served plan; "invalid:<rule>,<rule>" (validatePlan's rule names) for an invalid
//     answer; "nothing_to_plan" / "already_planned" as above; NULL when no answer was judged (disabled, no_key,
//     timeout, provider_error).
//   * Reading: as player-swap.routes.ts, the GET route (the only reader of a stored session's view: content in the
//     locale and en, status, attribution, skill test, totals, the X-Timezone day) is mounted on a PRIVATE app and
//     called with the caller's cookie, x-timezone header and query, so the two can never drift. CONTRACT GAP:
//     exporting the view builder from player-today.routes.ts would make this a plain function call.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { MastraModelConfig } from "@mastra/core/llm";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import { getSettings } from "../../admin/settings";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { getSkillGraph, listPublishedVersions } from "../../commons/repo";
import { logAiCall } from "../../mastra/ai-log";
import { buildCoachPrompt, createCoachAgent } from "../../mastra/coach-agent";
import { aiAvailable, textModelId } from "../../mastra/model";
import type { ModelEnv } from "../../mastra/model";
import type { CoachToolDeps } from "../../mastra/tools/coach-tools";
import { ITEM_MIN_MINUTES, PLAN_MIN_ITEMS, TOTAL_ABOVE_BUDGET, planWithFallback, validatePlan } from "../../mastra/validator";
import { candidates } from "../../planner/candidates";
import { SKILL_TEST_MINUTES } from "../../planner/session";
import { DEFAULT_SPORT } from "../../player/journey";
import { getProfile, getRoadmap } from "../../player/profile-repo";
import { ENDPOINTS } from "../../shared/ai";
import type { AiFallbackCode, AiPlan } from "../../shared/ai";
import type { PlayerProfileView } from "../../shared/domain";
import { ENDPOINTS as SESSION_ENDPOINTS } from "../../shared/session";
import type { TodaySession } from "../../shared/session";
import { fromZodError, problem } from "../problem";
import { register as registerToday } from "./player-today.routes";

/** The coach agent as this route uses it: one generate call, the structured answer in `object`. */
export interface CoachAgentLike {
  generate(
    prompt: string,
    options?: { abortSignal?: AbortSignal | undefined },
  ): Promise<{ object?: unknown; usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined }>;
}

export interface AiPlanRouteOptions {
  /** Builds the agent from the server's candidate set; default: the real Mastra coach agent on `model`. */
  createAgent?: ((deps: CoachToolDeps) => CoachAgentLike | Promise<CoachAgentLike>) | undefined;
  /** Where the key and model names are read (default process.env, read per request). */
  env?: ModelEnv | undefined;
  /** The model of the default agent; default `openai/<OPENAI_MODEL>` from `env`. */
  model?: MastraModelConfig | undefined;
  /** The hard timeout of the agent call; default AI_PLAN_TIMEOUT_MS (20 s). */
  timeoutMs?: number | undefined;
}

/** One entry of sessions.items, as player-today.routes.ts stores it. */
interface StoredItem {
  itemId: string;
  drillVersionId: string;
  minutes: number;
  reason?: string;
  done: boolean;
  regressionOf?: string;
  progressionOf?: string;
}

/** What one request tells the log; the player, kind, model and profile hash are the route's. */
interface LogFacts {
  candidateIds: readonly string[];
  chosenIds: readonly string[];
  validatorResult: string | null;
  fallbackCode: AiFallbackCode | null;
  latencyMs: number;
  tokens?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined;
}

/** The least drill budget a valid plan can have: two drills of the minimum length, the total may run over by 3. */
const MIN_PLANNABLE_BUDGET = PLAN_MIN_ITEMS * ITEM_MIN_MINUTES - TOTAL_ABOVE_BUDGET;

/** Every response of the route is never cached, whoever produced it (the guard included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

/** One issue per unknown key, at that key's own path, so its pointer names the key (as player-swap.routes.ts). */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] })) : [issue],
    ),
  );
}

/** A response of the private GET route as a fresh, mutable one of this route (status, body and content type kept). */
async function relay(res: Response): Promise<Response> {
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

/** sha-256 of the stored profile's fields in key order: groups equal profiles, names nobody. */
function profileHash(profile: PlayerProfileView): string {
  const fields = Object.entries(profile).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** The real coach agent behind the route's small interface (its usage counts pass through). */
function coachAgentOn(model: MastraModelConfig, deps: CoachToolDeps): CoachAgentLike {
  const agent = createCoachAgent({ ...deps, model });
  return {
    generate: async (prompt, options) => {
      const result = await agent.generate(prompt, options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal });
      return { object: result.object, usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens } };
    },
  };
}

/**
 * Stores the plan in the session in ONE immediate transaction: the finished items as they are NOW (byte for byte),
 * then the plan's items, minus any whose drill is finished by now. Writes nothing when the session is gone or is
 * already an AI plan.
 */
function storeAiPlan(db: Database, playerId: string, sessionId: string, plan: AiPlan): void {
  db.transaction((): void => {
    const row = db
      .query<{ items: string; planner: string }, [string, string]>("SELECT items, planner FROM sessions WHERE id = ?1 AND player_id = ?2")
      .get(sessionId, playerId);
    if (row === null || row.planner === "ai") return;
    const current = JSON.parse(row.items) as StoredItem[];
    const drillOf = db.query<{ drill_id: string }, [string]>("SELECT drill_id FROM drill_versions WHERE id = ?1");
    const drillIdOf = (versionId: string): string => drillOf.get(versionId)?.drill_id ?? versionId;

    const finished = current.filter((item) => item.done === true);
    const finishedDrills = new Set(finished.map((item) => drillIdOf(item.drillVersionId)));
    const highest = current.reduce((most, item) => Math.max(most, Number(/^item-(\d+)$/.exec(item.itemId)?.[1] ?? 0)), current.length);
    const fresh: StoredItem[] = plan.items
      .filter((item) => !finishedDrills.has(drillIdOf(item.drillVersionId)))
      .map((item, index) => ({
        itemId: `item-${highest + index + 1}`,
        drillVersionId: item.drillVersionId,
        minutes: item.minutes,
        reason: item.reason,
        done: false,
      }));
    db.query("UPDATE sessions SET planner = 'ai', items = ?1 WHERE id = ?2 AND player_id = ?3").run(JSON.stringify([...finished, ...fresh]), sessionId, playerId);
  }).immediate();
}

export function createAiPlanRegister(options: AiPlanRouteOptions = {}): (app: Hono, deps: AppDeps) => Promise<void> {
  return async function register(app: Hono, deps: AppDeps): Promise<void> {
    // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
    // whichever module mounts first.
    await ensureAuthSchema(getAuth(deps), deps.db);
    const { db } = deps;
    const spec = ENDPOINTS.aiPlan;

    // GET /api/player/today, mounted on a private app: the only reader of a stored session's view (see the header).
    const reader = new Hono();
    await registerToday(reader, deps);
    const readToday = (c: Context<{ Variables: AuthVariables }>): Promise<Response> => {
      const headers = new Headers();
      for (const name of ["cookie", "authorization", "x-timezone"]) {
        const value = c.req.header(name);
        if (value !== undefined) headers.set(name, value);
      }
      const url = new URL(SESSION_ENDPOINTS.getToday.path, c.req.url);
      url.search = new URL(c.req.url).search;
      return Promise.resolve(reader.fetch(new Request(url, { headers })));
    };

    app.post(spec.path, noStore, requirePlayer(deps), async (c: Context<{ Variables: AuthVariables }>) => {
      const text = await c.req.text();
      let json: unknown = {};
      if (text.trim() !== "") {
        try {
          json = JSON.parse(text);
        } catch {
          return problem(400, "Bad Request", "The request body is not valid JSON.");
        }
      }
      const body = spec.request.safeParse(json);
      if (!body.success) return problem(422, "Unprocessable Entity", "Invalid request body.", fromZodError(expandUnknownKeys(body.error)));

      const playerId = c.var.playerId;
      const opening = await readToday(c);
      if (opening.status !== 200) return relay(opening);
      const session = (await opening.json()) as TodaySession;

      const profile = getProfile(db, playerId);
      const roadmap = getRoadmap(db, playerId);
      if (profile === null || roadmap === null) return problem(404, "Not Found", "The player is not onboarded.");
      const locale = SESSION_ENDPOINTS.getToday.query.safeParse(c.req.query()).data?.locale ?? profile.locale;
      const graph = getSkillGraph(db, DEFAULT_SPORT, locale);
      if (graph === null) return problem(503, "Service Unavailable", `The ${DEFAULT_SPORT} skill graph is not loaded yet.`);

      const env = options.env ?? process.env;
      const model = textModelId(env);
      const hash = profileHash(profile);
      const log = (entry: LogFacts): void => {
        logAiCall(db, {
          playerId,
          kind: "plan",
          model,
          profileHash: hash,
          candidateIds: entry.candidateIds,
          chosenIds: entry.chosenIds,
          validatorResult: entry.validatorResult,
          fallbackCode: entry.fallbackCode,
          latencyMs: entry.latencyMs,
          tokensIn: entry.tokens?.inputTokens ?? null,
          tokensOut: entry.tokens?.outputTokens ?? null,
        });
      };

      // One paid call per day: a stored AI plan is answered as it is.
      if (session.planner === "ai") {
        log({ candidateIds: [], chosenIds: [], validatorResult: "already_planned", fallbackCode: null, latencyMs: 0 });
        return c.json(session, 200);
      }

      // The candidate set and the budget are the server's: the finished items stay, the AI plans the rest.
      const finished = session.items.filter((item) => item.done);
      const drillOf = db.query<{ drill_id: string }, [string]>("SELECT drill_id FROM drill_versions WHERE id = ?1");
      const finishedDrills = new Set(finished.map((item) => drillOf.get(item.drillVersionId)?.drill_id));
      const levels = Object.fromEntries(roadmap.tracks.map((track) => [track.skill, track.level]));
      const settings = getSettings(db);
      const offered = candidates(profile, levels, settings, listPublishedVersions(db, { sport: DEFAULT_SPORT }), graph).filter((version) => !finishedDrills.has(version.drillId));
      const offeredIds = offered.map((version) => version.versionId);
      const budgetMinutes =
        profile.minutesPerSession - finished.reduce((sum, item) => sum + item.minutes, 0) - (session.skillTest === undefined ? 0 : SKILL_TEST_MINUTES);
      const plannable = budgetMinutes >= MIN_PLANNABLE_BUDGET && offered.length >= PLAN_MIN_ITEMS;

      const seen: { answer?: unknown; usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined } = {};
      const createAgent = options.createAgent ?? ((deps: CoachToolDeps) => coachAgentOn(options.model ?? textModelId(env), deps));
      const started = performance.now();
      const result = await planWithFallback(
        async (signal) => {
          if (!plannable) return undefined; // no plan can be valid: no paid call, the validator says so
          const agent = await createAgent({ candidates: offered, graph, levels, locale });
          const request = { budgetMinutes, locale, ...(body.data.note === undefined ? {} : { note: body.data.note }) };
          const answer = await agent.generate(buildCoachPrompt(request), { abortSignal: signal });
          seen.answer = answer.object;
          seen.usage = answer.usage;
          return answer.object;
        },
        session,
        { candidateIds: offeredIds, budgetMinutes, profile, hasKey: aiAvailable(env), enabled: settings.aiPlannerEnabled, timeoutMs: options.timeoutMs },
      );
      const latencyMs = performance.now() - started;

      if (result.planner === "ai") {
        log({ candidateIds: offeredIds, chosenIds: result.session.items.map((item) => item.drillVersionId), validatorResult: "ok", fallbackCode: null, latencyMs, tokens: seen.usage });
        storeAiPlan(db, playerId, session.id, result.session);
        return relay(await readToday(c));
      }

      let validatorResult: string | null = null;
      if (result.fallback.code === "invalid_output") {
        const check = plannable ? validatePlan(seen.answer, offeredIds, budgetMinutes, profile) : undefined;
        validatorResult =
          check === undefined ? "nothing_to_plan" : check.ok ? "ok" : `invalid:${[...new Set(check.issues.map((issue) => issue.rule))].join(",")}`;
      }
      log({ candidateIds: offeredIds, chosenIds: [], validatorResult, fallbackCode: result.fallback.code, latencyMs, tokens: seen.usage });
      return c.json({ ...result.session, fallback: result.fallback }, 200);
    });
  };
}

/** The route module's entry: auto-loaded with the real coach agent. */
export const register = createAiPlanRegister();
