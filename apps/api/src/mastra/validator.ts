// The AI plan validator and the deterministic fallback wrapper (fc-mol-zo6.3).
//
// The AI never gets the last word: whatever the model returns is checked here against rules the
// SERVER owns, and anything doubtful is replaced by the deterministic session
// (pickSession in ../planner/session). Fail closed: the only way to get planner "ai" is a plan
// that passes every rule.
//
//   validatePlan(aiPlan, candidateIds, budgetMinutes, profile) -> { ok, plan } | { ok: false, code, issues }
//   planWithFallback(run, deterministic, ctx)                   -> { planner: 'ai', session: AiPlan }
//                                                                | { planner: 'rules', session: deterministic, fallback: { code } }
//
// Pure apart from the injected `run` function: no clock reads, no network, no env. The only side
// effect is the timeout timer planWithFallback owns (cleared before it returns).
//
// Readings of the criteria (each is a decision, not in the bead text):
//   - `aiPlan` is `unknown` (it is model output). It is first parsed with the contract's AiPlan
//     schema (shared/ai.ts: strict keys, integer minutes, non-empty reason, at least one item); a
//     failure is the single issue "shape". The bead's own rules run on top of that.
//   - the total window is inclusive: budget-2 .. budget+3. `budgetMinutes` is the drills' budget as
//     the caller computes it; the deterministic session also counts a 2-minute skill test in its
//     window, so a caller that keeps a test should pass budget minus the test's minutes.
//   - "duplicates" means the same drillVersionId twice (the validator only knows version ids).
//   - reason length is counted in code points, so kk/ru text and emoji are not over-counted.
//   - "no URLs": a scheme://, a www. prefix, or a bare domain under a list of common TLDs
//     (deliberately over-eager: a false positive only costs the fallback).
//   - a blank (whitespace-only) reason is rejected: the contract's AI session needs a real reason.
//   - `profile` is accepted for the signature the bead names but no rule reads it yet: the window
//     comes from `budgetMinutes`. Kept so callers need not change when a profile rule arrives.
//   - planWithFallback takes a third argument (ctx): the bead names (run, deterministic) but the
//     validator needs the candidate set and budget, and "missing key or disabled setting" needs
//     flags. When both are off, "disabled" wins (an explicit setting beats a missing key).
//   - the timeout defaults to AI_PLAN_TIMEOUT_MS (the contract's 20 s). `run` receives an AbortSignal
//     that is aborted on timeout. An error named TimeoutError (what AbortSignal.timeout throws) is
//     also a "timeout"; any other throw or rejection is "provider_error".
//   - the AI success `session` is the validated AiPlan (drillVersionId, minutes, reason); the route
//     turns it into a TodaySession because only it holds the candidates' content.
import { AI_PLAN_TIMEOUT_MS, AiPlan, aiPlanUnknownIds } from "../shared/ai";
import type { AiFallbackCode } from "../shared/ai";
import type { PlayerProfile } from "../shared/domain";

export const PLAN_MIN_ITEMS = 2;
export const PLAN_MAX_ITEMS = 8;
export const ITEM_MIN_MINUTES = 2;
export const ITEM_MAX_MINUTES = 15;
export const REASON_MAX_CHARS = 160;
/** The total may be this far under the budget... */
export const TOTAL_BELOW_BUDGET = 2;
/** ...and this far over it. */
export const TOTAL_ABOVE_BUDGET = 3;

export type PlanRule =
  | "shape"
  | "unknown_id"
  | "duplicate"
  | "item_count"
  | "item_minutes"
  | "total_minutes"
  | "reason_length"
  | "reason_blank"
  | "reason_url";

export interface PlanIssue {
  rule: PlanRule;
  detail: string;
}

export type PlanValidation =
  | { ok: true; plan: AiPlan }
  | { ok: false; code: "invalid_output"; issues: PlanIssue[] };

/** The part of a player profile a validation may read. */
export type ValidatorProfile = Pick<PlayerProfile, "minutesPerSession">;

const URL_PATTERN = new RegExp(
  [
    "[a-z][a-z0-9+.-]*://", // scheme://
    "\\bwww\\.", // www.
    "[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|org|net|io|kz|ru|info|co|me|app|dev|ai|tv|xyz|edu|gov|by|ua|uz|kg)", // bare domain
  ].join("|"),
  "i",
);

const codePoints = (text: string): number => [...text].length;

export function validatePlan(
  aiPlan: unknown,
  candidateIds: Iterable<string>,
  budgetMinutes: number,
  _profile: ValidatorProfile,
): PlanValidation {
  const parsed = AiPlan.safeParse(aiPlan);
  if (!parsed.success) {
    return { ok: false, code: "invalid_output", issues: [{ rule: "shape", detail: parsed.error.message }] };
  }
  const plan = parsed.data;
  const issues: PlanIssue[] = [];

  const unknown = aiPlanUnknownIds(plan, candidateIds);
  if (unknown.length > 0) {
    issues.push({ rule: "unknown_id", detail: `not in the candidate set: ${unknown.join(", ")}` });
  }

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const { drillVersionId } of plan.items) {
    if (seen.has(drillVersionId)) duplicated.add(drillVersionId);
    seen.add(drillVersionId);
  }
  if (duplicated.size > 0) issues.push({ rule: "duplicate", detail: `listed twice: ${[...duplicated].join(", ")}` });

  if (plan.items.length < PLAN_MIN_ITEMS || plan.items.length > PLAN_MAX_ITEMS) {
    issues.push({
      rule: "item_count",
      detail: `${plan.items.length} items, expected ${PLAN_MIN_ITEMS}..${PLAN_MAX_ITEMS}`,
    });
  }

  for (const { drillVersionId, minutes, reason } of plan.items) {
    if (minutes < ITEM_MIN_MINUTES || minutes > ITEM_MAX_MINUTES) {
      issues.push({
        rule: "item_minutes",
        detail: `${drillVersionId}: ${minutes} minutes, expected ${ITEM_MIN_MINUTES}..${ITEM_MAX_MINUTES}`,
      });
    }
    if (reason.trim() === "") {
      issues.push({ rule: "reason_blank", detail: `${drillVersionId}: the reason is blank` });
    }
    if (codePoints(reason) > REASON_MAX_CHARS) {
      issues.push({
        rule: "reason_length",
        detail: `${drillVersionId}: ${codePoints(reason)} characters, at most ${REASON_MAX_CHARS}`,
      });
    }
    if (URL_PATTERN.test(reason)) {
      issues.push({ rule: "reason_url", detail: `${drillVersionId}: the reason contains a URL` });
    }
  }

  const total = plan.items.reduce((sum, item) => sum + item.minutes, 0);
  const low = budgetMinutes - TOTAL_BELOW_BUDGET;
  const high = budgetMinutes + TOTAL_ABOVE_BUDGET;
  if (total < low || total > high) {
    issues.push({ rule: "total_minutes", detail: `${total} minutes in total, expected ${low}..${high}` });
  }

  return issues.length === 0 ? { ok: true, plan } : { ok: false, code: "invalid_output", issues };
}

// --- planWithFallback ---------------------------------------------------------------------------

export interface PlanContext {
  /** The server-computed candidate set of approved drill version ids. */
  candidateIds: Iterable<string>;
  budgetMinutes: number;
  profile: ValidatorProfile;
  /** An OpenAI key is configured (aiAvailable() in ./model). */
  hasKey: boolean;
  /** The AI planner setting is on. */
  enabled: boolean;
  /** Hard timeout; defaults to AI_PLAN_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
}

export type PlanResult<D> =
  | { planner: "ai"; session: AiPlan }
  | { planner: "rules"; session: D; fallback: { code: AiFallbackCode } };

const rules = <D>(session: D, code: AiFallbackCode): PlanResult<D> => ({
  planner: "rules",
  session,
  fallback: { code },
});

/**
 * Runs the AI once (no retry) and returns its validated plan, or `deterministic` untouched with the
 * reason it was used. Never throws for an AI failure.
 */
export async function planWithFallback<D>(
  run: (signal: AbortSignal) => unknown,
  deterministic: D,
  ctx: PlanContext,
): Promise<PlanResult<D>> {
  if (!ctx.enabled) return rules(deterministic, "disabled");
  if (!ctx.hasKey) return rules(deterministic, "no_key");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error("the AI planner timed out"), { name: "TimeoutError" });
      controller.abort(error);
      reject(error);
    }, ctx.timeoutMs ?? AI_PLAN_TIMEOUT_MS);
  });

  let answer: unknown;
  try {
    // `new Promise` turns a synchronous throw of `run` into a rejection too.
    answer = await Promise.race([new Promise<unknown>((resolve) => resolve(run(controller.signal))), timeout]);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    return rules(deterministic, isTimeout ? "timeout" : "provider_error");
  } finally {
    clearTimeout(timer);
  }

  const validation = validatePlan(answer, ctx.candidateIds, ctx.budgetMinutes, ctx.profile);
  return validation.ok ? { planner: "ai", session: validation.plan } : rules(deterministic, validation.code);
}
