// POST /api/player/drills/:versionId/explain (fc-mol-zo6.8): a simpler explanation (or a translation into the
// requested locale) of ONE published drill version, generated from the drill's own text.
//
// Behind requirePlayer (anonymous players included), which runs BEFORE the body is read. The player is always the
// session's (`c.var.playerId`); the body is the contract's strict ExplainRequest {locale, audience} (a `playerId` key is
// a 422). Every response, the guard's 401 and the problems included, is `Cache-Control: no-store`.
//
// What it does
//   1. the params and body are read (400 bad id / not JSON, 422 refused body);
//   2. the version is looked up: it must exist and belong to a drill that is not unpublished, else 404 (no AI call);
//   3. no key configured -> 503 problem 'ai_unavailable' (the agent is not built);
//   4. the explain agent runs ONCE under a hard timeout (see ../../mastra/explain.ts) on the drill's content as
//      delimited data; its answer is judged (a usable text only). Any failure -> 503 problem 'ai_unavailable', with a
//      body that never repeats the provider's message;
//   5. success -> 200 {text, aiGenerated: true, basedOnVersionId}. NOTHING is written to the commons, the sessions or
//      anywhere else: the text is not stored. The only write is the ai_calls row;
//   6. every request that reaches the AI step writes one ai_calls row (kind 'explain') through logAiCall: ids, codes,
//      counts, never the text (it never throws). A player with no profile row is logged with a NULL player (the log's
//      foreign key needs a profile); the profile hash is always NULL: no profile is sent to the model.
//
// Readings the criteria leave open (each pinned by explain.test.ts)
//   * "published drill version": ANY version of a drill that is not unpublished, not only its current one: the
//     session and the drill player can hold an older version id, and basedOnVersionId names exactly the one asked.
//   * the lookup (404) comes before the key check (503), so an unknown id is a 404 even without a key.
//   * every AI-side failure (no key, timeout, provider error, an unusable answer) is the same 503; the fallback code
//     that tells them apart is in the log only. The AI planner setting does not gate this route (it is the PLANNER's).
//   * THE AGENT IS INJECTABLE: `createAgent()` returns anything with generate(prompt, {abortSignal}) -> {text, usage?}.
//     The default builds the real Mastra explain agent on `openai/<OPENAI_MODEL>` (or `model`). `env` is the key/model
//     source (default process.env, read per request) and `timeoutMs` the hard limit; tests pass a fake agent, so
//     nothing needs a key or the network. The module's `register` is createExplainRegister() with the defaults.
import type { Database } from "bun:sqlite";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import type { AppDeps } from "../../app";
import { ensureAuthSchema, getAuth } from "../../auth/better-auth";
import { requirePlayer } from "../../auth/middleware";
import type { AuthVariables } from "../../auth/middleware";
import { logAiCall } from "../../mastra/ai-log";
import { buildExplainPrompt, createExplainAgent, runExplain } from "../../mastra/explain";
import type { ExplainAgentLike, ExplainUsage } from "../../mastra/explain";
import { aiAvailable, textModelId } from "../../mastra/model";
import type { ModelEnv } from "../../mastra/model";
import { AI_UNAVAILABLE, ENDPOINTS } from "../../shared/ai";
import type { AiFallbackCode } from "../../shared/ai";
import type { DrillContent } from "../../shared/primitives";
import { fromZodError, problem } from "../problem";

export type { ExplainAgentLike } from "../../mastra/explain";

export interface ExplainRouteOptions {
  /** Builds the explain agent; default: the real Mastra agent on `model`. */
  createAgent?: (() => ExplainAgentLike | Promise<ExplainAgentLike>) | undefined;
  /** Where the key and model names are read (default process.env, read per request). */
  env?: ModelEnv | undefined;
  /** The model of the default agent; default `openai/<OPENAI_MODEL>` from `env`. */
  model?: MastraModelConfig | undefined;
  /** The hard timeout of the agent call; default EXPLAIN_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
}

/** Every response of the route is never cached, whoever produced it (the guard included). */
const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

/** One issue per unknown key, at that key's own path, so its pointer names the key (as player-ai-plan.routes.ts). */
function expandUnknownKeys(error: ZodError): ZodError {
  return new ZodError(
    error.issues.flatMap((issue): typeof error.issues =>
      issue.code === "unrecognized_keys" ? issue.keys.map((key) => ({ ...issue, keys: [key], path: [...issue.path, key] })) : [issue],
    ),
  );
}

/** The real explain agent behind the route's small interface (its usage counts pass through). */
function explainAgentOn(model: MastraModelConfig): ExplainAgentLike {
  const agent = createExplainAgent({ model });
  return {
    generate: async (prompt, options) => {
      const result = await agent.generate(prompt, options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal });
      return { text: result.text, usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens } };
    },
  };
}

/** A version of a drill that is not unpublished (any version, not only the current one), or null. */
function findVersion(db: Database, versionId: string): { content: DrillContent } | null {
  const row = db
    .query<{ content: string }, [string]>(
      `SELECT v.content AS content
         FROM drill_versions v JOIN drills d ON d.id = v.drill_id
        WHERE v.id = ?1 AND d.unpublished_at IS NULL AND d.current_version_id IS NOT NULL`,
    )
    .get(versionId);
  return row === null ? null : { content: JSON.parse(row.content) as DrillContent };
}

const unavailable = (): Response =>
  problem(503, "Service Unavailable", "The AI explanation is not available right now.", undefined, { type: AI_UNAVAILABLE });

export function createExplainRegister(options: ExplainRouteOptions = {}): (app: Hono, deps: AppDeps) => Promise<void> {
  return async function register(app: Hono, deps: AppDeps): Promise<void> {
    // The guard reads Better Auth's tables. Idempotent and shared with auth.routes.ts, so this holds
    // whichever module mounts first.
    await ensureAuthSchema(getAuth(deps), deps.db);
    const { db } = deps;
    const spec = ENDPOINTS.explainDrill;

    app.post(spec.path, noStore, requirePlayer(deps), async (c: Context<{ Variables: AuthVariables }>) => {
      const params = spec.params.safeParse(c.req.param());
      if (!params.success) return problem(400, "Bad Request", "Invalid request parameters.", fromZodError(params.error));

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

      const { versionId } = params.data;
      const version = findVersion(db, versionId);
      if (version === null) return problem(404, "Not Found", "No published drill version has this id.");

      const playerId = c.var.playerId;
      const hasProfile = db.query("SELECT 1 FROM player_profiles WHERE player_id = ?1").get(playerId) !== null;
      const env = options.env ?? process.env;
      const model = textModelId(env);
      const log = (facts: { validatorResult: string | null; fallbackCode: AiFallbackCode | null; latencyMs: number; usage?: ExplainUsage | undefined }): void => {
        logAiCall(db, {
          playerId: hasProfile ? playerId : null,
          kind: "explain",
          model,
          profileHash: null,
          candidateIds: [versionId],
          chosenIds: facts.fallbackCode === null ? [versionId] : [],
          validatorResult: facts.validatorResult,
          fallbackCode: facts.fallbackCode,
          latencyMs: facts.latencyMs,
          tokensIn: facts.usage?.inputTokens ?? null,
          tokensOut: facts.usage?.outputTokens ?? null,
        });
      };

      if (!aiAvailable(env)) {
        log({ validatorResult: null, fallbackCode: "no_key", latencyMs: 0 });
        return unavailable();
      }

      const prompt = buildExplainPrompt({ content: version.content, locale: body.data.locale, audience: body.data.audience });
      const createAgent = options.createAgent ?? (() => explainAgentOn(options.model ?? textModelId(env)));
      const started = performance.now();
      const outcome = await runExplain(async (signal) => {
        const agent = await createAgent();
        return agent.generate(prompt, { abortSignal: signal });
      }, options.timeoutMs);
      const latencyMs = performance.now() - started;

      if (!outcome.ok) {
        log({ validatorResult: outcome.validatorResult, fallbackCode: outcome.code, latencyMs, usage: outcome.usage });
        return unavailable();
      }
      log({ validatorResult: "ok", fallbackCode: null, latencyMs, usage: outcome.usage });
      return c.json({ text: outcome.text, aiGenerated: true as const, basedOnVersionId: versionId }, 200);
    });
  };
}

/** The route module's entry: auto-loaded with the real explain agent. */
export const register = createExplainRegister();
